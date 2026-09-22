import { describe, expect, it } from 'vitest'

import { ActiveNoteService } from './activeNoteService'

import type { ActiveNoteReportRequest } from '../../shared/contracts'

function report(
  generation: number,
  overrides: Partial<ActiveNoteReportRequest> = {}
): ActiveNoteReportRequest {
  return {
    generation,
    knowledgeBase: { id: 'kb-a', name: 'docs', rootPath: '/tmp/docs' },
    note: {
      id: 'note-a',
      title: '笔记 A',
      absolutePath: '/tmp/docs/notes/0001. A.md',
      relPath: 'notes/0001. A.md'
    },
    editor: { viewMode: 'visual', hasUnsavedChanges: false },
    ...overrides
  }
}

function noteB(generation: number): ActiveNoteReportRequest {
  return report(generation, {
    note: {
      id: 'note-b',
      title: '笔记 B',
      absolutePath: '/tmp/docs/notes/0002. B.md',
      relPath: 'notes/0002. B.md'
    }
  })
}

function service(): ActiveNoteService {
  return new ActiveNoteService({ now: () => new Date('2026-09-22T00:00:00.000Z') })
}

describe('当前活动笔记服务（主进程）', () => {
  it('没有活动笔记时返回 no_focused_note，且不给任何路径', () => {
    const snapshot = service().read()
    expect(snapshot.status).toBe('no_focused_note')
    expect(snapshot.note).toBeUndefined()
    expect(snapshot.knowledgeBase).toBeUndefined()
    expect(snapshot.capturedAt).toBeNull()
    expect(snapshot.message).toContain('没有聚焦的笔记')
  })

  it('上报活动笔记：只给定位信息（路径 / 标题 / 知识库 / 视图与未保存标记）', () => {
    const store = service()
    expect(store.update(report(1)).accepted).toBe(true)
    const snapshot = store.read()
    expect(snapshot.status).toBe('ok')
    expect(snapshot.capturedAt).toBe('2026-09-22T00:00:00.000Z')
    expect(snapshot.note).toEqual({
      id: 'note-a',
      title: '笔记 A',
      absolutePath: '/tmp/docs/notes/0001. A.md',
      relPath: 'notes/0001. A.md'
    })
    expect(snapshot.knowledgeBase).toEqual({ id: 'kb-a', name: 'docs', rootPath: '/tmp/docs' })
    expect(snapshot.editor).toEqual({ viewMode: 'visual', hasUnsavedChanges: false })
    // 不返回正文：只有定位字段
    expect(JSON.stringify(snapshot)).not.toContain('正文')
  })

  it('切到网页 / 设置等非笔记标签 → no_focused_note，不回退上一次笔记', () => {
    const store = service()
    store.update(report(1))
    expect(store.clear('当前标签不是笔记', 2)).toBe(true)
    const snapshot = store.read()
    expect(snapshot.status).toBe('no_focused_note')
    expect(snapshot.note).toBeUndefined()
    expect(snapshot.message).toContain('当前标签不是笔记')
  })

  it('切回另一篇笔记：按新代次替换（旧笔记的路径不会残留）', () => {
    const store = service()
    store.update(report(1))
    store.clear('当前标签不是笔记', 2)
    expect(store.update(noteB(3)).accepted).toBe(true)
    expect(store.read().note?.id).toBe('note-b')
  })

  it('关闭活动笔记：已结束代次上的迟到上报不会把旧路径放回来', () => {
    const store = service()
    store.update(report(1))
    store.clear('关闭了笔记标签', 2)
    const late = store.update(report(2))
    expect(late).toMatchObject({ accepted: false, reason: 'generation-ended' })
    expect(store.read().status).toBe('no_focused_note')
    expect(store.read().note).toBeUndefined()
  })

  it('旧代次的迟到上报不会顶掉新的活动笔记', () => {
    const store = service()
    store.update(report(1))
    store.update(noteB(2))
    expect(store.update(report(1)).accepted).toBe(false)
    expect(store.read().note?.id).toBe('note-b')
  })

  it('clearNow 是无条件兜底（负载不合法时宁可没有当前笔记）', () => {
    const store = service()
    store.update(report(7))
    store.clearNow('活动笔记上报负载不合法（已放弃这一次上报）')
    expect(store.read().status).toBe('no_focused_note')
    expect(store.read().note).toBeUndefined()
    // 不影响后续正常上报
    expect(store.update(report(7)).accepted).toBe(true)
    expect(store.read().note?.id).toBe('note-a')
  })
})
