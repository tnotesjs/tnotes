import { beforeEach, describe, expect, it } from 'vitest'

import { parseMarkdown } from '../markdown/parser'
import { serializeMarkdown } from '../markdown/serializer'
import { MindmapSession } from '../session'
import { resetNodeIdCounter } from './document'
import {
  createLinkDefinitions,
  parseInline,
  parseInlineSegments,
  replaceInlineDisplayText,
  replaceInlineRange,
  setInlineFormat,
  stripInline,
  updateInlineLink
} from './inline'

const BAIDU = 'https://www.baidu.com'
const definitions = createLinkDefinitions([
  ['1', BAIDU],
  ['Foo  Bar', 'https://foo.example']
])
const options = { definitions }

beforeEach(() => resetNodeIdCounter())

describe('引用式链接：解析', () => {
  it('[文字][id] / [文字][] / [文字] 按定义解析成链接，标签大小写与空白不敏感', () => {
    const full = parseInlineSegments('参考 [百度][1]', options)
    expect(full.map((s) => s.text)).toEqual(['参考 ', '百度'])
    expect(full[1].link).toMatchObject({
      url: BAIDU,
      rawStart: 3,
      rawEnd: 10,
      reference: { id: '1', label: '百度' }
    })

    const collapsed = parseInlineSegments('[foo bar][]', options)
    expect(collapsed[0]).toMatchObject({ text: 'foo bar', link: { url: 'https://foo.example' } })
    expect(collapsed[0].link?.reference).toEqual({ id: '', label: 'foo bar' })

    const shortcut = parseInlineSegments('看 [FOO   bar] 吧', options)
    expect(shortcut[1]).toMatchObject({ text: 'FOO   bar', link: { url: 'https://foo.example' } })
    expect(shortcut[1].link?.reference).toEqual({ id: null, label: 'FOO   bar' })
  })

  it('没有定义或查不到定义时保持普通文本', () => {
    expect(stripInline('参考 [百度][1]')).toBe('参考 [百度][1]')
    expect(parseInlineSegments('参考 [百度][2]', options).every((s) => !s.link)).toBe(true)
    expect(stripInline('参考 [百度][2]', options)).toBe('参考 [百度][2]')
    expect(stripInline('[x][]', options)).toBe('[x][]')
  })

  it('行内代码里永不当链接；裸 dp[i][1] 按 CommonMark 当链接', () => {
    const code = parseInlineSegments('二维数组 `grid[0][1]`', options)
    expect(code.map((s) => s.text)).toEqual(['二维数组 ', 'grid[0][1]'])
    expect(code.every((s) => !s.link)).toBe(true)

    const bare = parseInlineSegments('dp[i][1] 转移', options)
    expect(bare.map((s) => s.text)).toEqual(['dp', 'i', ' 转移'])
    expect(bare[1].link?.url).toBe(BAIDU)
  })

  it('图片 ![x][1] 不当链接；转义的 \\[x] 是字面量；标签内的格式照常解析', () => {
    expect(parseInlineSegments('![图][1]', options).some((s) => s.link)).toBe(false)
    // `\[x]` 是字面量，后面的 `[1]` 按 CommonMark 是 shortcut 引用链接
    const escaped = parseInlineSegments('\\[x][1]', options)
    expect(escaped.map((s) => [s.text, s.link?.url ?? null])).toEqual([
      ['[x]', null],
      ['1', BAIDU]
    ])
    const bold = parseInlineSegments('[**百**度][1]', options)
    expect(bold.map((s) => [s.text, s.marks.bold, s.link?.url])).toEqual([
      ['百', true, BAIDU],
      ['度', false, BAIDU]
    ])
  })

  it('整个节点是引用链接时 content.link 有地址', () => {
    expect(parseInline('[百度][1]', options)).toMatchObject({ text: '百度', link: BAIDU })
    expect(parseInline('参考 [百度][1]', options).link).toBeNull()
  })
})

