import { z } from 'zod'

import {
  clearBackgroundFailures,
  listBackgroundFailures,
  onBackgroundFailuresChanged,
  recordBackgroundFailureWithoutTask
} from '../backgroundFailureLog'
import { commandTaskManager, TASK_TITLES } from '../commandTaskManager'
import { gitManager } from '../gitManager'
import { launchIde } from '../ide'
import { workspaceManager } from '../workspaceManager'
import { IPC_CHANNELS } from '../../shared/contracts'
import { handle } from './shared'

import type { BrowserWindow } from 'electron'
import type { CommandTaskDto, GitOperationResult } from '../../shared/contracts'
import type { CommandTaskHandle } from '../commandTaskManager'
import type { IdeLaunchResult } from '../ide'

const kindSchema = z.enum(['git-pull', 'git-push', 'git-fetch', 'launch-ide'])
const stageSchema = z.enum(['queued', 'saving', 'precheck', 'running', 'canceling', 'finished'])
const finishStatusSchema = z.enum(['done', 'failed', 'timeout', 'canceled'])

const claimSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  kind: kindSchema,
  title: z.string().min(1).max(120),
  cwd: z.string().min(1).max(4096),
  command: z.string().max(2000).optional()
})

/**
 * 一次运行的取消能力。
 *
 * 进入 Git 之前（推送要先保存）由 `commandTaskBegin` 登记；进入 Git 之后由
 * `runGitTask` 补上"哪一项在队列里"的信息。取消只走这里，**不再按知识库去猜
 * 某个 Git 队列项**——那会误伤同库其他排队任务。
 */
interface ExecutionRecord {
  /** 是否已收到取消请求（保存阶段据此决定不进入 Git） */
  canceled: boolean
  /** 设定本轮在 gitManager 队列里的身份（入队时得到） */
  attachOperation: (operationId: string, cancelQueuedNode: () => void) => void
  /** 取消本轮：保存阶段只置位；进入 Git 后按身份精确终止 */
  cancel: () => void
  /**
   * 本轮真正执行的 promise；`null` = 只登记了取消能力（保存阶段，还没进入 Git）。
   * 不能塞一个假的已/未结算 promise——那会让取消后的收尾永远等不到。
   */
  promise: Promise<void> | null
}

const runningExecutions = new Map<string, ExecutionRecord>()

function executionKey(taskId: string, run: number): string {
  return `${taskId}::${run}`
}

/**
 * 声明「这一轮开始执行了」（推送在受控保存之前调用）。
 *
 * 没有这条登记，保存期间的取消就没有归属：任务还没进 Git 队列，
 * 取消只能按知识库去猜一个队列项，正是"误伤同库其他任务"的来源。
 * 返回这一轮是否仍是当前运行（已被取消或不复存在则为 false）。
 */
export function beginCommandTask(taskId: string, run: number): boolean {
  const task = commandTaskManager.list().find((item) => item.id === taskId && item.run === run)
  if (!task) return false
  const key = executionKey(taskId, run)
  if (!runningExecutions.has(key)) {
    runningExecutions.set(key, createExecutionRecord(task.knowledgeBaseId))
  }
  return !runningExecutions.get(key)!.canceled
}

/**
 * 建一条本轮的取消记录。
 *
 * `cancel` 在保存阶段只置位（那时没有任何 Git 进程可终止）；一旦知道了队列身份，
 * 就按身份精确取消——身份匹配当前运行项才终止子进程，否则只让这一项失效。
 */
function createExecutionRecord(knowledgeBaseId: string): ExecutionRecord {
  let operationId: string | null = null
  let cancelQueuedNode: (() => void) | null = null
  const record: ExecutionRecord = {
    canceled: false,
    attachOperation: (id, cancelQueued) => {
      operationId = id
      cancelQueuedNode = cancelQueued
    },
    cancel: () => {
      record.canceled = true
      if (!operationId) return
      const runningNow = gitManager.getRunningOperationId?.(knowledgeBaseId) ?? null
      if (runningNow === operationId) {
        gitManager.cancelRunningOperation(knowledgeBaseId, operationId)
        return
      }
      // 还在 gitManager 队列里排队：只让这一项失效，绝不碰正在跑的另一项
      cancelQueuedNode?.()
    },
    promise: null
  }
  return record
}

