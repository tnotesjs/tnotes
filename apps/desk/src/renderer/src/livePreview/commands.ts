import { indentLess, indentMore } from '@codemirror/commands'
import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { foldedRanges, indentUnit } from '@codemirror/language'
import { searchPanelOpen } from '@codemirror/search'
import { EditorSelection, Transaction, type StateCommand } from '@codemirror/state'
import { EditorView, type Command } from '@codemirror/view'

import { sourceLineStyleChangesFor } from '../markdown/clearSourceLineStyles'
import {
  insertTextEdit,
  prefixLinesEdit,
  setLinePrefixEdit,
  wrapSelectionEdit,
  type TextEdit
} from '../markdown/sourceEdits'
import { calloutHiddenLines } from './calloutLayout'
import { collapsedCodeBodies } from './codeBlockChrome'
import { openFind } from './findPanel'
import { hiddenCodeGroupBodies } from './decorations'
import { livePreviewEnabled } from './host'
import { renumberOrderedLists } from './lists'

export function applyTextEdit(view: EditorView, edit: TextEdit): void {
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.selectionFrom, head: edit.selectionTo },
    scrollIntoView: true,
    userEvent: 'input'
  })
  view.focus()
}

/**
 * 把每个选区各自的替换合成一次修改。
 *
 * 选区坐标按改之前的文档计算。同一段被多个光标覆盖时只改一次，光标留在改完的那一段上，
 * 不会收成主光标一个。区间互相重叠、又不是同一段时，跳过后面那个，避免改动叠在一起。
 */
function dispatchTextEdits(view: EditorView, edits: TextEdit[], mainIndex: number): void {
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((left, right) => left.edit.from - right.edit.from || left.edit.to - right.edit.to)
  const accepted: Array<{ edit: TextEdit; index: number }> = []
  for (const item of ordered) {
    const previous = accepted[accepted.length - 1]
    if (previous && item.edit.from === previous.edit.from && item.edit.to === previous.edit.to) {
      if (item.index === mainIndex) previous.index = item.index
      continue
    }
    if (previous && item.edit.from < previous.edit.to) continue
    accepted.push(item)
  }
  if (accepted.length === 0) return
  let delta = 0
  let mappedMain = 0
  const ranges = accepted.map((item, placed) => {
    const edit = item.edit
    const range = EditorSelection.range(edit.selectionFrom + delta, edit.selectionTo + delta)
    if (item.index === mainIndex) mappedMain = placed
    delta += edit.insert.length - (edit.to - edit.from)
    return range
  })
  view.dispatch({
    changes: accepted.map((item) => ({
      from: item.edit.from,
      to: item.edit.to,
      insert: item.edit.insert
    })),
    selection: EditorSelection.create(ranges, mappedMain),
    scrollIntoView: true,
    userEvent: 'input'
  })
  queueMicrotask(() => {
    if (view.dom.isConnected) view.focus()
  })
}

function wrapRangeEdit(
  text: string,
  from: number,
  to: number,
  prefix: string,
  suffix: string,
  placeholder: string
): TextEdit {
  const docLength = text.length
  const before = text.slice(Math.max(0, from - prefix.length), from)
  const after = text.slice(to, Math.min(docLength, to + suffix.length))
  if (from !== to && before === prefix && after === suffix) {
    const start = from - prefix.length
    const end = to + suffix.length
    return {
      text,
      insert: text.slice(from, to),
      from: start,
      to: end,
      selectionFrom: start,
      selectionTo: to - prefix.length
    }
  }
  const inner = text.slice(from, to)
  if (
    inner.length > prefix.length + suffix.length &&
    inner.startsWith(prefix) &&
    inner.endsWith(suffix)
  ) {
    const stripped = inner.slice(prefix.length, inner.length - suffix.length)
    return {
      text,
      insert: stripped,
      from,
      to,
      selectionFrom: from,
      selectionTo: from + stripped.length
    }
  }
  return wrapSelectionEdit(text, from, to, prefix, suffix, placeholder)
}

/**
 * 包裹选区（加粗、斜体等）。选区已经被同样的标记包住时反过来去掉标记（与 Typora 一致）。
 */
export function wrapSelection(
  view: EditorView,
  prefix: string,
  suffix: string,
  placeholder = '文字'
): void {
  if (view.state.readOnly) return
  const text = view.state.doc.toString()
  const edits = view.state.selection.ranges.map((range) =>
    wrapRangeEdit(text, range.from, range.to, prefix, suffix, placeholder)
  )
  dispatchTextEdits(view, edits, view.state.selection.mainIndex)
}

