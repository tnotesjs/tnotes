import type { DeskTocNode } from '../../../shared/contracts'

export type BatchCheckState = 'all' | 'some' | 'none' | 'empty'

/** 分组里的全部笔记，含嵌套在子笔记下的笔记。分组自己不是笔记。 */
export function descendantNoteIds(node: DeskTocNode): string[] {
  const ids: string[] = []
  const walk = (current: DeskTocNode): void => {
    for (const child of current.children) {
      if (child.type === 'note') ids.push(child.uuid)
      walk(child)
    }
  }
  walk(node)
  return ids
}

/** 点这一行时一起勾选的笔记。笔记包含自己和全部子集，分组只包含里面的笔记。 */
export function batchTargetIds(node: DeskTocNode): string[] {
  const descendants = descendantNoteIds(node)
  return node.type === 'note' ? [node.uuid, ...descendants] : descendants
}

export function collectNoteIds(nodes: readonly DeskTocNode[]): string[] {
  const ids: string[] = []
  const walk = (list: readonly DeskTocNode[]): void => {
    for (const node of list) {
      if (node.type === 'note') ids.push(node.uuid)
      walk(node.children)
    }
  }
  walk(nodes)
  return ids
}

export function batchCheckState(
  ids: readonly string[],
  selected: ReadonlySet<string>
): BatchCheckState {
  if (ids.length === 0) return 'empty'
  let count = 0
  for (const id of ids) if (selected.has(id)) count += 1
  if (count === 0) return 'none'
  if (count === ids.length) return 'all'
  return 'some'
}

/** 已经全选时取消，否则补齐。空列表保持原样。 */
export function toggleBatchIds(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set(selected)
  const next = new Set(selected)
  const allOn = ids.every((id) => next.has(id))
  if (allOn) {
    for (const id of ids) next.delete(id)
  } else {
    for (const id of ids) next.add(id)
  }
  return next
}
