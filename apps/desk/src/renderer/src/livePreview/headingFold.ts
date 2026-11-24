import {
  foldEffect,
  foldService,
  foldedRanges,
  syntaxTree,
  unfoldEffect
} from '@codemirror/language'
import { EditorView, WidgetType } from '@codemirror/view'

import { calloutLayout } from './calloutLayout'

import {
  EditorSelection,
  EditorState,
  Transaction,
  type StateEffect,
  type TransactionSpec
} from '@codemirror/state'

export type HeadingFoldLevel = 1 | 2 | 3 | 4 | 5 | 6
export type HeadingFoldCommand =
  'fold-all' | 'unfold-all' | `fold-level-${HeadingFoldLevel}` | `unfold-level-${HeadingFoldLevel}`

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
  const callouts = calloutLayout(state).blocks
  const cursor = syntaxTree(state).cursor()
  if (cursor.firstChild()) {
    do {
      const match = /^ATXHeading([1-6])$/.exec(cursor.name)
      const pos = cursor.from
      // 提示块里的标题不进目录，也不分节折叠
      if (match && !callouts.some((block) => pos > block.open.to && pos <= block.end))
        headings.push({ level: Number(match[1]), from: pos })
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

interface FoldSpan {
  from: number
  to: number
}

/** 这次事务之后还折着的范围。效果里的位置已经是新文档坐标，旧范围要先映射过去。 */
function foldsAfter(tr: Transaction): FoldSpan[] {
  const ranges: FoldSpan[] = []
  foldedRanges(tr.startState).between(0, tr.startState.doc.length, (from, to) => {
    const start = tr.changes.mapPos(from, 1)
    const end = tr.changes.mapPos(to, -1)
    if (start < end) ranges.push({ from: start, to: end })
  })
  for (const effect of tr.effects) {
    if (effect.is(unfoldEffect)) {
      const value = effect.value as FoldSpan
      const index = ranges.findIndex((range) => range.from === value.from && range.to === value.to)
      if (index >= 0) ranges.splice(index, 1)
    } else if (effect.is(foldEffect)) {
      const value = effect.value as FoldSpan
      if (
        value.from < value.to &&
        !ranges.some((range) => range.from === value.from && range.to === value.to)
      )
        ranges.push(value)
    }
  }
  return ranges
}

function headingLineEnds(tr: Transaction): Set<number> {
  return new Set(
    headingSections(tr.startState).map((section) => tr.changes.mapPos(section.lineEnd, 1))
  )
}

/** 光标落在折叠正文里，或正好落在标题折叠的终点（贴在占位后面的那一空行）。 */
function foldAround(
  folds: FoldSpan[],
  head: number,
  headingFroms: Set<number> | null
): FoldSpan | null {
  let found: FoldSpan | null = null
  for (const fold of folds) {
    const inside = head > fold.from && head < fold.to
    const glued = headingFroms?.has(fold.from) === true && head === fold.to
    if ((inside || glued) && (!found || fold.from >= found.from)) found = fold
  }
  return found
}

/** 标题折叠终点的下一行。文档到这里为止时，退回标题末尾。 */
function afterHeadingFold(doc: Transaction['newDoc'], fold: FoldSpan): number {
  if (fold.to >= doc.length) return fold.from
  const nextLine = doc.lineAt(fold.to).to + 1
  return nextLine <= doc.length ? nextLine : fold.from
}

/**
 * 光标落进已收起的正文，或落在折叠标题占位的右侧时，拉回标题末尾。
 * 从标题末尾再往右走，则落到下一节还能看见的内容上。位置都用这次修改映射之后的坐标。
 */
export const keepCursorOutOfFold = EditorState.transactionFilter.of((tr) => {
  if (tr.annotation(Transaction.userEvent) === 'select.fold-clamp') return tr
  if (!tr.newSelection.main.empty) return tr
  const folds = foldsAfter(tr)
  if (folds.length === 0) return tr
  const head = tr.newSelection.main.head
  const onEdge = folds.some((fold) => fold.to === head)
  const inside = folds.some((fold) => head > fold.from && head < fold.to)
  if (!inside && !onEdge) return tr
  const headingFroms = headingLineEnds(tr)
  const fold = foldAround(folds, head, headingFroms)
  if (!fold) return tr
  const heading = headingFroms.has(fold.from)
  const origin = tr.startState.selection.main.head
  const prev = tr.changes.mapPos(origin, head >= origin ? 1 : -1)
  const forward =
    heading &&
    tr.annotation(Transaction.userEvent) === 'select' &&
    head > prev &&
    prev >= fold.from &&
    prev <= fold.to
  const target = forward ? afterHeadingFold(tr.newDoc, fold) : fold.from
  if (target === head) return tr
  const effects = tr.effects.filter((effect) => {
    if (!effect.is(unfoldEffect)) return true
    const value = effect.value as FoldSpan
    return !(head > value.from && head < value.to)
  })
  const spec: TransactionSpec = {
    changes: tr.changes,
    effects,
    selection: EditorSelection.create([
      EditorSelection.cursor(target, target === fold.from ? -1 : 1)
    ]),
    scrollIntoView: tr.scrollIntoView,
    filter: false,
    userEvent: tr.changes.empty
      ? 'select.fold-clamp'
      : (tr.annotation(Transaction.userEvent) ?? 'select.fold-clamp')
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
    targets = levelMatch
      ? sections.filter((section) => section.level === Number(levelMatch[1]))
      : sections
  } else if (levelMatch) {
    targets = sections.filter((section) => section.level === Number(levelMatch[1]))
  } else {
    const current = [...sections]
      .reverse()
      .find((section) => section.lineEnd <= cursorLine.to && section.end >= cursorLine.from)
    targets = current ? [current] : []
  }
  if (targets.length === 0) return false
  const effects: StateEffect<unknown>[] = []
  for (const section of targets) {
    const existing = foldsStartingAt(state, section.lineEnd)
    if (unfold) {
      for (const range of existing) effects.push(unfoldEffect.of(range))
    } else if (existing.length === 0) {
      effects.push(foldEffect.of({ from: section.lineEnd, to: section.end }))
    }
  }
  if (effects.length > 0) view.dispatch({ effects })
  return true
}

/** 从这一行标题末尾开始的折叠。终点不必和重新算出的小节终点相同。 */
function foldsStartingAt(state: EditorState, lineEnd: number): FoldSpan[] {
  const found: FoldSpan[] = []
  foldedRanges(state).between(lineEnd, lineEnd, (from, to) => {
    if (from === lineEnd && to > from) found.push({ from, to })
  })
  return found
}

export function isHeadingFolded(state: EditorState, lineEnd: number): boolean {
  return foldsStartingAt(state, lineEnd).length > 0
}

/** 折叠范围签名：预览装饰在折叠变化时要重建。 */
export function headingFoldKey(state: EditorState): string {
  const parts: string[] = []
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    parts.push(`${from}-${to}`)
  })
  return parts.join('|')
}

/** 标题 / details 折叠共用的向右折线（展开时旋转 90° 朝下）。 */
export const FOLD_CHEVRON_SVG =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>'

const CHEVRON = FOLD_CHEVRON_SVG

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
      const existing = foldsStartingAt(view.state, section.lineEnd)
      view.dispatch({
        effects:
          existing.length > 0
            ? existing.map((range) => unfoldEffect.of(range))
            : foldEffect.of({ from: section.lineEnd, to: section.end })
      })
    })
    return button
  }

  ignoreEvent(): boolean {
    return true
  }
}
