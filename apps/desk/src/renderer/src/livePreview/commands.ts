import { indentLess, indentMore } from '@codemirror/commands'
import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { Transaction, type StateCommand } from '@codemirror/state'
import { EditorView, type Command } from '@codemirror/view'

import { sourceLineStyleChangesFor } from '../markdown/clearSourceLineStyles'
import {
  insertTextEdit,
  prefixLinesEdit,
  setLinePrefixEdit,
  wrapSelectionEdit,
  type TextEdit
} from '../markdown/sourceEdits'
import { hiddenBlocks } from './decorations'
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

function selectionOffsets(view: EditorView): { text: string; from: number; to: number } {
  const range = view.state.selection.main
  return { text: view.state.doc.toString(), from: range.from, to: range.to }
}

/**
 * 包裹选区（加粗、斜体等）。选区已经被同样的标记包住时反过来去掉标记（与 Typora 一致）。
 */
export function wrapSelection(view: EditorView, prefix: string, suffix: string, placeholder = '文字'): void {
  if (view.state.readOnly) return
  const { from, to } = view.state.selection.main
  const doc = view.state.doc
  const before = doc.sliceString(Math.max(0, from - prefix.length), from)
  const after = doc.sliceString(to, Math.min(doc.length, to + suffix.length))
  if (from !== to && before === prefix && after === suffix) {
    view.dispatch({
      changes: [
        { from: from - prefix.length, to: from },
        { from: to, to: to + suffix.length }
      ],
      selection: { anchor: from - prefix.length, head: to - prefix.length },
      userEvent: 'input'
    })
    view.focus()
    return
  }
  const inner = doc.sliceString(from, to)
  if (inner.length > prefix.length + suffix.length && inner.startsWith(prefix) && inner.endsWith(suffix)) {
    view.dispatch({
      changes: { from, to, insert: inner.slice(prefix.length, inner.length - suffix.length) },
      selection: { anchor: from, head: to - prefix.length - suffix.length },
      userEvent: 'input'
    })
    view.focus()
    return
  }
  const { text } = selectionOffsets(view)
  applyTextEdit(view, wrapSelectionEdit(text, from, to, prefix, suffix, placeholder))
}

export function setLinePrefix(view: EditorView, prefix: string): void {
  if (view.state.readOnly) return
  const { text, from, to } = selectionOffsets(view)
  applyTextEdit(view, setLinePrefixEdit(text, from, to, prefix))
  renumberAround(view)
}

export function prefixSelection(view: EditorView, prefix: string): void {
  if (view.state.readOnly) return
  const { text, from, to } = selectionOffsets(view)
  applyTextEdit(view, prefixLinesEdit(text, from, to, prefix))
}

export function insertText(view: EditorView, insert: string, position?: number): void {
  if (view.state.readOnly) return
  const { text, from } = selectionOffsets(view)
  applyTextEdit(view, insertTextEdit(text, insert, position, from))
}

export function clearLineStyles(view: EditorView): boolean {
  if (view.state.readOnly) return false
  const { text, from, to } = selectionOffsets(view)
  const changes = sourceLineStyleChangesFor(text, from, to)
  if (changes.length > 0) {
    view.dispatch({
      changes: changes.map((change) => ({ from: change.from, to: change.to, insert: change.insert })),
      userEvent: 'input'
    })
  }
  return true
}

/** 当前选区附近的有序列表重编号（单独一次修改，跟在结构编辑后面） */
function renumberAround(view: EditorView): void {
  const { from, to } = view.state.selection.main
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
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  return /^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(line.text)
}

/** Tab：列表项缩进一级；其它地方插入 4 个空格 */
export const tabCommand: Command = (view) => {
  if (view.state.readOnly) return false
  if (inList(view) || !view.state.selection.main.empty) return indentListMore(view)
  view.dispatch(view.state.replaceSelection('    '), { userEvent: 'input' })
  return true
}

export const shiftTabCommand: Command = (view) => {
  if (view.state.readOnly) return false
  return indentListLess(view)
}

/** 标题内容开头按退格：直接回到正文（去掉整个 `## ` 前缀），不逐级降级。 */
export const headingBackspace: Command = (view) => {
  const { state } = view
  const selection = state.selection.main
  if (!selection.empty || state.readOnly) return false
  const line = state.doc.lineAt(selection.head)
  const match = /^( {0,3}#{1,6})([ \t]+|$)/.exec(line.text)
  if (!match) return false
  const contentStart = line.from + match[0].length
  if (selection.head !== contentStart) return false
  view.dispatch({
    changes: { from: line.from, to: contentStart },
    selection: { anchor: line.from },
    userEvent: 'delete.backward'
  })
  return true
}

/**
 * 上下方向键走进被组件整块替换的源码（否则光标会直接跳过卡片，永远露不出源码）。
 */
function enterHiddenBlock(forward: boolean): Command {
  return (view) => {
    const selection = view.state.selection.main
    if (!selection.empty) return false
    const doc = view.state.doc
    const line = doc.lineAt(selection.head)
    const blocks = hiddenBlocks(view.state)
    const block = forward
      ? blocks.find((item) => item.from === line.to + 1)
      : blocks.find((item) => item.to === line.from - 1)
    if (!block) return false
    const moved = view.moveVertically(selection, forward)
    const leavesLine = forward ? moved.head > line.to : moved.head < line.from
    if (!leavesLine) return false
    view.dispatch({
      selection: { anchor: forward ? block.from : block.to },
      scrollIntoView: true,
      userEvent: 'select'
    })
    return true
  }
}

export const arrowDownIntoBlock = enterHiddenBlock(true)
export const arrowUpIntoBlock = enterHiddenBlock(false)
