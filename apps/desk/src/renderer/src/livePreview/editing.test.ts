// @vitest-environment happy-dom
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import {
  continueMarkup,
  headingBackspace,
  tabCommand,
  wrapSelection
} from './commands'
import { taskToggleChange } from './widgets'
import { codeGroupTabs, livePreviewField, setFocused } from './decorations'
import { tnotesMarkdown } from './language'
import { renumberOrderedLists } from './lists'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

function mount(doc: string, cursor: number): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [tnotesMarkdown(), codeGroupTabs, livePreviewField]
    })
  })
  view.dispatch({ effects: setFocused.of(true) })
  views.push(view)
  return view
}

describe('live preview editing', () => {
  it('continues a bullet and an ordered item, and renumbers the ordered list', () => {
    const view = mount('- 苹果\n', 4)
    expect(continueMarkup(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('- 苹果\n- \n')

    const ordered = mount('1. 甲\n2. 乙\n', 4)
    expect(continueMarkup(ordered)).toBe(true)
    expect(ordered.state.doc.toString()).toBe('1. 甲\n2. \n3. 乙\n')
  })

  it('rewrites an all-1 list into consecutive numbers when an item is inserted', () => {
    const view = mount('1. 甲\n1. 乙\n', 4)
    expect(continueMarkup(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('1. 甲\n2. \n3. 乙\n')
  })

  it('turns a heading back into a paragraph with one backspace at the start of the text', () => {
    const doc = '## 标题\n'
    const view = mount(doc, 3)
    expect(headingBackspace(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('标题\n')
  })

  it('indents a list item with Tab', () => {
    const view = mount('- 甲\n- 乙\n', 6)
    expect(tabCommand(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('- 甲\n    - 乙\n')
  })

  it('wraps the selection in bold markers', () => {
    const view = mount('正文\n', 0)
    view.dispatch({ selection: EditorSelection.range(0, 2) })
    wrapSelection(view, '**', '**')
    expect(view.state.doc.toString()).toBe('**正文**\n')
  })

  it('keeps decorating while characters are inserted through a mixed note', () => {
    const doc = [
      '# 标题',
      '',
      '一段 **粗** 和 [链接](https://example.com)。',
      '',
      '- [ ] 待办',
      '- [x] 完成',
      '',
      '1. 甲',
      '1. 乙',
      '',
      '![图](../assets/a.png) {w=200}',
      '',
      '::: code-group',
      '```js [a.js]',
      'const a = 1',
      '```',
      '```ts [b.ts]',
      'const b = 2',
      '```',
      ':::',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      ''
    ].join('\n')
    const view = mount(doc, 0)
    for (let pos = 0; pos < view.state.doc.length; pos += 7) {
      view.dispatch({
        changes: { from: pos, to: pos, insert: '测' },
        selection: EditorSelection.cursor(pos + 1)
      })
      view.dispatch({ changes: { from: pos, to: pos + 1, insert: '' } })
    }
    expect(view.state.doc.toString()).toBe(doc)
    const renumber = renumberOrderedLists(view.state, 0, view.state.doc.length)
    expect(renumber.length).toBeGreaterThan(0)
  })

  it('renders a standalone NotesTable as a card instead of source text', () => {
    const doc = '介绍。\n\n<NotesTable :ids="[\'0028\', \'0014\', \'0002\']" />\n\n后文\n'
    const view = mount(doc, 0)
    const text = view.contentDOM.textContent ?? ''
    expect(text).toContain('介绍')
    expect(text).not.toContain('<NotesTable')
  })

  it('toggles a task marker from either side of the checkbox syntax', () => {
    const doc = '- [ ] 待办\n'
    const mark = doc.indexOf('[')
    expect(taskToggleChange(doc, mark)).toEqual({ from: mark + 1, to: mark + 2, insert: 'x' })
    expect(taskToggleChange(doc, mark + 3)).toEqual({ from: mark + 1, to: mark + 2, insert: 'x' })
    expect(taskToggleChange('- [x] 完成\n', 4)?.insert).toBe(' ')
  })

  it('hides the other code-group panels and the closing fence while the cursor is inside', () => {
    const doc = ['::: code-group', '```js [a.js]', 'aaa', '```', '```ts [b.ts]', 'bbb', '```', ':::', ''].join('\n')
    const view = mount(doc, doc.indexOf('aaa'))
    const text = view.contentDOM.textContent ?? ''
    expect(text).toContain('aaa')
    expect(text).not.toContain('bbb')
    expect(text).not.toContain(':::')
    const headerLine = [...view.dom.querySelectorAll('.cm-line')].find((line) =>
      line.querySelector('.cm-lp-code-header')
    )
    expect(headerLine?.className).toContain('cm-lp-codeblock-first')
    expect((view.dom.querySelector('.cm-lp-code-title') as HTMLInputElement | null)?.value).toBe('a.js')
  })
})
