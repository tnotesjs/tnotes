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
import { codeGroupTabs, keepCursorOutOfHiddenCodeGroup, livePreviewField, setFocused } from './decorations'
import { tnotesMarkdown } from './language'
import { renumberOrderedLists } from './lists'
import { codeBlockFullscreenClass } from './codeBlockChrome'

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
    // 没有单独的标题栏：标题在标签上，语言、复制、全屏、折叠都在标签栏里
    expect(view.dom.querySelector('.cm-lp-code-header')).toBeNull()
    expect(view.dom.querySelector('.cm-lp-code-tab.is-active')?.textContent).toBe('a.js')
    const tabs = view.dom.querySelector('.cm-lp-code-tabs')!
    expect((tabs.querySelector('.cm-lp-code-lang-input') as HTMLInputElement).value).toBe('js')
    expect(tabs.querySelector('.cm-lp-code-fold')).not.toBeNull()
    expect(tabs.querySelector('.cm-lp-code-copy')).not.toBeNull()
    expect(tabs.querySelector('.cm-lp-code-expand')).not.toBeNull()
    expect(text).not.toContain('```')
  })

  it('folds the whole code group from the tab bar and unfolds when a tab is picked', () => {
    const doc = ['::: code-group', '```js [a.js]', 'aaa', '```', '```ts [b.ts]', 'bbb', '```', ':::', '', '后文', ''].join('\n')
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(doc.indexOf('后文')),
        extensions: [tnotesMarkdown(), codeGroupTabs, codeBlockFullscreenClass, keepCursorOutOfHiddenCodeGroup, livePreviewField]
      })
    })
    views.push(view)
    const fold = () => view.dom.querySelector<HTMLButtonElement>('.cm-lp-code-tabs .cm-lp-code-fold')!
    fold().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(view.contentDOM.textContent).not.toContain('aaa')
    expect(fold().classList.contains('is-collapsed')).toBe(true)
    expect(view.dom.querySelector('.cm-lp-code-group-collapsed')).not.toBeNull()

    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf('aaa')) })
    expect(view.state.selection.main.head).not.toBe(doc.indexOf('aaa'))

    fold().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(view.contentDOM.textContent).toContain('aaa')
  })

  it('renames a code-group tab in place and writes the title into the fence', () => {
    const doc = ['::: code-group', '```js [a.js]', 'aaa', '```', '```ts [b.ts]', 'bbb', '```', ':::', ''].join('\n')
    const view = mount(doc, doc.indexOf('aaa'))
    const tab = view.dom.querySelector<HTMLElement>('.cm-lp-code-tab.is-active')!
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }))
    const rename = [...document.querySelectorAll<HTMLButtonElement>('.cm-lp-code-tab-menu button')].find(
      (button) => button.textContent === '重命名'
    )!
    rename.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const input = view.dom.querySelector<HTMLInputElement>('.cm-lp-code-tab-rename')!
        expect(input.value).toBe('a.js')
        input.value = 'main.js'
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        expect(view.state.doc.line(2).text).toBe('```js [main.js]')
        expect(view.dom.querySelector('.cm-lp-code-tab.is-active')?.textContent).toBe('main.js')
        resolve()
      }, 60)
    })
  })

  it('keeps a code group as decorated source when the cursor is outside, so focusing does not jump', () => {
    const doc = ['前文', '', '::: code-group', '```js {2} [a.js]', 'aaa', 'aaa2', '```', '```ts [b.ts]', 'bbb', '```', ':::', ''].join('\n')
    const view = mount(doc, 0)
    const shape = (): string[] =>
      [...view.contentDOM.querySelectorAll('.cm-line')]
        .map((line) => line.className.replace(/\bcm-activeLine\b/, '').trim())
        .filter(Boolean)
    expect(view.dom.querySelector('.cm-lp-card')).toBeNull()
    expect(view.dom.querySelector('.cm-lp-code-tabs')).not.toBeNull()
    expect(view.contentDOM.textContent).not.toContain('bbb')
    const outside = shape()

    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf('aaa2')) })
    expect(shape()).toEqual(outside)

    view.dispatch({ effects: setFocused.of(false) })
    expect(shape()).toEqual(outside)
  })

  it('hides blank lines between code-group panels without merging the tab bar into the header', () => {
    const doc = ['::: code-group', '', '```js [a.js]', 'aaa', '```', '', '```ts [b.ts]', 'bbb', '```', '', ':::', ''].join('\n')
    const view = mount(doc, doc.indexOf('aaa'))
    const lines = [...view.contentDOM.querySelectorAll('.cm-line')]
    const tabs = lines.find((line) => line.querySelector('.cm-lp-code-tabs'))
    const code = lines.find((line) => line.textContent === 'aaa')
    expect(tabs).toBeDefined()
    expect(code).not.toBe(tabs)
    expect(code?.className).toContain('cm-lp-codeblock')
    expect(view.contentDOM.textContent).not.toContain('bbb')
  })

  it('keeps a cursor coming from outside the code group out of the hidden panel', () => {
    const doc = ['前文', '', '::: code-group', '```js [a.js]', 'aaa', '```', '```ts [b.ts]', 'bbb', '```', ':::', ''].join('\n')
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(0),
        extensions: [tnotesMarkdown(), codeGroupTabs, keepCursorOutOfHiddenCodeGroup, livePreviewField]
      })
    })
    views.push(view)
    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf('bbb')) })
    const head = view.state.selection.main.head
    expect(head < doc.indexOf('```ts') || head > doc.indexOf('bbb') + 3).toBe(true)
  })

  it('numbers code lines and marks the highlighted ones from the fence meta', () => {
    const doc = ['```js {2}', 'a', 'b', 'c', '```', ''].join('\n')
    const view = mount(doc, doc.length)
    const lines = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-line[data-code-line]')]
    expect(lines.map((line) => line.dataset.line)).toEqual(['1', '2', '3'])
    expect(lines.map((line) => line.classList.contains('cm-lp-code-highlighted'))).toEqual([false, true, false])
  })
})
