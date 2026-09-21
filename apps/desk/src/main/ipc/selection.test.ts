import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 本机 MCP 选区的 IPC 边界。
 *
 * 这一组测试专门盯住"schema 抢在服务前面拒收"这个坑：
 * IPC 的传输上限必须**明显高于**语义上限，否则「刚刚超过语义上限」的上报会被 schema 挡下，
 * `selectionService.update()` 没有机会执行，旧快照会继续以 `ok` 返回（过期内容）。
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
vi.mock('../mcp/manager', () => ({
  mcpManager: {
    status: vi.fn(() => ({ enabled: false, running: false })),
    setEnabled: vi.fn(),
    rotateToken: vi.fn()
  }
}))
vi.mock('../log', () => ({ deskLog: vi.fn() }))

import { IPC_CHANNELS, SELECTION_LIMITS, SELECTION_TRANSPORT_LIMITS } from '../../shared/contracts'
import { SelectionContextService } from '../selection/selectionService'
import { registerSelection } from './selection'

import type { SelectionCaptureDto, SelectionReportRequest } from '../../shared/contracts'

const window = { webContents: { id: 1 } }
const getWindow = () => window as never
const event = { sender: { id: 1 } }

async function invoke(
  channel: string,
  input: unknown
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; details?: unknown } }> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`未注册的通道：${channel}`)
  return (await handler(event, input)) as never
}

function report(generation: number, capture: SelectionCaptureDto): SelectionReportRequest {
  return {
    generation,
    knowledgeBase: { id: 'kb-a', name: 'docs', rootPath: '/tmp/docs' },
    note: { id: 'note-a', title: '笔记 A', absolutePath: '/tmp/docs/notes/0001. A.md' },
    editor: {
      viewMode: 'source',
      contentSource: 'disk',
      hasUnsavedChanges: false,
      revision: 'rev-1'
    },
    capture
  }
}

const normalCapture = (): SelectionCaptureDto => ({
  collector: 'source',
  empty: false,
  selectedText: '选中的正文',
  blocks: [{ kind: 'paragraph', markdown: '选中的正文', source: 'raw' }]
})

let service: SelectionContextService

beforeEach(() => {
  mocks.handlers.clear()
  service = new SelectionContextService({ newId: () => 'snap', now: () => new Date(0) })
  registerSelection(getWindow, service)
})

