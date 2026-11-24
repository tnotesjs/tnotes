// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { codeFolding, foldEffect, foldedRanges } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { livePreviewField } from './decorations'
import {
  headingFoldService,
  headingSections,
  isHeadingFolded,
  keepCursorOutOfFold
} from './headingFold'
import { tnotesMarkdown } from './language'
import { slashCommand } from './slashCommand'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views) view.destroy()
  views.length = 0
  document.body.replaceChildren()
})

const doc = '# 导读\n\n中间\n\n# 下一节\n'

function editor(head: number, preview = false): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(head),
      extensions: [
        tnotesMarkdown(),
        codeFolding({ placeholderText: '…' }),
        headingFoldService,
        keepCursorOutOfFold,
        slashCommand,
        ...(preview ? [livePreviewField] : [])
      ]
    })
  })
  views.push(view)
  view.observer.stop()
  view.focus()
  view.dispatch({})
  return view
}

function guide(view: EditorView) {
  return headingSections(view.state).find((section) =>
    view.state.doc.lineAt(section.lineEnd).text.includes('导读')
  )!
}

async function foldGuide(view: EditorView): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  const block = (event: Event) => event.stopImmediatePropagation()
  document.addEventListener('selectionchange', block, true)
  const section = guide(view)
  try {
    view.dispatch({ effects: foldEffect.of({ from: section.lineEnd, to: section.end }) })
  } finally {
    document.removeEventListener('selectionchange', block, true)
  }
}

function typeChar(view: EditorView, char: string): void {
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: char },
    selection: EditorSelection.cursor(head + char.length),
    userEvent: 'input.type'
  })
}

function hint(view: EditorView): string | null {
  return view.dom.querySelector('.cm-lp-slash-hint')?.textContent ?? null
}

describe('folded heading cursor', () => {
  it('moves the cursor to the heading end when folding from an interior empty line', async () => {
    const view = editor(doc.indexOf('\n\n') + 1)
    const section = guide(view)
    expect(hint(view)).toBe('输入 / 唤起更多')
    await foldGuide(view)
    expect(view.state.selection.main.head).toBe(section.lineEnd)
    expect(view.state.selection.main.assoc).toBe(-1)
    expect(hint(view)).toBeNull()
    expect(isHeadingFolded(view.state, section.lineEnd)).toBe(true)
  })

  it('moves the cursor off the blank line before the next heading and hides the hint', async () => {
    const view = editor(0)
    const section = guide(view)
    view.dispatch({ selection: EditorSelection.cursor(section.end) })
    expect(hint(view)).toBe('输入 / 唤起更多')
    await foldGuide(view)
    expect(view.state.selection.main.head).toBe(section.lineEnd)
    expect(hint(view)).toBeNull()
  })

  it('appends typed characters to the heading in key order', async () => {
    const view = editor(doc.indexOf('\n\n') + 1)
    await foldGuide(view)
    typeChar(view, '1')
    typeChar(view, '2')
    typeChar(view, '3')
    expect(view.state.doc.toString()).toContain('# 导读123\n')
    expect(view.state.doc.toString()).toContain('中间')
    expect(view.state.doc.toString()).not.toContain('321')
    const guideLine = Array.from({ length: view.state.doc.lines }, (_, index) =>
      view.state.doc.line(index + 1)
    ).find((item) => item.text.startsWith('# 导读'))!
    expect(view.state.selection.main.head).toBe(guideLine.to)
    expect(isHeadingFolded(view.state, guideLine.to)).toBe(true)
  })

  it('skips to the next heading when moving right from the folded heading', async () => {
    const view = editor(doc.indexOf('\n\n') + 1)
    const section = guide(view)
    await foldGuide(view)
    view.dispatch({
      selection: EditorSelection.cursor(section.end),
      userEvent: 'select'
    })
    expect(view.state.selection.main.head).toBe(section.end + 1)
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toContain('下一节')
  })

  it('returns a click on the folded side to the heading end', async () => {
    const view = editor(doc.indexOf('\n\n') + 1)
    const section = guide(view)
    await foldGuide(view)
    view.dispatch({
      selection: EditorSelection.cursor(section.end),
      userEvent: 'select.pointer'
    })
    expect(view.state.selection.main.head).toBe(section.lineEnd)
    expect(view.state.selection.main.assoc).toBe(-1)
  })

  it('unfolds from the chevron when the stored fold end no longer matches the section', async () => {
    const view = editor(0, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const section = guide(view)
    const block = (event: Event) => event.stopImmediatePropagation()
    document.addEventListener('selectionchange', block, true)
    try {
      view.dispatch({
        effects: foldEffect.of({ from: section.lineEnd, to: section.lineEnd + 1 })
      })
    } finally {
      document.removeEventListener('selectionchange', block, true)
    }
    expect(isHeadingFolded(view.state, section.lineEnd)).toBe(true)
    const button = [...view.dom.querySelectorAll('.cm-lp-heading-toggle')].find((element) =>
      element.getAttribute('aria-label')?.includes('导读')
    ) as HTMLButtonElement
    expect(button.dataset.folded).toBe('true')
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(isHeadingFolded(view.state, section.lineEnd)).toBe(false)
    const ranges: Array<{ from: number; to: number }> = []
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      ranges.push({ from, to })
    })
    expect(ranges).toEqual([])
  })

  it('hides the heading fold placeholder and keeps it for other folds', () => {
    const css = readFileSync('src/renderer/src/livePreview/livePreview.css', 'utf8')
    expect(css).toMatch(/\.cm-lp-heading \.cm-foldPlaceholder \{\s*display:\s*none;/)
    expect(css).toMatch(/\.cm-lp-li \.cm-foldPlaceholder \{\s*display:\s*none;/)
  })
})
