/**
 * The document-wide "a mindmap owns fullscreen" flag.
 *
 * The flag drives an **unscoped**, `!important` rule (in `Mindmap.vue`) that
 * hides the child buttons (`.mindmap-preview-actions`) of every *non*-fullscreen
 * mindmap. So the flag and the `is-fullscreen` classes have to be reconciled
 * together — a stale flag, or a stale class left behind by a path that only
 * observed `fullscreenchange` (ESC) or unmounted a preview, hides every toolbar
 * with no way back short of a page reload.
 *
 * Kept as plain DOM code in its own module so the invariant is unit-testable
 * without mounting the canvas-backed component.
 */

export const FS_BODY_ATTR = 'tnMindmapFs'

/** Custom event peers dispatch to make each other leave fullscreen. */
export const FORCE_EXIT_FULLSCREEN_EVENT = 'tnotes-mindmap-force-exit-fullscreen'

/**
 * Reconcile the document flag with the fullscreen classes.
 *
 * - `activeRoot` still marked fullscreen → keep the flag (a peer's stray
 *   `.is-fullscreen` must not be mistaken for the owner);
 * - otherwise → drop the class from every tracked preview and delete the flag.
 */
export function reconcileMindmapFullscreen(
  activeRoot: HTMLElement | null,
  previews: ArrayLike<HTMLElement>
): void {
  if (typeof document === 'undefined') return
  if (activeRoot?.classList.contains('is-fullscreen')) {
    document.body.dataset[FS_BODY_ATTR] = '1'
    document.documentElement.dataset[FS_BODY_ATTR] = '1'
    return
  }
  for (const el of Array.from(previews)) el.classList.remove('is-fullscreen')
  delete document.body.dataset[FS_BODY_ATTR]
  delete document.documentElement.dataset[FS_BODY_ATTR]
}
