import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
  return {
    handlers,
    showContextMenu: vi.fn(async () => null)
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
      mocks.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => mocks.handlers.delete(channel)
  },
  dialog: { showMessageBox: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() }
}))
vi.mock('../contextMenus', () => ({ showContextMenu: mocks.showContextMenu }))
vi.mock('../sidebarMenus', () => ({
  showKnowledgeSidebarMenu: vi.fn(async () => null),
  showNavigatorSidebarMenu: vi.fn(async () => null)
}))
vi.mock('../log', () => ({ deskLog: vi.fn() }))

import { IPC_CHANNELS } from '../../shared/contracts'
import { registerWorkspace } from './workspace'

const window = { webContents: { id: 1 }, isDestroyed: () => false }
const getWindow = () => window as never
const event = { sender: { id: 1 } }

async function invoke(channel: string, input: unknown) {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`未注册的通道：${channel}`)
  return (await handler(event, input)) as { ok: boolean; value?: unknown; error?: { code: string } }
}

beforeEach(() => {
  mocks.handlers.clear()
  vi.clearAllMocks()
  registerWorkspace(getWindow)
})

describe('工作区 IPC 合同', () => {
  it('笔记菜单请求能进入主进程（历史版本入口依赖它）', async () => {
    const result = await invoke(IPC_CHANNELS.contextMenuShow, {
      kind: 'note',
      pinned: false,
      tocPinned: false,
      completed: true
    })
    expect(result.ok).toBe(true)
    expect(mocks.showContextMenu).toHaveBeenCalledWith(window, {
      kind: 'note',
      pinned: false,
      tocPinned: false,
      completed: true
    })
  })

  it('所有标签页类型都能弹出标签菜单（含画布、导图与历史）', async () => {
    for (const tabType of [
      'note',
      'web',
      'kb-settings',
      'kb-assets',
      'excalidraw',
      'mindmap',
      'note-history',
      'text-file'
    ] as const) {
      const result = await invoke(IPC_CHANNELS.contextMenuShow, {
        kind: 'tab',
        tabType,
        pinned: false
      })
      expect(result.ok, `${tabType} 应通过校验`).toBe(true)
    }
    expect(mocks.showContextMenu).toHaveBeenCalledTimes(8)
  })

  it('未知标签页类型被拒绝', async () => {
    const result = await invoke(IPC_CHANNELS.contextMenuShow, {
      kind: 'tab',
      tabType: 'unknown-tab',
      pinned: false
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_REQUEST')
    expect(mocks.showContextMenu).not.toHaveBeenCalled()
  })
})