describe('引用式链接：编辑后写回仍是引用语法', () => {
  it('改链接文字 / 链接外文字都不会把地址内联', () => {
    expect(replaceInlineDisplayText('参考 [百度][1]', '参考 百度一下', options)).toBe(
      '参考 [百度一下][1]'
    )
    expect(replaceInlineDisplayText('参考 [百度][1]', '参考资料 百度', options)).toBe(
      '参考资料 [百度][1]'
    )
    expect(replaceInlineDisplayText('dp[i][1] 转移', 'dpi 转移X', options)).toBe('dp[i][1] 转移X')
  })

  it('在链接开头插入或整段替换链接文字时，仍保留引用写法', () => {
    expect(replaceInlineRange('[百度][1]', 0, 0, '新', undefined, options)).toBe('[新百度][1]')
    expect(replaceInlineRange('[百度][1]', 0, 2, '搜索', undefined, options)).toBe('[搜索][1]')
  })

  it('[文字][] / [文字] 改字后补上原标签，仍指向同一条定义', () => {
    expect(replaceInlineDisplayText('[Foo Bar][]', 'Foo Bar!', options)).toBe('[Foo Bar!][Foo Bar]')
    expect(replaceInlineDisplayText('[Foo Bar] 后', 'Foo Bar 后面', options)).toBe('[Foo Bar] 后面')
    expect(replaceInlineDisplayText('[Foo Bar]', 'Foo Baz', options)).toBe('[Foo Baz][Foo Bar]')
  })

  it('加格式保留引用写法；改地址则变成行内链接', () => {
    expect(setInlineFormat('[百度][1]', 0, 2, 'bold', true, options)).toBe('[**百度**][1]')
    expect(updateInlineLink('[百度][1]', 0, 7, BAIDU, options)).toBe('[百度][1]')
    expect(updateInlineLink('[百度][1]', 0, 7, 'https://example.com', options)).toBe(
      '[百度](https://example.com)'
    )
    expect(updateInlineLink('[百度][1]', 0, 7, null, options)).toBe('百度')
  })

  it('行内代码里的方括号编辑后保持字面量', () => {
    expect(replaceInlineDisplayText('二维数组 `grid[0][1]`', '二维数组X grid[0][1]', options)).toBe(
      '二维数组X `grid[0][1]`'
    )
  })
})

describe('引用式链接：整份导图', () => {
  const MD = [
    '# 测试',
    '',
    '- 参考 [百度][1]',
    '- 二维数组 `grid[0][1]`',
    '- dp[i][1] 转移',
    ''
  ].join('\n')

  it('parseMarkdown 带定义后节点显示为链接，序列化与原文一致', () => {
    const { doc, valid } = parseMarkdown(MD, 't', options)
    expect(valid).toBe(true)
    const [ref, code, dp] = doc.root.children
    expect(ref.content.text).toBe('参考 百度')
    expect(code.content.text).toBe('二维数组 grid[0][1]')
    expect(dp.content.text).toBe('dpi 转移')
    expect(serializeMarkdown(doc)).toBe(MD)
  })

  it('会话里改其它节点、撤销重做后，引用写法都不变', () => {
    const session = new MindmapSession({ markdown: MD, definitions: { 1: BAIDU } })
    const [ref, , dp] = session.document.root.children
    expect(ref.content.text).toBe('参考 百度')
    session.updateNodeDisplayText(dp.id, 'dpi 转移X')
    expect(session.getMarkdown()).toBe(MD.replace('转移', '转移X'))
    session.updateNodeDisplayText(ref.id, '参考 百度一下')
    expect(session.getMarkdown()).toContain('- 参考 [百度一下][1]')
    session.undo()
    session.undo()
    expect(session.getMarkdown()).toBe(MD)
    expect(session.document.root.children[0].content.text).toBe('参考 百度')
    session.redo()
    expect(session.getMarkdown()).toBe(MD.replace('转移', '转移X'))
  })

  it('不传定义时与旧行为一致：引用写法按字面量显示', () => {
    const session = new MindmapSession({ markdown: MD })
    expect(session.document.root.children[0].content.text).toBe('参考 [百度][1]')
    expect(session.getMarkdown()).toBe(MD)
  })
})
