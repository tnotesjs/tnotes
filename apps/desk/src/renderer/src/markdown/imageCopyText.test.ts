// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'

import { selectionHasImage, selectionPlainText } from './imageCopyText'

import type { EditorView } from '@milkdown/kit/prose/view'

/** 最小 schema：段落 + 图片 + 硬换行，够验"纯文本形态" */
const schema = new Schema({
  nodes: {
    text: { group: 'inline' },
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    image: {
      group: 'inline',
      inline: true,
      attrs: { src: { default: '' }, alt: { default: '' } },
      toDOM: () => ['img']
    },
    hardbreak: { group: 'inline', inline: true, toDOM: () => ['br'] }
  },
  marks: {}
})

const p = (children: unknown[]) => schema.nodes.paragraph.create(null, children as never)
const img = (alt: string, src = 'a.svg') => schema.nodes.image.create({ src, alt })
const text = (value: string) => schema.text(value)
const br = () => schema.nodes.hardbreak.create()

function viewWith(doc: unknown, from: number, to: number): EditorView {
  const state = EditorState.create({ schema, doc: doc as never })
  const withSelection = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, from, to))
  )
  return { state: withSelection } as unknown as EditorView
}

describe('选区纯文本形态（图片贡献 alt）', () => {
  it('单张有 alt 的图 → 纯文本就是 alt', () => {
    const doc = schema.nodes.doc.create(null, [p([img('画布')])])
    // 段落起点 1，图片占 1 个位置
    expect(selectionPlainText(viewWith(doc, 1, 2))).toBe('画布')
  })

  it('图片没有 alt → 纯文本为空（不是"复制失败"，只是没有描述）', () => {
    const doc = schema.nodes.doc.create(null, [p([img('')])])
    expect(selectionPlainText(viewWith(doc, 1, 2))).toBe('')
  })

  it('图片与正文混选 → 按文档顺序拼接，不丢正文、不重复描述', () => {
    const doc = schema.nodes.doc.create(null, [
      p([text('前后')]),
      p([img('画布')]),
      p([text('结尾')])
    ])
    const end = doc.content.size
    expect(selectionPlainText(viewWith(doc, 0, end))).toBe('前后\n画布\n结尾')
  })

  it('多张图片 → 每张各出一次 alt，顺序与文档一致', () => {
    const doc = schema.nodes.doc.create(null, [
      p([img('甲')]),
      p([img('乙'), text('尾巴')]),
      p([img('丙')])
    ])
    expect(selectionPlainText(viewWith(doc, 0, doc.content.size))).toBe('甲\n乙尾巴\n丙')
  })

  it('段内硬换行 → 换行', () => {
    const doc = schema.nodes.doc.create(null, [p([text('上行'), br(), text('下行')])])
    expect(selectionPlainText(viewWith(doc, 1, 5))).toBe('上行\n下行')
  })

  it('只选正文（含图）时，正文文字原样保留', () => {
    const doc = schema.nodes.doc.create(null, [p([text('只有正文')])])
    expect(selectionPlainText(viewWith(doc, 1, 5))).toBe('只有正文')
  })
})

describe('选区是否含图片', () => {
  it('只选正文 → false（不需要补纯文本）', () => {
    const doc = schema.nodes.doc.create(null, [p([text('正文')])])
    expect(selectionHasImage(viewWith(doc, 1, 3))).toBe(false)
  })

  it('选区覆盖图片 → true', () => {
    const doc = schema.nodes.doc.create(null, [p([text('a')]), p([img('画布')])])
    expect(selectionHasImage(viewWith(doc, 0, doc.content.size))).toBe(true)
  })

  it('图片不在选区内 → false', () => {
    const doc = schema.nodes.doc.create(null, [p([img('画布')]), p([text('正文')])])
    const start = doc.content.size - 2
    expect(selectionHasImage(viewWith(doc, start, doc.content.size))).toBe(false)
  })
})
