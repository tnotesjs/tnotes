// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import {
  escapeBlockSourceForLiteral,
  escapeLineForLiteral,
  literalParagraphSourceFor
} from './literalProjection'

describe('literalProjection · 行转义', () => {
  it('块级构造的行首记号被转义，正文行不动', () => {
    expect(escapeLineForLiteral('::: tip T')).toBe('\\::: tip T')
    expect(escapeLineForLiteral(':::: tip T')).toBe('\\:::: tip T')
    expect(escapeLineForLiteral('```js')).toBe('\\```js')
    expect(escapeLineForLiteral('## 标题')).toBe('\\## 标题')
    expect(escapeLineForLiteral('- 列表项')).toBe('\\- 列表项')
    expect(escapeLineForLiteral('1. 有序项')).toBe('\\1. 有序项')
    expect(escapeLineForLiteral('> 引用')).toBe('\\> 引用')
    expect(escapeLineForLiteral('| A | B |')).toBe('\\| A | B |')
    expect(escapeLineForLiteral('<div>x</div>')).toBe('\\<div>x</div>')
    expect(escapeLineForLiteral('---')).toBe('\\---')
    expect(escapeLineForLiteral('普通正文，含 **加粗** 与 `代码`')).toBe(
      '普通正文，含 **加粗** 与 `代码`'
    )
    expect(escapeLineForLiteral('  缩进两格的正文')).toBe('  缩进两格的正文')
  })

  it('整块转义保留空行与顺序', () => {
    const source = '::: tip 外层\n外层正文\n\n::: quote 内层\n内层正文\n\n:::\n\n:::'
    expect(escapeBlockSourceForLiteral(source).split('\n')).toEqual([
      '\\::: tip 外层',
      '外层正文',
      '',
      '\\::: quote 内层',
      '内层正文',
      '',
      '\\:::',
      '',
      '\\:::'
    ])
  })
})

describe('literalProjection · 整段做成一个段落', () => {
  it('逐行转义后用行内 <br /> 连接，不留空行', () => {
    const source = '::: tip 外层\n外层正文\n\n::: quote 内层\n内层正文\n\n:::'
    const paragraph = literalParagraphSourceFor(source)
    expect(paragraph.split('\n').filter((line) => line.trim() === '')).toEqual([])
    expect(paragraph.startsWith('\\::: tip 外层<br />')).toBe(true)
    expect(paragraph).toContain('外层正文<br />')
    expect(paragraph).toContain('\\::: quote 内层')
    expect(paragraph.endsWith('\\:::')).toBe(true)
    // 空行变成一个多余的 <br />
    expect(paragraph).toContain('<br />\n<br />')
  })
})
