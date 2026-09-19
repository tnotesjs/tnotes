import { z } from 'zod'

import { commandTaskManager } from '../commandTaskManager'
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

export const TASK_TITLES: Record<CommandTaskDto['kind'], string> = {
  'git-pull': '拉取更新',
  'git-push': '推送更改',
  'git-fetch': '获取远端更新',
  'launch-ide': '启动 IDE'
}

/**
 * 正在执行的运行：`taskId::run` → 本轮上下文。
 *
 * 两件事都靠它保证：
 *  - **同一 (taskId, run) 只启动一次**：重复点击只定位/等待已有运行，不再起第二次；
 *  - **取消要等进程真的退出**：这里登记取消入口，真正结算由 `runGitTask` 在子进程
 *    close 之后完成（`gitManager` 的 runGit 以 close 为准，必要时 SIGKILL 兜底）。
 *    发出终止信号后任务先进入「取消中」，**不会**提前标记 canceled。
 */
const runningExecutions = new Map<
  string,
  {
    cancel: () => void
    promise: Promise<void>
  }
>()

function executionKey(taskId: string, run: number): string {
  return `${taskId}::${run}`
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
  getWindow?: () => BrowserWindow | null
): Promise<GitOperationResult> {
  if (!taskId) {
    // 老路径：没有任务面板参与（后台定时 fetch 等）
    if (kind === 'git-fetch') return gitManager.fetch(knowledgeBaseId)
    if (kind === 'git-pull') return gitManager.pull(knowledgeBaseId)
    return gitManager.publish(knowledgeBaseId)
  }
  const location = workspaceManager.getLocation(knowledgeBaseId)
  const { handle: handleRef } = commandTaskManager.claimHandle({
    knowledgeBaseId,
    knowledgeBaseName: location.name,
    kind,
    title: TASK_TITLES[kind],
    cwd: location.rootPath
  })
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
  const existing = runningExecutions.get(key)
  if (existing) {
    await existing.promise
    return
  }
  const execution = {
    cancel: () => {
      // 只终止本轮：gitManager 的队列节点只登记了本轮 spawn
      gitManager.cancelRunningOperation(knowledgeBaseId)
    },
    promise: Promise.resolve()
  }
  execution.promise = runGitTask(handleRef, kind, knowledgeBaseId)
  runningExecutions.set(key, execution)
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
  knowledgeBaseId: string
): Promise<void> {
  try {
    handleRef.stage('precheck', kind === 'git-fetch' ? '检查远端更新' : '检查仓库状态')
    handleRef.stage(
      'running',
      kind === 'git-fetch' ? '获取远端更新' : kind === 'git-pull' ? '拉取更新' : '推送更改'
    )

    const observer = {
      commandLine: (line: string) => handleRef.command(line),
      output: (stream: 'stdout' | 'stderr', chunk: string) => handleRef.write(stream, chunk)
    }

    let outcome: GitOperationResult
    if (kind === 'git-fetch') outcome = await gitManager.fetch(knowledgeBaseId, false, { observer })
    else if (kind === 'git-pull') outcome = await gitManager.pull(knowledgeBaseId, { observer })
    else outcome = await gitManager.publish(knowledgeBaseId, { observer })

    if (!handleRef.isCurrent()) return
    // 取消请求由「取消中」阶段标记；此时 gitManager 已确认子进程退出（它等 close），
    // 所以这里结算成 canceled 是「退出确认之后」的结果。
    if (handleRef.canceled()) {
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
    (input) => {
      const task = commandTaskManager.list().find((item) => item.id === input.taskId)
      if (!task) throw new Error('命令任务不存在')
      if (task.stage === 'finished') return

      const key = executionKey(task.id, task.run)
      const execution = runningExecutions.get(key)
      if (execution) {
        // 运行中：先进入「取消中」，等子进程真正退出后由 runGitTask 结算 canceled。
        // 这里**不**提前标记终态——否则用户可以在进程还没退出时重试。
        commandTaskManager.reportStage(task.id, task.run, 'canceling', '正在停止…')
        execution.cancel()
        return
      }
      // 尚未开始执行（排队中）：让**这一项**失效即可。绝不终止前面正在跑的操作，
      // 更不会碰其他知识库；轮到它时直接跳过。
      gitManager.cancelQueuedOperation(task.knowledgeBaseId)
      commandTaskManager.finishRun(task.id, task.run, 'canceled', '已在排队阶段取消')
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
      commandTaskManager.reportStage(input.taskId, input.run, input.stage, input.label)
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
    }
  )

  return () => {
    offChanged()
    offLog()
  }
}
