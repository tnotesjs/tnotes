// @vitest-environment happy-dom

import { codeFolding, foldEffect } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { headingFoldService, headingSections } from './headingFold'
import { livePreviewEnabled } from './host'
import { slashCommand } from './slashCommand'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views) view.destroy()
  views.length = 0
})

function editor(doc: string, head: number): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(head),
      extensions: [
        livePreviewEnabled.of(true),
        markdown(),
        codeFolding(),
        headingFoldService,
        slashCommand
      ]
    })
  })
  views.push(view)
  view.observer.stop()
  view.focus()
  view.dispatch({})
  return view
}

function hint(view: EditorView): string | null {
  return view.dom.querySelector('.cm-lp-slash-hint')?.textContent ?? null
}

describe('slash hint on folded headings', () => {
  const doc = '# 2. s.1\n\n\n正文\n'

  it('shows the hint on a normal empty line', () => {
    const view = editor(doc, doc.indexOf('\n\n') + 1)
    expect(hint(view)).toBe('输入 / 唤起更多')
  })

  it('hides the hint when that empty line is folded into the heading', async () => {
    const view = editor(doc, doc.indexOf('\n\n') + 1)
    expect(hint(view)).toBe('输入 / 唤起更多')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const blockSelection = (event: Event) => event.stopImmediatePropagation()
    document.addEventListener('selectionchange', blockSelection, true)
    const section = headingSections(view.state)[0]
    try {
      view.dispatch({ effects: foldEffect.of({ from: section.lineEnd, to: section.end }) })
    } finally {
      document.removeEventListener('selectionchange', blockSelection, true)
    }
    expect(hint(view)).toBeNull()
  })

  it('hides the hint on the blank line glued to the end of a folded heading', async () => {
    const text = '# 导读\n\n中间\n\n# 下一节\n'
    const view = editor(text, 0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const section = headingSections(view.state)[0]
    view.dispatch({ selection: EditorSelection.cursor(section.end) })
    expect(hint(view)).toBe('输入 / 唤起更多')
    const blockSelection = (event: Event) => event.stopImmediatePropagation()
    document.addEventListener('selectionchange', blockSelection, true)
    try {
      view.dispatch({ effects: foldEffect.of({ from: section.lineEnd, to: section.end }) })
    } finally {
      document.removeEventListener('selectionchange', blockSelection, true)
    }
    expect(view.state.selection.main.head).toBe(section.end)
    expect(hint(view)).toBeNull()
  })

  it('hides the hint when the cursor sits at the end of a folded heading', async () => {
    const view = editor(doc, doc.indexOf('\n'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const blockSelection = (event: Event) => event.stopImmediatePropagation()
    document.addEventListener('selectionchange', blockSelection, true)
    const section = headingSections(view.state)[0]
    try {
      view.dispatch({
        effects: foldEffect.of({ from: section.lineEnd, to: section.end }),
        selection: EditorSelection.cursor(section.lineEnd)
      })
    } finally {
      document.removeEventListener('selectionchange', blockSelection, true)
    }
    expect(hint(view)).toBeNull()
  })
})
