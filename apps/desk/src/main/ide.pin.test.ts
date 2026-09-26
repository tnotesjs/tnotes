import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

const mocks = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
  build: vi.fn((template: MenuItemConstructorOptions[]) => {
    mocks.template = template
    return { popup: vi.fn() }
  })
}))

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: mocks.build },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn() }
}))
vi.mock('./log', () => ({ deskLog: vi.fn() }))
vi.mock('./settings', () => ({ loadSettings: () => ({ ide: 'vscode' }) }))

import { showIdeContextMenu } from './ide'

describe('知识库右键置顶', () => {
  it('菜单顶部是置顶，已置顶时改为取消置顶', () => {
    const toggle = vi.fn()
    showIdeContextMenu({} as Electron.BrowserWindow, '/tmp/kb', undefined, {
      onTogglePin: toggle,
      pinned: false,
      onOpenSettings: vi.fn()
    })
    expect(mocks.template[0]?.label).toBe('置顶')
    expect(mocks.template[1]?.type).toBe('separator')
    expect(mocks.template.map((item) => item.label).filter(Boolean)).toContain('知识库配置')

    showIdeContextMenu({} as Electron.BrowserWindow, '/tmp/kb', undefined, {
      onTogglePin: toggle,
      pinned: true
    })
    expect(mocks.template[0]?.label).toBe('取消置顶')
    const click = mocks.template[0]?.click
    click?.(
      {} as Electron.MenuItem,
      {} as Electron.BrowserWindow,
      {} as Electron.KeyboardEvent
    )
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('没有置顶回调时不插入这一项', () => {
    showIdeContextMenu({} as Electron.BrowserWindow, '/tmp/kb')
    expect(mocks.template.map((item) => item.label)).not.toContain('置顶')
    expect(mocks.template[0]?.label).toBe('在终端中打开')
  })
})
