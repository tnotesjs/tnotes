import { describe, expect, it, vi } from 'vitest'

import { SELECTION_LIMITS } from '../../shared/contracts'
import { PinnedContextService } from './pinnedContextService'

import type { PinSelectionRequest } from '../../shared/contracts'

function pinRequest(overrides: Partial<PinSelectionRequest> = {}): PinSelectionRequest {
  return {
    owner: {
      groupId: 'group-a',
      tabId: 'tab-a',
      knowledgeBaseId: 'kb-a',
      noteUuid: 'note-a'
    },
    knowledgeBase: { id: 'kb-a', name: 'docs', rootPath: '/tmp/docs' },
    note: { id: 'note-a', title: '笔记 A', absolutePath: '/tmp/docs/notes/0001. A.md' },
    editor: {
      viewMode: 'source',
      contentSource: 'disk',
      hasUnsavedChanges: false,
      revision: 'rev-1'
    },
    capture: {
      collector: 'source',
      empty: false,
      selectedText: '固定的正文',
      sourceRange: {
        startLine: 3,
        startColumn: 1,
        endLine: 3,
        endColumn: 6,
        startOffset: 10,
        endOffset: 15,
        lineBase: 1,
        columnBase: 1,
        endExclusive: true,
        source: 'disk'
      },
      blocks: [{ kind: 'paragraph', markdown: '固定的正文', source: 'raw' }]
    },
    anchor: {
      view: 'source',
      kind: 'source-range',
      // 位置锚：偏移 10–15 上应当是「固定的正文」
      textRange: { startOffset: 10, endOffset: 15, expected: '固定的正文' },
      sourceRange: {
        startLine: 3,
        startColumn: 1,
        endLine: 3,
        endColumn: 6,
        startOffset: 10,
        endOffset: 15,
        lineBase: 1,
        columnBase: 1,
        endExclusive: true,
        source: 'disk'
      }
    },
    ...overrides
  }
}

function service(exists = true): PinnedContextService {
  let counter = 0
  return new PinnedContextService({
    now: () => new Date('2026-09-22T01:00:00.000Z'),
    newId: () => `pin-${++counter}`,
    exists: () => exists
  })
}

