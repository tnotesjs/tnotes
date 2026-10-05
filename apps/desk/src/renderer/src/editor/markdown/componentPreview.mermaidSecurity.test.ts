// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('@tnotesjs/ui', () => ({
  Mermaid: {
    name: 'Mermaid',
    props: {
      source: { type: String, default: '' },
      center: { type: Boolean, default: false },
      // Mirrors packages/ui Mermaid.vue: omitting the prop selects loose.
      securityLevel: { type: String, default: 'loose' },
      onCenterChange: Function
    },
    setup(props: Record<string, unknown>) {
      seen.push({
        source: props.source,
        securityLevel: props.securityLevel
      })
      return () => null
    }
  },
  BilibiliVideo: { name: 'BilibiliVideo', setup: () => () => null },
  Mindmap: { name: 'Mindmap', setup: () => () => null },
  NotesTable: { name: 'NotesTable', setup: () => () => null },
  Footprints: { name: 'Footprints', setup: () => () => null },
  WordList: { name: 'WordList', setup: () => () => null },
  WORD_LIST_FEATURES_STATIC: {}
}))

import { mountMermaidPreview } from './componentPreview'

const cleanups: Array<() => void> = []

afterEach(() => {
  seen.splice(0)
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
  document.body.innerHTML = ''
})

describe('mountMermaidPreview security', () => {
  it('passes securityLevel strict so note diagrams cannot use the loose default', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const mounted = mountMermaidPreview(host, {
      source: 'flowchart TD\n  A[Node]\n  click A deskExploit'
    })
    cleanups.push(() => {
      mounted.unmount()
      host.remove()
    })

    await vi.waitFor(() => {
      expect(seen.length).toBeGreaterThan(0)
    })
    expect(seen[0]?.securityLevel).toBe('strict')
  })
})
