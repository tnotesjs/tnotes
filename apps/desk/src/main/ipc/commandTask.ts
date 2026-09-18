import { z } from 'zod'

import { commandTaskManager } from '../commandTaskManager'
import { gitManager } from '../gitManager'
import { workspaceManager } from '../workspaceManager'
import { IPC_CHANNELS } from '../../shared/contracts'
import { handle } from './shared'

import type { BrowserWindow } from 'electron'
import type { GitOperationResult } from '../../shared/contracts'
import type { CommandTaskHandle } from '../commandTaskManager'

const kindSchema = z.enum(['git-pull', 'git-push', 'git-fetch', 'launch-ide'])
const stageSchema = z.enum(['queued', 'saving', 'precheck', 'running', 'finished'])
const finishStatusSchema = z.enum(['done', 'failed', 'timeout', 'canceled'])

const claimSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  kind: kindSchema,
  title: z.string().min(1).max(120),
  cwd: z.string().min(1).max(4096),
  command: z.string().max(2000).optional()
})

/**
 * 正在执行的运行：`taskId::run` → AbortController。
 *
 * 取消要落到**具体那一轮运行**上，并且发出终止信号后必须等子进程真的退出
 * （`runGitStreaming` 会等 `close`，必要时 SIGKILL 兜底），再解除忙碌状态。
 */
const activeRuns = new Map<string, AbortController>()
/** 被请求重试的任务 id：任务结束后由主进程按种类重新走一遍既有流程 */
const retryRequested = new Set<string>()

export type CommandTaskKindName = 'git-pull' | 'git-push' | 'git-fetch' | 'launch-ide'

function runKey(taskId: string, run: number): string {
  return `${taskId}::${run}`
}

/** 请求渲染端展开面板并定位任务（手动操作立即展开；后台失败由界面决定是否展开）。 */
function requestReveal(getWindow: () => BrowserWindow | null, taskId: string): void {
  getWindow()?.webContents.send(IPC_CHANNELS.commandTaskReveal, taskId)
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
    // 老路径：没有任务面板参与
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
  // 展开面板并定位：新建与复用（重复点击）都要把用户带到那个标签上。
  // 由主进程统一发事件，避免渲染端再造一条平行的通路面。
  if (getWindow) requestReveal(getWindow, handleRef.id)
  if (kind === 'git-fetch') await runGitTask(handleRef, kind, knowledgeBaseId)
  else if (kind === 'git-pull') await runGitTask(handleRef, kind, knowledgeBaseId)
  else await runGitTask(handleRef, kind, knowledgeBaseId)

  const state = gitManager.list().find((item) => item.knowledgeBaseId === knowledgeBaseId)
  const task = commandTaskManager.find(knowledgeBaseId, kind)
  return {
    state: state ?? {
      knowledgeBaseId,
      knowledgeBaseName: location.name,
      busy: null,
      error: task?.error ?? null
    },
    message: task?.error ?? task?.stageLabel ?? '',
    conflict: task?.status === 'failed'
  } as GitOperationResult
}

const TASK_TITLES = {
  'git-pull': '拉取更新',
  'git-push': '推送更改',
  'git-fetch': '获取远端更新',
  'launch-ide': '启动 IDE'
} as const

/**
 * 把一次 Git 操作包成命令任务：排队/检查/执行阶段与实时输出都进面板。
 *
 * 业务检查（门禁、冲突、保存）仍由既有实现负责——这里只订阅过程。
 */
