import type { DeskTocNode } from './contracts'

/** 新置顶的排在最前；已经在列表里的挪到最前，其余顺序不动。 */
export function pinToFront(ids: readonly string[], id: string): string[] {
  const trimmed = id.trim()
  if (!trimmed) return [...ids]
  return [trimmed, ...ids.filter((item) => item !== trimmed)]
}

export function unpinId(ids: readonly string[], id: string): string[] {
  return ids.filter((item) => item !== id)
}

/** 丢掉不存在的 id 和重复项，保留第一次出现的顺序。 */
export function prunePinIds(ids: readonly string[], alive: ReadonlySet<string>): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const id of ids) {
    if (!alive.has(id) || seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  return next
}

export function listsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

export function orderedPinned<T>(ids: readonly string[], byId: ReadonlyMap<string, T>): T[] {
  const seen = new Set<string>()
  const next: T[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const item = byId.get(id)
    if (item === undefined) continue
    seen.add(id)
    next.push(item)
  }
  return next
}

/**
 * 按置顶顺序平铺笔记。不带出子笔记，目录树本身不改。
 * 已经不在目录里的 id 直接丢掉。
 */
export function flatPinnedNotes(
  nodes: readonly DeskTocNode[],
  ids: readonly string[]
): Array<Extract<DeskTocNode, { type: 'note' }>> {
  const byId = new Map<string, Extract<DeskTocNode, { type: 'note' }>>()
  const walk = (list: readonly DeskTocNode[]): void => {
    for (const node of list) {
      if (node.type === 'note') byId.set(node.uuid, node)
      if (node.children.length) walk(node.children)
    }
  }
  walk(nodes)
  return orderedPinned(ids, byId).map((node) => ({ ...node, children: [] }))
}
