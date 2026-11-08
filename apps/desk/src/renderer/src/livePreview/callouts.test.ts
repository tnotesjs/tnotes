// @vitest-environment happy-dom
import { codeFolding, ensureSyntaxTree, foldEffect } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { calloutLayout, isCalloutCollapsed } from './calloutLayout'
import {
  calloutArrowDown,
  calloutBackspace,
  calloutDelete,
  calloutEnter,
  commitCalloutHeader,
  unwrapCallout
} from './calloutView'
import { containerAtCursor } from './containerAt'
import { livePreviewField, setFocused } from './decorations'
import { headingFoldService, headingSections } from './headingFold'
import { tnotesMarkdown } from './language'
import { collectHeadings } from './outline'

const views: EditorView[] = []

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy())
  document.body.replaceChildren()
})

function stateOf(doc: string, cursor = 0): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [tnotesMarkdown()]
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}

function mount(doc: string, cursor: number): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [tnotesMarkdown(), livePreviewField]
    })
  })
  ensureSyntaxTree(view.state, doc.length, 5000)
  view.dispatch({ effects: setFocused.of(true) })
  views.push(view)
  return view
}

describe('callout layout', () => {
  it('pairs top-level open / close lines and keeps nested ones as source', () => {
    const doc = [
      ':::: tip 外层',
      '外层正文',
      '::: warning 内层',
      '内层',
      ':::',
      '::::',
      '',
      '::: details',
      '收起',
      ':::'
    ].join('\n')
    const { blocks, nested } = calloutLayout(stateOf(doc))
    expect(blocks.map((block) => [block.type, block.title, block.colons])).toEqual([
      ['tip', '外层', '::::'],
      ['details', '', ':::']
    ])
    expect(doc.slice(blocks[0].bodyFrom, blocks[0].bodyTo)).toBe(
      '外层正文\n::: warning 内层\n内层\n:::'
    )
    expect(nested.map((span) => doc.slice(span.from, span.to))).toEqual([
      '::: warning 内层\n内层\n:::'
    ])
  })

  it('closes at the first colon-only line with enough colons, like markdown-it-container', () => {
    const doc = '::: tip\n一\n::: quote\n二\n:::\n三\n:::\n'
    const { blocks } = calloutLayout(stateOf(doc))
    expect(blocks).toHaveLength(1)
    expect(doc.slice(blocks[0].bodyFrom, blocks[0].bodyTo)).toBe('一\n::: quote\n二')
  })

  it('runs an unclosed callout to the end of the document', () => {
    const doc = '::: danger\n正文\n'
    const [block] = calloutLayout(stateOf(doc)).blocks
    expect(block.close).toBeNull()
    expect(doc.slice(block.bodyFrom, block.end)).toBe('正文')
  })

  it('keeps headings inside callouts out of the outline and heading folds', () => {
    const doc = '# 一\n\n::: tip\n## 容器里\n:::\n\n## 二\n'
    const state = stateOf(doc)
    expect(collectHeadings(state).map((heading) => heading.text)).toEqual(['一', '二'])
    expect(headingSections(state)).toHaveLength(2)
  })

  it('reports the callout type at the cursor only inside the body', () => {
    const doc = '::: warning\n正文\n:::\n'
    expect(containerAtCursor(stateOf(doc, doc.indexOf('正文')))).toBe('warning')
    expect(containerAtCursor(stateOf(doc, doc.length))).toBeNull()
  })

  it('collapses details unless expanded or the selection is inside', () => {
    const doc = '前文\n::: details 更多\n藏起来\n:::\n'
    expect(isCalloutCollapsed(stateOf(doc, 0), calloutLayout(stateOf(doc)).blocks[0])).toBe(true)
    const inside = stateOf(doc, doc.indexOf('藏'))
    expect(isCalloutCollapsed(inside, calloutLayout(inside).blocks[0])).toBe(false)
  })
})

