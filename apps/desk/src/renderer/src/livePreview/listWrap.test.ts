// @vitest-environment happy-dom
import { codeFolding, foldEffect, foldedRanges } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { livePreviewField, setFocused } from './decorations'
import { tnotesMarkdown } from './language'
import { listFoldService, listItemFoldRange, toggleListItemFold } from './listFold'
import { listLineIndent } from './listWrap'

function stateOf(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [tnotesMarkdown(), EditorState.tabSize.of(4), listFoldService]
  })
}

function indentOf(doc: string, lineNumber: number): ReturnType<typeof listLineIndent> {
  const state = stateOf(doc)
  return listLineIndent(state, state.doc.line(lineNumber).from)
}

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [tnotesMarkdown(), listFoldService, codeFolding(), livePreviewField]
    })
  })
  view.dispatch({ effects: setFocused.of(false) })
  views.push(view)
  return view
}

describe('list line indent', () => {
  it('keeps the leading indent, depth, and guides at parent markers', () => {
    const doc = '- item1\n    - item2\n        - item3\n    - item4\n'
    expect(indentOf(doc, 1)).toEqual({ indent: 0, leading: 0, guides: [], depth: 0, marker: true })
    expect(indentOf(doc, 2)).toEqual({ indent: 4, leading: 4, guides: [0], depth: 1, marker: true })
    expect(indentOf(doc, 3)).toEqual({
      indent: 8,
      leading: 8,
      guides: [0, 4],
      depth: 2,
      marker: true
    })
    expect(indentOf(doc, 4)).toEqual({ indent: 4, leading: 4, guides: [0], depth: 1, marker: true })
  })

  it('gives two-space and tab nesting the same depth', () => {
    expect(indentOf('- a\n  - b\n', 2)).toMatchObject({ indent: 2, depth: 1 })
    expect(indentOf('- a\n\t- b\n', 2)).toMatchObject({ indent: 4, leading: 1, depth: 1 })
  })

  it('handles ordered items and tasks the same way', () => {
    expect(indentOf('1. a\n    1. b\n', 2)).toMatchObject({ indent: 4, depth: 1, marker: true })
    expect(indentOf('- [ ] a\n    - [x] b\n', 2)).toMatchObject({
      indent: 4,
      depth: 1,
      marker: true
    })
  })

  it('marks a continuation paragraph inside an item', () => {
    expect(indentOf('- a\n\n  续段\n', 3)).toEqual({
      indent: 2,
      leading: 2,
      guides: [0],
      depth: 0,
      marker: false
    })
  })

  it('ignores paragraphs and code inside lists', () => {
    expect(indentOf('普通段落\n', 1)).toBeNull()
    expect(indentOf('- a\n\n    ```js\n    x\n    ```\n', 4)).toBeNull()
  })
})

describe('list item folding', () => {
  it('folds an item with children from its first line end to its last child', () => {
    const doc = '- a\n    - b\n        - c\n- d\n'
    const state = stateOf(doc)
    expect(listItemFoldRange(state, 0)).toEqual({ from: 3, to: doc.indexOf('\n- d') })
    expect(listItemFoldRange(state, state.doc.line(2).from)).toEqual({
      from: state.doc.line(2).to,
      to: state.doc.line(3).to
    })
    expect(listItemFoldRange(state, state.doc.line(3).from)).toBeNull()
    expect(listItemFoldRange(state, state.doc.line(4).from)).toBeNull()
  })

  it('toggles the fold and shows the triangle in the visual view', () => {
    const view = mount('- a\n    - b\n- c\n')
    const toggles = view.dom.querySelectorAll('.cm-lp-list-toggle')
    expect(toggles).toHaveLength(1)
    expect(toggles[0]?.getAttribute('data-folded')).toBe('false')

    expect(toggleListItemFold(view, 0)).toBe(true)
    let folded = 0
    foldedRanges(view.state).between(0, view.state.doc.length, () => {
      folded += 1
    })
    expect(folded).toBe(1)
    expect(view.dom.querySelector('.cm-lp-list-toggle')?.getAttribute('data-folded')).toBe('true')

    expect(toggleListItemFold(view, 0)).toBe(true)
    expect(view.dom.querySelector('.cm-lp-list-toggle')?.getAttribute('data-folded')).toBe('false')
  })

  it('uses depth classes, hides the source indent, and cycles bullet shapes', () => {
    const view = mount('- a\n    - b\n        - c\n            - d\n')
    const lines = [...view.dom.querySelectorAll<HTMLElement>('.cm-line.cm-lp-li')]
    expect(lines.map((line) => line.style.getPropertyValue('--lp-depth'))).toEqual([
      '0',
      '1',
      '2',
      '3'
    ])
    expect(lines.map((line) => line.textContent)).toEqual(['a', 'b', 'c', 'd'])
    expect(
      [...view.dom.querySelectorAll<HTMLElement>('.cm-lp-bullet')].map(
        (bullet) => bullet.dataset.shape
      )
    ).toEqual(['disc', 'circle', 'square', 'disc'])
    view.dispatch({ effects: foldEffect.of({ from: 3, to: view.state.doc.line(4).to }) })
    expect(view.dom.querySelectorAll('.cm-line.cm-lp-li')).toHaveLength(1)
  })

  it('draws a guide per ancestor level, plus its own level on continuation lines', () => {
    const view = mount('- a\n    - b\n\n      续段\n')
    const guides = (lineNumber: number): number => {
      const line = view.domAtPos(view.state.doc.line(lineNumber).from).node
      const element = (
        line instanceof HTMLElement ? line : line.parentElement
      )?.closest<HTMLElement>('.cm-line')
      return element?.getAttribute('style')?.match(/linear-gradient/g)?.length ?? 0
    }
    expect([guides(1), guides(2), guides(4)]).toEqual([0, 1, 2])
  })

  it('shows only the checkbox for task items and toggles it in place', () => {
    const view = mount('- [x] a\n- [ ] b\n')
    expect(view.dom.querySelectorAll('.cm-lp-bullet')).toHaveLength(0)
    const boxes = view.dom.querySelectorAll<HTMLInputElement>('.cm-lp-task-marker .cm-lp-task')
    expect([...boxes].map((box) => box.checked)).toEqual([true, false])
    boxes[1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(view.state.doc.toString()).toBe('- [x] a\n- [x] b\n')
  })
})
