// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CodeBlock from './CodeBlock/CodeBlock.vue'
import CodeGroup from './CodeGroup/CodeGroup.vue'
import ImagePreview from './ImagePreview/ImagePreview.vue'

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
  document.documentElement.style.overflow = ''
  vi.restoreAllMocks()
})

describe('shared code and media components', () => {
  it('copies raw code and closes its fullscreen dialog with Escape', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    const host = mount(CodeBlock, {
      code: 'const value = 1\n',
      info: 'ts [demo.ts]',
      highlightedHtml: '<pre class="tn-code-highlight"><code>ok</code></pre>'
    })

    // 按类名取，别按顺序：标题左侧还有折叠 Icon
    host.querySelector<HTMLButtonElement>('.tn-code-block__copy-btn')!.click()
    await nextTick()
    expect(writeText).toHaveBeenCalledWith('const value = 1')

    host.querySelector<HTMLButtonElement>('.tn-code-block__fullscreen-btn')!.click()
    await nextTick()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    document.body
      .querySelector<HTMLElement>('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('switches code-group tabs with click and arrow keys', async () => {
    const host = mount(CodeGroup, {
      items: [
        { code: 'one', info: 'text [one.txt]' },
        { code: 'two', info: 'text [two.txt]' }
      ]
    })
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await nextTick()
    await nextTick()
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(host.querySelectorAll<HTMLElement>('[role="tabpanel"]')[1].hidden).toBe(false)
  })

  it('previews prose images, navigates, and restores document overflow', async () => {
    const prose = document.createElement('div')
    prose.className = 'tn-prose'
    prose.innerHTML = '<img src="/one.png"><img src="/two.png">'
    document.body.append(prose)
    cleanups.push(() => prose.remove())
    mount(ImagePreview)

    prose.querySelector<HTMLImageElement>('img')!.click()
    await nextTick()
    expect(document.documentElement.style.overflow).toBe('hidden')
    expect(document.body.querySelector<HTMLImageElement>('.tn-image-preview > img')?.src).toContain(
      '/one.png'
    )
    document.body.querySelector<HTMLButtonElement>('[aria-label="下一张"]')!.click()
    await nextTick()
    expect(document.body.querySelector<HTMLImageElement>('.tn-image-preview > img')?.src).toContain(
      '/two.png'
    )
    document.body.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click()
    await nextTick()
    expect(document.documentElement.style.overflow).toBe('')
  })

  it('only collects images inside the clicked image\'s editor scope (no cross-tab gallery)', async () => {
    const tabA = document.createElement('div')
    tabA.className = 'cm-editor'
    tabA.innerHTML =
      '<div class="tn-prose"><img src="/a-1.png"></div><span class="cm-lp-image-frame"><img src="/a-2.png"></span>'
    const tabB = document.createElement('div')
    tabB.className = 'cm-editor'
    tabB.innerHTML = '<div class="tn-prose"><img src="/b-1.png"><img src="/b-2.png"></div>'
    document.body.append(tabA, tabB)
    cleanups.push(() => {
      tabA.remove()
      tabB.remove()
    })
    mount(ImagePreview, { gallerySelector: '.tn-prose img, .cm-lp-image-frame img' })

    document.dispatchEvent(
      new CustomEvent('tn:preview-image', { detail: tabA.querySelector('.cm-lp-image-frame img') })
    )
    await nextTick()
    const shown = (): string =>
      document.body.querySelector<HTMLImageElement>('.tn-image-preview > img')?.src ?? ''
    expect(shown()).toContain('/a-2.png')
    expect(document.body.querySelector('.tn-image-preview__counter')?.textContent).toBe('2 / 2')
    document.body.querySelector<HTMLButtonElement>('[aria-label="下一张"]')!.click()
    await nextTick()
    expect(shown()).toContain('/a-1.png')
    document.body.querySelector<HTMLButtonElement>('[aria-label="下一张"]')!.click()
    await nextTick()
    expect(shown()).toContain('/a-2.png')
    document.body.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click()
    await nextTick()

    tabB.querySelectorAll('img')[1]!.click()
    await nextTick()
    expect(shown()).toContain('/b-2.png')
    expect(document.body.querySelector('.tn-image-preview__counter')?.textContent).toBe('2 / 2')
    document.body.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click()
    await nextTick()
  })

  it('opens from a programmatic preview request', async () => {
    const prose = document.createElement('div')
    prose.className = 'tn-prose tn-preview-ignore'
    prose.innerHTML = '<img src="/requested.png">'
    document.body.append(prose)
    cleanups.push(() => prose.remove())
    mount(ImagePreview)

    document.dispatchEvent(
      new CustomEvent('tn:preview-image', {
        detail: prose.querySelector('img')
      })
    )
    await nextTick()
    expect(document.body.querySelector<HTMLImageElement>('.tn-image-preview > img')?.src).toContain(
      '/requested.png'
    )
    document.body.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click()
    await nextTick()
  })
})
