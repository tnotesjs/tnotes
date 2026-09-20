import { recordBackgroundFailureWithoutTask } from './backgroundFailureLog'
import { deskLog } from './log'
import { commandTaskManager, TASK_TITLES } from './commandTaskManager'
import { workspaceManager } from './workspaceManager'

import type { GitRunObserver } from './gitManager'
import type { CommandTaskStatus } from '../shared/contracts'

/**
 * 后台 Git 操作（定时 fetch、自动推送）→ 一个**在开始时认领、在结束时结算**的可见任务。
 *
 * 之前这里是"失败之后补一条任务"：先 `claimHandle` 再立刻 `finishRun`，任务时长恒为
 * 约 0ms —— 是假数据，也拿不到真实输出。现在由 `GitManager` 在真正开始执行前调用
 * `createBackgroundGitTask()`，把观察者接进命令执行，结束时按真实分类
 * （done / failed / timeout）结算，因此：
 *  - `startedAt` / `finishedAt` 是真实开始与结束时间；
 *  - 失败与超时分类明确（超时由执行层 code 124 判定）；
 *  - 已有输出保留在任务里，面板的「查看输出」照常可用。
 *
 * 去抖只作用于**通知**：同一知识库同一种操作的相同失败在窗口内重复发生时
 * `notify: false`（不再弹通知），任务明细照常保留。
 */

export type BackgroundGitKind = 'git-fetch' | 'git-push'

/** 结算状态：后台任务不会出现 canceled（没有用户取消入口）。 */
export type BackgroundGitFinishStatus = Extract<CommandTaskStatus, 'done' | 'failed' | 'timeout'>

export interface BackgroundGitTask {
  observer: GitRunObserver
  finish(status: BackgroundGitFinishStatus, error: string | null): void
}

export const NOTIFY_DEDUPE_WINDOW_MS = 5 * 60_000

const lastNotified = new Map<string, { message: string; at: number }>()

/**
 * 是否需要为这次后台失败弹通知（纯函数，便于单测）。
 *
 * 键是 `(知识库, 种类)`：同一个库的同一个操作重复失败时静音；**失败原因变了**
 * 说明是新问题，仍然通知。跨知识库的聚合在渲染端完成（多库同时失败只弹一条）。
 */
export function shouldNotifyBackgroundFailure(
  memory: Map<string, { message: string; at: number }>,
  event: { knowledgeBaseId: string; kind: BackgroundGitKind; message: string },
  now: number,
  windowMs = NOTIFY_DEDUPE_WINDOW_MS
): boolean {
  const key = `${event.knowledgeBaseId}::${event.kind}`
  const previous = memory.get(key)
  if (previous && previous.message === event.message && now - previous.at < windowMs) {
    return false
  }
  memory.set(key, { message: event.message, at: now })
  return true
}

export function createBackgroundGitTask(event: {
  knowledgeBaseId: string
  kind: BackgroundGitKind
}): BackgroundGitTask | null {
  try {
    const location = workspaceManager.getLocation(event.knowledgeBaseId)
    const { handle, dto } = commandTaskManager.claimHandle({
      knowledgeBaseId: event.knowledgeBaseId,
      knowledgeBaseName: location.name,
      kind: event.kind,
      title: TASK_TITLES[event.kind],
      cwd: location.rootPath,
      background: true
    })
    handle.stage('running', TASK_TITLES[event.kind])
    let finished = false
    return {
      observer: {
        commandLine: (line: string) => handle.command(line),
        output: (stream: 'stdout' | 'stderr', chunk: string): void => handle.write(stream, chunk),
        // 执行层为限制内存丢弃了输出：把丢弃量告诉面板，用户能看到"有输出被丢"
        outputTruncated: (droppedBytes: number): void => handle.addTruncated(droppedBytes)
      },
      finish: (status, error) => {
        // 幂等：执行器与异常收尾路径都可能在极端时序下调用
        if (finished) return
        finished = true
        const message = error ?? ''
        const notify =
          status === 'done'
            ? true
            : shouldNotifyBackgroundFailure(lastNotified, { ...event, message }, Date.now())
        commandTaskManager.finishRun(dto.id, dto.run, status, error, { notify })
      }
    }
  } catch (cause) {
    // 落任务失败不能反过来影响后台流程（容量门禁、workspace 未就绪等）。
    // 但**不能只写日志**：面板里没有这条任务，用户就没有任何入口看到失败。
    // 所以额外记一条不占标签的记录（设置里可看），保留主进程给出的错误原文。
    const message = cause instanceof Error ? cause.message : String(cause)
    deskLog('git:background-task', 'claim failed', {
      knowledgeBaseId: event.knowledgeBaseId,
      kind: event.kind,
      message
    })
    recordBackgroundFailureWithoutTask({
      knowledgeBaseId: event.knowledgeBaseId,
      kind: event.kind,
      reason: claimFailureReason(message),
      message
    })
    return null
  }
}

/**
 * 把"认领失败"的原始错误翻成用户能看懂的原因。
 *
 * 容量门禁抛的是中文文案（见 `shared/bottomPanelTabs.ts`），原样透出即可；
 * 其它情况（workspace 未就绪等）也把原文带上，不吞信息。
 */
export function claimFailureReason(message: string): string {
  return message.trim() === '' ? '主进程未能创建后台任务（原因未提供）' : message
}

/** 测试用：清掉通知去抖状态，让用例之间互不影响。 */
export function resetBackgroundFailureDedupe(): void {
  lastNotified.clear()
}
