// @vitest-environment happy-dom
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { filterInsertItems, INSERT_ITEMS, insertItem } from '../markdown/insertCatalog'
import { livePreviewEnabled } from './host'
import { insertItemSpec } from './insertBlock'
import { tnotesMarkdown } from './language'
import {
  availableItems,
  insertHost,
  runInsertItem,
  slashCommand,
  slashStateOf
} from './slashCommand'

import type { InsertHost } from './slashCommand'

const views: EditorView[] = []

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy())
  document.body.replaceChildren()
})

function mount(doc: string, cursor: number, host?: Partial<InsertHost>, visual = true): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [
        tnotesMarkdown(),
        livePreviewEnabled.of(visual),
        slashCommand,
        insertHost.of({
          exclude: [],
          pickImage: () => undefined,
          insertCanvas: () => undefined,
          ...host
        })
      ]
    })
  })
  ensureSyntaxTree(view.state, doc.length, 5000)
  views.push(view)
  return view
}

function type(view: EditorView, text: string): void {
  for (const char of text) {
    const at = view.state.selection.main.head
    view.dispatch({
      changes: { from: at, insert: char },
      selection: EditorSelection.cursor(at + char.length),
      userEvent: 'input.type'
    })
  }
}

function press(view: EditorView, key: string): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  )
}

function apply(doc: string, at: number, id: string, remove?: { from: number; to: number }) {
  const state = EditorState.create({ doc, extensions: [tnotesMarkdown()] })
  const tr = state.update(insertItemSpec(state, insertItem(id)!, at, remove))
  return { doc: tr.state.doc.toString(), cursor: tr.state.selection.main.head }
}

describe('slash menu trigger', () => {
  it('opens on / at the start of a line or after a space', () => {
    const view = mount('段落\n\n', 4)
    type(view, '/')
    expect(slashStateOf(view.state)).toEqual({ from: 4, query: '' })

    const inline = mount('文字 ', 3)
    type(inline, '/')
    expect(slashStateOf(inline.state)).not.toBeNull()
  })

  it('also opens on 、 (the / key under a Chinese input method)', () => {
    const view = mount('\n', 0)
    type(view, '、')
    expect(slashStateOf(view.state)).toEqual({ from: 0, query: '' })
  })

  it('stays closed right after text, inside code, and in source mode', () => {
    const glued = mount('a/b', 1)
    type(glued, '/')
    expect(slashStateOf(glued.state)).toBeNull()

    const code = mount('```js\n\n```\n', 6)
    type(code, '/')
    expect(slashStateOf(code.state)).toBeNull()

    const source = mount('\n', 0, {}, false)
    type(source, '/')
    expect(slashStateOf(source.state)).toBeNull()
  })

  it('tracks the query and closes on a space or when the slash is deleted', () => {
    const view = mount('\n', 0)
    type(view, '/swd')
    expect(slashStateOf(view.state)?.query).toBe('swd')
    type(view, ' ')
    expect(slashStateOf(view.state)).toBeNull()

    const again = mount('\n', 0)
    type(again, '/')
    again.dispatch({ changes: { from: 0, to: 1 }, userEvent: 'delete.backward' })
    expect(slashStateOf(again.state)).toBeNull()
  })

  it('Escape closes the menu and leaves the typed text', () => {
    const view = mount('\n', 0)
    type(view, '/ta')
    press(view, 'Escape')
    expect(slashStateOf(view.state)).toBeNull()
    expect(view.state.doc.toString()).toBe('/ta\n')
  })

  it('Enter inserts the best match and removes /query', () => {
    const view = mount('前文\n\n后文', 3)
    type(view, '/swdt')
    press(view, 'Enter')
    expect(slashStateOf(view.state)).toBeNull()
    expect(view.state.doc.toString()).toBe(
      '前文\n\n```mindmap\n# 中心主题\n\n- 分支一\n- 分支二\n```\n\n后文'
    )
  })

  it('ArrowDown moves the selection before Enter', () => {
    const view = mount('\n', 0)
    type(view, '/h')
    press(view, 'ArrowDown')
    press(view, 'Enter')
    // h1, h2, h3 … → 第二项
    expect(view.state.doc.toString()).toBe('## \n')
  })

  it('Enter with no match falls through to a normal newline', () => {
    const view = mount('\n', 0)
    type(view, '/zzzz')
    press(view, 'Enter')
    expect(slashStateOf(view.state)).toBeNull()
  })

  it('image hands the empty line to the host picker', () => {
    const pickImage = vi.fn()
    const view = mount('正文\n\n', 3, { pickImage })
    type(view, '/tp')
    press(view, 'Enter')
    expect(view.state.doc.toString()).toBe('正文\n\n\n')
    expect(pickImage).toHaveBeenCalledWith(view, 4)
  })
})

