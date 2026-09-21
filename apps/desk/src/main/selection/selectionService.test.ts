import { describe, expect, it } from 'vitest'

import { SelectionContextService, SELECTION_LIMITS } from './selectionService'

import type { SelectionCaptureDto, SelectionReportRequest } from '../../shared/contracts'

/** 渲染端每次换活动编辑器 / 结束一个上下文，代次就 +1（这里用 gen 显式表示） */
function report(
  generation: number,
  overrides: Partial<SelectionReportRequest> = {}
): SelectionReportRequest {
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

/** 另一篇笔记的上报（用于切换场景） */
function otherNote(
  generation: number,
  capture?: Partial<SelectionCaptureDto>
): SelectionReportRequest {
  return report(generation, {
    note: { id: 'note-b', title: '笔记 B', absolutePath: '/tmp/docs/notes/0002. B.md' },
    capture: {
      collector: 'source',
      empty: false,
      selectedText: 'B 的正文',
      blocks: [{ kind: 'paragraph', markdown: 'B 的正文', source: 'raw' }],
      ...capture
    }
  })
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
    expect(store.update(report(1)).accepted).toBe(true)
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
      report(1, {
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
    store.update(report(1))
    store.update(report(1, { capture: { collector: 'source', empty: true } }))
    const snapshot = store.read()
    expect(snapshot.status).toBe('no_selection')
    expect(snapshot.note?.id).toBe('note-a')
    expect(snapshot.selection).toBeUndefined()
    expect(store.hasSnapshot()).toBe(true)
  })

  it('多选区 / 无法映射 → unsupported_selection，并给出原因', () => {
    const store = service()
    store.update(
      report(1, {
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

  it('切换代次：不把"上一个快照的笔记"当作"当前活动笔记"，两种切换顺序都不得留下旧笔记', () => {
    // 顺序一：新编辑器先上报（代次更高），旧编辑器随后才失效
    const forward = service()
    forward.update(report(1))
    expect(forward.update(otherNote(2)).accepted).toBe(true)
    // 旧编辑器的失效必须被忽略（它已经不是当前上下文）
    expect(forward.invalidate('切换到其它编辑器', 1)).toBe(false)
    expect(forward.read().status).toBe('ok')
    expect(forward.read().note?.id).toBe('note-b')
    expect(forward.read().selection?.selectedText).toBe('B 的正文')

    // 顺序二：旧编辑器先失效，新编辑器再上报
    const backward = service()
    backward.update(report(1))
    expect(backward.invalidate('切换到其它编辑器', 1)).toBe(true)
    expect(backward.read().status).toBe('selection_invalidated')
    expect(backward.update(otherNote(2)).accepted).toBe(true)
    expect(backward.read().note?.id).toBe('note-b')
    expect(backward.read().selection?.selectedText).toBe('B 的正文')
  })

  it('旧代次的迟到上报不会覆盖新快照', () => {
    const store = service()
    store.update(report(1))
    store.update(otherNote(2))
    const late = store.update(report(1))
    expect(late).toMatchObject({ accepted: false, reason: 'stale-generation' })
    expect(store.read().status).toBe('ok')
    expect(store.read().note?.id).toBe('note-b')
    expect(store.read().selection?.selectedText).toBe('B 的正文')
  })

  it('已结束的代次不会被在途上报复活（清除 / 失效之后同代次上报被拒）', () => {
    const store = service()
    store.update(report(1))
    // 用户取消选区：结束代次 1
    expect(store.clear('note-a', 1)).toBe(true)
    expect(store.read().status).toBe('no_selection')

    const resurrect = store.update(report(1))
    expect(resurrect).toMatchObject({ accepted: false, reason: 'generation-ended' })
    expect(store.read().status).toBe('no_selection')
    expect(store.read().selection).toBeUndefined()

    // 下一个上下文（代次 2）照常可用
    expect(store.update(report(2)).accepted).toBe(true)
    expect(store.read().selection?.selectedText).toBe('选中的正文')
  })

  it('切笔记后按新代次上报可以替换（不需要靠"笔记不同"拒收）', () => {
    const store = service()
    store.update(report(1))
    // 切笔记：结束代次 1，随后新上下文用代次 2 上报
    expect(store.invalidate('切换到另一篇笔记', 1)).toBe(true)
    expect(store.update(otherNote(2)).accepted).toBe(true)
    expect(store.read().note?.id).toBe('note-b')
    expect(store.read().selection?.selectedText).toBe('B 的正文')
  })

  it('超限明确拒绝，不静默截断，也不返回上一次的选区', () => {
    const store = service()
    store.update(report(1))
    const tooLong = store.update(
      report(2, {
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

    // 用户重新给一个正常选区 → 恢复 ok；取消选区 → 回到 no_selection（不再卡在 too_large）
    expect(store.update(report(2)).status).toBe('ok')
    store.update(
      report(2, {
        capture: {
          collector: 'source',
          empty: false,
          selectedText: 'y'.repeat(SELECTION_LIMITS.maxSelectedChars + 1)
        }
      })
    )
    store.clear('note-a', 2)
    expect(store.read().status).toBe('no_selection')
  })

  it('三个语义上限各自都能让旧快照失效，缩小选区后恢复', () => {
    const cases: Array<[string, SelectionCaptureDto]> = [
      [
        '选字过多',
        {
          collector: 'source',
          empty: false,
          selectedText: 'x'.repeat(SELECTION_LIMITS.maxSelectedChars + 1)
        }
      ],
      [
        '相关块内容过长',
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
        }
      ],
      [
        '涉及块过多',
        {
          collector: 'visual',
          empty: false,
          selectedText: '短',
          blocks: Array.from({ length: SELECTION_LIMITS.maxBlocks + 1 }, () => ({
            kind: 'paragraph',
            markdown: '块',
            source: 'reserialized' as const
          }))
        }
      ]
    ]

    for (const [name, capture] of cases) {
      const store = service()
      store.update(report(1))
      const outcome = store.update(report(2, { capture }))
      expect(outcome.status, name).toBe('context_too_large')
      expect(store.read().status, name).toBe('context_too_large')
      expect(store.read().selection, name).toBeUndefined()

      // 缩小选区（同一代次）→ 恢复 ok
      expect(store.update(report(2)).accepted, name).toBe(true)
      expect(store.read().selection?.selectedText, name).toBe('选中的正文')
    }
  })

  it('渲染端报来"不带正文的超限状态"也能失效旧快照', () => {
    const store = service()
    store.update(report(1))
    const outcome = store.update(
      report(2, {
        capture: {
          collector: 'visual',
          empty: false,
          overLimit:
            '选中内容过长：1200000 字符，上限 20000 字符（超过传输上限，未随上报发送正文）',
          selectedChars: 1_200_000
        }
      })
    )
    expect(outcome).toMatchObject({ accepted: false, status: 'context_too_large' })
    const snapshot = store.read()
    expect(snapshot.status).toBe('context_too_large')
    expect(snapshot.selection).toBeUndefined()
    expect(snapshot.message).toContain('传输上限')
  })

  it('失效后读到 selection_invalidated，并且不再给出旧文本与旧范围', () => {
    const store = service()
    store.update(report(1))
    store.invalidate('切换到另一篇笔记', 1)
    const snapshot = store.read()
    expect(snapshot.status).toBe('selection_invalidated')
    expect(snapshot.snapshotId).toBeNull()
    expect(snapshot.selection).toBeUndefined()
    expect(snapshot.message).toContain('切换到另一篇笔记')
    // 失效之后允许新笔记 / 新上下文的上报
    expect(store.update(otherNote(2)).accepted).toBe(true)
  })

  it('只清除指定笔记的快照（避免竞态清掉新快照）', () => {
    const store = service()
    store.update(report(1))
    expect(store.clear('note-b', 1)).toBe(false)
    expect(store.read().status).toBe('ok')
    expect(store.clear('note-a', 1)).toBe(true)
    expect(store.read().status).toBe('no_selection')
  })

  it('invalidateNow 是无条件兜底（负载不合法时宁可没有快照）', () => {
    const store = service()
    store.update(report(5))
    store.invalidateNow('选区上报负载不合法（已放弃这一次上报）')
    const snapshot = store.read()
    expect(snapshot.status).toBe('selection_invalidated')
    expect(snapshot.selection).toBeUndefined()
    // 不影响后续正常上报
    expect(store.update(report(5)).accepted).toBe(true)
  })
})
