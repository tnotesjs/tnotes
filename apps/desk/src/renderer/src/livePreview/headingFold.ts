import { foldEffect, foldService, foldedRanges, syntaxTree, unfoldEffect } from '@codemirror/language'
import { EditorView, WidgetType } from '@codemirror/view'

import { EditorSelection, EditorState, Transaction, type StateEffect, type TransactionSpec } from '@codemirror/state'

export type HeadingFoldLevel = 1 | 2 | 3 | 4 | 5 | 6
export type HeadingFoldCommand =
  | 'fold-all'
  | 'unfold-all'
  | `fold-level-${HeadingFoldLevel}`
  | `unfold-level-${HeadingFoldLevel}`

interface HeadingSection {
  level: number
  /** 标题行末尾（折叠从这里开始） */
  lineEnd: number
  /** 这一节的结束（下一个同级或更高级标题之前） */
  end: number
}

export function headingSections(state: EditorState): HeadingSection[] {
  const doc = state.doc
  const headings: Array<{ level: number; from: number }> = []
  const cursor = syntaxTree(state).cursor()
  if (cursor.firstChild()) {
    do {
      const match = /^ATXHeading([1-6])$/.exec(cursor.name)
      if (match) headings.push({ level: Number(match[1]), from: cursor.from })
    } while (cursor.nextSibling())
  }
  return headings.map((heading, index) => {
    const line = doc.lineAt(heading.from)
    let end = doc.length
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) {
        // 留住下一个标题前面的那个换行，标题才不会被接到上一行末尾。
        end = doc.lineAt(headings[next].from).from - 1
        break
      }
    }
    return { level: heading.level, lineEnd: line.to, end: Math.max(line.to, end) }
  })
}

/** 让 CodeMirror 的折叠命令（以及折叠槽）认识标题小节 */
export const headingFoldService = foldService.of((state, _lineStart, lineEnd) => {
  const section = headingSections(state).find((item) => item.lineEnd === lineEnd)
  if (!section || section.end <= section.lineEnd) return null
  return { from: section.lineEnd, to: section.end }
})

/** 光标落进已收起的正文时，拉回这一节标题的末尾，并取消因此触发的自动展开。 */
export const keepCursorOutOfFold = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || !tr.newSelection.main.empty) return tr
  if (tr.annotation(Transaction.userEvent) === 'select.fold-clamp') return tr
  const head = tr.newSelection.main.head
  let edge: number | null = null
  foldedRanges(tr.startState).between(0, tr.startState.doc.length, (from, to) => {
    if (head > from && head < to) edge = from
  })
  if (edge == null) return tr
  const effects = tr.effects.filter((effect) => {
    if (!effect.is(unfoldEffect)) return true
    const value = effect.value as { from: number; to: number }
    return !(head > value.from && head < value.to)
  })
  const spec: TransactionSpec = {
    changes: tr.changes,
    effects,
    selection: EditorSelection.cursor(edge),
    scrollIntoView: false,
    filter: false,
    userEvent: 'select.fold-clamp'
  }
  return spec
})

/** 命令面板的「折叠/展开标题」：按命令挑出要处理的标题小节 */
export function applyHeadingFoldCommand(view: EditorView, command: HeadingFoldCommand): boolean {
  const state = view.state
  const sections = headingSections(state).filter((section) => section.end > section.lineEnd)
  if (sections.length === 0) return false
  const cursorLine = state.doc.lineAt(state.selection.main.head)
  const unfold = command.startsWith('unfold')
  const levelMatch = /(\d)$/.exec(command)
  let targets: HeadingSection[]
  if (command.includes('All') || command.includes('all')) {
    targets = levelMatch ? sections.filter((section) => section.level === Number(levelMatch[1])) : sections
  } else if (levelMatch) {
    targets = sections.filter((section) => section.level === Number(levelMatch[1]))
  } else {
    const current = [...sections]
      .reverse()
      .find((section) => section.lineEnd <= cursorLine.to && section.end >= cursorLine.from)
    targets = current ? [current] : []
  }
  if (targets.length === 0) return false
  const folded = foldedRanges(state)
  const effects: StateEffect<unknown>[] = []
  for (const section of targets) {
    let isFolded = false
    folded.between(section.lineEnd, section.lineEnd, (from, to) => {
      if (from === section.lineEnd && to === section.end) isFolded = true
    })
    if (unfold && isFolded) effects.push(unfoldEffect.of({ from: section.lineEnd, to: section.end }))
    if (!unfold && !isFolded) effects.push(foldEffect.of({ from: section.lineEnd, to: section.end }))
  }
  if (effects.length > 0) view.dispatch({ effects })
  return true
}

export function isHeadingFolded(state: EditorState, lineEnd: number, end: number): boolean {
  let folded = false
  foldedRanges(state).between(lineEnd, lineEnd, (from, to) => {
    if (from === lineEnd && to === end) folded = true
  })
  return folded
}

/** 折叠范围签名：预览装饰在折叠变化时要重建。 */
export function headingFoldKey(state: EditorState): string {
  const parts: string[] = []
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    parts.push(`${from}-${to}`)
  })
  return parts.join('|')
}

const CHEVRON =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>'

/** 标题左侧的折叠箭头，交互对齐站点：展开时悬停才出现，折叠后一直显示。 */
export class HeadingFoldToggle extends WidgetType {
  constructor(
    private readonly folded: boolean,
    private readonly label: string
  ) {
    super()
  }

  eq(other: HeadingFoldToggle): boolean {
    return other.folded === this.folded && other.label === this.label
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-lp-heading-toggle'
    button.dataset.folded = this.folded ? 'true' : 'false'
    button.setAttribute('aria-expanded', this.folded ? 'false' : 'true')
    button.title = `${this.folded ? '展开' : '折叠'} ${this.label}`
    button.setAttribute('aria-label', button.title)
    button.innerHTML = CHEVRON
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      let pos: number
      try {
        pos = view.posAtDOM(button)
      } catch {
        return
      }
      const line = view.state.doc.lineAt(pos)
      const section = headingSections(view.state).find((item) => item.lineEnd === line.to)
      if (!section || section.end <= section.lineEnd) return
      const folded = isHeadingFolded(view.state, section.lineEnd, section.end)
      view.dispatch({
        effects: folded
          ? unfoldEffect.of({ from: section.lineEnd, to: section.end })
          : foldEffect.of({ from: section.lineEnd, to: section.end })
      })
    })
    return button
  }

  ignoreEvent(): boolean {
    return true
  }
}