/**
 * 请求取消一次正在执行的运行（与 IPC 取消处理器**同一条**路径）。
 *
 * 单独抽出来是为了让测试能驱动真实的取消处理逻辑，而不是复制一份判断：
 * 复制出来的那份只能证明测试自己是对的。
 */
export function cancelRunningExecution(taskId: string, run: number): void {
  const execution = runningExecutions.get(executionKey(taskId, run))
  if (!execution) return
  commandTaskManager.reportStage(taskId, run, 'canceling', '正在停止…')
  execution.cancel()
}

/**
 * 处理一次「停止任务」请求（IPC 处理器只做参数校验，逻辑在这里）。
 *
 * 两条路径都不在取消的当下写终态：进入 Git 之后的等进程 close，
 * 保存阶段的等收尾方在保存完成后以「已取消」结束。
 */
export function requestCancel(taskId: string): void {
  const task = commandTaskManager.list().find((item) => item.id === taskId)
  if (!task) throw new Error('命令任务不存在')
  if (task.stage === 'finished') return

  if (runningExecutions.has(executionKey(task.id, task.run))) {
    // 已在跑的等子进程 close 再结算；还在排队的等它轮到时立即以「已取消」结算；
    // 保存阶段的置位后不再进入 Git。
    cancelRunningExecution(task.id, task.run)
    return
  }
  // 没有本轮的运行记录、也没有队列身份：**不取消任何 Git 队列项**。
  // 按知识库取消会打到该库第一个未运行节点，而它不一定属于这个任务
  // （典型场景：目标任务还停在保存阶段、尚未入队）。此时只把任务本身收尾。
  commandTaskManager.finishRun(task.id, task.run, 'canceled', '已在执行前取消')
}

/** 请求渲染端展开面板并定位任务（手动操作立即展开；后台失败由界面决定是否展开）。 */
function requestReveal(getWindow: () => BrowserWindow | null, taskId: string): void {
  getWindow()?.webContents.send(IPC_CHANNELS.commandTaskReveal, taskId)
}

/**
 * 请求渲染端重跑该任务。
 *
 * 重试**不能**在主进程直接调 Git：推送的完整流程包含渲染端的「保存未提交更改」，
 * 绕过去会把旧磁盘内容提交并推送。所以这里只发请求，由渲染端起头复用完整流程。
 */
function requestRetry(getWindow: () => BrowserWindow | null, taskId: string): void {
  getWindow()?.webContents.send(IPC_CHANNELS.commandTaskRetryRequested, taskId)
}

/** 把业务结果汇总成既有契约的返回值（失败时保留真实原因）。 */
function summarizeResult(
  knowledgeBaseId: string,
  kind: CommandTaskDto['kind']
): GitOperationResult {
  const task = commandTaskManager.find(knowledgeBaseId, kind)
  const state =
    gitManager.list().find((item) => item.knowledgeBaseId === knowledgeBaseId) ??
    ({
      knowledgeBaseId,
      knowledgeBaseName: task?.knowledgeBaseName ?? '',
      busy: null,
      error: task?.error ?? null
    } as GitOperationResult['state'])
  return {
    state,
    message: task?.error ?? task?.stageLabel ?? '',
    // 非 done 一律按「需要处理」回给上层，避免失败被当成成功
    conflict: Boolean(task && task.status !== 'done')
  }
}

/**
 * 按 taskId 执行一次 Git 任务；没有 taskId 时走原有路径（后台 fetch 等）。
 *
 * 这是「手动操作」的统一入口：既有 Git 流程（排队、门禁、冲突检查、状态刷新）
 * 原样复用，只是把观察者与取消信号接了进去。
 */
export async function runGitTaskFor(
  knowledgeBaseId: string,
  kind: 'git-pull' | 'git-push' | 'git-fetch',
  taskId: string | undefined,
  getWindow?: () => BrowserWindow | null,
  run?: number
): Promise<GitOperationResult> {
  if (!taskId) {
    // 老路径：没有任务面板参与（后台定时 fetch 等）
    if (kind === 'git-fetch') return gitManager.fetch(knowledgeBaseId)
    if (kind === 'git-pull') return gitManager.pull(knowledgeBaseId)
    return gitManager.publish(knowledgeBaseId)
  }
  const location = workspaceManager.getLocation(knowledgeBaseId)
  let handleRef: CommandTaskHandle
  if (run === undefined) {
    // 没有指明轮次（拉取/获取在渲染端认领后立即执行）：沿用既有认领语义
    handleRef = commandTaskManager.claimHandle({
      knowledgeBaseId,
      knowledgeBaseName: location.name,
      kind,
      title: TASK_TITLES[kind],
      cwd: location.rootPath
    }).handle
  } else {
    // 指明了轮次（推送带保存）：只认**这一轮**，绝不认领/复活。
    // 被取消或已被取代时直接收手，不去执行任何 Git 写操作。
    const handle = commandTaskManager.handleForRun(taskId, run)
    if (!handle) {
      return summarizeResult(knowledgeBaseId, kind)
    }
    handleRef = handle
  }
  if (getWindow) requestReveal(getWindow, handleRef.id)

  await ensureExecution(handleRef, kind, knowledgeBaseId)
  return summarizeResult(knowledgeBaseId, kind)
}

