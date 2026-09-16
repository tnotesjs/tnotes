import type { MindmapNode, MindmapSession } from '@tnotesjs/mindmap-core'

/**
 * The level field holds at most two digits: 1–99. Kept here as the one source of
 * truth for the clamp, the key handler and the field's own width/placeholder.
 */
export const MIN_EXPAND_LEVEL = 1
export const MAX_EXPAND_LEVEL = 99

export function normalizeExpandLevel(value: number): number {
  const level = Math.trunc(Number(value) || MIN_EXPAND_LEVEL)
  return Math.min(MAX_EXPAND_LEVEL, Math.max(MIN_EXPAND_LEVEL, level))
}

/**
 * What the level field accepts as its complete text: one or two digits, no
 * leading zero (`0` is below the range, `07` is not how a level is written).
 * Empty is allowed while editing — it means "no input yet".
 */
export function isValidExpandLevelText(text: string): boolean {
  return text === '' || /^[1-9]\d?$/.test(text)
}

/**
 * Whether an edit would leave the field in an acceptable state. `beforeinput`
 * asks this before the browser applies the change, so a rejected key leaves the
 * value *and* the selection untouched — restoring the value afterwards wedges the
 * browser's editing state and the field stops accepting input.
 *
 * `next` is what the field would read after the edit.
 */
export function acceptsExpandLevelEdit(next: string): boolean {
  return isValidExpandLevelText(next)
}

/** One arrow-key step, clamped to the range. */
export function stepExpandLevel(value: number, direction: -1 | 1): number {
  return Math.min(MAX_EXPAND_LEVEL, Math.max(MIN_EXPAND_LEVEL, value + direction))
}

/** Editing ended: an empty field drops the current value back. */
export function resolvedExpandLevel(text: string, previous: number): number {
  return text === '' ? previous : normalizeExpandLevel(Number(text))
}

function childLevel(node: MindmapNode, root: MindmapNode): number {
  let level = 0
  let current: MindmapNode | null = node
  while (current && current !== root) {
    level += 1
    current = current.parent
  }
  return level
}

/**
 * Level 1 renders root + direct children; level 2 additionally renders
 * grandchildren. Nodes at the last visible level are collapsed.
 */
export function applyInitialExpandLevel(session: MindmapSession, value: number): void {
  const visibleLevel = normalizeExpandLevel(value)
  const root = session.document.root
  session.document.traverse((node) => {
    if (node === root || node.children.length === 0) return
    session.setCollapsed(node.id, childLevel(node, root) >= visibleLevel)
  })
}
