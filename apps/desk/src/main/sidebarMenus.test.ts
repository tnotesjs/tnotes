import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions, PopupOptions } from 'electron'

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  popup: vi.fn()
}))
vi.mock('electron', () => ({ Menu: { buildFromTemplate: mocks.build } }))

import {
  knowledgeSidebarMenuTemplate,
  navigatorSidebarMenuTemplate,
  showKnowledgeSidebarMenu,
  showNavigatorSidebarMenu
} from './sidebarMenus'

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('sidebar native menus', () => {
  it.each([
    ['darwin', '在访达中打开'],
    ['win32', '在资源管理器中打开'],
    ['linux', '打开工作区目录']
  ] as const)('builds the knowledge sidebar menu for %s', (platform, reveal) => {
    const template = knowledgeSidebarMenuTemplate(
      { hasWorkspace: true, loading: false },
      vi.fn(),
      platform
    )
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      '新建知识库',
      '重新扫描知识库',
      'separator',
      reveal,
      '更换工作区'
    ])
  })

  it('disables create/refresh while loading and reveal without workspace', () => {
    const template = knowledgeSidebarMenuTemplate({ hasWorkspace: false, loading: true }, vi.fn())
    expect(template.find((item) => item.id === 'create')?.enabled).toBe(false)
    expect(template.find((item) => item.id === 'refresh')?.enabled).toBe(false)
    expect(template.find((item) => item.id === 'reveal-workspace')?.enabled).toBe(false)
    expect(template.find((item) => item.id === 'choose-workspace')?.enabled).not.toBe(false)
  })

  it('builds the navigator sidebar menu with preview/build state', () => {
    const template = navigatorSidebarMenuTemplate(
      { ready: true, previewLabel: '停止站点预览', buildBusy: true, noteCount: 12 },
      vi.fn()
    )
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      '新建笔记',
      '新建多篇笔记',
      '新建分组',
      '批量删除',
      '停止站点预览',
      '正在构建站点',
      'separator',
      '资源',
      '知识库配置',
      '使用 IDE 打开',
      '打开知识库目录'
    ])
    expect(template.find((item) => item.id === 'build')?.enabled).toBe(false)
  })

  it('disables batch create when the knowledge base already has 9999 notes', () => {
    const template = navigatorSidebarMenuTemplate(
      { ready: true, previewLabel: '启动站点预览', buildBusy: false, noteCount: 9999 },
      vi.fn()
    )
    expect(template.find((item) => item.id === 'create-notes')?.enabled).toBe(false)
    expect(template.find((item) => item.id === 'create-note')?.enabled).toBe(true)
    expect(template.find((item) => item.id === 'batch-delete')?.enabled).toBe(true)
  })

  it('disables batch delete when the knowledge base has no notes', () => {
    const template = navigatorSidebarMenuTemplate(
      { ready: true, previewLabel: '启动站点预览', buildBusy: false, noteCount: 0 },
      vi.fn()
    )
    expect(template.find((item) => item.id === 'batch-delete')?.enabled).toBe(false)
  })

  it('disables navigator actions when knowledge base is not ready', () => {
    const template = navigatorSidebarMenuTemplate(
      { ready: false, previewLabel: '启动站点预览', buildBusy: false, noteCount: 12 },
      vi.fn()
    )
    for (const id of [
      'create-note',
      'create-notes',
      'create-group',
      'batch-delete',
      'preview',
      'build',
      'settings',
      'assets',
      'ide',
      'reveal'
    ]) {
      expect(template.find((item) => item.id === id)?.enabled).toBe(false)
    }
  })

  it('resolves selected knowledge action and dismisses to null', async () => {
    vi.useFakeTimers()
    let selected: MenuItemConstructorOptions['click']
    mocks.build.mockImplementation((template: MenuItemConstructorOptions[]) => {
      selected = template.find((item) => item.id === 'refresh')?.click
      return { popup: mocks.popup }
    })
    mocks.popup.mockImplementation((options: PopupOptions) => {
      selected?.(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        {} as Electron.KeyboardEvent
      )
      options.callback?.()
    })

    const first = showKnowledgeSidebarMenu({} as never, { hasWorkspace: true, loading: false })
    await expect(first).resolves.toBe('refresh')

    mocks.popup.mockImplementation((options: PopupOptions) => {
      options.callback?.()
    })
    const second = showKnowledgeSidebarMenu({} as never, { hasWorkspace: true, loading: false })
    vi.runAllTimers()
    await expect(second).resolves.toBeNull()
  })

  it('resolves selected navigator action', async () => {
    let selected: MenuItemConstructorOptions['click']
    mocks.build.mockImplementation((template: MenuItemConstructorOptions[]) => {
      selected = template.find((item) => item.id === 'create-note')?.click
      return { popup: mocks.popup }
    })
    mocks.popup.mockImplementation(() => {
      selected?.(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        {} as Electron.KeyboardEvent
      )
    })

    await expect(
      showNavigatorSidebarMenu({} as never, {
        ready: true,
        previewLabel: '启动站点预览',
        buildBusy: false,
        noteCount: 12
      })
    ).resolves.toBe('create-note')
  })
})
