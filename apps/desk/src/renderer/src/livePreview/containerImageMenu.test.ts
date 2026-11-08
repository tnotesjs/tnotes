// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { renderContainerFromSource } from '../editor/markdown/containerBody'
import { clearDetailsOpenSession, detailsSessionKey } from './cards'

afterEach(() => {
  document.body.replaceChildren()
})

const editor = { readOnly: false, commit: () => undefined }

describe('callout card image chrome', () => {
  it('wraps markdown images in info/tip/warning/danger/details like body images', () => {
    for (const name of ['quote', 'tip', 'warning', 'danger', 'details']) {
      const el = renderContainerFromSource(
        `::: ${name}\n\n![a](https://e.com/a.png) {w=50% align=center}\n\n<img src="https://e.com/raw.png">\n\n:::`,
        (src) => src,
        undefined,
        undefined,
        editor
      )
      const figures = [...el.querySelectorAll('.cm-lp-container-image')]
      expect(figures, name).toHaveLength(1)
      expect(figures[0]?.classList.contains('is-center')).toBe(true)
      expect(figures[0]?.querySelector<HTMLElement>('.cm-lp-image-frame')?.style.width).toBe('50%')
      expect(figures[0]?.querySelector('.cm-lp-image-caption')?.textContent).toBe('a')
      expect(el.querySelectorAll('.cm-lp-image-handle.is-se')).toHaveLength(1)
      expect(el.querySelectorAll('.cm-lp-image-more')).toHaveLength(1)
      expect(el.querySelector('.cm-lp-image-toolbar')).toBeNull()
      // 手写 <img> 不编号、不加控件
      const raw = [...el.querySelectorAll('img')].find((img) => img.src.includes('raw.png'))
      expect(raw?.closest('.cm-lp-image-frame')).toBeNull()
    }
  })

  it('read-only: keeps ⋯ (preview) but no resize handle; no editor → plain images', () => {
    const ro = renderContainerFromSource(
      '::: tip\n![a](https://e.com/a.png)\n:::',
      (src) => src,
      undefined,
      undefined,
      { readOnly: true, commit: () => undefined }
    )
    expect(ro.querySelectorAll('.cm-lp-image-more')).toHaveLength(1)
    expect(ro.querySelectorAll('.cm-lp-image-handle.is-se')).toHaveLength(0)
    const site = renderContainerFromSource('::: tip\n![a](https://e.com/a.png)\n:::')
    expect(site.querySelector('.cm-lp-image-frame')).toBeNull()
  })
})

describe('details fold icon + session open cache', () => {
  it('renders left-side fold chevron matching heading fold SVG', () => {
    const el = renderContainerFromSource('::: details 标题\n\n正文\n\n:::')
    expect(el.tagName).toBe('DETAILS')
    const fold = el.querySelector('.tn-details-fold')
    expect(fold).not.toBeNull()
    expect(fold?.querySelector('svg')).not.toBeNull()
    expect(el.querySelector('summary')?.textContent).toContain('标题')
  })

  it('keeps details expanded across remount after image attr writeback (session cache)', () => {
    clearDetailsOpenSession()
    const note = 'note-1'
    const before = '::: details\n\n![a](https://e.com/a.png)\n\n:::'
    const after = '::: details\n\n![a](https://e.com/a.png) {w=120px}\n\n:::'
    expect(detailsSessionKey(note, before)).toBe(detailsSessionKey(note, after))

    let open = false
    const first = renderContainerFromSource(before, (s) => s, undefined, undefined, editor, {
      open: false,
      onOpenChange: (next) => {
        open = next
      }
    }) as HTMLDetailsElement
    first.querySelector('summary')!.click()
    expect(first.open).toBe(true)
    expect(open).toBe(true)

    // 模拟 CardWidget 按 session key 重建
    const session = new Map<string, boolean>()
    session.set(detailsSessionKey(note, before), open)
    const remount = renderContainerFromSource(after, (s) => s, undefined, undefined, editor, {
      open: session.get(detailsSessionKey(note, after)) ?? false
    }) as HTMLDetailsElement
    expect(remount.open).toBe(true)
    expect(remount.querySelector('.cm-lp-container-image')).not.toBeNull()
  })
})
