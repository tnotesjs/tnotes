/**
 * 「固定为 Agent 上下文」动作的执行者桥。
 *
 * 快捷键在主进程被 `TabShortcutResolver` 截获（`⌘K P`），命令面板也会触发同一个动作；
 * 但真正的采集必须走**活动标签页**（它才有当前编辑器句柄、笔记身份与草稿状态），
 * 所以这里只做登记与转发 —— 与 headingFoldBridge / viewToggleBridge 同一套做法。
 */
type PinSelectionRunner = () => void

let runner: PinSelectionRunner | null = null

/**
 * 登记执行者；返回**只注销自己**的函数。
 *
 * 多分组时每个分组都有"组内活动标签"，只有真正活动的那个编辑器才该持有执行者；
 * 注销时也要确认当前登记的仍是自己，避免把刚接手的新活动编辑器注销掉。
 */
export function registerPinSelectionRunner(next: PinSelectionRunner | null): () => void {
  runner = next
  return () => {
    if (runner === next) runner = null
  }
}

export function runPinSelection(): boolean {
  if (!runner) return false
  runner()
  return true
}

export function canRunPinSelection(): boolean {
  return runner != null
}
