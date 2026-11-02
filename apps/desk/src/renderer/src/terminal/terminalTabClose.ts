/**
 * ⌘W / Ctrl+W 在终端面板获得焦点时关掉终端标签，而不是上面的笔记标签。
 * 调用方按当前视图只传其中一个：输出视图传任务，终端视图传会话。
 */
export function terminalShortcutCloseTarget(input: {
  panelOpen: boolean
  focusInsidePanel: boolean
  activeTaskId: string | null
  activeSessionId: string | null
}): { kind: 'task'; id: string } | { kind: 'session'; id: string } | null {
  if (!input.panelOpen || !input.focusInsidePanel) return null
  if (input.activeTaskId) return { kind: 'task', id: input.activeTaskId }
  if (input.activeSessionId) return { kind: 'session', id: input.activeSessionId }
  return null
}