export function setLinePrefix(view: EditorView, prefix: string): void {
  if (view.state.readOnly) return
  const text = view.state.doc.toString()
  const edits = view.state.selection.ranges.map((range) =>
    setLinePrefixEdit(text, range.from, range.to, prefix)
  )
  dispatchTextEdits(view, edits, view.state.selection.mainIndex)
  renumberAround(view)
}

export function prefixSelection(view: EditorView, prefix: string): void {
  if (view.state.readOnly) return
  const text = view.state.doc.toString()
  const edits = view.state.selection.ranges.map((range) =>
    prefixLinesEdit(text, range.from, range.to, prefix)
  )
  dispatchTextEdits(view, edits, view.state.selection.mainIndex)
}

export function insertText(view: EditorView, insert: string, position?: number): void {
  if (view.state.readOnly) return
  const text = view.state.doc.toString()
  const callout = /^\n?:{3,}[ \t]*(?:tip|info|warning|danger|details)\b[^\n]*\n/.exec(insert)
  const ranges = position == null ? view.state.selection.ranges : [{ from: position, to: position }]
  const edits = ranges.map((range) => {
    const edit = insertTextEdit(text, insert, position == null ? undefined : position, range.from)
    if (callout && insert.length > callout[0].length) {
      edit.selectionFrom = edit.selectionTo = edit.from + callout[0].length
    }
    return edit
  })
  dispatchTextEdits(view, edits, position == null ? view.state.selection.mainIndex : 0)
}

