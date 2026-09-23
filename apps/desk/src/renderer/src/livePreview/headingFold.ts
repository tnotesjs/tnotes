import { foldEffect, foldService, foldedRanges, syntaxTree, unfoldEffect } from '@codemirror/language'

import type { EditorState, StateEffect } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

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

function headingSections(state: EditorState): HeadingSection[] {
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
        end = doc.lineAt(headings[next].from).from - 1
        break
      }
    }
    while (end > line.to && /^\s*$/.test(doc.lineAt(end).text)) {
      const current = doc.lineAt(end)
      end = current.from - 1
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
