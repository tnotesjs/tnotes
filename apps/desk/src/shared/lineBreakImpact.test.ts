import { describe, expect, it } from 'vitest'

import { isLineBreakSensitive } from './lineBreakImpact'

describe('isLineBreakSensitive', () => {
  it('flags soft line breaks in paragraphs, list items and quotes', () => {
    expect(isLineBreakSensitive('第一行\n第二行\n')).toBe(true)
    expect(isLineBreakSensitive('- 条目\n  续行\n')).toBe(true)
    expect(isLineBreakSensitive('> 甲\n> 乙\n')).toBe(true)
  })

  it('flags runs of two or more blank lines between blocks', () => {
    expect(isLineBreakSensitive('a\n\n\nb\n')).toBe(true)
    expect(isLineBreakSensitive('## 标题\n\n\n\n正文\n')).toBe(true)
  })

  it('ignores notes that render the same either way', () => {
    expect(isLineBreakSensitive('a\n\nb\n')).toBe(false)
    expect(isLineBreakSensitive('# 标题\n正文\n')).toBe(false)
    expect(isLineBreakSensitive('- a\n- b\n- c\n')).toBe(false)
    expect(isLineBreakSensitive('行尾两个空格  \n下一行\n')).toBe(false)
    expect(isLineBreakSensitive('| a | b |\n| - | - |\n| 1 | 2 |\n')).toBe(false)
    expect(isLineBreakSensitive('\n\n\n正文\n\n\n\n')).toBe(false)
  })

  it('skips multi-line HTML and component blocks', () => {
    expect(isLineBreakSensitive("<NotesTable :ids=\"[\n  '0001',\n  '0002'\n]\" />\n")).toBe(false)
    expect(isLineBreakSensitive('<div>\n内容\n</div>\n\n\n后文\n')).toBe(true)
  })

  it('treats list items inside a quote as separate items', () => {
    expect(isLineBreakSensitive('> - 甲\n> - 乙\n')).toBe(false)
    expect(isLineBreakSensitive('> - 甲\n>   续行\n')).toBe(true)
  })

  it('skips frontmatter, fences and math blocks', () => {
    expect(isLineBreakSensitive('---\nid: x\ntitle: y\n---\n\n正文\n')).toBe(false)
    expect(isLineBreakSensitive('```js\nconst a = 1\n\n\n\nconst b = 2\n```\n')).toBe(false)
    expect(isLineBreakSensitive('$$\na = b\n\n\nc = d\n$$\n')).toBe(false)
    expect(isLineBreakSensitive('```js\n1\n```\n后文\n')).toBe(false)
  })

  it('counts any blank line in a callout body, but not in other containers', () => {
    expect(isLineBreakSensitive('::: tip\n\n内容\n\n:::\n')).toBe(true)
    expect(isLineBreakSensitive('::: tip\n甲\n\n乙\n:::\n')).toBe(true)
    expect(isLineBreakSensitive('::: tip\n内容\n:::\n')).toBe(false)
    expect(isLineBreakSensitive('::: swiper\n![a](a.png)\n\n\n![b](b.png)\n:::\n')).toBe(false)
  })

  it('keeps list spacing as CommonMark', () => {
    expect(isLineBreakSensitive('- a\n\n\n- b\n')).toBe(false)
    expect(isLineBreakSensitive('- a\n\n\n后文\n')).toBe(true)
  })
})