/**
 * 保证同一 (taskId, run) 只启动一次。
 *
 * 重复点击、并发请求都会命中同一条运行：后来者只**等待**已有运行，不会再起一次
 * （否则同一运行会有两个执行体、两个 AbortController 互相覆盖）。
 */
export async function ensureExecution(
  handleRef: CommandTaskHandle,
  kind: 'git-pull' | 'git-push' | 'git-fetch',
  knowledgeBaseId: string
): Promise<void> {
  const key = executionKey(handleRef.id, handleRef.run)
  // 推送已经用 commandTaskBegin 登记过（保存要能被取消）：沿用同一条记录，
  // 不能新建——新建会丢掉保存期间收到的取消请求。
  let execution = runningExecutions.get(key)
  if (!execution || !execution.promise) {
    // 已取消且还没进入 Git：主体不必再跑，仍然要走 `runGitTask` 的守卫去收尾
    // （它会以 canceled 结束任务，且一条 Git 命令都不执行）。
    execution = execution ?? createExecutionRecord(knowledgeBaseId)
    // runGitTask 会把主体推迟一个微任务再跑，所以这里返回的 promise 是真实那一轮的
    // promise，而不是"占位后再替换"——后者会让并发的后来者永远等在旧 promise 上。
    execution.promise = runGitTask(handleRef, kind, knowledgeBaseId, execution)
    runningExecutions.set(key, execution)
  }
  try {
    await execution.promise
  } finally {
    runningExecutions.delete(key)
  }
}

/**
 * 执行一次 Git 操作并把过程与结果写进任务。
 *
 * 注意**业务结果映射**：`gitManager` 对「本地有变更阻止拉取」「快进失败」等情况
 * 返回 `{ conflict: true }` 而**不抛错**，只看 Promise 会把失败显示成成功。
 */