describe('insert catalog', () => {
  it('matches aliases before labels and keeps the catalog order', () => {
    expect(filterInsertItems(INSERT_ITEMS, 'swdt')[0].id).toBe('mindmap')
    expect(filterInsertItems(INSERT_ITEMS, 'mindmap')[0].id).toBe('mindmap')
    expect(filterInsertItems(INSERT_ITEMS, '思维')[0].id).toBe('mindmap')
    expect(filterInsertItems(INSERT_ITEMS, 'tsk')[0].id).toBe('tip')
    expect(filterInsertItems(INSERT_ITEMS, 'bg')[0].id).toBe('table')
    expect(filterInsertItems(INSERT_ITEMS, '提示')[0].id).toBe('tip')
    expect(filterInsertItems(INSERT_ITEMS, 'qqqq')).toEqual([])
  })

  it('every alias is unique so the first match is predictable', () => {
    const seen = new Map<string, string>()
    for (const item of INSERT_ITEMS) {
      for (const alias of item.aliases) {
        expect(seen.get(alias), `${alias}: ${item.id} / ${seen.get(alias)}`).toBeUndefined()
        seen.set(alias, item.id)
      }
    }
  })

  it('inside a callout offers code but no other containers or diagrams', () => {
    const view = mount('::: tip\n\n:::\n', 8)
    const ids = availableItems(view.state, 'slash').map((item) => item.id)
    expect(ids).toContain('code')
    expect(ids).toContain('h2')
    expect(ids).not.toContain('tip')
    expect(ids).not.toContain('mermaid')
    expect(ids).not.toContain('canvas')
  })

  it('respects the host exclusions', () => {
    const view = mount('\n', 0, { exclude: ['canvas'] })
    expect(availableItems(view.state, 'toolbar').map((item) => item.id)).not.toContain('canvas')
  })
})

describe('block insertion', () => {
  it('replaces an empty line and puts the cursor inside the block', () => {
    const result = apply('段落\n\n\n', 4, 'code')
    expect(result.doc).toBe('段落\n\n```js\n\n```\n')
    expect(result.cursor).toBe('段落\n\n```js\n'.length)
    // 前一行有字：块紧跟段落之后会被并进去，所以先空一行
    const padded = apply('段落\n', 3, 'code')
    expect(padded.doc).toBe('段落\n\n```js\n\n```\n')
    expect(padded.cursor).toBe('段落\n\n```js\n'.length)
  })

  it('appends below a line that still has text', () => {
    const result = apply('文字 /tsk\n下一段', 3, 'tip', { from: 3, to: 7 })
    expect(result.doc).toBe('文字 \n\n::: tip\n\n:::\n\n下一段')
    expect(result.cursor).toBe('文字 \n\n::: tip\n'.length)
  })

  it('does not pad against a callout open / close line', () => {
    const result = apply('::: tip\n\n:::\n', 8, 'code')
    expect(result.doc).toBe('::: tip\n```js\n\n```\n\n:::\n')
  })

  it('leaves the cursor after blocks without a caret', () => {
    const result = apply('\n', 0, 'divider')
    expect(result.doc).toBe('---\n')
    expect(result.cursor).toBe(4)
  })

  it('prefix items rewrite the current line and keep its text', () => {
    expect(apply('标题 /h2', 3, 'h2', { from: 3, to: 6 }).doc).toBe('## 标题 ')
    expect(apply('- 事项', 0, 'quote').doc).toContain('::: quote')
  })

  it('runInsertItem from the toolbar inserts at the cursor line', () => {
    const view = mount('第一段', 3)
    runInsertItem(view, insertItem('table')!)
    expect(view.state.doc.toString()).toBe('第一段\n\n|  |  |\n| --- | --- |\n|  |  |\n')
    expect(view.state.selection.main.head).toBe('第一段\n\n| '.length)
  })
})
