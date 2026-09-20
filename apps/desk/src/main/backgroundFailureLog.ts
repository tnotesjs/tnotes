import { randomUUID } from 'node:crypto'

import { deskLog } from './log'
import { workspaceManager } from './workspaceManager'

import type { BackgroundFailureDto } from '../shared/contracts'

/**
 * 「后台操作没能建出可见任务」的失败记录。
 *
 * 目前的唯一成因是**底部面板标签已达上限**：`createBackgroundGitTask` 认领任务时被
 * 容量门禁拦下，于是面板里既没有任务、也没有「查看输出」入口。把它只写进日志
 * 等于用户永远看不到，所以这里单独留一条记录：**不占用面板标签**，保留主进程给出的
 * 错误原文与发生时间，由设置里的「Git 与远端」分组展示。
 *
 * 去重键是 `(知识库, 操作, 原因, 消息)`：同一原因反复发生只累加 `count`，
 * 不会刷出一屏重复条目。
 */

export const BACKGROUND_FAILURE_LIMIT = 20

const failures: BackgroundFailureDto[] = []
const listeners = new Set<(items: BackgroundFailureDto[]) => void>()

function notify(): void {
  const snapshot = listBackgroundFailures()
  for (const listener of listeners) {
    try {
      listener(snapshot)
    } catch (cause) {
      deskLog('git:background-failure', 'listener failed', {
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }
  }
}

export function listBackgroundFailures(): BackgroundFailureDto[] {
  return failures.map((item) => ({ ...item }))
}

export function onBackgroundFailuresChanged(
  listener: (items: BackgroundFailureDto[]) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function clearBackgroundFailures(): void {
  if (failures.length === 0) return
  failures.length = 0
  notify()
}

/**
 * 记一条后台失败（含"没能建出可见任务"这一类）。
 *
 * 生命周期约定（第三轮验收修正）：
 *  - **只在最终失败时记录**，不再先建一条"运行中占位记录"再更新 —— 那样一次失败
 *    会先建后更、`count` 变成 2（显示 ×2），而且下一次的占位记录无法按原消息命中
 *    已变成 Git 错误的旧记录，重复失败会不断新增条目；
 *  - 聚合键是 `(知识库, 操作, 原因, 最终错误)`：同一个原因+同一个最终错误的重复失败
 *    只累加 `count`；
 *  - **成功不记录**：不会留下只写着"标签已满"的失败条目。
 *
 * @param reason 这条失败的性质（例如"底部面板标签已达上限"或 Git 执行失败）
 */
export function recordBackgroundFailureWithoutTask(event: {
  knowledgeBaseId: string
  kind: 'git-fetch' | 'git-push'
  reason: string
  message: string
  at?: Date
}): BackgroundFailureDto {
  const at = (event.at ?? new Date()).toISOString()
  const name = (() => {
    try {
      return workspaceManager.getLocation(event.knowledgeBaseId).name
    } catch {
      return event.knowledgeBaseId
    }
  })()
  const existing = failures.find(
    (item) =>
      item.knowledgeBaseId === event.knowledgeBaseId &&
      item.kind === event.kind &&
      item.reason === event.reason &&
      item.message === event.message
  )
  if (existing) {
    existing.count += 1
    existing.at = at
    notify()
    return { ...existing }
  }
  const record: BackgroundFailureDto = {
    id: randomUUID(),
    knowledgeBaseId: event.knowledgeBaseId,
    knowledgeBaseName: name,
    kind: event.kind,
    message: event.message,
    reason: event.reason,
    at,
    count: 1
  }
  failures.unshift(record)
  if (failures.length > BACKGROUND_FAILURE_LIMIT) failures.length = BACKGROUND_FAILURE_LIMIT
  notify()
  return { ...record }
}

/** 测试用：清空记录与订阅。 */
export function resetBackgroundFailureLog(): void {
  failures.length = 0
  listeners.clear()
}
