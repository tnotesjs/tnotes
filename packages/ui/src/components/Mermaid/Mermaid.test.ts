// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'

import Mermaid from './Mermaid.vue'

const cleanups: Array<() => void> = []

function mount(component: Component, props: Record<string, unknown> = {}): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(defineComponent({ render: () => h(component, props) }))
  app.mount(host)
  cleanups.push(() => {
    app.unmount()
    host.remove()
  })
  return host
}

afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
  document.body.innerHTML = ''
})

describe('Mermaid preview host', () => {
  it('keeps the diagram host laid out while loading (note 0020 diagrams)', async () => {
    const sources = [
      `flowchart LR\n  Desk --> UI`,
      `sequenceDiagram\n  participant Desk\n  participant Site\n  Desk->>Site: hi`,
      `graph TD\n  A[Start] --> B{ok}`
    ]
    for (const source of sources) {
      const host = mount(Mermaid, { source })
      await nextTick()
      const diagram = host.querySelector('.tn-mermaid__diagram')
      expect(diagram).not.toBeNull()
      // Mermaid 11 needs layout during mermaid.render(); do not visibility:hidden the host.
      expect(diagram!.classList.contains('is-obscured')).toBe(false)
    }
  })

  it('only obscures the host for empty or error states', async () => {
    const emptyHost = mount(Mermaid, { source: '' })
    await nextTick()
    expect(emptyHost.querySelector('.tn-mermaid__diagram')!.classList.contains('is-obscured')).toBe(
      true
    )
  })

  it('flags the document as fullscreen in place, without moving the preview out of its host', async () => {
    const host = mount(Mermaid, { source: 'graph TD\n  A --> B' })
    await nextTick()
    const root = host.querySelector<HTMLElement>('.tn-mermaid')!
    const toggle = host.querySelector<HTMLButtonElement>('button[title="全屏查看图表"]')!
    toggle.click()
    await nextTick()
    expect(root.classList.contains('is-fullscreen')).toBe(true)
    expect(root.parentElement).toBe(host)
    expect(root.dataset.tnFullscreenLayer).toBe('')
    expect(document.body.dataset.tnFullscreen).toBe('')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(root.classList.contains('is-fullscreen')).toBe(false)
    expect(document.body.dataset.tnFullscreen).toBeUndefined()
  })
})
