import type { SidebarItem } from '../types'
import { sidebarNodeKey } from './sidebarState'

export function sidebarNotes(items: SidebarItem[]): SidebarItem[] {
  return items.flatMap((item) => [...(item.link ? [item] : []), ...sidebarNotes(item.items ?? [])])
}

/** Keep original position keys, including ancestors, so filtering cannot change collapse ownership. */
export function filterSidebarKeys(items: SidebarItem[], query: string): Set<string> | null {
  const term = query.trim().toLowerCase()
  if (!term) return null
  const keys = new Set<string>()
  function visit(nodes: SidebarItem[], prefix = '', parentMatched = false): boolean {
    let found = false
    nodes.forEach((item, i) => {
      const key = sidebarNodeKey(prefix, i)
      const own =
        parentMatched ||
        item.text.toLowerCase().includes(term) ||
        Boolean(
          item.index &&
          (/^\d+$/.test(term) ? Number(item.index) === Number(term) : item.index.includes(term))
        )
      const child = visit(item.items ?? [], key, own)
      if (own || child) {
        keys.add(key)
        found = true
      }
    })
    return found
  }
  visit(items)
  return keys
}

/**
 * Position keys of every node that can hold children, outermost first.
 *
 * The collapse-everything toggle needs this same list twice — once to collapse
 * and once to ask "is everything already collapsed?" — and a key that disagreed
 * with the tree's own `nodeKey` would collapse the wrong branch, so the walk
 * lives in one place instead of being repeated at the call site.
 */
export function sidebarGroupKeys(items: SidebarItem[], prefix = ''): string[] {
  return items.flatMap((item, i) => {
    if (!item.items?.length) return []
    const key = sidebarNodeKey(prefix, i)
    return [key, ...sidebarGroupKeys(item.items, key)]
  })
}

/**
 * Route comparison shared by the tree's highlight and the default collapse set.
 *
 * One definition on purpose: if the two disagreed, the group folded by default
 * would stop being the group the reader is standing in.
 */
export function normalizeRoute(value: string): string {
  return (
    decodeURIComponent(value)
      .replace(/\.(md|html)$/i, '')
      .replace(/\/$/, '') || '/'
  )
}

/**
 * Group keys that start closed: every group except the ones on the path to the
 * current note.
 *
 * An open tree buries the current note — on a 3800-note TOC it is thousands of
 * rows away — so the tree opens showing the reader's own branch and nothing
 * else. Both the server render and the client's first render call this, so the
 * paint before hydration is already folded and there is nothing to correct.
 */
export function collapsedByDefaultKeys(items: SidebarItem[], activeRoute: string): string[] {
  const active = normalizeRoute(activeRoute)
  /** Keys down to the current note, outermost first; null when it is not in this subtree. */
  function pathToCurrent(prefix: string, nodes: SidebarItem[]): string[] | null {
    for (const [position, item] of nodes.entries()) {
      const key = sidebarNodeKey(prefix, position)
      if (item.link && normalizeRoute(item.link) === active) {
        return item.items?.length ? [key] : []
      }
      const deeper = item.items?.length ? pathToCurrent(key, item.items) : null
      if (deeper) return [key, ...deeper]
    }
    return null
  }
  const open = new Set(pathToCurrent('', items) ?? [])
  return sidebarGroupKeys(items).filter((key) => !open.has(key))
}

export function noteNumber(route: string): string {
  const match = route.match(/^\/notes\/(\d+)$/)
  return match ? match[1].padStart(4, '0') : ''
}

export function clampSidebarWidth(value: number): number {
  return Number.isFinite(value) ? Math.max(220, Math.min(420, value)) : 272
}
