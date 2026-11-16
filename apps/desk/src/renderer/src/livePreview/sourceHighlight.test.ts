// @vitest-environment happy-dom
import { tags } from '@lezer/highlight'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { tnotesMarkdown } from './language'
import { sourceHighlightExtension, sourceHighlightStyles } from './sourceHighlight'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

function colorOf(theme: 'light' | 'dark', tag: typeof tags.heading): string | undefined {
  const match = sourceHighlightStyles(theme).findLast((style) =>
    Array.isArray(style.tag) ? style.tag.includes(tag) : style.tag === tag
  )
  return match?.color
}

function renderedColor(theme: 'light' | 'dark', doc: string, text: string): string {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      extensions: [tnotesMarkdown(), sourceHighlightExtension(theme)]
    })
  })
  views.push(view)
  const span = [...view.dom.querySelectorAll('span')].find(
    (node) => node.textContent?.trim() === text
  )
  if (!span) throw new Error(`没有渲染出 ${text}：${view.contentDOM.innerHTML}`)
  return getComputedStyle(span).color
}

describe('source highlight', () => {
  it('uses GitHub heading, emphasis, link and inline-code colors', () => {
    expect(colorOf('dark', tags.heading)).toBe('#d2a8ff')
    expect(colorOf('light', tags.heading)).toBe('#24292e')
    expect(colorOf('dark', tags.monospace)).toBe('#a5d6ff')
    expect(colorOf('light', tags.monospace)).toBe('#032f62')
    expect(colorOf('dark', tags.link)).toBe('#58a6ff')
    expect(colorOf('light', tags.link)).toBe('#032f62')
    expect(colorOf('dark', tags.processingInstruction)).toBe('#8b949e')
    expect(colorOf('light', tags.emphasis)).toBe('#24292e')
    expect(colorOf('dark', tags.keyword)).toBe('#ff7b72')
    expect(colorOf('light', tags.keyword)).toBe('#d73a49')
  })

  it('paints rendered markdown with the GitHub colors', () => {
    const doc = '# 标题\n\n*强调* 与 `code`\n'
    expect(renderedColor('dark', doc, '标题')).toBe('#d2a8ff')
    expect(renderedColor('light', doc, '标题')).toBe('#24292e')
    expect(renderedColor('dark', doc, '强调')).toBe('#d2a8ff')
    expect(renderedColor('dark', doc, 'code')).toBe('#a5d6ff')
    expect(renderedColor('light', doc, 'code')).toBe('#032f62')
  })
})
