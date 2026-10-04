// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import { hydrateTnSwipers } from './hydrate'

function swiperShell(titles: string[]): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `
    <div class="tn-swiper">
      <div class="tn-swiper-tabs"></div>
      <div class="swiper-container">
        <div class="swiper-wrapper">
          ${titles
            .map(
              (title) =>
                `<div class="swiper-slide" data-title="${title}"><img alt="${title}" src="/${title}.svg"></div>`
            )
            .join('')}
        </div>
      </div>
    </div>
  `
  document.body.append(root)
  return root
}

describe('hydrateTnSwipers', () => {
  it('builds tabs and shows only the active slide', () => {
    const root = swiperShell(['A', 'B', 'C'])
    expect(hydrateTnSwipers(root)).toBe(1)

    const host = root.querySelector('.tn-swiper')!
    const tabs = [...host.querySelectorAll('.tn-tab')].map((tab) => tab.textContent)
    expect(tabs).toEqual(['A', 'B', 'C'])
    expect(host.querySelectorAll('.tn-tab-nav')).toHaveLength(3) // < / >

    const slides = [...host.querySelectorAll('.swiper-slide')] as HTMLElement[]
    expect(slides[0]!.classList.contains('is-active')).toBe(true)
    expect(slides[0]!.hidden).toBe(false)
    expect(slides[1]!.hidden).toBe(true)
    expect(slides[2]!.hidden).toBe(true)

    ;(host.querySelectorAll('.tn-tab')[1] as HTMLButtonElement).click()
    expect(slides[0]!.hidden).toBe(true)
    expect(slides[1]!.hidden).toBe(false)
    expect(slides[1]!.classList.contains('is-active')).toBe(true)

    // Idempotent
    expect(hydrateTnSwipers(root)).toBe(0)
    root.remove()
  })

  it('leaves an empty swiper placeholder in place', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<div class="tn-swiper is-empty"><div class="swiper-container"><p class="tn-swiper-empty">empty swiper</p></div></div>'
    document.body.append(root)
    expect(hydrateTnSwipers(root)).toBe(1)
    expect(root.querySelector('.tn-swiper-empty')?.textContent).toBe('empty swiper')
    expect(hydrateTnSwipers(root)).toBe(0)
    root.remove()
  })

  it('omits the tab bar for a single slide', () => {
    const root = swiperShell(['solo'])
    hydrateTnSwipers(root)
    expect(root.querySelector('.tn-swiper-tabs')).toBeNull()
    expect(root.querySelector('.swiper-slide')!.classList.contains('is-active')).toBe(true)
    root.remove()
  })
})
