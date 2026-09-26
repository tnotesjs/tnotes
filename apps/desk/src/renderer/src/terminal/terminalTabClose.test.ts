import { describe, expect, it } from 'vitest'

import { terminalShortcutCloseTarget } from './terminalTabClose'

describe('终端标签的 ⌘W', () => {
  it('焦点在面板里时关掉当前会话，只剩一个也关', () => {
    expect(
      terminalShortcutCloseTarget({
        panelOpen: true,
        focusInsidePanel: true,
        activeTaskId: null,
        activeSessionId: 'only'
      })
    ).toEqual({ kind: 'session', id: 'only' })
  })

  it('命令输出标签优先于交互式会话', () => {
    expect(
      terminalShortcutCloseTarget({
        panelOpen: true,
        focusInsidePanel: true,
        activeTaskId: 'task-1',
        activeSessionId: 'shell-1'
      })
    ).toEqual({ kind: 'task', id: 'task-1' })
  })

  it('焦点在笔记上、或面板收起时，不抢笔记标签的关闭', () => {
    const base = {
      panelOpen: true,
      focusInsidePanel: false,
      activeTaskId: null,
      activeSessionId: 'shell-1'
    }
    expect(terminalShortcutCloseTarget(base)).toBeNull()
    expect(terminalShortcutCloseTarget({ ...base, panelOpen: false, focusInsidePanel: true })).toBeNull()
    expect(
      terminalShortcutCloseTarget({
        panelOpen: true,
        focusInsidePanel: true,
        activeTaskId: null,
        activeSessionId: null
      })
    ).toBeNull()
  })
})
