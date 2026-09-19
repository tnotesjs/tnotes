import type { CommandTaskDto } from '../../../shared/contracts'

/**
 * 后台失败通知的**聚合规划**（纯函数）。
 *
 * 为什么需要：多个知识库可能在同一时刻因为同一个原因（远端不可达、代理挂了）
 * 同时失败。逐条弹通知会在一瞬间刷满屏幕，用户既看不清也点不过来。这里把
 * **同一时间窗内、同一种后台操作**的失败合并成一条通知，消息里列出涉及的
 * 知识库；每条失败任务本身仍然保留（面板里能翻到、能看输出），
 * 「查看输出」定位到批次里的第一条。
 *
 * 手动操作（`background === false`）不聚合：它本来就是用户主动触发的单次操作，
 * 逐条提示更清楚，而且通知键 `id:run` 已经保证同一条任务只提示一次。
 */

/** 后台失败聚合窗口：这段时间内同种类的后台失败算作一批。 */
export const FAILURE_AGGREGATE_WINDOW_MS = 2000

export interface FailureNotice {
  /** 这批任务的通知去重键（`id:run`），界面据此标记"已提示过" */
  keys: string[]
  /** 「查看输出」定位到这一条 */
  actionTaskId: string
  message: string
  /** 聚合了几个知识库（1 = 未聚合） */
  count: number
}

export function taskRunKey(task: Pick<CommandTaskDto, 'id' | 'run'>): string {
  return `${task.id}:${task.run}`
}

/**
 * 从当前任务列表里挑出**尚未提示过**的失败/超时，规划成一组通知。
 *
 * 只处理真正结算过的任务（`finishedAt !== null`）与允许通知的任务
 * （`notify !== false`：后台同一失败在去抖窗口内的重复不再骚扰用户）。
 */
export function planFailureNotices(
  tasks: CommandTaskDto[],
  notified: ReadonlySet<string>,
  windowMs = FAILURE_AGGREGATE_WINDOW_MS
): FailureNotice[] {
  const pending = tasks
    .filter(
      (task) =>
        (task.status === 'failed' || task.status === 'timeout') &&
        task.notify !== false &&
        task.finishedAt !== null &&
        !notified.has(taskRunKey(task))
    )
    .sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0))

  const notices: FailureNotice[] = []
  const batches: CommandTaskDto[][] = []
  for (const task of pending) {
    if (!task.background) {
      notices.push({
        keys: [taskRunKey(task)],
        actionTaskId: task.id,
        count: 1,
        message: `${task.title}失败：${task.knowledgeBaseName}`
      })
      continue
    }
    const current = batches[batches.length - 1]
    const first = current?.[0]
    if (
      current &&
      first &&
      first.kind === task.kind &&
      (task.finishedAt ?? 0) - (first.finishedAt ?? 0) <= windowMs
    ) {
      current.push(task)
    } else {
      batches.push([task])
    }
  }

  for (const batch of batches) {
    const first = batch[0]
    if (batch.length === 1) {
      notices.push({
        keys: [taskRunKey(first)],
        actionTaskId: first.id,
        count: 1,
        message: `${first.title}失败：${first.knowledgeBaseName}`
      })
      continue
    }
    const names = batch.map((task) => task.knowledgeBaseName)
    const shown = names.slice(0, 3).join('、')
    const suffix = names.length > 3 ? ` 等 ${names.length} 个知识库` : ''
    notices.push({
      keys: batch.map(taskRunKey),
      actionTaskId: first.id,
      count: batch.length,
      message: `${first.title}失败：${shown}${suffix}`
    })
  }

  return notices
}