export async function runGitTask(
  handleRef: CommandTaskHandle,
  kind: 'git-pull' | 'git-push' | 'git-fetch',
  knowledgeBaseId: string,
  execution?: ExecutionRecord
): Promise<void> {
  // 主体推迟一个微任务：让 `ensureExecution` 能**同步**拿到本轮真正的 promise，
  // 并发调用才会命中同一条运行（否则每个调用都会在 promise 赋值前抢跑一次）。
  await Promise.resolve()
  try {
    // 进入 Git 之前就已经收到取消（推送在保存阶段被取消）：一条 Git 命令都不执行。
    // 这里在 stage 之前判，避免把已取消的项又标成 precheck/running。
    if (execution?.canceled || handleRef.canceled()) {
      commandTaskManager.finishRun(handleRef.id, handleRef.run, 'canceled', '任务已取消')
      return
    }
    handleRef.stage('precheck', kind === 'git-fetch' ? '检查远端更新' : '检查仓库状态')
    handleRef.stage(
      'running',
      kind === 'git-fetch' ? '获取远端更新' : kind === 'git-pull' ? '拉取更新' : '推送更改'
    )

    const extras = {
      observer: {
        commandLine: (line: string) => handleRef.command(line),
        output: (stream: 'stdout' | 'stderr', chunk: string): void =>
          handleRef.write(stream, chunk),
        // 执行层为限制内存丢弃了输出：把丢弃量告诉面板，用户能看到"有输出被丢"
        outputTruncated: (droppedBytes: number): void => handleRef.addTruncated(droppedBytes)
      },
      // 清理超时仍未确认进程组消失：如实告知（不是失败，仍在收尾）
      onCleanupUnconfirmed: (): void => {
        handleRef.stage('canceling', '进程组仍在收尾（清理未确认）')
      },
      // 一入队就拿到身份：排队中被取消时只让这一项失效，不碰正在跑的另一项
      onEnqueued: (id: string, cancel: () => void) => {
        execution?.attachOperation(id, cancel)
      }
    }

    let outcome: GitOperationResult
    if (kind === 'git-fetch') outcome = await gitManager.fetch(knowledgeBaseId, false, extras)
    else if (kind === 'git-pull') outcome = await gitManager.pull(knowledgeBaseId, extras)
    else outcome = await gitManager.publish(knowledgeBaseId, extras)

    if (!handleRef.isCurrent()) return
    // 取消请求由「取消中」阶段标记；此时 gitManager 已确认子进程退出（它等 close），
    // 所以这里结算成 canceled 是「退出确认之后」的结果。
    if (handleRef.canceled() || execution?.canceled) {
      commandTaskManager.finishRun(handleRef.id, handleRef.run, 'canceled', '任务已取消')
      return
    }
    if (outcome.conflict) {
      commandTaskManager.finishRun(
        handleRef.id,
        handleRef.run,
        'failed',
        outcome.message || '操作未完成，需要处理'
      )
      return
    }
    commandTaskManager.finishRun(handleRef.id, handleRef.run, 'done', null)
  } catch (error) {
    if (!handleRef.isCurrent()) return
    const message = error instanceof Error ? error.message : String(error)
    const canceled = handleRef.canceled()
    commandTaskManager.finishRun(
      handleRef.id,
      handleRef.run,
      canceled ? 'canceled' : /超时/.test(message) ? 'timeout' : 'failed',
      canceled ? '任务已取消' : message
    )
  } finally {
    // 取消失败/被取消之后，仓库状态可能已经变了（暂存区、甚至已经产生提交），
    // 而 gitManager 对取消**不做自动刷新**（避免一次挂住的刷新把队列拖住）。
    // 这里在任务收尾后补一次尽力而为的刷新，让界面重新拿到真实状态，
    // 而不是以永久保留旧状态换取队列收敛。
    if (!handleRef.isCurrent() || handleRef.canceled()) {
      void gitManager.refresh(knowledgeBaseId).catch(() => undefined)
    }
  }
}

/**
 * 启动 IDE 并把**启动器**的过程做成命令任务。
 *
 * 正常打开时只创建任务、不请求展开面板（不抢焦点）；失败才请求展开，
 * 让用户直接看到命令、目标路径与错误。
 */
async function launchIdeTask(
  getWindow: () => BrowserWindow | null,
  knowledgeBaseId: string,
  targetPath: string
): Promise<IdeLaunchResult> {
  const location = workspaceManager.getLocation(knowledgeBaseId)
  const { handle: task } = commandTaskManager.claimHandle({
    knowledgeBaseId,
    knowledgeBaseName: location.name,
    kind: 'launch-ide',
    title: TASK_TITLES['launch-ide'],
    cwd: targetPath
  })
  task.stage('running', '启动 IDE')
  const result = await launchIde(targetPath, (stream, chunk) => task.write(stream, chunk))
  task.command(result.command)
  if (result.ok) {
    commandTaskManager.finishRun(task.id, task.run, 'done', null)
    return result
  }
  commandTaskManager.finishRun(
    task.id,
    task.run,
    'failed',
    [result.error, result.stderr.trim()].filter(Boolean).join('\n')
  )
  const window = getWindow()
  if (window && !window.isDestroyed()) {
    window.webContents.send(IPC_CHANNELS.commandTaskReveal, task.id)
  }
  return result
}

export { launchIdeTask }

