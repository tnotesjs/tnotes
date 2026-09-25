// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { SHARED_CODE_GROUP_CONTRACT } from '@tnotesjs/ui/code'
import {
  isStructuredCalloutSource,
  parseContainerSource,
  preservedContainerSource,
  rebuildContainerSource,
  renderContainerFromSource
} from './containerBody'

describe('parseContainerSource', () => {
  it('parses a bare-titled container', () => {
    const parsed = parseContainerSource('::: details 展开查看：说明\n\n正文  \n\n:::\n')
    expect(parsed).toEqual({
      name: 'details',
      title: '展开查看：说明',
      body: '正文  ',
      hasBody: true
    })
  })

  it('parses an untitled callout and keeps body whitespace', () => {
    const parsed = parseContainerSource('::: tip\nline  one\n\ntwo\n:::\n')
    expect(parsed.name).toBe('tip')
    expect(parsed.title).toBe('')
    expect(parsed.body).toBe('line  one\n\ntwo')
    expect(parsed.hasBody).toBe(true)
  })
})

describe('rebuildContainerSource', () => {
  it('rewrites title and body while keeping colon count', () => {
    const previous = ':::: tip 💡 TIP\n\nold\n\n::::\n'
    expect(rebuildContainerSource(previous, { title: '新标题', body: '新正文' })).toBe(
      ':::: tip 新标题\n\n新正文\n\n::::\n'
    )
  })

  it('keeps an empty body shell valid', () => {
    expect(
      rebuildContainerSource('::: info ℹ️ INFO\n\n\n\n:::\n', { title: 'ℹ️ INFO', body: '' })
    ).toBe('::: info ℹ️ INFO\n\n\n:::\n')
  })

  it('identifies structured callout names', () => {
    expect(isStructuredCalloutSource('::: tip\n\n:::\n')).toBe(true)
    expect(isStructuredCalloutSource('::: code-group\n\n:::\n')).toBe(false)
    expect(isStructuredCalloutSource('::: swiper\n\n:::\n')).toBe(false)
  })
})

