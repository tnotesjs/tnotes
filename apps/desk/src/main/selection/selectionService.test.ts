import { describe, expect, it } from 'vitest'

import { SelectionContextService, SELECTION_LIMITS } from './selectionService'

import type { SelectionReportRequest } from '../../shared/contracts'

function report(overrides: Partial<SelectionReportRequest> = {}): SelectionReportRequest {
  return {
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
      selectedText: '选中的正文',
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
      blocks: [{ kind: 'paragraph', markdown: '选中的正文', source: 'raw' }]
    },
    ...overrides
  }
}

function service(): SelectionContextService {
  let counter = 0
  return new SelectionContextService({
    now: () => new Date('2026-09-21T00:00:00.000Z'),
    newId: () => `snap-${++counter}`
  })
}

describe('选区上下文服务（主进程）', () => {
  it('没有选区时返回 no_selection（结构化结果，不是异常）', () => {
    const snapshot = service().read()
    expect(snapshot.status).toBe('no_selection')
    expect(snapshot.snapshotId).toBeNull()
    expect(snapshot.selection).toBeUndefined()
    expect(snapshot.message).toContain('没有选中')
  })

  it('整包替换：笔记身份、版本、选区一次写入，且 revision 不是时间戳', () => {
    const store = service()
    expect(store.update(report()).accepted).toBe(true)
    const snapshot = store.read()
    expect(snapshot.status).toBe('ok')
    expect(snapshot.snapshotId).toBe('snap-1')
    expect(snapshot.capturedAt).toBe('2026-09-21T00:00:00.000Z')
    expect(snapshot.knowledgeBase).toEqual({ id: 'kb-a', name: 'docs', rootPath: '/tmp/docs' })
    expect(snapshot.note?.absolutePath).toBe('/tmp/docs/notes/0001. A.md')
    expect(snapshot.editor).toMatchObject({
      viewMode: 'source',
      collector: 'source',
      contentSource: 'disk',
      hasUnsavedChanges: false,
      revision: 'rev-1'
    })
    expect(snapshot.selection?.selectedText).toBe('选中的正文')
    expect(snapshot.selection?.mapping).toBe('source-range')
    expect(snapshot.selection?.sourceRange).toMatchObject({
      startLine: 3,
      endLine: 3,
      startOffset: 10,
      endOffset: 15,
      endExclusive: true,
      lineBase: 1,
      columnBase: 1,
      source: 'disk'
    })
    expect(snapshot.limits).toEqual({ ...SELECTION_LIMITS })
  })

  it('草稿快照标明 contentSource=draft 且范围也标 draft', () => {
    const store = service()
    store.update(
      report({
        editor: {
          viewMode: 'visual',
          contentSource: 'draft',
          hasUnsavedChanges: true,
          revision: 'rev-2'
        },
        capture: {
          collector: 'visual',
          empty: false,
          selectedText: '草稿里的字',
          blocks: [{ kind: 'paragraph', markdown: '草稿里的字', source: 'reserialized' }]
        }
      })
    )
    const snapshot = store.read()
    expect(snapshot.editor).toMatchObject({
      contentSource: 'draft',
      hasUnsavedChanges: true,
      revision: 'rev-2',
      collector: 'visual'
    })
    // 没有精确范围 → 明确是块级上下文
    expect(snapshot.selection?.mapping).toBe('block')
    expect(snapshot.selection?.sourceRange).toBeUndefined()
    expect(snapshot.selection?.blocks[0]).toMatchObject({
      kind: 'paragraph',
      source: 'reserialized'
    })
  })

  it('空选区 → no_selection（用户主动取消），但保留笔记身份便于诊断', () => {
    const store = service()
    store.update(report())
    store.update(report({ capture: { collector: 'source', empty: true } }))
    const snapshot = store.read()
    expect(snapshot.status).toBe('no_selection')
    expect(snapshot.note?.id).toBe('note-a')
    expect(snapshot.selection).toBeUndefined()
    expect(store.hasSnapshot()).toBe(true)
  })

  it('多选区 / 无法映射 → unsupported_selection，并给出原因', () => {
    const store = service()
    store.update(
      report({
        capture: {
          collector: 'visual',
          empty: false,
          unsupportedReason: '首版不支持多个不连续选区'
        }
      })
    )
    const snapshot = store.read()
    expect(snapshot.status).toBe('unsupported_selection')
    expect(snapshot.message).toContain('多个不连续选区')
  })

  it('超限明确拒绝，不静默截断，也不返回上一次的选区', () => {
    const store = service()
    store.update(report())
    const tooLong = store.update(
      report({
        capture: {
          collector: 'source',
          empty: false,
          selectedText: 'x'.repeat(SELECTION_LIMITS.maxSelectedChars + 1)
        }
      })
    )
    expect(tooLong).toMatchObject({ accepted: false, status: 'context_too_large' })
    expect(tooLong.reason).toContain('上限')
    // 关键：不能把上一次的选区当成"当前选区"返回（那等于静默给出过期内容）
    const afterLimit = store.read()
    expect(afterLimit.status).toBe('context_too_large')
    expect(afterLimit.selection).toBeUndefined()
    expect(afterLimit.snapshotId).toBeNull()
    expect(afterLimit.message).toContain('上限')
    expect(afterLimit.limits).toEqual({ ...SELECTION_LIMITS })

    const tooManyBlocks = store.update(
      report({
        capture: {
          collector: 'visual',
          empty: false,
          blocks: Array.from({ length: SELECTION_LIMITS.maxBlocks + 1 }, () => ({
            kind: 'paragraph',
            markdown: '块',
            source: 'reserialized' as const
          }))
        }
      })
    )
    expect(tooManyBlocks.status).toBe('context_too_large')

    // 用户重新给一个正常选区 → 恢复 ok；取消选区 → 回到 no_selection（不再卡在 too_large）
    expect(store.update(report()).status).toBe('ok')
    store.update(
      report({
        capture: {
          collector: 'source',
          empty: false,
          selectedText: 'y'.repeat(SELECTION_LIMITS.maxSelectedChars + 1)
        }
      })
    )
    store.clear('note-a')
    expect(store.read().status).toBe('no_selection')
  })

  it('切笔记后的迟到上报被拒绝，不混上另一篇笔记的身份', () => {
    const store = service()
    store.update(report())
    const late = store.update(
      report({
        note: { id: 'note-b', title: '笔记 B', absolutePath: '/tmp/docs/notes/0002. B.md' }
      })
    )
    expect(late).toMatchObject({ accepted: false, reason: 'note-changed' })
    // 仍然读到 A 的快照，不会出现 A 的路径 + B 的正文
    expect(store.read().note?.id).toBe('note-a')
  })

  it('失效后读到 selection_invalidated，并且不再给出旧文本与旧范围', () => {
    const store = service()
    store.update(report())
    store.invalidate('切换到另一篇笔记')
    const snapshot = store.read()
    expect(snapshot.status).toBe('selection_invalidated')
    expect(snapshot.snapshotId).toBeNull()
    expect(snapshot.selection).toBeUndefined()
    expect(snapshot.message).toContain('切换到另一篇笔记')
    // 失效之后允许新笔记的上报（不再被 note-changed 挡住）
    expect(
      store.update(
        report({
          note: { id: 'note-b', title: '笔记 B', absolutePath: '/tmp/docs/notes/0002. B.md' }
        })
      ).accepted
    ).toBe(true)
  })

  it('只清除指定笔记的快照（避免竞态清掉新快照）', () => {
    const store = service()
    store.update(report())
    expect(store.clear('note-b')).toBe(false)
    expect(store.read().status).toBe('ok')
    expect(store.clear('note-a')).toBe(true)
    expect(store.read().status).toBe('no_selection')
  })
})
