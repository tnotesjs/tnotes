// @vitest-environment happy-dom
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { livePreviewField, setFocused } from './decorations'
import { tnotesMarkdown } from './language'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const state = EditorState.create({ doc, extensions: [tnotesMarkdown(), livePreviewField] })
  ensureSyntaxTree(state, doc.length, 5000)
  const view = new EditorView({ state, parent })
  view.dispatch({ effects: setFocused.of(false) })
  views.push(view)
  return view
}

// todo 2026.10.05/06 的复现笔记
const NOTE = [
  '# 表格引用链接',
  '',
  '| 说明 | 链接 |',
  '| --- | --- |',
  '| 引用 | [点我][1] |',
  '',
  '[1]: https://example.com',
  ''
].join('\n')

describe('table card reference links', () => {
  it('expands note-level reference links inside a GFM table card', () => {
    const view = mount(NOTE)
    const card = view.dom.querySelector('.cm-lp-table-card')
    expect(card).not.toBeNull()
    const link = card!.querySelector('a')
    expect(link).not.toBeNull()
    expect(link!.textContent).toBe('点我')
    expect(link!.getAttribute('href')).toBe('https://example.com')
    // 不应再以字面 `[点我][1]` 显示
    expect(card!.textContent ?? '').not.toContain('[点我][1]')
    expect(card!.textContent ?? '').toContain('点我')
  })

  it('keeps inline links in table cells working without definitions', () => {
    const doc = [
      '| 说明 | 链接 |',
      '| --- | --- |',
      '| 直链 | [点我](https://direct.example/) |',
      ''
    ].join('\n')
    const view = mount(doc)
    const link = view.dom.querySelector('.cm-lp-table-card a')
    expect(link?.getAttribute('href')).toBe('https://direct.example/')
    expect(link?.textContent).toBe('点我')
  })
})