describe('renderContainerFromSource', () => {
  it('renders details with the summary title and body content', () => {
    const el = renderContainerFromSource(
      '::: details 展开查看\n\n![a](https://cdn.example/a.png)\n\nsome **bold** text\n\n:::'
    )
    expect(el).toBeInstanceOf(HTMLDetailsElement)
    expect(el.querySelector('summary')?.textContent).toContain('展开查看')
    const img = el.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://cdn.example/a.png')
    expect(el.querySelector('strong')?.textContent).toBe('bold')
    expect(el.getAttribute('data-type')).toBeNull()
  })

  it('renders callouts with class and default title', () => {
    const warning = renderContainerFromSource('::: warning\ncareful\n:::')
    expect(warning.className).toBe('tn-custom-block warning')
    expect(warning.querySelector('.tn-custom-block-title')?.textContent).toBe('WARNING')
  })

  it('resolves relative images through the provided resolver', () => {
    const el = renderContainerFromSource('::: swiper\n\n![1](./assets/1.png)\n\n:::', (src) => {
      return src === './assets/1.png' ? 'tnotes-asset://asset?path=1' : src
    })
    expect(el.classList.contains('tn-swiper')).toBe(true)
    const img = el.querySelector('img')
    expect(img?.getAttribute('src')).toBe('tnotes-asset://asset?path=1')
    expect(el.querySelector('.swiper-slide')?.getAttribute('data-title')).toBe('1')
  })

  it('builds tabbed swiper slides from image alts', () => {
    const el = renderContainerFromSource(
      '::: swiper\n\n![封面](./a.png)\n\n![细节](./b.png)\n\n:::',
      (src) => src
    )
    const tabs = [...el.querySelectorAll('.tn-tab')].map((tab) => tab.textContent)
    expect(tabs).toEqual(['封面', '细节'])
    expect(el.querySelector('.tn-tab.active')?.textContent).toBe('封面')
    expect(el.querySelectorAll('.swiper-slide')).toHaveLength(2)
    expect(el.querySelector('.tn-tab-prev')?.textContent).toBe('<')
    expect(el.querySelector('.tab-tab-line')?.textContent).toBe('/')
    expect(el.querySelector('.tn-tab-next')?.textContent).toBe('>')
    expect((el.querySelector('.tn-swiper-tabs') as HTMLElement).style.padding).toBe(
      '0px 0.8rem 0px 3rem'
    )
  })

  it('omits swiper tab nav for a single slide', () => {
    const el = renderContainerFromSource('::: swiper\n\n![only](./a.png)\n\n:::', (src) => src)
    expect(el.querySelector('.tn-tab')).toBeNull()
    expect(el.querySelector('.tn-tab-prev')).toBeNull()
    expect(el.querySelector('.tn-tab-next')).toBeNull()
  })

  it('cycles swiper slides via prev/next nav', () => {
    const el = renderContainerFromSource(
      '::: swiper\n\n![a](./a.png)\n\n![b](./b.png)\n\n![c](./c.png)\n\n:::',
      (src) => src
    )
    const next = el.querySelector('.tn-tab-next') as HTMLButtonElement
    const prev = el.querySelector('.tn-tab-prev') as HTMLButtonElement
    const activeTitle = (): string | undefined =>
      el.querySelector('.tn-tab.active')?.textContent ?? undefined

    next.click()
    expect(activeTitle()).toBe('b')
    next.click()
    expect(activeTitle()).toBe('c')
    next.click()
    expect(activeTitle()).toBe('a')
    prev.click()
    expect(activeTitle()).toBe('c')
  })

  it('sanitizes script tags in the body', () => {
    const el = renderContainerFromSource('::: tip\n<script>alert(1)</script>ok\n:::')
    expect(el.querySelector('script')).toBeNull()
    expect(el.textContent).toBe('TIPalert(1)ok')
  })

  it('renders details with a working manual toggle', () => {
    const el = renderContainerFromSource('::: details\n\ncontent\n\n:::') as HTMLDetailsElement
    expect(el.open).toBe(false)
    el.querySelector('summary')?.dispatchEvent(
      new Event('click', { bubbles: true, cancelable: true })
    )
    expect(el.open).toBe(true)
  })

  it('builds a tabbed code group with the first tab active', async () => {
    const el = renderContainerFromSource(
      [
        '::: code-group',
        '```html [App.vue]',
        '<div></div>',
        '```',
        '',
        '```js [main.js]',
        'const x = 1',
        '```',
        ':::'
      ].join('\n')
    )
    const tabs = Array.from(el.querySelectorAll('.code-group-tab'))
    expect(tabs).toHaveLength(2)
    expect(tabs[0].classList.contains('active')).toBe(true)
    expect(tabs[1].classList.contains('active')).toBe(false)
    expect(tabs[0].textContent).toBe('App.vue')
    expect(tabs[1].textContent).toBe('main.js')
    const panels = Array.from(el.querySelectorAll('.code-group-panel'))
    expect(panels).toHaveLength(2)
    expect(panels[0].classList.contains('active')).toBe(true)
    expect(panels[1].classList.contains('active')).toBe(false)
    // Clicking the second tab switches the active panel.
    tabs[1].dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(panels[1].classList.contains('active')).toBe(true)
    expect(panels[0].classList.contains('active')).toBe(false)
  })

  it('matches the shared Core/Desk code-group contract', async () => {
    const el = renderContainerFromSource(SHARED_CODE_GROUP_CONTRACT.source)
    await vi.waitFor(() => {
      expect(el.querySelectorAll('.tn-code-highlight')).toHaveLength(2)
    })

    const tabs = [...el.querySelectorAll('.code-group-tab')].map((tab) => tab.textContent)
    expect(tabs).toEqual(SHARED_CODE_GROUP_CONTRACT.items.map((item) => item.title))
    const blocks = [...el.querySelectorAll('.tn-code-block')]
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.classList.contains('has-line-numbers')).toBe(true)
    expect(blocks[1]?.classList.contains('has-line-numbers')).toBe(false)
    expect(
      [...blocks[0]!.querySelectorAll('[data-line]')].map((line) => ({
        line: line.getAttribute('data-line'),
        highlighted: line.classList.contains('highlighted')
      }))
    ).toEqual([
      { line: '4', highlighted: false },
      { line: '5', highlighted: true }
    ])
    expect(blocks[0]?.textContent).toContain('console.log(1)')
    expect(blocks[1]?.textContent).toContain('const value: number = 2')
  })
})

describe('未改动的结构化容器保持字节不变', () => {
  const baseline = { source: '::: tip   标题\n\n\n正文\n\n:::  ', title: '标题', body: '正文' }

  it('没改动时返回原始源码（不做模板规范化）', () => {
    expect(preservedContainerSource(baseline, baseline.source, { body: '正文' })).toBe(
      baseline.source
    )
    expect(
      preservedContainerSource(baseline, baseline.source, { title: ' 标题 ', body: '正文' })
    ).toBe(baseline.source)
  })

  it('正文或标题被改动时返回 null，交给调用方重建', () => {
    expect(preservedContainerSource(baseline, baseline.source, { body: '改过了' })).toBeNull()
    expect(
      preservedContainerSource(baseline, baseline.source, { title: '新标题', body: '正文' })
    ).toBeNull()
  })

  it('源码被外部改动时不再沿用基线', () => {
    expect(
      preservedContainerSource(baseline, '::: tip 标题\n\n正文\n\n:::', { body: '正文' })
    ).toBeNull()
  })

  it('没有基线时返回 null', () => {
    expect(preservedContainerSource(null, baseline.source, { body: '正文' })).toBeNull()
  })
})
