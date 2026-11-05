import { EditorSelection } from '@codemirror/state'

import { CARET, templateOf } from '../markdown/insertCatalog'

import type { EditorState, TransactionSpec } from '@codemirror/state'
import type { InsertItem } from '../markdown/insertCatalog'

export interface TextRange {
  from: number
  to: number
}

const CALLOUT_OPEN = /^\s*:{3,}[ \t]*\S/
const BLOCK_MARKER =
  /^(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/

/** 去掉 `remove` 那段之后，`at` 所在行剩下的文字 */
function restOfLine(state: EditorState, at: number, remove?: TextRange): string {
  const line = state.doc.lineAt(at)
  if (!remove) return line.text
  const from = Math.max(remove.from, line.from) - line.from
  const to = Math.min(remove.to, line.to) - line.from
  return line.text.slice(0, from) + line.text.slice(Math.max(from, to))
}

/** 把当前行改成标题 / 列表 / 引用：换掉行首已有的块标记，保留文字 */
function prefixLine(
  state: EditorState,
  at: number,
  prefix: string,
  remove?: TextRange
): TransactionSpec {
  const line = state.doc.lineAt(at)
  const rest = restOfLine(state, at, remove)
  const indent = /^[ \t]*/.exec(rest)?.[0] ?? ''
  const body = rest.slice(indent.length).replace(BLOCK_MARKER, '')
  const text = indent + prefix + body
  return {
    changes: { from: line.from, to: line.to, insert: text },
    selection: EditorSelection.cursor(line.from + text.length),
    scrollIntoView: true,
    userEvent: 'input'
  }
}

/**
 * 在 `at` 所在行插入一整块：这一行（去掉 `remove` 之后）是空行就换成这块，否则插在它下面。
 * 前后补空行把块和相邻内容隔开（紧挨提示块开启 / 结束行时不补），光标落在模板的 {@link CARET}，
 * 模板里没有就落在块后面那一行。
 */
export function insertBlockText(
  state: EditorState,
  template: string,
  at: number,
  remove?: TextRange
): TransactionSpec {
  const { doc } = state
  const line = doc.lineAt(at)
  const rest = restOfLine(state, at, remove)
  const blank = rest.trim() === ''
  const indent = blank ? rest : ''
  const block = template
    .split('\n')
    .map((text) => (text ? indent + text : text))
    .join('\n')
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null
  const prev = line.number > 1 ? doc.line(line.number - 1) : null
  const nextBlank = next !== null && next.text.trim() === ''

  const changes: Array<{ from: number; to: number; insert: string }> = []
  let insertAt: number
  let lead: string
  if (blank) {
    insertAt = line.from
    lead = prev && prev.text.trim() !== '' && !CALLOUT_OPEN.test(prev.text) ? '\n' : ''
    changes.push({ from: line.from, to: line.to, insert: '' })
  } else {
    insertAt = line.to
    lead = '\n\n'
    if (remove && remove.to > remove.from) changes.push({ ...remove, insert: '' })
  }
  const trail = nextBlank ? '' : '\n'
  let text = lead + block + trail
  let caret = text.indexOf(CARET)
  if (caret >= 0) text = text.slice(0, caret) + text.slice(caret + CARET.length)
  else caret = lead.length + block.length + 1

  // 同一事务里的修改按原文坐标；插入点之前删掉的长度要从光标里扣掉
  const removedBefore = changes
    .filter((change) => change.to <= insertAt && change.from < insertAt)
    .reduce((sum, change) => sum + (change.to - change.from), 0)
  if (blank) changes[0].insert = text
  else changes.push({ from: insertAt, to: insertAt, insert: text })
  const base = blank ? line.from : insertAt - removedBefore
  return {
    changes,
    selection: EditorSelection.cursor(base + caret),
    scrollIntoView: true,
    userEvent: 'input'
  }
}

/**
 * 菜单项对应的编辑；图片 / 画布只先腾出一个空行把光标放上去，后续交给宿主。
 */
export function insertItemSpec(
  state: EditorState,
  item: InsertItem,
  at: number,
  remove?: TextRange
): TransactionSpec {
  switch (item.action.kind) {
    case 'prefix':
      return prefixLine(state, at, item.action.prefix, remove)
    case 'block':
      return insertBlockText(state, templateOf(item), at, remove)
    default:
      return insertBlockText(state, CARET, at, remove)
  }
}
