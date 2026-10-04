import { describe, expect, it } from 'vitest'

import { noteFileName, noteLabelParts, workspaceRelativePath } from './noteFileName'

describe('noteFileName', () => {
  it('prefers the real on-disk name and keeps the index prefix', () => {
    expect(noteFileName({ noteIndex: '0001', title: '欢迎', fileName: '0001. 欢迎.md' })).toBe(
      '0001. 欢迎'
    )
    expect(noteFileName({ noteIndex: '0112', title: '前端', dirName: '0112.前端学习路线' })).toBe(
      '0112.前端学习路线'
    )
  })

  it('falls back to index plus title', () => {
    expect(noteFileName({ noteIndex: '0038', title: '后台搜索' })).toBe('0038. 后台搜索')
  })

  it('splits a leading index so the palette can fade it', () => {
    expect(noteLabelParts('0012. 测试快捷方式', '0012')).toEqual({
      index: '0012.',
      title: '测试快捷方式'
    })
    expect(noteLabelParts('0112.前端学习路线', '0112')).toEqual({
      index: '0112.',
      title: '前端学习路线'
    })
    expect(noteLabelParts('README', '')).toEqual({ index: '', title: 'README' })
  })

  it('joins the knowledge-base path onto the workspace root', () => {
    expect(
      workspaceRelativePath(
        '/Users/huyouda/tnotesjs/kbs',
        '/Users/huyouda/tnotesjs/kbs/test',
        'notes/0012. 测试快捷方式.md'
      )
    ).toBe('test/notes/0012. 测试快捷方式.md')
    expect(workspaceRelativePath(null, null, 'notes/0001.md')).toBe('notes/0001.md')
  })
})
