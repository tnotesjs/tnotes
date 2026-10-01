import {
  foldEffect,
  foldService,
  foldedRanges,
  syntaxTree,
  unfoldEffect
} from '@codemirror/language'
import { EditorView, WidgetType } from '@codemirror/view'

import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

/** 标记落在这一行的列表项（这一行是它的首行）。 */
export function listItemOnLine(state: EditorState, lineFrom: number): SyntaxNode | null {
  const line = state.doc.lineAt(lineFrom)
  const offset = /^[ \t]*/.exec(line.text)?.[0].length ?? 0
  if (offset >= line.length) return null
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from + offset, 1);
    node;
    node = node.parent
  ) {
    if (node.name !== 'ListItem') continue
    const mark = node.getChild('ListMark')
    return mark && mark.from >= line.from && mark.to <= line.to ? node : null
  }
  return null
}

/** 列表项可折叠的范围：首行末尾到这一项（含子列表、续段）最后一个非空字符。只有一行时返回 null。 */
export function listItemFoldRange(
  state: EditorState,
  lineFrom: number
): { from: number; to: number } | null {
  const item = listItemOnLine(state, lineFrom)
  if (!item) return null
  const doc = state.doc
  const from = doc.lineAt(lineFrom).to
  let to = Math.min(item.to, doc.length)
  while (to > from && /\s/.test(doc.sliceString(to - 1, to))) to -= 1
  if (to <= from) return null
  return { from, to: doc.lineAt(to).to }
}

export function isListItemFolded(state: EditorState, range: { from: number; to: number }): boolean {
  let folded = false
  foldedRanges(state).between(range.from, range.from, (from, to) => {
    if (from === range.from && to === range.to) folded = true
  })
  return folded
}

/** 让 CodeMirror 的折叠命令和源码折叠槽认识列表项 */
export const listFoldService = foldService.of((state, lineStart) =>
  listItemFoldRange(state, lineStart)
)

export function toggleListItemFold(view: EditorView, lineFrom: number): boolean {
  const range = listItemFoldRange(view.state, lineFrom)
  if (!range) return false
  view.dispatch({
    effects: isListItemFolded(view.state, range) ? unfoldEffect.of(range) : foldEffect.of(range)
  })
  return true
}

const TRIANGLE =
  '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M2.5 1.2 6 4 2.5 6.8z" fill="currentColor" /></svg>'

/** 列表标记左侧的折叠三角：展开时悬停才出现，折叠后一直显示。 */
export class ListFoldToggle extends WidgetType {
  constructor(private readonly folded: boolean) {
    super()
  }

  eq(other: ListFoldToggle): boolean {
    return other.folded === this.folded
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('span')
    button.className = 'cm-lp-list-toggle'
    button.dataset.folded = this.folded ? 'true' : 'false'
    button.setAttribute('role', 'button')
    button.setAttribute('aria-expanded', this.folded ? 'false' : 'true')
    button.setAttribute('aria-label', this.folded ? '展开列表项' : '折叠列表项')
    button.title = button.getAttribute('aria-label') ?? ''
    button.innerHTML = TRIANGLE
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      let pos: number
      try {
        pos = view.posAtDOM(button)
      } catch {
        return
      }
      toggleListItemFold(view, view.state.doc.lineAt(pos).from)
    })
    return button
  }

  ignoreEvent(): boolean {
    return true
  }
}
