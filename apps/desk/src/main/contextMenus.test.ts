import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions, PopupOptions } from 'electron'

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  popup: vi.fn(),
  settings: vi.fn(() => ({ ide: 'vscode' }))
}))
vi.mock('electron', () => ({ Menu: { buildFromTemplate: mocks.build } }))
vi.mock('./settings', () => ({ loadSettings: mocks.settings }))
import { contextMenuTemplate, showContextMenu } from './contextMenus'

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('native context menus', () => {
  it.each([
    ['darwin', '在 Finder 中显示'],
    ['win32', '在文件资源管理器中显示'],
    ['linux', '打开所在文件夹']
  ] as const)('builds the note menu for %s', (platform, reveal) => {
    const template = contextMenuTemplate(
      { kind: 'note', pinned: false, completed: false },
      vi.fn(),
      platform
    )
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      '复制路径',
      reveal,
      '固定',
      'separator',
      '在右侧打开',
      '显示本笔记资源',
      '历史版本',
      '重命名',
      '标记为完成',
      '在 VSCode 中打开',
      'separator',
      '在上方添加',
      '在下方添加',
      'separator',
      '永久删除'
    ])
  })

  it('笔记菜单提供历史版本入口', () => {
    const template = contextMenuTemplate({ kind: 'note', pinned: false, completed: false }, vi.fn())
    expect(template.find((item) => item.id === 'show-history')?.label).toBe('历史版本')
  })

  it('uses the configured IDE and current pin state', () => {
    mocks.settings.mockReturnValueOnce({ ide: 'cursor' })
    const template = contextMenuTemplate({ kind: 'note', pinned: true, completed: true }, vi.fn())
    expect(template.find((item) => item.id === 'toggle-pin')?.label).toBe('解除固定')
    expect(template.find((item) => item.id === 'open-ide')?.label).toBe('在 Cursor 中打开')
    expect(template.find((item) => item.id === 'toggle-done')?.label).toBe('标记为未完成')
    expect(template.filter((item) => item.id === 'open-ide')).toHaveLength(1)
  })

  it('gives code-group tabs rename and delete', () => {
    const template = contextMenuTemplate({ kind: 'code-group-tab' }, vi.fn())
    expect(template.map((item) => item.id)).toEqual(['rename', 'request-delete'])
    expect(template.map((item) => item.label)).toEqual(['重命名', '删除代码块'])
  })

  it('gives groups the former more-menu actions without note-only commands', () => {
    const selected = vi.fn()
    const template = contextMenuTemplate({ kind: 'group' }, selected)
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      '重命名',
      'separator',
      '在上方添加',
      '在下方添加',
      'separator',
      '永久删除'
    ])
    const ids = template.map((item) => item.id).filter(Boolean)
    expect(ids).toEqual(['rename', 'add-before', 'add-after', 'request-delete'])
    expect(selected).not.toHaveBeenCalled()
  })

  it.each(['note', 'web'] as const)(
    'preserves applicable actions and shortcut hints for %s tabs',
    (tabType) => {
      const template = contextMenuTemplate(
        { kind: 'tab', tabType, pinned: false },
        vi.fn(),
        'darwin'
      )
      const ids = template.map((item) => item.id).filter(Boolean)
      expect(ids).toEqual([
        'close',
        'close-saved',
        'close-all',
        'close-web',
        ...(tabType === 'note'
          ? ['copy-path', 'reveal-file', 'reveal-toc', 'show-note-assets']
          : []),
        'toggle-pin'
      ])
      expect(template[0]).toMatchObject({
        enabled: true,
        accelerator: 'CommandOrControl+W',
        registerAccelerator: false
      })
      expect(template.find((item) => item.id === 'close-all')?.label).toContain('⌘ K W')
      expect(
        template
          .filter((item) => item.accelerator)
          .every((item) => item.registerAccelerator === false)
      ).toBe(true)
    }
  )

  it('disables normal close for a pinned tab but allows unpinning', () => {
    const template = contextMenuTemplate({ kind: 'tab', tabType: 'note', pinned: true }, vi.fn())
    expect(template[0].enabled).toBe(false)
    expect(template.at(-1)?.label).toContain('解除固定')
  })

  it('returns only the chosen action after popping up a real native menu', async () => {
    mocks.build.mockImplementation((template: MenuItemConstructorOptions[]) => {
      mocks.popup.mockImplementation((options: PopupOptions) => {
        options.callback?.()
        template
          .find((item) => item.id === 'toggle-pin')
          ?.click?.(
            {} as Electron.MenuItem,
            {} as Electron.BrowserWindow,
            {} as Electron.KeyboardEvent
          )
      })
      return { popup: mocks.popup }
    })
    const window = {} as Electron.BrowserWindow
    expect(await showContextMenu(window, { kind: 'note', pinned: false, completed: false })).toBe(
      'toggle-pin'
    )
    expect(mocks.popup).toHaveBeenCalledWith(expect.objectContaining({ window }))
  })

  it('resolves to null when the user dismisses the menu without choosing an item', async () => {
    mocks.build.mockReturnValue({ popup: (options: PopupOptions) => options.callback?.() })
    expect(
      await showContextMenu({} as Electron.BrowserWindow, {
        kind: 'note',
        pinned: false,
        completed: false
      })
    ).toBeNull()
  })
})
