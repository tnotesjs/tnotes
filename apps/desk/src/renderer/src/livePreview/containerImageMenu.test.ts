// @vitest-environment happy-dom
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { afterEach, describe, expect, it } from 'vitest'

import { renderContainerFromSource } from '../editor/markdown/containerBody'
import {
  clearDetailsOpenSession,
  containerImageChange,
  detailsSessionKey,
  type ContainerImageChange
} from './cards'
import { tnotesMarkdown } from './language'

function stateOf(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [tnotesMarkdown()] })
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}

function apply(
  doc: string,
  index: number,
  next: ContainerImageChange,
  src = '',
  at = ':::'
): string | null {
  const state = stateOf(doc)
  const change = containerImageChange(state, doc.indexOf(at), index, next, src)
  if (!change) return null
  return state.update({ changes: change }).state.doc.toString()
}

afterEach(() => {
  document.body.replaceChildren()
})

const editor = { readOnly: false, commit: () => undefined }

const INFO = [
  '前文 ![out](https://e.com/out.png)',
  '',
  '::: info 标题',
  '',
  '说明 `![code](x.png)` <img src="raw.png">',
  '',
  '![one](https://e.com/1.png)',
  '',
  '行内 ![two](./two.png){w=120px} 图',
  '',
  ':::',
  '',
  '后文'
].join('\n')

describe('callout card image chrome', () => {
  it('wraps markdown images in info/tip/warning/danger/details like body images', () => {
    for (const name of ['info', 'tip', 'warning', 'danger', 'details']) {
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
      expect(el.querySelectorAll('.cm-lp-image-handle')).toHaveLength(1)
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
    expect(ro.querySelectorAll('.cm-lp-image-handle')).toHaveLength(0)
    const site = renderContainerFromSource('::: tip\n![a](https://e.com/a.png)\n:::')
    expect(site.querySelector('.cm-lp-image-frame')).toBeNull()
  })

  it('writes {w=…} / align back on the Nth image of the callout body only', () => {
    const wide = apply(INFO, 1, { width: '240px' })
    expect(wide).toContain('行内 ![two](./two.png) {w=240px} 图')
    expect(wide).toContain('![one](https://e.com/1.png)\n')
    expect(wide).toContain('前文 ![out](https://e.com/out.png)')
    expect(apply(INFO, 0, { align: 'center' })).toContain(
      '![one](https://e.com/1.png) {align=center}'
    )
    expect(apply(INFO, 1, { width: '' })).toContain('行内 ![two](./two.png) 图')
  })

  it('deletes a standalone image line, or only the image when it shares a line', () => {
    const removed = apply(INFO, 0, { remove: true })
    expect(removed).not.toContain('![one]')
    expect(removed).toContain('::: info 标题')
    expect(removed?.split('\n')).toHaveLength(INFO.split('\n').length - 1)
    expect(apply(INFO, 1, { remove: true })).toContain('行内  图')
  })

  it('refuses to write when the expected src does not match or the index is out of range', () => {
    expect(apply(INFO, 0, { width: '100px' }, 'https://e.com/OTHER.png')).toBeNull()
    expect(apply(INFO, 0, { width: '100px' }, 'https://e.com/1.png')).toContain('{w=100px}')
    expect(apply(INFO, 5, { width: '100px' })).toBeNull()
  })

  it('numbers images in the same order the renderer does (code, raw html, nested ::: text)', () => {
    const src = '::: warning\n\n```md\n![no](n.png)\n```\n\n![first](https://e.com/f.png)\n\n:::'
    const el = renderContainerFromSource(src, (s) => s, undefined, undefined, editor)
    const img = el.querySelector<HTMLImageElement>('img[data-tn-md-image]')
    expect(img?.dataset.tnMdImage).toBe('0')
    expect(apply(src, 0, { width: '90px' }, img?.dataset.tnMdSrc)).toContain(
      '![first](https://e.com/f.png) {w=90px}'
    )
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
    const first = renderContainerFromSource(
      before,
      (s) => s,
      undefined,
      undefined,
      editor,
      {
        open: false,
        onOpenChange: (next) => {
          open = next
        }
      }
    ) as HTMLDetailsElement
    first.querySelector('summary')!.click()
    expect(first.open).toBe(true)
    expect(open).toBe(true)

    // 模拟 CardWidget 按 session key 重建
    const session = new Map<string, boolean>()
    session.set(detailsSessionKey(note, before), open)
    const remount = renderContainerFromSource(
      after,
      (s) => s,
      undefined,
      undefined,
      editor,
      { open: session.get(detailsSessionKey(note, after)) ?? false }
    ) as HTMLDetailsElement
    expect(remount.open).toBe(true)
    expect(remount.querySelector('.cm-lp-container-image')).not.toBeNull()
  })
})