describe('callout editing', () => {
  it('rewrites only the open line when the type or title changes', () => {
    const doc = ':::: tip 旧\n正文\n::::\n'
    const view = mount(doc, doc.indexOf('正文'))
    const block = calloutLayout(view.state).blocks[0]
    commitCalloutHeader(view, block, { name: 'warning' })
    expect(view.state.doc.toString()).toBe(':::: warning 旧\n正文\n::::\n')
    commitCalloutHeader(view, calloutLayout(view.state).blocks[0], { title: '  新标题 ' })
    expect(view.state.doc.toString()).toBe(':::: warning 新标题\n正文\n::::\n')
    commitCalloutHeader(view, calloutLayout(view.state).blocks[0], { title: '' })
    expect(view.state.doc.toString()).toBe(':::: warning\n正文\n::::\n')
  })

  it('unwraps a callout and keeps its body', () => {
    const doc = '前\n::: tip\n正文\n:::\n后\n'
    const view = mount(doc, doc.indexOf('正文'))
    unwrapCallout(view, calloutLayout(view.state).blocks[0])
    expect(view.state.doc.toString()).toBe('前\n正文\n后\n')
    expect(view.state.selection.main.head).toBe('前\n'.length)
  })

  it('backspace at the start of the body unwraps, or removes an empty callout', () => {
    const doc = '::: tip\n正文\n:::\n'
    const view = mount(doc, doc.indexOf('正文'))
    expect(calloutBackspace(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('正文\n')

    const empty = mount('前\n::: quote\n\n:::\n后', '前\n::: quote\n'.length)
    expect(calloutBackspace(empty)).toBe(true)
    expect(empty.state.doc.toString()).toBe('前\n后')
  })

  it('backspace on the empty line after a callout goes back into the body', () => {
    const doc = '::: tip\n正文\n:::\n\n后'
    const view = mount(doc, '::: tip\n正文\n:::\n'.length)
    expect(calloutBackspace(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('::: tip\n正文\n:::\n后')
    expect(view.state.selection.main.head).toBe('::: tip\n正文'.length)
  })

  it('delete at the end of the body does not swallow the close line', () => {
    const doc = '::: tip\n正文\n:::\n'
    const view = mount(doc, '::: tip\n正文'.length)
    expect(calloutDelete(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(doc)
  })

  it('enter on an empty last body line leaves the callout', () => {
    const doc = '::: tip\n正文\n\n:::\n'
    const view = mount(doc, '::: tip\n正文\n'.length)
    expect(calloutEnter(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('::: tip\n正文\n:::\n')
    expect(view.state.selection.main.head).toBe('::: tip\n正文\n:::\n'.length)

    const tight = mount('::: tip\n正文\n\n:::\n后文', '::: tip\n正文\n'.length)
    expect(calloutEnter(tight)).toBe(true)
    expect(tight.state.doc.toString()).toBe('::: tip\n正文\n:::\n\n后文')
    expect(tight.state.selection.main.head).toBe('::: tip\n正文\n:::\n'.length)

    // 只有一行空正文时回车照常换行
    const fresh = mount('::: tip\n\n:::\n', '::: tip\n'.length)
    expect(calloutEnter(fresh)).toBe(false)
  })

  it('折叠标题后，标题行不露出井号，后面的高亮块也不画色条', () => {
    const doc = '## 标题\n\n正文\n\n::: tip\n提示\n:::\n'
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [tnotesMarkdown(), codeFolding(), headingFoldService, livePreviewField]
      })
    })
    views.push(view)
    const section = headingSections(view.state)[0]
    expect(section).toBeTruthy()
    view.dispatch({ effects: foldEffect.of({ from: section!.lineEnd, to: section!.end }) })
    const heading = [...document.querySelectorAll('.cm-line')].find((line) =>
      line.textContent?.includes('标题')
    )
    expect(heading?.textContent ?? '').not.toContain('#')
    expect(document.querySelectorAll('.cm-lp-callout-bar')).toHaveLength(0)
  })

  it('arrow down past a callout at the end of the document adds a line', () => {
    const doc = '::: tip\n正文\n:::'
    const view = mount(doc, '::: tip\n正'.length)
    expect(calloutArrowDown(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(`${doc}\n`)
    expect(view.state.selection.main.head).toBe(doc.length + 1)
  })
})