export function clearLineStyles(view: EditorView): boolean {
  if (view.state.readOnly) return false
  const text = view.state.doc.toString()
  const seen = new Set<string>()
  const changes = view.state.selection.ranges.flatMap((range) =>
    sourceLineStyleChangesFor(text, range.from, range.to).filter((change) => {
      const key = `${change.from}:${change.to}:${change.insert}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  )
  if (changes.length > 0) {
    view.dispatch({
      changes: changes.map((change) => ({
        from: change.from,
        to: change.to,
        insert: change.insert
      })),
      userEvent: 'input'
    })
  }
  return true
}

/** Esc：多个光标收成主光标。查找面板开着时不接管，让查找自己关掉。 */
export const collapseExtraCursors: Command = (view) => {
  if (searchPanelOpen(view.state) || view.state.selection.ranges.length < 2) return false
  const main = view.state.selection.main
  view.dispatch({
    selection: EditorSelection.single(main.anchor, main.head),
    userEvent: 'select'
  })
  return true
}

/** 当前选区附近的有序列表重编号（单独一次修改，跟在结构编辑后面） */
function renumberAround(view: EditorView): void {
  const ranges = view.state.selection.ranges
  const from = Math.min(...ranges.map((range) => range.from))
  const to = Math.max(...ranges.map((range) => range.to))
  const changes = renumberOrderedLists(view.state, from, to)
  if (changes.length > 0) {
    view.dispatch({
      changes,
      annotations: Transaction.addToHistory.of(true),
      userEvent: 'input.renumber'
    })
  }
}

/**
 * 包一层：命令产生的修改之后顺带把相关有序列表重编号，合成**一个**事务（一步撤销）。
 */
function withRenumber(command: StateCommand): Command {
  return (view) =>
    command({
      state: view.state,
      dispatch: (tr) => {
        const after = tr.state.selection.main
        const renumber = renumberOrderedLists(tr.state, after.from, after.to)
        if (renumber.length === 0) {
          view.dispatch(tr)
          return
        }
        view.dispatch(
          view.state.update(
            {
              changes: tr.changes,
              selection: tr.selection,
              scrollIntoView: true,
              userEvent: tr.annotation(Transaction.userEvent) ?? 'input'
            },
            { changes: renumber, sequential: true }
          )
        )
      }
    })
}

export const continueMarkup = withRenumber(insertNewlineContinueMarkup)
export const deleteMarkup = withRenumber(deleteMarkupBackward)
export const indentListMore = withRenumber(indentMore)
export const indentListLess = withRenumber(indentLess)

function inList(view: EditorView): boolean {
  return view.state.selection.ranges.some((range) => {
    const line = view.state.doc.lineAt(range.head)
    return /^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(line.text)
  })
}

/** Tab：列表项缩进一级；其它地方插入一个缩进单位（2 个空格）。多个光标同时处理。 */
export const tabCommand: Command = (view) => {
  if (view.state.readOnly) return false
  if (inList(view) || view.state.selection.ranges.some((range) => !range.empty)) {
    return indentListMore(view)
  }
  view.dispatch(view.state.replaceSelection(view.state.facet(indentUnit)), { userEvent: 'input' })
  return true
}

export const shiftTabCommand: Command = (view) => {
  if (view.state.readOnly) return false
  return indentListLess(view)
}

/** 标题内容开头按退格：直接回到正文（去掉整个 `## ` 前缀），不逐级降级。 */
export const headingBackspace: Command = (view) => {
  const { state } = view
  if (state.readOnly) return false
  const strips: Array<{ from: number; to: number; index: number }> = []
  for (const [index, range] of state.selection.ranges.entries()) {
    if (!range.empty) return false
    const line = state.doc.lineAt(range.head)
    const match = /^( {0,3}#{1,6})([ \t]+|$)/.exec(line.text)
    if (!match) return false
    const contentStart = line.from + match[0].length
    if (range.head !== contentStart) return false
    strips.push({ from: line.from, to: contentStart, index })
  }
  if (strips.length === 0) return false
  const unique = strips
    .sort((left, right) => left.from - right.from)
    .filter((strip, index, all) => index === 0 || strip.from !== all[index - 1]?.from)
  let removed = 0
  let mappedMain = 0
  const ranges = unique.map((strip, placed) => {
    const cursor = EditorSelection.cursor(strip.from - removed)
    if (strip.index === state.selection.mainIndex) mappedMain = placed
    removed += strip.to - strip.from
    return cursor
  })
  view.dispatch({
    changes: unique.map((strip) => ({ from: strip.from, to: strip.to, insert: '' })),
    selection: EditorSelection.create(ranges, mappedMain),
    userEvent: 'delete.backward'
  })
  return true
}

/**
 * 方向键默认按屏幕行走，折行仍停在这一行里。
 * 像素落点如果跳过了看得见的行、走到看不见的行，或反向弹走，就改停到移动方向上的下一行可见行。
 * 高度为 0 的围栏、收起的代码、代码组隐藏页、折叠正文和属性头都整段跨过去。
 * 那个方向上没有可见行时返回 stay：光标留在当前行。
 */
export function verticalStopLine(
  current: number,
  landed: number,
  forward: boolean,
  lineCount: number,
  restable: (lineNo: number) => boolean
): number | null | 'stay' {
  if (landed === current) return null
  const step = forward ? 1 : -1
  const next = current + step
  if (next < 1 || next > lineCount) return null
  let lineNo = next
  while (lineNo >= 1 && lineNo <= lineCount && !restable(lineNo)) lineNo += step
  if (lineNo < 1 || lineNo > lineCount) return 'stay'
  const wrongWay = forward ? landed < current : landed > current
  const skipped = forward ? landed > lineNo : landed < lineNo
  if (wrongWay || skipped || !restable(landed)) return lineNo
  return null
}

function lineIsRestable(view: EditorView, lineNo: number): boolean {
  const line = view.state.doc.line(lineNo)
  const pos = line.from
  if (
    view.state.facet(livePreviewEnabled) &&
    calloutHiddenLines(view.state).some((span) => pos >= span.from && pos <= span.to)
  )
    return false
  if (collapsedCodeBodies(view.state).some((body) => pos >= body.from && pos < body.to))
    return false
  if (hiddenCodeGroupBodies(view.state).some((body) => pos >= body.from && pos <= body.to))
    return false
  let folded = false
  foldedRanges(view.state).between(line.from, line.to, (from, to) => {
    if (pos >= from && pos < to) folded = true
  })
  if (folded) return false
  const coords = view.coordsAtPos(pos)
  if (coords && coords.bottom - coords.top < 1) return false
  return true
}

function arrowByScreenLine(forward: boolean): Command {
  return (view) => {
    if (view.state.selection.ranges.length > 1) return false
    const selection = view.state.selection.main
    if (!selection.empty) return false
    const doc = view.state.doc
    const line = doc.lineAt(selection.head)
    const moved = view.moveVertically(selection, forward)
    const stop = verticalStopLine(
      line.number,
      doc.lineAt(moved.head).number,
      forward,
      doc.lines,
      (lineNo) => lineIsRestable(view, lineNo)
    )
    if (stop == null) return false
    if (stop === 'stay') return true
    const target = doc.line(stop)
    const coords = view.coordsAtPos(line.from)
    const fromWidget = Boolean(coords && coords.bottom - coords.top >= 40)
    const column = fromWidget || !lineIsRestable(view, line.number) ? 0 : selection.head - line.from
    view.dispatch({
      selection: { anchor: Math.min(target.from + column, target.to) },
      scrollIntoView: true,
      userEvent: 'select'
    })
    return true
  }
}

export const arrowDownIntoBlock = arrowByScreenLine(true)
export const arrowUpIntoBlock = arrowByScreenLine(false)

/**
 * 当前行不可见时，先沿移动方向找下一行可见行，没有再反向找。
 * `fromAbove` 为真表示是往下走到这一行的，光标应放在行首。
 */
export function nearestRestableLine(
  current: number,
  lineCount: number,
  preferUp: boolean,
  restable: (lineNo: number) => boolean
): { line: number; fromAbove: boolean } | null {
  const first = preferUp ? -1 : 1
  for (const step of [first, -first]) {
    for (let lineNo = current + step; lineNo >= 1 && lineNo <= lineCount; lineNo += step) {
      if (restable(lineNo)) return { line: lineNo, fromAbove: step > 0 }
    }
  }
  return null
}

/** 可视化里光标落在高度为 0 的行（前置信息、围栏）时，挪到最近的可见行。 */
export const keepCursorOnVisibleLine = EditorView.updateListener.of((update) => {
  if (!update.state.facet(livePreviewEnabled)) return
  if (!update.selectionSet) return
  if (
    update.transactions.some(
      (tr) => tr.annotation(Transaction.userEvent) === 'select.visible-clamp'
    )
  ) {
    return
  }
  const doc = update.state.doc
  const previousRanges = update.startState.selection.ranges
  const clamp = (pos: number, from: number): number => {
    const lineNo = doc.lineAt(pos).number
    if (lineIsRestable(update.view, lineNo)) return pos
    const found = nearestRestableLine(lineNo, doc.lines, pos < from, (line) =>
      lineIsRestable(update.view, line)
    )
    if (!found) return pos
    const line = doc.line(found.line)
    return found.fromAbove ? line.from : line.to
  }
  const ranges = update.state.selection.ranges.map((range, index) => {
    const previous = previousRanges[index] ?? range
    return EditorSelection.range(
      clamp(range.anchor, previous.anchor),
      clamp(range.head, previous.head)
    )
  })
  const unchanged = ranges.every((range, index) =>
    range.eq(update.state.selection.ranges[index] ?? range)
  )
  if (unchanged) return
  update.view.dispatch({
    selection: EditorSelection.create(ranges, update.state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: 'select.visible-clamp'
  })
})

/**
 * ← → 默认走一个字符。落点若在看不见的行（结束围栏、隐藏页）上，就继续走到下一处看得见的位置。
 * 返回 default：交给编辑器自己走一格；stay：那边没有看得见的位置，按键不移动光标。
 */
export function horizontalStop(
  steps: number[],
  restable: (pos: number) => boolean
): 'default' | 'stay' | number {
  if (steps.length === 0) return 'stay'
  if (restable(steps[0])) return 'default'
  return steps.find((pos) => restable(pos)) ?? 'stay'
}

function arrowByChar(forward: boolean): Command {
  return (view) => {
    if (view.state.selection.ranges.length > 1) return false
    const selection = view.state.selection.main
    if (!selection.empty) return false
    const steps: number[] = []
    let range = selection
    for (let guard = 0; guard < view.state.doc.length; guard += 1) {
      const next = view.moveByChar(range, forward)
      if (next.head === range.head) break
      steps.push(next.head)
      range = next
      if (lineIsRestable(view, view.state.doc.lineAt(next.head).number)) break
    }
    const stop = horizontalStop(steps, (pos) =>
      lineIsRestable(view, view.state.doc.lineAt(pos).number)
    )
    if (stop === 'default') return false
    if (stop === 'stay') return true
    view.dispatch({
      selection: { anchor: stop },
      scrollIntoView: true,
      userEvent: 'select'
    })
    return true
  }
}

export const arrowLeftToVisible = arrowByChar(false)
export const arrowRightToVisible = arrowByChar(true)

/**
 * macOS 按住 Option 时 `key` 不再是字母：U 变成 Dead，T 变成 †，S 变成 ß。
 * CodeMirror 用 `key` 对 `Mod-Alt-u`，所以对不上。这里改认物理键 `code`。
 */
const altModByCode: Record<string, (view: EditorView) => void> = {
  KeyU: (view) => setLinePrefix(view, '> '),
  KeyT: (view) => setLinePrefix(view, '- [ ] '),
  KeyS: (view) => insertText(view, '\n---\n'),
  KeyF: (view) => void openFind(view, true),
  Digit0: (view) => setLinePrefix(view, ''),
  Numpad0: (view) => setLinePrefix(view, '')
}

for (let level = 1; level <= 6; level += 1) {
  const apply = (view: EditorView): void => setLinePrefix(view, `${'#'.repeat(level)} `)
  altModByCode[`Digit${level}`] = apply
  altModByCode[`Numpad${level}`] = apply
}

export function runAltModShortcut(view: EditorView, event: KeyboardEvent): boolean {
  if (event.repeat || event.isComposing || event.shiftKey) return false
  const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!primary || !event.altKey) return false
  const apply = altModByCode[event.code]
  if (!apply) return false
  apply(view)
  return true
}