export function registerCommandTask(getWindow: () => BrowserWindow | null): () => void {
  const offChanged = commandTaskManager.onChanged((state) => {
    getWindow()?.webContents.send(IPC_CHANNELS.commandTaskChanged, state)
  })
  const offLog = commandTaskManager.onLog((event) => {
    getWindow()?.webContents.send(IPC_CHANNELS.commandTaskLog, event)
  })
  // 任务标签被移除（用户关闭 / 容量回收）时通知界面，避免留下点不动的空标签
  const offClosed = commandTaskManager.onClosed((taskId) => {
    getWindow()?.webContents.send(IPC_CHANNELS.commandTaskClosed, taskId)
  })
  // 没建出可见任务的后台失败（容量被拦）：单独一条通道，不占面板标签
  const offBackgroundFailures = onBackgroundFailuresChanged((items) => {
    getWindow()?.webContents.send(IPC_CHANNELS.backgroundFailureChanged, items)
  })

  handle(IPC_CHANNELS.commandTaskClaim, getWindow, claimSchema, (input) => {
    const location = workspaceManager.getLocation(input.knowledgeBaseId)
    return commandTaskManager.claim({
      knowledgeBaseId: input.knowledgeBaseId,
      knowledgeBaseName: location.name,
      kind: input.kind,
      title: input.title,
      cwd: input.cwd,
      command: input.command
    })
  })

  handle(IPC_CHANNELS.commandTaskList, getWindow, z.undefined(), () => commandTaskManager.list())
  handle(IPC_CHANNELS.backgroundFailureList, getWindow, z.undefined(), () =>
    listBackgroundFailures()
  )
  handle(IPC_CHANNELS.backgroundFailureClear, getWindow, z.undefined(), () => {
    clearBackgroundFailures()
  })
  // 仅 E2E：后台失败要"容量满 + 真实远端失败"才会自然发生，成本高且不确定。
  // 用一个**受环境门禁保护**的注入口来验证界面路径；生产构建里直接拒绝。
  handle(
    IPC_CHANNELS.backgroundFailureInject,
    getWindow,
    z.object({
      knowledgeBaseId: z.string().min(1),
      kind: z.enum(['git-fetch', 'git-push']),
      reason: z.string().min(1).max(400),
      message: z.string().min(1).max(4000)
    }),
    (input) => {
      if (process.env.DESK_E2E_EXPOSE_INTERNALS !== '1') {
        throw new Error('backgroundFailureInject 仅在 E2E 下可用')
      }
      return recordBackgroundFailureWithoutTask(input)
    }
  )

  handle(
    IPC_CHANNELS.commandTaskClose,
    getWindow,
    z.object({ taskId: z.string().min(1) }),
    (input) => {
      // 关闭视图 ≠ 取消：只是在面板里收起这个标签
      commandTaskManager.close(input.taskId)
    }
  )

  handle(
    IPC_CHANNELS.commandTaskCancel,
    getWindow,
    z.object({ taskId: z.string().min(1) }),
    (input) => requestCancel(input.taskId)
  )

  handle(
    IPC_CHANNELS.commandTaskBegin,
    getWindow,
    z.object({ taskId: z.string().min(1), run: z.number().int().min(1) }),
    (input) => {
      const task = commandTaskManager.list().find((item) => item.id === input.taskId)
      if (!task || task.run !== input.run) return false
      return beginCommandTask(input.taskId, input.run)
    }
  )

  handle(
    IPC_CHANNELS.commandTaskRetry,
    getWindow,
    z.object({ taskId: z.string().min(1) }),
    (input) => {
      const task = commandTaskManager.list().find((item) => item.id === input.taskId)
      if (!task) throw new Error('命令任务不存在')
      if (commandTaskManager.isActive(task.status)) {
        throw new Error('任务仍在执行或正在停止，请等它结束再重试')
      }
      // 交给渲染端重跑：它才知道推送前要先保存（完整业务流程）
      requestRetry(getWindow, task.id)
    }
  )

  handle(
    IPC_CHANNELS.commandTaskStage,
    getWindow,
    z.object({
      taskId: z.string().min(1),
      run: z.number().int().min(1),
      stage: stageSchema,
      label: z.string().max(80)
    }),
    (input) => {
      // run 不符会被内部忽略：旧运行的迟到上报改不了新运行
      return commandTaskManager.reportStageChecked(
        input.taskId,
        input.run,
        input.stage,
        input.label
      )
    }
  )

  handle(
    IPC_CHANNELS.commandTaskFinish,
    getWindow,
    z.object({
      taskId: z.string().min(1),
      run: z.number().int().min(1),
      status: finishStatusSchema,
      error: z.string().max(4000).nullable()
    }),
    (input) => {
      commandTaskManager.finishRun(input.taskId, input.run, input.status, input.error)
      // 任务已收尾：清掉这一轮的运行记录。
      // 保存阶段被取消时只会登记取消能力（还没进入 Git），那条记录不会由
      // `ensureExecution` 的 finally 清理——不清就会残留到应用退出。
      runningExecutions.delete(executionKey(input.taskId, input.run))
    }
  )

  return () => {
    offChanged()
    offLog()
    offClosed()
    offBackgroundFailures()
  }
}
