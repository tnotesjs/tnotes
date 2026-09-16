import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SIDEBAR_RESTORE_CLASS,
  centredScrollTop,
  emptySidebarState,
  readSidebarState,
  releaseSidebarRestoreGate,
  sidebarAncestorKeys,
  sidebarNodeKey,
  sidebarStorageKey,
  writeSidebarState
} from '../src/client/sidebarState'

/**
 * The module touches exactly two browser APIs — `sessionStorage` and
 * `documentElement.classList` — so they are stubbed explicitly rather than
 * pulling in a whole DOM. Both are absent under SSR, which is also why the
 * module guards every access.
 */
let stored: Map<string, string>
let classes: Set<string>

function stubBrowser() {
  stored = new Map()
  classes = new Set()
  const sessionStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key)
  }
  vi.stubGlobal('window', { sessionStorage })
  vi.stubGlobal('document', {
    documentElement: {
      classList: {
        add: (name: string) => void classes.add(name),
        remove: (name: string) => void classes.delete(name),
        contains: (name: string) => classes.has(name)
      }
    }
  })
}

beforeEach(stubBrowser)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sidebar session state', () => {
  it('scopes the storage key to the site base', () => {
    // Every TNotes KB is published under one origin, so an unprefixed key would
    // let 32 knowledge bases share a single collapse set.
    expect(sidebarStorageKey('/TNotes.vue/')).not.toBe(sidebarStorageKey('/TNotes.rust/'))
    expect(sidebarStorageKey('/TNotes.vue/')).toContain('/TNotes.vue/')
  })

  it('round-trips the collapse set and offset', () => {
    writeSidebarState('/kb/', { collapsed: ['0', '2/1'], scrollTop: 420 })
    expect(readSidebarState('/kb/')).toEqual({ collapsed: ['0', '2/1'], scrollTop: 420 })
  })

  it('does not leak state across knowledge bases', () => {
    writeSidebarState('/TNotes.vue/', { collapsed: ['3'], scrollTop: 120 })
    expect(readSidebarState('/TNotes.rust/')).toEqual(emptySidebarState())
  })

  it('keeps "no position" distinct from "position zero"', () => {
    // A saved 0 is a spot the reader chose and must be restored; null is what
    // tells the next page to reveal the current note instead.
    writeSidebarState('/kb/', { collapsed: [], scrollTop: 0 })
    expect(readSidebarState('/kb/').scrollTop).toBe(0)

    writeSidebarState('/kb/', { collapsed: [], scrollTop: null })
    expect(readSidebarState('/kb/').scrollTop).toBeNull()
  })

  it('falls back to an empty state on a corrupt payload', () => {
    stored.set(sidebarStorageKey('/kb/'), '{ not json')
    expect(readSidebarState('/kb/')).toEqual(emptySidebarState())

    stored.set(sidebarStorageKey('/kb/'), JSON.stringify({ collapsed: 'nope' }))
    expect(readSidebarState('/kb/')).toEqual(emptySidebarState())

    stored.set(sidebarStorageKey('/kb/'), JSON.stringify(null))
    expect(readSidebarState('/kb/')).toEqual(emptySidebarState())
  })

  it('drops non-string keys and negative offsets instead of trusting storage', () => {
    stored.set(
      sidebarStorageKey('/kb/'),
      JSON.stringify({ collapsed: ['0', 7, null], scrollTop: -50 })
    )
    expect(readSidebarState('/kb/')).toEqual({ collapsed: ['0'], scrollTop: null })
  })

  it('releases the first-paint gate', () => {
    classes.add(SIDEBAR_RESTORE_CLASS)
    releaseSidebarRestoreGate()
    expect(classes.has(SIDEBAR_RESTORE_CLASS)).toBe(false)
  })

  it('survives storage that throws (private mode)', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
        removeItem: () => {}
      }
    })
    expect(readSidebarState('/kb/')).toEqual(emptySidebarState())
    expect(() => writeSidebarState('/kb/', emptySidebarState())).not.toThrow()
  })
})

describe('sidebar node keys', () => {
  it('builds a position path that is stable and unique', () => {
    expect(sidebarNodeKey('', 0)).toBe('0')
    expect(sidebarNodeKey('2', 1)).toBe('2/1')
    expect(sidebarNodeKey('2/1', 4)).toBe('2/1/4')
  })

  it('lists ancestors outermost first so expanding reopens the whole path', () => {
    expect(sidebarAncestorKeys('0')).toEqual([])
    expect(sidebarAncestorKeys('2/1')).toEqual(['2'])
    expect(sidebarAncestorKeys('2/1/4')).toEqual(['2', '2/1'])
  })
})

describe('centredScrollTop', () => {
  const container = { scrollTop: 0, clientHeight: 600, scrollHeight: 1200 }

  it('centres the target inside the container', () => {
    expect(centredScrollTop({ ...container, targetTop: 400, targetHeight: 30 })).toBe(115)
  })

  it('clamps to the top instead of returning a negative offset', () => {
    expect(centredScrollTop({ ...container, targetTop: 10, targetHeight: 30 })).toBe(0)
  })

  it('clamps to the bottom of the scrollable range', () => {
    expect(
      centredScrollTop({ ...container, scrollTop: 600, targetTop: 1190, targetHeight: 30 })
    ).toBe(600)
  })

  it('stays put when the container has nothing to scroll', () => {
    expect(
      centredScrollTop({ ...container, clientHeight: 1200, targetTop: 400, targetHeight: 30 })
    ).toBe(0)
  })

  it('leaves the offset alone when the target is not laid out', () => {
    // A collapsed ancestor gives a zero-height box; scrolling to it would land
    // somewhere arbitrary.
    expect(centredScrollTop({ ...container, scrollTop: 240, targetTop: 0, targetHeight: 0 })).toBe(
      240
    )
  })
})
