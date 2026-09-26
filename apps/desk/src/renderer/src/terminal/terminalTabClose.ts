/**
 * ⌘W / Ctrl+W 在终端面板获得焦点时关掉终端标签，而不是上面的笔记标签。
 * 命令输出标签优先于交互式会话，和面板里原来的按键顺序一致。
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
