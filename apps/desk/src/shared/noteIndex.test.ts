import { describe, expect, it } from 'vitest'

import { canonicalNoteIndex, noteIndexChangeError, rewriteNoteIndexContent } from './noteIndex'

describe('修改笔记索引', () => {
  it('把 1 到 4 位数字收成 0001–9999', () => {
    expect(canonicalNoteIndex('42')).toBe('0042')
    expect(canonicalNoteIndex('0001')).toBe('0001')
    expect(canonicalNoteIndex('9999')).toBe('9999')
    expect(canonicalNoteIndex('0')).toBeNull()
    expect(canonicalNoteIndex('0000')).toBeNull()
    expect(canonicalNoteIndex('10000')).toBeNull()
    expect(canonicalNoteIndex('1.5')).toBeNull()
    expect(canonicalNoteIndex('')).toBeNull()
  })

  it('拒绝已被占用的编号，当前编号本身不算占用', () => {
    const taken = new Set(['0001', '0013'])
    expect(noteIndexChangeError('1', '0013', taken)).toBe('索引 0001 已被占用')
    expect(noteIndexChangeError('13', '0013', taken)).toBeNull()
    expect(noteIndexChangeError('99', '0013', taken)).toBeNull()
    expect(noteIndexChangeError('abc', '0013', taken)).toBe('索引必须是 0001 到 9999')
  })

  it('改标题前缀和本篇资源路径', () => {
    const content = '---\nid: u\n---\n\n# 0013. new\n\n![](../assets/0013-pic.png)\n'
    expect(rewriteNoteIndexContent(content, '0013', '0007')).toBe(
      '---\nid: u\n---\n\n# 0007. new\n\n![](../assets/0007-pic.png)\n'
    )
  })
})