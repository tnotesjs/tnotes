/**
 * Sidebar session state — collapse set plus scroll offset.
 *
 * The SSG is an MPA: every sidebar entry is a plain `<a href>`, so each click
 * is a full document load and component state cannot survive navigation. This
 * state therefore lives in sessionStorage: per-tab, dropped when the tab
 * closes, and never written back to the knowledge base.
 *
 * Storage is scoped per *origin*, not per path, and every TNotes KB is
 * published under the same origin (`tnotesjs.github.io/TNotes.<topic>/`). Keys
 * carry the site base so 32 sibling knowledge bases never share one collapse
 * set.
 *
 * `scrollTop` is `null` — not `0` — when there is no position worth restoring.
 * The distinction matters: a saved `0` means the reader deliberately sits at
 * the top of the tree and must stay there, while `null` means the next page
 * should reveal the current note instead.
 */

export interface SidebarSessionState {
  /** Stable keys of the nodes the reader collapsed. */
  collapsed: string[]
  /** Offset to restore, or `null` to locate the current note instead. */
  scrollTop: number | null
}

/** Bumped when the stored shape changes; stale payloads are then ignored. */
const STORAGE_VERSION = 1

export function sidebarStorageKey(base: string): string {
  return `tnotes-sidebar:${STORAGE_VERSION}:${base}`
}

export function emptySidebarState(): SidebarSessionState {
  return { collapsed: [], scrollTop: null }
}

export function readSidebarState(base: string): SidebarSessionState {
  if (typeof window === 'undefined') return emptySidebarState()
  try {
    const raw = window.sessionStorage.getItem(sidebarStorageKey(base))
    if (!raw) return emptySidebarState()
    const parsed = JSON.parse(raw) as Partial<SidebarSessionState> | null
    if (!parsed || typeof parsed !== 'object') return emptySidebarState()
    return {
      collapsed: Array.isArray(parsed.collapsed)
        ? parsed.collapsed.filter((key): key is string => typeof key === 'string')
        : [],
      // Out-of-domain values are treated as absent, not clamped: a negative
      // offset cannot come from a real scroll container, so it means the
      // payload is untrustworthy rather than that the reader sits at the top.
      scrollTop:
        typeof parsed.scrollTop === 'number' &&
        Number.isFinite(parsed.scrollTop) &&
        parsed.scrollTop >= 0
          ? parsed.scrollTop
          : null
    }
  } catch {
    // Unavailable (private mode) or corrupt — the sidebar still works, it
    // just forgets. Never let persistence break navigation.
    return emptySidebarState()
  }
}

export function writeSidebarState(base: string, state: SidebarSessionState): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(sidebarStorageKey(base), JSON.stringify(state))
  } catch {
    /* quota / private mode — remembering is a nicety, not a requirement */
  }
}

/**
 * Node key: the path of sibling positions down the tree ("0", "2/1", "2/1/4").
 * Stable across builds and unique within the tree, so it survives the note
 * edits that rebuild every other part of the payload.
 */
export function sidebarNodeKey(prefix: string, position: number): string {
  return prefix ? `${prefix}/${position}` : String(position)
}

/** Ancestor keys of a node key, outermost first ("2/1/4" -> ["2", "2/1"]). */
export function sidebarAncestorKeys(key: string): string[] {
  const segments = key.split('/')
  const keys: string[] = []
  for (let index = 1; index < segments.length; index++) {
    keys.push(segments.slice(0, index).join('/'))
  }
  return keys
}

export interface ScrollTarget {
  /** Current offset of the scroll container. */
  scrollTop: number
  /** Visible height of the scroll container. */
  clientHeight: number
  /** Full height of the scroll container's content. */
  scrollHeight: number
  /** Offset of the target from the container's top edge, in viewport terms. */
  targetTop: number
  /** Height of the target; 0 means it is not laid out (collapsed away). */
  targetHeight: number
}

/**
 * Offset that centres `target` inside the container, clamped to the scrollable
 * range.
 *
 * Returned as a number for `container.scrollTop` rather than done with
 * `scrollIntoView`, which walks *every* scrollable ancestor: it drags the
 * article out from under the reader — the exact interruption this sidebar
 * exists to prevent.
 */
export function centredScrollTop(target: ScrollTarget): number {
  if (target.targetHeight <= 0) return target.scrollTop
  const limit = Math.max(0, target.scrollHeight - target.clientHeight)
  const centred =
    target.targetTop + target.scrollTop - (target.clientHeight - target.targetHeight) / 2
  return Math.min(Math.max(centred, 0), limit)
}

/**
 * Marks the document while the sidebar is waiting for its stored state.
 * `site.ts` sets it from an inline head script — before first paint — so the
 * sidebar never renders all-expanded at offset 0 and then jumps once the
 * client bundle loads. The script also arms a timeout, because a bundle that
 * never arrives must not leave navigation invisible.
 */
export const SIDEBAR_RESTORE_CLASS = 'tn-sb-restore'

/** How long the inline gate waits before giving up on the client bundle. */
export const SIDEBAR_RESTORE_TIMEOUT_MS = 1000

export function releaseSidebarRestoreGate(): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.remove(SIDEBAR_RESTORE_CLASS)
}
