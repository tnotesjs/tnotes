// @vitest-environment happy-dom
//
// 选区上报（渲染端）的**切换代次**与业务结果处理。
//
// 这一组盯住两个坑：
// 1. `accepted:false` 是业务结果，不能当成功（否则同一选区被拒后再也发不出去）；
// 2. 归属者只决定"谁能清空 / 失效"，代次才决定"主进程收不收"——两者混用会在
//    多分组切换时互相拒收，旧笔记的选区会一直以 ok 返回。
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SELECTION_LIMITS, SELECTION_TRANSPORT_LIMITS } from '../../../shared/contracts'
import {
  clearSelection,
  invalidateSelection,
  reportSelection,
  type EditorSelectionPayload,
  type SelectionReportIdentity
} from './selectionReporter'

import type { SelectionClearRequest, SelectionReportRequest } from '../../../shared/contracts'

const reportCalls: SelectionReportRequest[] = []
const clearCalls: SelectionClearRequest[] = []
/** 可切换的"主进程"行为 */
const remote = { accepted: true, ok: true, manual: false }
/** `remote.manual = true` 时上报的响应挂起，由用例按顺序 resolve（验迟到响应） */
const deferred: Array<(result: unknown) => void> = []

type ReportResult =
  | { ok: true; value: { accepted: boolean; status: 'ok' | 'context_too_large'; reason?: string } }
  | { ok: false; error: { code: string; message: string } }

function reportResult(): ReportResult {
  if (!remote.ok) {
    return { ok: false as const, error: { code: 'INTERNAL_ERROR', message: 'boom' } }
  }
  return {
    ok: true as const,
    value: {
      accepted: remote.accepted,
      status: remote.accepted ? ('ok' as const) : ('context_too_large' as const),
      reason: remote.accepted ? undefined : '选中内容过长'
    }
  }
}

function installBridge(): void {
  reportCalls.length = 0
  clearCalls.length = 0
  deferred.length = 0
  remote.accepted = true
  remote.ok = true
  remote.manual = false
  window.desk = {
    selection: {
      report: vi.fn((request: SelectionReportRequest) => {
        reportCalls.push(request)
        if (remote.manual) {
          return new Promise<ReportResult>((resolve) => {
            deferred.push((result) => resolve(result as ReportResult))
          })
        }
        return Promise.resolve(reportResult())
      }),
      clear: vi.fn(async (request: SelectionClearRequest) => {
        clearCalls.push(request)
        return { ok: true as const, value: { cleared: true } }
      })
    }
  } as unknown as typeof window.desk
}

const settle = async (): Promise<void> => {
  // 上报有 80ms 节流
  await new Promise((resolve) => setTimeout(resolve, 130))
}

/** 让已 resolve 的 promise 回调（微任务）跑完 */
const drain = async (): Promise<void> => {
  for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()
}

const identity = (noteId = 'note-a'): SelectionReportIdentity => ({
  knowledgeBase: { id: 'kb', name: 'docs', rootPath: '/tmp/kb' },
  note: { id: noteId, title: `笔记 ${noteId}`, absolutePath: `/tmp/kb/notes/${noteId}.md` },
  editor: {
    viewMode: 'visual',
    contentSource: 'disk',
    hasUnsavedChanges: false,
    revision: 'rev-1',
    collector: 'visual'
  }
})

const payload = (text: string): EditorSelectionPayload => ({
  empty: false,
  selectedText: text,
  blocks: [{ kind: 'paragraph', markdown: text, source: 'reserialized' }]
})

beforeEach(installBridge)

