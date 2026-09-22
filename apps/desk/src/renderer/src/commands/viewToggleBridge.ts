/**
 * 「可视化 / 源码」整体开关的执行者桥。
 *
 * 快捷键在**主进程**被 `TabShortcutResolver` 截获（`⌘K V`），再以命令发回渲染端；
 * 而切换动作必须走活动标签页自己的 `toggleMode()` —— 那里有草稿保护、flush 顺序
 * 与视图切换判定的完整逻辑，绕过去会丢未保存内容。
 *
 * 与 `headingFoldBridge` 同一套做法：活动标签页挂载时登记，卸载时注销。
 */
type ViewToggleRunner = () => void

let runner: ViewToggleRunner | null = null

/**
 * 登记执行者；返回**只注销自己**的函数。
 *
 * 多分组时每个分组都有"组内活动标签"，只有真正活动的那个编辑器才该持有执行者；
 * 注销时也要确认当前登记的仍是自己，避免把刚接手的新活动编辑器注销掉。
 */
export function registerViewToggleRunner(next: ViewToggleRunner | null): () => void {
  runner = next
  return () => {
    if (runner === next) runner = null
  }
}

export function runViewToggle(): boolean {
  if (!runner) return false
  runner()
  return true
}

export function canRunViewToggle(): boolean {
  return runner != null
}
