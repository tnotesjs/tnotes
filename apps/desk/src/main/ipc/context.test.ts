import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `get_current_note` 的 IPC 边界：渲染端上报的活动笔记要真的进到服务里，
 * 关掉 / 切走之后不许再返回旧路径。
 */
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
  return { handlers }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
      mocks.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => mocks.handlers.delete(channel)
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../log', () => ({ deskLog: vi.fn() }))

import { IPC_CHANNELS } from '../../shared/contracts'
import { ActiveNoteService } from '../context/activeNoteService'
import { registerContext } from './context'

import type { ActiveNoteReportRequest } from '../../shared/contracts'

const window = { webContents: { id: 1 } }
const getWindow = () => window as never
const event = { sender: { id: 1 } }

async function invoke(
  channel: string,
  input: unknown
): Promise<{ ok: boolean; value?: unknown; error?: { code: string } }> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`未注册的通道：${channel}`)
  return (await handler(event, input)) as never
}

const report = (generation: number): ActiveNoteReportRequest => ({
  generation,
  knowledgeBase: { id: 'kb-a', name: 'docs', rootPath: '/tmp/docs' },
  note: {
    id: 'note-a',
    title: '笔记 A',
    absolutePath: '/tmp/docs/notes/0001. A.md',
    relPath: 'notes/0001. A.md'
  },
  editor: { viewMode: 'source', hasUnsavedChanges: true }
})

let service: ActiveNoteService

beforeEach(() => {
  mocks.handlers.clear()
  service = new ActiveNoteService({ now: () => new Date(0) })
  registerContext(getWindow, service)
})

describe('当前活动笔记 IPC', () => {
  it('上报 → 读取；清除 → no_focused_note', async () => {
    const accepted = await invoke(IPC_CHANNELS.contextActiveNoteReport, report(1))
    expect(accepted.ok).toBe(true)
    expect(service.read()).toMatchObject({
      status: 'ok',
      note: { absolutePath: '/tmp/docs/notes/0001. A.md' },
      editor: { viewMode: 'source', hasUnsavedChanges: true }
    })

    const cleared = await invoke(IPC_CHANNELS.contextActiveNoteClear, {
      reason: '当前标签不是笔记',
      generation: 2
    })
    expect(cleared.ok).toBe(true)
    expect(service.read().status).toBe('no_focused_note')
    expect(service.read().note).toBeUndefined()
  })

  it('参数不合法（缺代次 / 视图形状不对）被拒，且不留旧路径', async () => {
    await invoke(IPC_CHANNELS.contextActiveNoteReport, report(1))
    const legacy = await invoke(IPC_CHANNELS.contextActiveNoteReport, {
      knowledgeBase: { id: 'kb-a', name: 'docs', rootPath: '/tmp/docs' },
      note: report(1).note,
      editor: { viewMode: 'visual', hasUnsavedChanges: false }
    })
    expect(legacy.ok).toBe(false)
    expect(legacy.error?.code).toBe('INVALID_REQUEST')

    // 负载不合法 = 上报没进来：宁可没有当前笔记，也不留旧路径
    expect(service.read().status).toBe('no_focused_note')
  })

  it('关闭活动笔记后，旧代次的迟到上报被拒', async () => {
    await invoke(IPC_CHANNELS.contextActiveNoteReport, report(1))
    await invoke(IPC_CHANNELS.contextActiveNoteClear, { reason: '关闭了笔记标签', generation: 2 })
    const late = await invoke(IPC_CHANNELS.contextActiveNoteReport, report(2))
    expect(late.ok).toBe(true)
    expect(late.value).toMatchObject({ accepted: false, reason: 'generation-ended' })
    expect(service.read().status).toBe('no_focused_note')
  })
})
