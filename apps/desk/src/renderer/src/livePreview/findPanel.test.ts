// @vitest-environment happy-dom

import { ensureSyntaxTree } from '@codemirror/language'
import { searchPanelOpen } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { codeBlockChrome, codeBlockFullscreenClass, toggleCodeCollapse } from './codeBlockChrome'
import { codeGroupTabs, keepCursorOutOfHiddenCodeGroup, livePreviewField } from './decorations'
import { findExtension, findScopeField, loadFindOptions, openFind } from './findPanel'
import { handleGlobalFindKey } from './findTargets'
import { tnotesMarkdown } from './language'

let views: EditorView[] = []

function editor(doc: string, anchor = 0, head = anchor): EditorView {
  const host = document.createElement('div')
  document.body.append(host)
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor, head }, extensions: [findExtension()] }),
    parent: host
  })
  views.push(view)
  return view
}

function panel(view: EditorView) {
  const root = view.dom.querySelector<HTMLElement>('.cm-find-panel')!
  const inputs = root.querySelectorAll<HTMLInputElement>('.cm-find-input')
  const byLabel = (label: string): HTMLButtonElement =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      item.getAttribute('aria-label')?.startsWith(label)
    )!
  return {
    root,
    find: inputs[0],
    replace: inputs[1],
    replaceRow: root.querySelector<HTMLElement>('.cm-find-replace-row')!,
    count: () => root.querySelector('.cm-find-count')!.textContent,
    button: byLabel,
    type(input: HTMLInputElement, value: string) {
      input.value = value
      input.dispatchEvent(new Event('input'))
    },
    key(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
      )
    }
  }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  for (const view of views) view.destroy()
  views = []
  document.body.replaceChildren()
})

describe('查找条', () => {
  it('计数「当前 / 总数」，Enter / ⇧Enter 前后跳转并循环', () => {
    const view = editor('foo bar foo baz foo')
    openFind(view)
    const ui = panel(view)
    ui.type(ui.find, 'foo')
    expect(ui.count()).toBe('? / 3')
    ui.key(ui.find, 'Enter')
    expect(ui.count()).toBe('1 / 3')
    ui.key(ui.find, 'Enter')
    expect(view.state.selection.main.from).toBe(8)
    expect(ui.count()).toBe('2 / 3')
    ui.key(ui.find, 'Enter')
    ui.key(ui.find, 'Enter')
    expect(ui.count()).toBe('1 / 3')
    ui.key(ui.find, 'Enter', { shiftKey: true })
    expect(ui.count()).toBe('3 / 3')
  })

  it('没有匹配时显示「无结果」并标红输入框，正则写错显示无效', () => {
    const view = editor('alpha beta')
    openFind(view)
    const ui = panel(view)
    ui.type(ui.find, 'gamma')
    expect(ui.count()).toBe('无结果')
    expect(ui.find.classList.contains('is-missing')).toBe(true)
    ui.button('使用正则表达式').click()
    ui.type(ui.find, '(')
    expect(ui.count()).toBe('表达式无效')
  })

  it('区分大小写、全字匹配开关生效，并记住到下次打开的编辑器', () => {
    const view = editor('Foo foo food')
    openFind(view)
    const ui = panel(view)
    ui.type(ui.find, 'foo')
    expect(ui.count()).toBe('? / 3')
    ui.button('区分大小写').click()
    expect(ui.count()).toBe('? / 2')
    ui.button('全字匹配').click()
    expect(ui.count()).toBe('? / 1')
    expect(loadFindOptions()).toEqual({ caseSensitive: true, wholeWord: true, regexp: false })

    const next = editor('Foo foo')
    openFind(next)
    const nextUi = panel(next)
    expect(nextUi.button('区分大小写').classList.contains('is-active')).toBe(true)
    expect(nextUi.button('全字匹配').classList.contains('is-active')).toBe(true)
  })

  it('替换单处、全部替换，正则捕获组按 $1 写回', () => {
    const view = editor('a@x b@x c@y')
    openFind(view, true)
    const ui = panel(view)
    expect(ui.replaceRow.hidden).toBe(false)
    ui.button('使用正则表达式').click()
    ui.type(ui.find, '(\\w)@x')
    ui.type(ui.replace, '$1!')
    ui.key(ui.find, 'Enter')
    ui.key(ui.replace, 'Enter')
    expect(view.state.doc.toString()).toBe('a! b@x c@y')
    ui.button('全部替换').click()
    expect(view.state.doc.toString()).toBe('a! b! c@y')
  })

  it('在选区中查找：计数、跳转与全部替换都只作用于选区', () => {
    const doc = 'cat cat | cat cat'
    const view = editor(doc, 0, doc.indexOf('|'))
    openFind(view, true)
    const ui = panel(view)
    ui.type(ui.find, 'cat')
    expect(ui.count()).toBe('? / 4')
    ui.button('在选区中查找').click()
    expect(view.state.field(findScopeField)).toEqual({ from: 0, to: doc.indexOf('|') })
    expect(ui.count()).toBe('? / 2')
    ui.type(ui.replace, 'dog')
    ui.button('全部替换').click()
    expect(view.state.doc.toString()).toBe('dog dog | cat cat')
  })

  it('Esc 关闭查找条并把焦点还给正文', () => {
    const view = editor('hello')
    openFind(view)
    const ui = panel(view)
    expect(document.activeElement).toBe(ui.find)
    ui.key(ui.find, 'Escape')
    expect(searchPanelOpen(view.state)).toBe(false)
    expect(view.hasFocus).toBe(true)
  })

  it('查找条内 ⌥⌘F 展开替换并聚焦替换框', () => {
    const view = editor('hello')
    openFind(view)
    const ui = panel(view)
    expect(ui.replaceRow.hidden).toBe(true)
    ui.key(ui.find, 'ƒ', { metaKey: true, altKey: true, code: 'KeyF' })
    expect(ui.replaceRow.hidden).toBe(false)
    expect(document.activeElement).toBe(ui.replace)
  })
})

