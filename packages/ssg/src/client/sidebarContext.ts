/**
 * Sidebar collapse context.
 *
 * The tree recurses one component deep per TOC level, so the collapse set and
 * its mutators travel by injection rather than through every level of props.
 */
import { reactive, type InjectionKey } from 'vue'

export interface SidebarCollapseContext {
  /** Keys of collapsed nodes. Reactive: `has` tracks, `add`/`delete` trigger. */
  collapsed: Set<string>
  toggle: (key: string) => void
  /** Re-expand the given keys (used to reveal the current note's ancestry). */
  expand: (keys: string[]) => void
}

export const SIDEBAR_COLLAPSE_KEY: InjectionKey<SidebarCollapseContext> =
  Symbol('tnotes-sidebar-collapse')

/**
 * Used when the tree is rendered outside a sidebar (tests, isolated reuse):
 * nothing is collapsed and toggling is inert, so the tree stays fully expanded
 * instead of throwing.
 */
export function createInertCollapseContext(): SidebarCollapseContext {
  return reactive({
    collapsed: new Set<string>(),
    toggle: () => {},
    expand: () => {}
  })
}
