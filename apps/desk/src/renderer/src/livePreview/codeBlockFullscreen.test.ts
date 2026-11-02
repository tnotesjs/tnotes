// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { codeBlockFullscreenClass, toggleCodeFullscreen } from './codeBlockChrome'
import { tnotesMarkdown } from './language'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

function mount(): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '正文\n\n```js\nconst a = 1\n```\n',
      extensions: [tnotesMarkdown(), codeBlockFullscreenClass]
    })
  })
  views.push(view)
  return view
}

describe('code block fullscreen shell flag', () => {
  it('marks the editor as the fullscreen layer and flags the body while open', () => {
    const view = mount()
    const before = view.state.doc.toString()
    view.dispatch({ effects: toggleCodeFullscreen.of(4) })
    expect(view.dom.classList.contains('cm-lp-code-fs')).toBe(true)
    expect(view.dom.dataset.tnFullscreenLayer).toBe('')
    expect(document.body.dataset.tnFullscreen).toBe('')

    view.dispatch({ effects: toggleCodeFullscreen.of(4) })
    expect(view.dom.dataset.tnFullscreenLayer).toBeUndefined()
    expect(document.body.dataset.tnFullscreen).toBeUndefined()
    expect(view.state.doc.toString()).toBe(before)
  })

  it('drops the body flag when the editor is destroyed mid-fullscreen', () => {
    const view = mount()
    view.dispatch({ effects: toggleCodeFullscreen.of(4) })
    views.splice(0)
    view.destroy()
    expect(document.body.dataset.tnFullscreen).toBeUndefined()
  })
})
