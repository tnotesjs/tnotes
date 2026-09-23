import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'

import type { ChangeSpec, EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

const ORDERED_MARK = /^(\d{1,9})([.)])$/

function listDepth(node: SyntaxNode): number {
  let depth = 0
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'BulletList' || parent.name === 'OrderedList') depth += 1
  }
  return depth
}

function renumberList(state: EditorState, list: SyntaxNode, changes: ChangeSpec[]): void {
  const doc = state.doc
  let expected: number | null = null
  for (let item = list.firstChild; item; item = item.nextSibling) {
    if (item.name !== 'ListItem') continue
    const mark = item.getChild('ListMark')
    if (!mark) continue
    const text = doc.sliceString(mark.from, mark.to)
    const match = ORDERED_MARK.exec(text)
    if (!match) continue
    if (expected === null) {
      // 嵌套列表一律从 1 开始；顶层列表保留用户写的起始编号
      expected = listDepth(list) > 0 ? 1 : Number(match[1])
    }
    const next = `${expected}${match[2]}`
    if (next !== text) changes.push({ from: mark.from, to: mark.to, insert: next })
    expected += 1
  }
}

/**
 * 有序列表重编号：把与 `[from, to]` 相交的每个有序列表改成连续编号。
 *
 * 规则（与用户确认过）：插入 / 删除 / 缩进后一律重写为连续编号，全写 `1.` 的列表也改。
 */
export function renumberOrderedLists(state: EditorState, from: number, to: number): ChangeSpec[] {
  const changes: ChangeSpec[] = []
  const seen = new Set<number>()
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, to + 2000), 50) ?? syntaxTree(state)
  const lineFrom = state.doc.lineAt(Math.max(0, from)).from
  const lineTo = state.doc.lineAt(Math.min(state.doc.length, to)).to
  tree.iterate({
    from: lineFrom,
    to: lineTo,
    enter(node) {
      if (node.name !== 'OrderedList' || seen.has(node.from)) return
      seen.add(node.from)
      renumberList(state, node.node, changes)
    }
  })
  // 光标所在项的外层列表也要看（缩进后原列表断开，后面各项要跟着改）
  let outer: SyntaxNode | null = tree.resolveInner(lineFrom, 1)
  while (outer) {
    if (outer.name === 'OrderedList' && !seen.has(outer.from)) {
      seen.add(outer.from)
      renumberList(state, outer, changes)
    }
    outer = outer.parent
  }
  return changes
}
