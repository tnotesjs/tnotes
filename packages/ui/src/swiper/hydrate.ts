/**
 * Client-side tab activation for `.tn-swiper` shells emitted by the SSG
 * markdown pipeline (empty `.tn-swiper-tabs`, all slides in the wrapper).
 * Desk also uses this after building slide DOM so both hosts share one path.
 */

export function applySwiperTabsPadding(tabs: HTMLElement, hasNav: boolean): void {
  tabs.style.padding = hasNav ? '0 0.8rem 0 3rem' : '0 0.8rem'
}

export function createSwiperTabNav(handlers: { onPrev: () => void; onNext: () => void }): {
  prev: HTMLButtonElement
  line: HTMLSpanElement
  next: HTMLButtonElement
} {
  const prev = document.createElement('button')
  prev.type = 'button'
  prev.className = 'tn-tab-nav tn-tab-prev'
  prev.textContent = '<'
  prev.title = '上一页'
  prev.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    handlers.onPrev()
  })

  const line = document.createElement('span')
  line.className = 'tn-tab-nav tab-tab-line'
  line.textContent = '/'

  const next = document.createElement('button')
  next.type = 'button'
  next.className = 'tn-tab-nav tn-tab-next'
  next.textContent = '>'
  next.title = '下一页'
  next.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    handlers.onNext()
  })

  return { prev, line, next }
}

export function wrapSlideIndex(index: number, length: number, delta: -1 | 1): number {
  if (length <= 0) return 0
  return (index + delta + length) % length
}

export const SWIPER_EMPTY_TEXT = 'empty swiper'

/** 没有图片幻灯片时的壳。Desk 与站点用同一段结构。 */
export function emptySwiperMarkup(): string {
  return `<div class="tn-swiper is-empty"><div class="swiper-container"><p class="tn-swiper-empty">${SWIPER_EMPTY_TEXT}</p></div></div>`
}

const READY = 'tnSwiperReady'

/**
 * Hydrate every `.tn-swiper` under `root` (or `document`). Idempotent:
 * already-hydrated roots are skipped via `data-tn-swiper-ready`.
 * When `root` itself is a `.tn-swiper`, it is included.
 */
export function hydrateTnSwipers(root: ParentNode = document): number {
  const hosts: HTMLElement[] = []
  if (root instanceof HTMLElement && root.classList.contains('tn-swiper')) {
    hosts.push(root)
  }
  hosts.push(...root.querySelectorAll<HTMLElement>('.tn-swiper'))

  let count = 0
  const seen = new Set<HTMLElement>()
  for (const host of hosts) {
    if (seen.has(host)) continue
    seen.add(host)
    if (host.dataset[READY] === 'true') continue
    if (hydrateOne(host)) {
      host.dataset[READY] = 'true'
      count += 1
    }
  }
  return count
}

function hydrateOne(host: HTMLElement): boolean {
  if (host.classList.contains('is-empty')) return true
  const tabs = host.querySelector<HTMLElement>('.tn-swiper-tabs')
  const wrapper = host.querySelector<HTMLElement>('.swiper-wrapper')
  if (!wrapper) return false

  const slides = [...wrapper.querySelectorAll<HTMLElement>(':scope > .swiper-slide')]
  if (slides.length === 0) {
    // Empty shell — still mark ready so we don't loop.
    return true
  }

  // Ensure tabs host exists (site always emits it; Desk may omit for 1 slide).
  let tabsEl = tabs
  if (!tabsEl) {
    tabsEl = document.createElement('div')
    tabsEl.className = 'tn-swiper-tabs'
    host.prepend(tabsEl)
  }

  const useTabs = slides.length > 1
  tabsEl.replaceChildren()
  applySwiperTabsPadding(tabsEl, useTabs)

  const tabButtons: HTMLButtonElement[] = []

  const activate = (index: number): void => {
    tabButtons.forEach((button, buttonIndex) =>
      button.classList.toggle('active', buttonIndex === index)
    )
    slides.forEach((slide, slideIndex) => {
      const on = slideIndex === index
      slide.classList.toggle('is-active', on)
      slide.hidden = !on
    })
  }

  const activeIndex = (): number => {
    const found = tabButtons.findIndex((button) => button.classList.contains('active'))
    return found >= 0 ? found : 0
  }

  if (useTabs) {
    const nav = createSwiperTabNav({
      onPrev: () => activate(wrapSlideIndex(activeIndex(), slides.length, -1)),
      onNext: () => activate(wrapSlideIndex(activeIndex(), slides.length, 1))
    })
    tabsEl.append(nav.prev, nav.line)

    slides.forEach((slide, index) => {
      const title =
        slide.dataset.title?.trim() ||
        slide.querySelector('img')?.getAttribute('alt')?.trim() ||
        'img'
      slide.dataset.title = title
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'tn-tab'
      tab.textContent = title
      tab.addEventListener('click', () => activate(index))
      tabButtons.push(tab)
      tabsEl!.append(tab)
    })

    tabsEl.append(nav.next)
    // Multi-slide: tabs stay above the container.
    if (tabsEl.parentElement !== host || host.firstElementChild !== tabsEl) {
      host.prepend(tabsEl)
    }
  } else {
    // Single slide: drop empty tab bar (Desk parity).
    tabsEl.remove()
  }

  activate(0)
  return true
}