describe('实时预览里的匹配', () => {
  it('从侧栏打开查找时，跳到被隐藏的标记里也会展开源码', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const doc = 'intro\n\nsome **bold** word'
    const state = EditorState.create({
      doc,
      extensions: [tnotesMarkdown(), livePreviewField, findExtension()]
    })
    ensureSyntaxTree(state, doc.length, 5000)
    const view = new EditorView({ state, parent: host })
    views.push(view)
    expect(view.contentDOM.textContent).not.toContain('**bold**')
    openFind(view)
    const ui = panel(view)
    ui.type(ui.find, '**')
    ui.key(ui.find, 'Enter')
    expect(view.state.selection.main.from).toBe(doc.indexOf('**'))
    expect(view.contentDOM.textContent).toContain('**bold**')
  })

  function previewEditor(doc: string): EditorView {
    const host = document.createElement('div')
    document.body.append(host)
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        tnotesMarkdown(),
        codeGroupTabs,
        codeBlockFullscreenClass,
        keepCursorOutOfHiddenCodeGroup,
        livePreviewField,
        findExtension()
      ]
    })
    ensureSyntaxTree(state, doc.length, 5000)
    const view = new EditorView({ state, parent: host })
    views.push(view)
    return view
  }

  const groupDoc = [
    '::: code-group',
    '```js [a.js]',
    'aaa',
    '```',
    '```ts [b.ts]',
    'needle',
    '```',
    ':::',
    '',
    'tail',
    ''
  ].join('\n')

  it('匹配在代码组没显示的标签里：切到那个标签，而不是把选区挤出去', () => {
    const view = previewEditor(groupDoc)
    expect(view.contentDOM.textContent).not.toContain('needle')
    openFind(view)
    const ui = panel(view)
    ui.type(ui.find, 'needle')
    ui.key(ui.find, 'Enter')
    expect(view.state.selection.main.from).toBe(groupDoc.indexOf('needle'))
    expect(view.state.field(codeGroupTabs).get(0)).toBe(1)
    expect(view.contentDOM.textContent).toContain('needle')
    expect(ui.count()).toBe('1 / 1')
  })

  it('匹配在收起的代码组里：展开整组并切到对应标签', () => {
    const view = previewEditor(groupDoc)
    view.dispatch({ effects: toggleCodeCollapse.of(0) })
    expect(view.state.field(codeBlockChrome).some((mark) => mark.collapsed)).toBe(true)
    openFind(view)
    const ui = panel(view)
    ui.type(ui.find, 'needle')
    ui.key(ui.find, 'Enter')
    expect(view.state.selection.main.from).toBe(groupDoc.indexOf('needle'))
    expect(view.state.field(codeBlockChrome).some((mark) => mark.collapsed)).toBe(false)
    expect(view.contentDOM.textContent).toContain('needle')
  })

  it('匹配在收起的代码块里：展开这个代码块', () => {
    const doc = ['intro', '', '```js', 'const needle = 1', '```', '', 'tail', ''].join('\n')
    const view = previewEditor(doc)
    view.dispatch({ effects: toggleCodeCollapse.of(doc.indexOf('```js')) })
    expect(view.contentDOM.textContent).not.toContain('needle')
    openFind(view)
    const ui = panel(view)
    ui.type(ui.find, 'needle')
    ui.key(ui.find, 'Enter')
    expect(view.state.selection.main.from).toBe(doc.indexOf('needle'))
    expect(view.state.field(codeBlockChrome).some((mark) => mark.collapsed)).toBe(false)
    expect(view.contentDOM.textContent).toContain('needle')
  })
})

describe('窗口级 ⌘F', () => {
  function press(init: KeyboardEventInit): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', cancelable: true, ...init })
  }

  it('焦点在侧栏时打开当前编辑器的查找条，⌥⌘F 打开替换', () => {
    const view = editor('hello')
    const open = vi.fn(() => true)
    expect(handleGlobalFindKey(press({ metaKey: true }), open, () => view)).toBe(true)
    expect(open).toHaveBeenLastCalledWith(view, false)
    expect(handleGlobalFindKey(press({ metaKey: true, altKey: true }), open, () => view)).toBe(true)
    expect(open).toHaveBeenLastCalledWith(view, true)
  })

  it('焦点在终端面板里时让给终端自己的查找', () => {
    const view = editor('hello')
    const terminal = document.createElement('section')
    terminal.className = 'terminal-panel'
    const input = document.createElement('input')
    terminal.append(input)
    document.body.append(terminal)
    input.focus()
    const open = vi.fn(() => true)
    expect(handleGlobalFindKey(press({ metaKey: true }), open, () => view)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('编辑器已经处理过、或者有弹框时不重复打开', () => {
    const view = editor('hello')
    const open = vi.fn(() => true)
    const handled = press({ metaKey: true })
    handled.preventDefault()
    expect(handleGlobalFindKey(handled, open, () => view)).toBe(false)
    const backdrop = document.createElement('div')
    backdrop.className = 'dialog-backdrop'
    document.body.append(backdrop)
    expect(handleGlobalFindKey(press({ metaKey: true }), open, () => view)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