export async function runGitTask(
  handleRef: CommandTaskHandle,
  kind: 'git-pull' | 'git-push' | 'git-fetch',
  knowledgeBaseId: string
): Promise<void> {
  const controller = new AbortController()
  activeRuns.set(runKey(handleRef.id, handleRef.run), controller)
  try {
    if (kind === 'git-fetch') {
      handleRef.stage('precheck', '检查远端更新')
    } else {
      handleRef.stage('precheck', '检查仓库状态')
    }
    handleRef.stage(
      'running',
      kind === 'git-fetch' ? '获取远端更新' : kind === 'git-pull' ? '拉取更新' : '推送更改'
    )

    const observer = {
      commandLine: (line: string) => handleRef.command(line),
      output: (stream: 'stdout' | 'stderr', chunk: string) => handleRef.write(stream, chunk)
    }
    const options = { observer, signal: controller.signal }

    if (kind === 'git-fetch') {
      await gitManager.fetch(knowledgeBaseId, false, options)
    } else if (kind === 'git-pull') {
      await gitManager.pull(knowledgeBaseId, options)
    } else {
      await gitManager.publish(knowledgeBaseId, options)
    }

    if (!handleRef.isCurrent()) return
    if (controller.signal.aborted) {
      commandTaskManager.finishRun(handleRef.id, handleRef.run, 'canceled', '任务已取消')
      return
    }
    commandTaskManager.finishRun(handleRef.id, handleRef.run, 'done', null)
  } catch (error) {
    if (!handleRef.isCurrent()) return
    const message = error instanceof Error ? error.message : String(error)
    const canceled = controller.signal.aborted
    // 超时与取消都要保留此前输出：finishRun 会先冲刷残留日志再置状态
    commandTaskManager.finishRun(
      handleRef.id,
      handleRef.run,
      canceled ? 'canceled' : /超时/.test(message) ? 'timeout' : 'failed',
      canceled ? '任务已取消' : message
    )
  } finally {
    activeRuns.delete(runKey(handleRef.id, handleRef.run))
  }
}

function scheduleRetry(
  kind: 'git-pull' | 'git-push' | 'git-fetch' | 'launch-ide',
  knowledgeBaseId: string
): void {
  // 重试必须重新走既有业务检查：这里只是重新认领任务并调用同一个入口，
  // 不缓存、也不重放上一条命令。
  const task = commandTaskManager.find(knowledgeBaseId, kind)
  if (!task) return
  const { handle: handleRef } = commandTaskManager.claimHandle({
    knowledgeBaseId,
    knowledgeBaseName: task.knowledgeBaseName,
    kind,
    title: task.title,
    cwd: task.cwd,
    command: task.command
  })
  if (kind === 'launch-ide') return
  void runGitTask(handleRef, kind, knowledgeBaseId)
}

export function registerCommandTask(getWindow: () => BrowserWindow | null): () => void {
  const offChanged = commandTaskManager.onChanged((state) => {
    getWindow()?.webContents.send(IPC_CHANNELS.commandTaskChanged, state)
    // 任务收尾时兑现「重试」请求：成功也重试没有意义，只在非 done 时执行
    if (state.stage === 'finished' && state.status !== 'done' && retryRequested.has(state.id)) {
      retryRequested.delete(state.id)
      scheduleRetry(state.kind, state.knowledgeBaseId)
    }
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
      const controller = activeRuns.get(runKey(task.id, task.run))

      // 队列是串行的：任务可能正卡在某个操作后面。此时只 abort 自己的 signal 没有用
      // ——那个 signal 还没被任何子进程监听。必须先终止真正占住队列的操作，
      // 队列才会前进（否则用户看到的就是「点了停止没反应」）。
      const blockedQueue = gitManager.abortActiveOperation(task.knowledgeBaseId)

      if (controller) {
        // 自己已经在跑：发终止信号，等 runGitTask 收到子进程退出再收尾
        controller.abort()
      }
      if (!controller || blockedQueue) {
        // 排队中被取消（或刚终止了占队列的操作）：立刻结算，不必再等自己那一轮
        commandTaskManager.finishRun(
          task.id,
          task.run,
          'canceled',
          blockedQueue ? '已取消（同时终止了占用队列的前一个操作）' : '已在排队阶段取消'
        )
      }
    }
  )

  handle(
    IPC_CHANNELS.commandTaskRetry,
    getWindow,
    z.object({ taskId: z.string().min(1) }),
    (input) => {
      const task = commandTaskManager.list().find((item) => item.id === input.taskId)
      if (!task) throw new Error('命令任务不存在')
      if (task.status === 'queued' || task.status === 'running') {
        throw new Error('任务仍在执行，先停止再重试')
      }
      // 重新走既有业务检查：只是重新认领 + 调同一个入口，不重放上一条命令
      scheduleRetry(task.kind, task.knowledgeBaseId)
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