describe('选区 IPC 边界', () => {
  it('传输上限明显高于语义上限（否则超限上报进不了服务）', () => {
    expect(SELECTION_TRANSPORT_LIMITS.maxSelectedTextChars).toBeGreaterThan(
      SELECTION_LIMITS.maxSelectedChars
    )
    expect(SELECTION_TRANSPORT_LIMITS.maxBlockChars).toBeGreaterThan(SELECTION_LIMITS.maxBlockChars)
    expect(SELECTION_TRANSPORT_LIMITS.maxBlocks).toBeGreaterThan(SELECTION_LIMITS.maxBlocks)
    expect(SELECTION_TRANSPORT_LIMITS.maxTotalChars).toBeGreaterThan(SELECTION_LIMITS.maxBlockChars)
  })

  it('先正常上报，再上报超限负载：都走服务，超限明确失效且没有旧正文，缩小后恢复', async () => {
    const first = await invoke(IPC_CHANNELS.selectionReport, report(1, normalCapture()))
    expect(first.ok).toBe(true)
    expect(first.value).toMatchObject({ accepted: true, status: 'ok' })
    expect(service.read().selection?.selectedText).toBe('选中的正文')

    const overLimitCases: Array<[string, SelectionCaptureDto, string]> = [
      [
        '选字超过语义上限',
        {
          collector: 'source',
          empty: false,
          selectedText: 'x'.repeat(SELECTION_LIMITS.maxSelectedChars + 1)
        },
        '选中内容过长'
      ],
      [
        '单块 Markdown 超过语义上限',
        {
          collector: 'source',
          empty: false,
          selectedText: '短',
          blocks: [
            {
              kind: 'paragraph',
              markdown: 'x'.repeat(SELECTION_LIMITS.maxBlockChars + 1),
              source: 'raw'
            }
          ]
        },
        '相关块内容过长'
      ],
      [
        '相关块数量超过语义上限',
        {
          collector: 'visual',
          empty: false,
          selectedText: '短',
          blocks: Array.from({ length: SELECTION_LIMITS.maxBlocks + 1 }, (_, index) => ({
            kind: 'paragraph',
            markdown: `块 ${index}`,
            source: 'reserialized' as const
          }))
        },
        '涉及块过多'
      ]
    ]

    for (const [name, capture, expectedReason] of overLimitCases) {
      const result = await invoke(IPC_CHANNELS.selectionReport, report(2, capture))
      // 关键：不是 IPC 层的 INVALID_REQUEST，而是服务给出的业务结果
      expect(result.ok, name).toBe(true)
      expect(result.value, name).toMatchObject({ accepted: false, status: 'context_too_large' })
      expect(String((result.value as { reason?: string }).reason), name).toContain(expectedReason)

      const snapshot = service.read()
      expect(snapshot.status, name).toBe('context_too_large')
      expect(snapshot.selection, name).toBeUndefined()
      expect(snapshot.snapshotId, name).toBeNull()
      expect(snapshot.message, name).toContain('上限')

      // 缩小选区（同一代次重新上报）→ 恢复 ok
      const recovered = await invoke(IPC_CHANNELS.selectionReport, report(2, normalCapture()))
      expect(recovered.value, name).toMatchObject({ accepted: true, status: 'ok' })
      expect(service.read().selection?.selectedText, name).toBe('选中的正文')
    }
  })

  it('负载大到超过传输上限：schema 挡下也必须让旧快照失效', async () => {
    await invoke(IPC_CHANNELS.selectionReport, report(1, normalCapture()))
    expect(service.read().status).toBe('ok')

    const tooBig = await invoke(
      IPC_CHANNELS.selectionReport,
      report(2, {
        collector: 'source',
        empty: false,
        selectedText: 'x'.repeat(SELECTION_TRANSPORT_LIMITS.maxSelectedTextChars + 1)
      })
    )
    expect(tooBig.ok).toBe(false)
    expect(tooBig.error?.code).toBe('INVALID_REQUEST')

    // 被 schema 挡下的上报也不能留下过期内容
    const snapshot = service.read()
    expect(snapshot.status).toBe('selection_invalidated')
    expect(snapshot.selection).toBeUndefined()
  })

  it('"不带正文的超限状态"是允许的上报形态', async () => {
    await invoke(IPC_CHANNELS.selectionReport, report(1, normalCapture()))
    const result = await invoke(
      IPC_CHANNELS.selectionReport,
      report(2, {
        collector: 'visual',
        empty: false,
        overLimit: '相关块内容过长：70000 字符，上限 60000 字符（超过传输上限，未随上报发送正文）',
        selectedChars: 3
      })
    )
    expect(result.value).toMatchObject({ accepted: false, status: 'context_too_large' })
    expect(service.read().selection).toBeUndefined()
  })

  it('缺少代次的上报被拒（防止旧契约的客户端绕过代次判定）', async () => {
    const legacy = await invoke(IPC_CHANNELS.selectionReport, {
      knowledgeBase: { id: 'kb-a', name: 'docs', rootPath: '/tmp/docs' },
      note: { id: 'note-a', title: '笔记 A', absolutePath: '/tmp/docs/notes/0001. A.md' },
      editor: {
        viewMode: 'source',
        contentSource: 'disk',
        hasUnsavedChanges: false,
        revision: 'rev-1'
      },
      capture: normalCapture()
    })
    expect(legacy.ok).toBe(false)
    expect(legacy.error?.code).toBe('INVALID_REQUEST')
  })

  it('清除与失效都带代次：旧代次不会清掉新快照', async () => {
    await invoke(IPC_CHANNELS.selectionReport, report(1, normalCapture()))
    await invoke(IPC_CHANNELS.selectionReport, report(2, normalCapture()))

    const staleClear = await invoke(IPC_CHANNELS.selectionClear, {
      reason: '切换到其它编辑器',
      noteId: 'note-a',
      generation: 1
    })
    expect(staleClear.ok).toBe(true)
    expect(service.read().status).toBe('ok')

    const current = await invoke(IPC_CHANNELS.selectionClear, {
      reason: 'selection-cancelled',
      noteId: 'note-a',
      generation: 2
    })
    expect(current.ok).toBe(true)
    expect(service.read().status).toBe('no_selection')
  })
})
