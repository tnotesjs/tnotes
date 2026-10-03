// @vitest-environment happy-dom

import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { afterEach, describe, expect, it } from 'vitest'

import { DESK_SELECT_ALL_EVENT } from './markdown/documentSelection'
import { selectAllInRenderer } from './selectAll'

describe('selectAllInRenderer', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('selects the focused input instead of broadcasting to the note', () => {
    const input = document.createElement('input')
    input.value = 'hello'
    document.body.append(input)
    input.focus()
    const seen: Event[] = []
    window.addEventListener(DESK_SELECT_ALL_EVENT, (event) => seen.push(event))
    selectAllInRenderer()
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(5)
    expect(seen).toHaveLength(0)
  })

  it('selects the focused CodeMirror document', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const view = new EditorView({
      state: EditorState.create({ doc: 'alpha\nbeta' }),
      parent: host
    })
    view.focus()
    selectAllInRenderer()
    expect(view.state.selection.main.from).toBe(0)
    expect(view.state.selection.main.to).toBe(view.state.doc.length)
    view.destroy()
  })

  it('selects the last nested CodeMirror after the menu accelerator blurs it', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const view = new EditorView({
      state: EditorState.create({ doc: 'alpha\nbeta' }),
      parent: host
    })
    view.focus()
    view.contentDOM.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    view.contentDOM.blur()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    const seen: Event[] = []
    window.addEventListener(DESK_SELECT_ALL_EVENT, (event) => seen.push(event))
    selectAllInRenderer()
    expect(seen).toHaveLength(0)
    expect(view.state.selection.main.from).toBe(0)
    expect(view.state.selection.main.to).toBe(view.state.doc.length)
    view.destroy()
  })

  it('broadcasts desk:select-all when no field is focused', () => {
    const seen: Event[] = []
    window.addEventListener(DESK_SELECT_ALL_EVENT, (event) => seen.push(event))
    document.body.focus?.()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    selectAllInRenderer()
    expect(seen).toHaveLength(1)
  })
})
