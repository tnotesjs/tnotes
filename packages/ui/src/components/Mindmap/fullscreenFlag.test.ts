// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { reconcileMindmapFullscreen } from './fullscreenFlag'

/**
 * `data-tn-mindmap-fs` drives an unscoped `!important` rule that hides the child
 * buttons of every *non*-fullscreen mindmap, so a stale flag or a stale
 * `is-fullscreen` class leaves the toolbar invisible until the page reloads.
 * These cases pin the reconciliation that ESC (and unmount) now go through.
 */
const FLAG = 'tnMindmapFs'

function preview(fullscreen = false): HTMLElement {
  const el = document.createElement('section')
  el.className = fullscreen ? 'mindmap-preview is-fullscreen' : 'mindmap-preview'
  document.body.append(el)
  return el
}

const flags = () => ({
  body: document.body.dataset[FLAG],
  html: document.documentElement.dataset[FLAG]
})

afterEach(() => {
  document.body.replaceChildren()
  delete document.body.dataset[FLAG]
  delete document.documentElement.dataset[FLAG]
})

describe('mindmap fullscreen document flag', () => {
  it('sets the flag while a preview owns fullscreen', () => {
    const active = preview(true)
    reconcileMindmapFullscreen(active, [active])
    expect(flags()).toEqual({ body: '1', html: '1' })
    expect(active.classList.contains('is-fullscreen')).toBe(true)
  })

  it('clears the flag and the stale class on exit', () => {
    // Enter: mirrored state.
    const active = preview(true)
    reconcileMindmapFullscreen(active, [active])
    expect(flags()).toEqual({ body: '1', html: '1' })

    // Exit the way ESC does: the caller passes null while the class is still on
    // the element (only `fullscreenchange` fired, nothing removed it).
    reconcileMindmapFullscreen(null, [active])
    expect(flags()).toEqual({ body: undefined, html: undefined })
    expect(active.classList.contains('is-fullscreen')).toBe(false)
  })

  it('clears a peer that unmounted mid-fullscreen', () => {
    const active = preview(true)
    reconcileMindmapFullscreen(active, [active])
    const peer = preview(true)
    // The peer is torn down without going through its own exit path.
    reconcileMindmapFullscreen(null, [peer])
    expect(flags()).toEqual({ body: undefined, html: undefined })
    expect(peer.classList.contains('is-fullscreen')).toBe(false)
  })

  it('keeps the owning preview fullscreen while a peer is also marked', () => {
    const active = preview(true)
    const stale = preview(true)
    reconcileMindmapFullscreen(active, [active, stale])
    expect(flags()).toEqual({ body: '1', html: '1' })
    // The tracked owner keeps its class; the stale peer is not consulted.
    expect(active.classList.contains('is-fullscreen')).toBe(true)
  })
})
