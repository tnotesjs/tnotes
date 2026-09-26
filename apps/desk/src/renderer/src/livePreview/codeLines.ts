import { Prec, type Extension, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'

import {
  applyFenceHighlights,
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
  for (let number = openLineNumber + 1; number <= last; number += 1) {
    const index = number - openLineNumber
    const highlighted = highlights.has(index)
    if (!numbered && !highlighted) continue
    const classes = ['cm-lp-code-line']
    if (highlighted) classes.push('cm-lp-code-highlighted')
    ranges.push(
      Decoration.line({
        class: classes.join(' '),
        attributes: numbered
          ? { 'data-line': String(start + index - 1), 'data-code-line': String(index) }
          : {}
      }).range(doc.line(number).from)
    )
  }
  return ranges
}

/** 切换围栏上 `{…}` 里的某一行，返回要替换的范围；围栏不合法时返回 null。 */
export function toggleFenceHighlight(
  doc: Text,
  openLineNumber: number,
  index: number
): { from: number; to: number; insert: string } | null {
  const line = doc.line(openLineNumber)
  const match = FENCE_OPEN.exec(line.text)
  if (!match) return null
  const info = match[3]
  const next = applyFenceHighlights(info, toggleHighlightLine(parseHighlightRanges(info), index))
  const markerEnd = line.from + match[1].length
  const infoFrom = markerEnd + match[2].length
  if (!next) return { from: markerEnd, to: line.to, insert: '' }
  return { from: infoFrom, to: line.to, insert: next }
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
      const padding = parseFloat(getComputedStyle(line).paddingLeft) || 0
      const gutter = line.classList.contains('cm-lp-code-nowrap') ? 52 : padding
      if (event.clientX - box.left > gutter) return false
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
