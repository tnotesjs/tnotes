import {
  Prec,
  Transaction,
  type ChangeSpec,
  type EditorState,
  type Extension,
  type Range,
  type Text
} from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import {
  applyFenceHighlights,
  clampHighlightRanges,
  parseHighlightRanges,
  toggleHighlightLine
} from '../editor/markdown/lineHighlight'

const FENCE_OPEN = /^([ \t]*(?:`{3,}|~{3,}))([ \t]*)(.*)$/
const LINE_NUMBERS_OFF = /:no-line-numbers\b/
const LINE_NUMBERS_START = /:line-numbers=(\d+)\b/

/**
 * 代码正文每一行的行号和高亮。`{1,3-5}` 按正文第几行算，和 VitePress 一致；
 * `:line-numbers=N` 只改显示的起始号。
 */
export function codeLineDecorations(
  doc: Text,
  openLineNumber: number,
  lastBodyLine: number
): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = []
  const match = FENCE_OPEN.exec(doc.line(openLineNumber).text)
  if (!match) return ranges
  const info = match[3]
  const highlights = parseHighlightRanges(info)
  const numbered = !LINE_NUMBERS_OFF.test(info)
  const start = Number(LINE_NUMBERS_START.exec(info)?.[1] ?? 1)
  const last = Math.min(lastBodyLine, doc.lines)
  const rows: { number: number; index: number; highlighted: boolean }[] = []
  let maxLabel = start
  for (let number = openLineNumber + 1; number <= last; number += 1) {
    const index = number - openLineNumber
    const highlighted = highlights.has(index)
    if (!numbered && !highlighted) continue
    if (numbered) maxLabel = Math.max(maxLabel, start + index - 1)
    rows.push({ number, index, highlighted })
  }
  // 整块共用同一列宽，按这一块里最大的行号有几位来定，避免每一行按自己的数字收缩。
  const digits = String(maxLabel).length
  for (const row of rows) {
    const classes = ['cm-lp-code-line']
    if (row.highlighted) classes.push('cm-lp-code-highlighted')
    ranges.push(
      Decoration.line({
        class: classes.join(' '),
        attributes: numbered
          ? {
              'data-line': String(start + row.index - 1),
              'data-code-line': String(row.index),
              'data-digits': String(digits)
            }
          : {}
      }).range(doc.line(row.number).from)
    )
  }
  return ranges
}

/** 行号列的像素宽度。点行号、以及横向滚动时给光标留白，都用这一列的实际宽度。 */
export function codeLineGutterWidth(line: HTMLElement): number {
  if (!line.hasAttribute('data-line')) return 0
  const width = parseFloat(getComputedStyle(line, '::before').width)
  return Number.isFinite(width) ? width : 0
}

function fenceInfoChange(
  line: { from: number; to: number; text: string },
  next: string
): { from: number; to: number; insert: string } | null {
  const match = FENCE_OPEN.exec(line.text)
  if (!match) return null
  const markerEnd = line.from + match[1].length
  const infoFrom = markerEnd + match[2].length
  if (!next) return { from: markerEnd, to: line.to, insert: '' }
  if (next === match[3]) return null
  return { from: infoFrom, to: line.to, insert: next }
}

/** 这一块正文有几行。未闭合的围栏算到节点末行。 */
function fenceBodyLines(openNumber: number, closeNumber: number, closed: boolean): number {
  const lastBody = closed ? closeNumber - 1 : closeNumber
  return Math.max(0, lastBody - openNumber)
}

const FENCE_LINE = /^([ \t]{0,3})(`{3,}|~{3,})(.*)$/

/**
 * 高亮号超出正文的，从围栏信息里去掉。
 * `{9}` 在只剩 3 行时会被清掉；`{1,9}` 会留下 `{1}`。
 * 按行扫描，这样代码组里的围栏也能清掉（它们不单独进语法树）。
 */
export function staleHighlightChanges(state: EditorState): ChangeSpec[] {
  const doc = state.doc
  const changes: { from: number; to: number; insert: string }[] = []
  let open: { line: number; marker: string } | null = null
  const finish = (openLine: number, closeLine: number, closed: boolean): void => {
    const line = doc.line(openLine)
    const match = FENCE_OPEN.exec(line.text)
    if (!match) return
    const current = parseHighlightRanges(match[3])
    if (current.size === 0) return
    const clamped = clampHighlightRanges(current, fenceBodyLines(openLine, closeLine, closed))
    if (clamped.size === current.size) return
    const change = fenceInfoChange(line, applyFenceHighlights(match[3], clamped))
    if (change) changes.push(change)
  }
  for (let number = 1; number <= doc.lines; number += 1) {
    const match = FENCE_LINE.exec(doc.line(number).text)
    if (!match) continue
    const marker = match[2]
    if (open) {
      const closes =
        match[3].trim() === '' &&
        marker[0] === open.marker[0] &&
        marker.length >= open.marker.length
      if (!closes) continue
      finish(open.line, number, true)
      open = null
      continue
    }
    open = { line: number, marker }
  }
  if (open) finish(open.line, doc.lines, false)
  return changes
}

const PRUNE_USER_EVENT = 'input.code-highlight-prune'

/** 行被删掉之后，围栏上已经不存在的高亮号自动清掉。 */
export const pruneStaleCodeHighlights: Extension = ViewPlugin.fromClass(
  class {
    private queued = false

    constructor(private readonly view: EditorView) {
      this.schedule()
    }

    update(update: ViewUpdate): void {
      if (!update.docChanged) return
      if (
        update.transactions.some((tr) => tr.annotation(Transaction.userEvent) === PRUNE_USER_EVENT)
      )
        return
      this.schedule()
    }

    private schedule(): void {
      if (this.queued) return
      this.queued = true
      const view = this.view
      queueMicrotask(() => {
        this.queued = false
        if (!view.dom.isConnected) return
        const changes = staleHighlightChanges(view.state)
        if (changes.length === 0) return
        view.dispatch({ changes, userEvent: PRUNE_USER_EVENT })
      })
    }
  }
)

/** 切换围栏上 `{…}` 里的某一行，返回要替换的范围；围栏不合法时返回 null。 */
export function toggleFenceHighlight(
  doc: Text,
  openLineNumber: number,
  index: number
): { from: number; to: number; insert: string } | null {
  const line = doc.line(openLineNumber)
  const match = FENCE_OPEN.exec(line.text)
  if (!match) return null
  const next = applyFenceHighlights(
    match[3],
    toggleHighlightLine(parseHighlightRanges(match[3]), index)
  )
  return fenceInfoChange(line, next)
}

/** 点代码行左侧的行号区域：切换这一行的高亮，结果写回 Markdown。 */
export const codeLineNumberClick: Extension = Prec.high(
  EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || view.state.readOnly) return false
      const target = event.target
      if (!(target instanceof Element)) return false
      const line = target.closest<HTMLElement>('.cm-line[data-code-line]')
      if (!line || !view.contentDOM.contains(line)) return false
      const box = line.getBoundingClientRect()
      if (event.clientX - box.left > codeLineGutterWidth(line)) return false
      const index = Number(line.dataset.codeLine)
      if (!Number.isInteger(index) || index < 1) return false
      const lineNumber = view.state.doc.lineAt(view.posAtDOM(line)).number
      const openLineNumber = lineNumber - index
      if (openLineNumber < 1) return false
      const change = toggleFenceHighlight(view.state.doc, openLineNumber, index)
      if (!change) return false
      event.preventDefault()
      view.dispatch({ changes: change, userEvent: 'input.code-highlight' })
      return true
    }
  })
)