describe('固定选区上下文服务（主进程）', () => {
  it('没有固定时状态是 none', () => {
    const context = service().read()
    expect(context.state).toBe('none')
    expect(context.pinId).toBeNull()
    expect(context.selection).toBeUndefined()
  })

  it('固定后给不可变快照 + 归属 + 锚点（并标明固定时间）', () => {
    const store = service()
    expect(store.pin(pinRequest()).accepted).toBe(true)
    const context = store.read()
    expect(context.state).toBe('pinned')
    expect(context.pinId).toBe('pin-1')
    expect(context.pinnedAt).toBe('2026-09-22T01:00:00.000Z')
    expect(context.owner).toMatchObject({ groupId: 'group-a', tabId: 'tab-a' })
    expect(context.note?.absolutePath).toBe('/tmp/docs/notes/0001. A.md')
    expect(context.selection?.selectedText).toBe('固定的正文')
    expect(context.selection?.mapping).toBe('source-range')
    expect(context.anchor?.kind).toBe('source-range')
    expect(context.limits).toEqual({ ...SELECTION_LIMITS })
  })

  it('再次固定即替换（全局只留一份）', () => {
    const store = service()
    store.pin(pinRequest())
    const second = pinRequest({
      owner: { groupId: 'group-b', tabId: 'tab-b', knowledgeBaseId: 'kb-a', noteUuid: 'note-b' },
      note: { id: 'note-b', title: '笔记 B', absolutePath: '/tmp/docs/notes/0002. B.md' },
      capture: {
        collector: 'visual',
        empty: false,
        selectedText: 'B 的选区',
        blocks: [{ kind: 'paragraph', markdown: 'B 的选区', source: 'reserialized' }]
      },
      anchor: {
        view: 'visual',
        kind: 'block',
        textRange: { startOffset: 0, endOffset: 6, expected: 'B 的选区' },
        blocks: [{ pos: 3, kind: 'paragraph', markdown: 'B 的选区' }],
        from: 4,
        to: 9
      }
    })
    expect(store.pin(second).accepted).toBe(true)
    const context = store.read()
    expect(context.pinId).toBe('pin-2')
    expect(context.owner?.tabId).toBe('tab-b')
    expect(context.selection?.selectedText).toBe('B 的选区')
    expect(context.selection?.mapping).toBe('block')
  })

  it('超限 / 没有锚点 / 没有正文的固定被拒，且保留原有固定', () => {
    const store = service()
    store.pin(pinRequest())

    const tooLarge = store.pin(
      pinRequest({
        capture: {
          collector: 'source',
          empty: false,
          selectedText: 'x'.repeat(SELECTION_LIMITS.maxSelectedChars + 1)
        }
      })
    )
    expect(tooLarge.accepted).toBe(false)
    expect(tooLarge.reason).toContain('无法固定')

    const blockTooLarge = store.pin(
      pinRequest({
        capture: {
          collector: 'visual',
          empty: false,
          selectedText: '短',
          blocks: [
            {
              kind: 'paragraph',
              markdown: 'x'.repeat(SELECTION_LIMITS.maxBlockChars + 1),
              source: 'reserialized'
            }
          ]
        }
      })
    )
    expect(blockTooLarge.accepted).toBe(false)

    const noAnchor = store.pin(
      pinRequest({ anchor: { view: 'visual', kind: 'block', blocks: [] } })
    )
    expect(noAnchor.accepted).toBe(false)
    expect(noAnchor.reason).toContain('位置信息')

    // 没有位置锚（只能靠全文搜索）→ 明确拒绝固定
    const noPosition = store.pin(
      pinRequest({
        anchor: {
          view: 'visual',
          kind: 'block',
          blocks: [{ pos: 3, kind: 'paragraph', markdown: '固定的正文' }],
          from: 4,
          to: 9
        }
      })
    )
    expect(noPosition.accepted).toBe(false)
    expect(noPosition.reason).toContain('位置信息')

    const emptyCapture = store.pin(pinRequest({ capture: { collector: 'source', empty: false } }))
    expect(emptyCapture.accepted).toBe(false)

    // 失败不弄丢已有固定
    expect(store.read().state).toBe('pinned')
    expect(store.read().pinId).toBe('pin-1')
    expect(store.read().selection?.selectedText).toBe('固定的正文')
  })

  it('校验失效：丢正文、给原因（不返回旧内容）', () => {
    const store = service()
    store.pin(pinRequest())
    expect(store.validate({ pinId: 'pin-1', valid: true })).toBe(true)

    expect(store.validate({ pinId: 'pin-1', valid: false, reason: '内容已变化' })).toBe(true)
    const context = store.read()
    expect(context.state).toBe('invalidated')
    expect(context.reason).toBe('内容已变化')
    expect(context.selection).toBeUndefined()
    // 身份还在（便于界面说明"哪一个固定失效了"），但没有正文
    expect(context.note?.title).toBe('笔记 A')
    expect(JSON.stringify(context)).not.toContain('固定的正文')
  })

  it('旧 pinId 的校验结果不影响新固定（重新固定后的竞态）', () => {
    const store = service()
    store.pin(pinRequest())
    store.pin(pinRequest({ note: { id: 'note-b', title: 'B', absolutePath: '/tmp/b.md' } }))
    expect(store.validate({ pinId: 'pin-1', valid: false, reason: '过期的校验' })).toBe(false)
    expect(store.read().state).toBe('pinned')
    expect(store.read().pinId).toBe('pin-2')
  })

  it('用户显式解除 → none（显式恢复实时模式）', () => {
    const store = service()
    store.pin(pinRequest())
    expect(store.clear('用户解除了固定上下文')).toBe(true)
    expect(store.read().state).toBe('none')
    expect(store.read().selection).toBeUndefined()
  })

  it('来源笔记被删除：读取时明确失效，绝不返回旧正文', () => {
    const store = service()
    store.pin(pinRequest())
    // 注入"文件不存在"的判据
    const removed = service(false)
    removed.pin(pinRequest())
    const context = removed.read()
    expect(context.state).toBe('invalidated')
    expect(context.reason).toContain('来源笔记已删除')
    expect(context.selection).toBeUndefined()
  })

  it('磁盘位置复核：只认位置锚（移位 / 别处有相同文字都要失效）', () => {
    const store = service()
    store.pin(pinRequest())
    // A 的偏移是 10–15
    const same = '0123456789固定的正文甲段二。（外部追加）'
    expect(store.revalidateAgainst(same, 'pin-1')).toBe(true)
    expect(store.read().state).toBe('pinned')

    // 前面插入内容 → 坐标变化 → 失效（不是"全文还能搜到"）
    const shifted = '前面插了一段。0123456789固定的正文甲段二。'
    expect(store.revalidateAgainst(shifted, 'pin-1')).toBe(false)
    expect(store.read().state).toBe('invalidated')
    expect(store.read().selection).toBeUndefined()
    expect(JSON.stringify(store.read())).not.toContain('固定的正文')

    // 原位置被别的文字占掉、别处仍有同样文字 → 仍然失效
    const replaced = '0123456789XXXXX甲段二。后面还有 固定的正文'
    const second = service()
    second.pin(pinRequest())
    expect(second.revalidateAgainst(replaced, 'pin-1')).toBe(false)
    expect(second.read().state).toBe('invalidated')

    // 草稿固定：磁盘复核不参与（不误判）
    const draftStore = service()
    draftStore.pin(
      pinRequest({
        editor: {
          viewMode: 'visual',
          contentSource: 'draft',
          hasUnsavedChanges: true,
          revision: 'rev-2'
        }
      })
    )
    expect(draftStore.revalidateAgainst('完全不一样的磁盘内容', 'pin-1')).toBe(false)
    expect(draftStore.read().state).toBe('pinned')
  })

  it('变化会广播（状态条订阅它）', () => {
    const store = service()
    const listener = vi.fn()
    const off = store.onChanged(listener)
    store.pin(pinRequest())
    store.validate({ pinId: 'pin-1', valid: false, reason: '内容已变化' })
    store.clear('解除')
    off()
    store.pin(pinRequest())
    expect(listener).toHaveBeenCalledTimes(3)
    expect(listener.mock.calls[0]![0]).toMatchObject({ state: 'pinned' })
    expect(listener.mock.calls[1]![0]).toMatchObject({ state: 'invalidated' })
    expect(listener.mock.calls[2]![0]).toMatchObject({ state: 'none' })
  })
})
