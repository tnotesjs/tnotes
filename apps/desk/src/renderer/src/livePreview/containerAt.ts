import { syntaxTree } from '@codemirror/language'

import type { EditorState } from '@codemirror/state'

/**
 * 光标所在 `:::` 容器的类型名（`::: tip 标题` → `tip`）；不在容器正文里时为 null。
 * 开 / 闭围栏行本身不算「在容器里」，插入会落在容器外。
 */
export function containerAtCursor(state: EditorState): string | null {
  const pos = state.selection.main.head
  let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(
    state
  ).resolveInner(pos, -1)
  for (; node; node = node.parent) {
    if (node.name !== 'Container') continue
    const open = state.doc.lineAt(node.from)
    const close = node.getChildren('ContainerMark')[1]
    if (pos <= open.to || (close && pos >= close.from)) return null
    const info = node.getChild('ContainerInfo')
    if (!info) return null
    return state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] || null
  }
  return null
}
