import { deskLog } from './log'
import { commandTaskManager, TASK_TITLES } from './commandTaskManager'
import { workspaceManager } from './workspaceManager'

/**
 * 后台 Git 操作失败 → 做成一个**可见的命令任务**。
 *
 * 后台的定时 fetch / 自动推送原本只写日志：用户看不到失败，也没有「查看输出」的入口。
 * 面板对"任何失败/超时的任务"都会弹带「查看输出」的通知，所以这里把后台失败落成
 * 一个 failed 任务即可接到同一条通知链路上。
 *
 * 去抖：同一个库同一种操作的**相同**失败在窗口内只落一次任务——否则定时 fetch 会
 * 每个周期都新增一条通知。
 */

const DEDUPE_WINDOW_MS = 5 * 60_000
const lastReported = new Map<string, { message: string; at: number }>()

export interface BackgroundFailure {
  knowledgeBaseId: string
  kind: 'git-fetch' | 'git-push'
  message: string
}

export function reportBackgroundGitFailure(event: BackgroundFailure): void {
  const key = `${event.knowledgeBaseId}::${event.kind}`
  const previous = lastReported.get(key)
  const now = Date.now()
  if (previous && previous.message === event.message && now - previous.at < DEDUPE_WINDOW_MS) {
    return
  }
  lastReported.set(key, { message: event.message, at: now })

  try {
    const location = workspaceManager.getLocation(event.knowledgeBaseId)
    // 创建一条失败记录（不复用正在跑的任务：复用会把失败写进别人的运行）
    const { dto } = commandTaskManager.claimHandle({
      knowledgeBaseId: event.knowledgeBaseId,
      knowledgeBaseName: location.name,
      kind: event.kind,
      title: TASK_TITLES[event.kind],
      cwd: location.rootPath
    })
    commandTaskManager.finishRun(dto.id, dto.run, 'failed', event.message)
  } catch (cause) {
    // 落任务失败不能反过来影响后台流程
    deskLog('git:background-failure', 'report failed', String(cause))
  }
}

/** 测试用：清掉去抖状态，让用例之间互不影响。 */
export function resetBackgroundFailureDedupe(): void {
  lastReported.clear()
}
