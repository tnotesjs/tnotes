import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { externalSync, frontmatterIdGuard } from './frontmatterIdGuard'

const doc = ['---', 'id: abc-123', 'description: 简介', '---', '', '正文'].join('\n')

function edit(from: number, to: number, insert: string): string {
  const state = EditorState.create({ doc, extensions: [frontmatterIdGuard()] })
  return state.update({ changes: { from, to, insert } }).state.doc.toString()
}

describe('frontmatterIdGuard', () => {
  it('rejects edits inside the id line', () => {
    const idAt = doc.indexOf('abc')
    expect(edit(idAt, idAt + 3, 'zzz')).toBe(doc)
    const lineStart = doc.indexOf('id:')
    expect(edit(lineStart, lineStart, 'X')).toBe(doc)
  })

  it('allows editing the description and the body', () => {
    const description = doc.indexOf('简介')
    expect(edit(description, description + 2, '说明')).toContain('description: 说明')
    const body = doc.indexOf('正文')
    expect(edit(body, body + 2, '新正文')).toContain('新正文')
  })

  it('allows typing at the cursor in the body and the description', () => {
    const body = doc.indexOf('正文')
    expect(edit(body, body, '甲')).toContain('甲正文')
    const description = doc.indexOf('简介')
    expect(edit(description, description, '新')).toContain('description: 新简介')
  })

  it('select-all delete keeps the id line and the frontmatter fences', () => {
    expect(edit(0, doc.length, '')).toBe('---\nid: abc-123\n---\n')
  })

  it('lets content synced from the session replace the frontmatter as is', () => {
    const next = ['---', 'id: other-456', '---', '', '别的笔记'].join('\n')
    const state = EditorState.create({ doc, extensions: [frontmatterIdGuard()] })
    const tr = state.update({
      changes: { from: 0, to: doc.length, insert: next },
      annotations: externalSync.of(true)
    })
    expect(tr.state.doc.toString()).toBe(next)
    expect(tr.annotation(externalSync)).toBe(true)
  })
})