describe('选区上报（渲染端）', () => {
  it('同一编辑器代次不变，换归属者才推进代次', async () => {
    reportSelection('owner-a', identity(), payload('A 的第一段'))
    await settle()
    reportSelection('owner-a', identity(), payload('A 的第二段'))
    await settle()
    reportSelection('owner-b', identity('note-b'), payload('B 的正文'))
    await settle()

    expect(reportCalls).toHaveLength(3)
    expect(reportCalls[1]!.generation).toBe(reportCalls[0]!.generation)
    expect(reportCalls[2]!.generation).toBeGreaterThan(reportCalls[1]!.generation)
  })

  it('accepted:false（业务被拒）不记去重签名：同一内容还能再发；接受后才去重', async () => {
    remote.accepted = false
    reportSelection('owner-c', identity(), payload('被拒的那段'))
    await settle()
    expect(reportCalls).toHaveLength(1)

    // 内容没变：被拒之后必须还能重试（否则这个选区永远读不到）
    reportSelection('owner-c', identity(), payload('被拒的那段'))
    await settle()
    expect(reportCalls).toHaveLength(2)

    // 主进程恢复接受：同样的内容落地
    remote.accepted = true
    reportSelection('owner-c', identity(), payload('被拒的那段'))
    await settle()
    expect(reportCalls).toHaveLength(3)

    // 已成功落地的相同内容不再重复发
    reportSelection('owner-c', identity(), payload('被拒的那段'))
    await settle()
    expect(reportCalls).toHaveLength(3)
  })

  it('语义超限被拒后，原样重报同一段内容也能恢复（缓存必须作废）', async () => {
    reportSelection('owner-n', identity(), payload('正常内容'))
    await settle()
    expect(reportCalls).toHaveLength(1)

    // 同一编辑器里选了一大段：主进程清除快照并返回 context_too_large
    remote.accepted = false
    reportSelection(
      'owner-n',
      identity(),
      payload('x'.repeat(SELECTION_LIMITS.maxSelectedChars + 1))
    )
    await settle()
    expect(reportCalls).toHaveLength(2)

    // 用户重新选回**与第一次完全相同**的内容：不能被去重缓存拦下
    remote.accepted = true
    reportSelection('owner-n', identity(), payload('正常内容'))
    await settle()
    expect(reportCalls).toHaveLength(3)
    expect(reportCalls[2]!.capture.selectedText).toBe('正常内容')

    // 恢复之后，同样的内容再报一次才去重
    reportSelection('owner-n', identity(), payload('正常内容'))
    await settle()
    expect(reportCalls).toHaveLength(3)
  })

  it('不带正文的传输超限状态被拒后，原样重报同一段内容也能恢复', async () => {
    reportSelection('owner-o', identity(), payload('正常内容'))
    await settle()
    expect(reportCalls).toHaveLength(1)

    // 大到超过传输上限：只发超限状态（不带正文），主进程同样返回 context_too_large
    remote.accepted = false
    reportSelection(
      'owner-o',
      identity(),
      payload('x'.repeat(SELECTION_TRANSPORT_LIMITS.maxSelectedTextChars + 1))
    )
    await settle()
    expect(reportCalls).toHaveLength(2)
    expect(reportCalls[1]!.capture.overLimit).toContain('选中内容过长')

    remote.accepted = true
    reportSelection('owner-o', identity(), payload('正常内容'))
    await settle()
    expect(reportCalls).toHaveLength(3)
    expect(reportCalls[2]!.capture.selectedText).toBe('正常内容')
  })

  it('旧代次的响应迟到：不写新代次的缓存，也不清新代次的缓存', async () => {
    remote.manual = true
    reportSelection('owner-p1', identity('note-p1'), payload('P1 的正文'))
    await settle()
    expect(reportCalls).toHaveLength(1)
    expect(deferred).toHaveLength(1)

    // 旧响应还没回来就换了上下文：新代次照常上报并落地
    invalidateSelection('owner-p1', '切换到另一篇笔记')
    reportSelection('owner-p2', identity('note-p2'), payload('P2 的正文'))
    await settle()
    expect(reportCalls).toHaveLength(2)
    deferred[1]!(reportResult())
    await drain()

    // 旧代次的响应（接受）迟到：不能顶掉新代次的去重缓存
    deferred[0]!(reportResult())
    await drain()
    reportSelection('owner-p2', identity('note-p2'), payload('P2 的正文'))
    await settle()
    expect(reportCalls).toHaveLength(2)
  })

  it('旧代次的失败响应迟到：也不能清新代次的去重缓存', async () => {
    remote.manual = true
    reportSelection('owner-q1', identity('note-q1'), payload('Q1 的正文'))
    await settle()
    expect(reportCalls).toHaveLength(1)

    invalidateSelection('owner-q1', '切换到另一篇笔记')
    reportSelection('owner-q2', identity('note-q2'), payload('Q2 的正文'))
    await settle()
    expect(reportCalls).toHaveLength(2)
    deferred[1]!(reportResult())
    await drain()

    // 旧代次的响应这次是"被拒 / 失败"：同样不许动新代次的缓存
    deferred[0]!({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'late boom' } })
    await drain()
    reportSelection('owner-q2', identity('note-q2'), payload('Q2 的正文'))
    await settle()
    expect(reportCalls).toHaveLength(2)
  })

  it('IPC 失败（ok=false）同样不记签名，允许重试', async () => {
    remote.ok = false
    reportSelection('owner-d', identity(), payload('失败的那段'))
    await settle()
    expect(reportCalls).toHaveLength(1)

    remote.ok = true
    reportSelection('owner-d', identity(), payload('失败的那段'))
    await settle()
    expect(reportCalls).toHaveLength(2)
  })

  it('刚刚超过语义上限照常发正文（由主进程判定并失效）', async () => {
    reportSelection(
      'owner-e',
      identity(),
      payload('x'.repeat(SELECTION_LIMITS.maxSelectedChars + 1))
    )
    await settle()
    expect(reportCalls).toHaveLength(1)
    expect(reportCalls[0]!.capture.selectedText).toHaveLength(SELECTION_LIMITS.maxSelectedChars + 1)
    expect(reportCalls[0]!.capture.overLimit).toBeUndefined()
  })

  it('超过传输上限的正文不塞进 IPC：只报不带正文的超限状态', async () => {
    reportSelection(
      'owner-f',
      identity(),
      payload('x'.repeat(SELECTION_TRANSPORT_LIMITS.maxSelectedTextChars + 1))
    )
    await settle()
    expect(reportCalls).toHaveLength(1)
    const capture = reportCalls[0]!.capture
    expect(capture.overLimit).toContain('选中内容过长')
    expect(capture.overLimit).toContain('未随上报发送正文')
    expect(capture.selectedText).toBeUndefined()
    expect(capture.blocks).toBeUndefined()
  })

  it('旧归属者的失效被跳过；当前归属者失效后重新上报用更高代次', async () => {
    reportSelection('owner-g', identity('note-g'), payload('G 的正文'))
    await settle()
    reportSelection('owner-h', identity('note-h'), payload('H 的正文'))
    await settle()
    expect(reportCalls).toHaveLength(2)

    // 旧归属者（G）不是当前上下文：不许清掉 H 的快照
    invalidateSelection('owner-g', '切换到其它编辑器')
    await settle()
    expect(clearCalls).toHaveLength(0)

    // 当前归属者（H）失效：带"被结束的那个代次"
    invalidateSelection('owner-h', '切换到另一篇笔记')
    expect(clearCalls).toHaveLength(1)
    expect(clearCalls[0]!.generation).toBe(reportCalls[1]!.generation)

    // 失效后同一编辑器重新采集：代次必须更高，旧上下文的上报才会被主进程丢掉
    reportSelection('owner-h', identity('note-h'), payload('H 的新正文'))
    await settle()
    expect(reportCalls).toHaveLength(3)
    expect(reportCalls[2]!.generation).toBeGreaterThan(clearCalls[0]!.generation)
  })

  it('用户主动取消选区：带上笔记与结束代次', async () => {
    reportSelection('owner-i', identity('note-i'), payload('I 的正文'))
    await settle()
    clearSelection('owner-i', 'note-i')
    expect(clearCalls).toHaveLength(1)
    expect(clearCalls[0]).toMatchObject({
      reason: 'selection-cancelled',
      noteId: 'note-i',
      generation: reportCalls[0]!.generation
    })
  })

  it('没有上报过就不再发清除（光标每次移动不该刷 IPC）', async () => {
    invalidateSelection('owner-j', '切换到另一篇笔记')
    clearSelection('owner-j', 'note-j')
    await settle()
    expect(clearCalls).toHaveLength(0)
  })

  it('preload 桥缺失时静默降级，不抛异常', async () => {
    delete (window as unknown as { desk?: unknown }).desk
    expect(() => reportSelection('owner-k', identity(), payload('没有桥'))).not.toThrow()
    expect(() => invalidateSelection('owner-k', '测试')).not.toThrow()
    await settle()
  })
})
