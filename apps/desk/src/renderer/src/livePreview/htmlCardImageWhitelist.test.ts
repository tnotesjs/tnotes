// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { renderTable, rewriteResolvedImages } from './cards'
import { resolveMarkdownImageUrl } from '../markdown/markdownAssetUrl'

const BAD_SVG =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22240%22%20height%3D%2280%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%23f60%22%2F%3E%3Ctext%20x%3D%22120%22%20y%3D%2248%22%20text-anchor%3D%22middle%22%20fill%3D%22%23fff%22%20font-size%3D%2220%22%3EBAD%20HTML%3C%2Ftext%3E%3C%2Fsvg%3E'

const resolveImage = (src: string) => resolveMarkdownImageUrl(src, 'kb', 'note')

// todo 2026.10.05/08：HTML 卡片与表格卡片共用剥离逻辑；resolve 为空则去掉 src
describe('html card image whitelist', () => {
  it('strips rejected img src (same path HTML and table cards use)', () => {
    expect(resolveImage(BAD_SVG)).toBe('')

    const root = document.createElement('div')
    root.innerHTML = `<img src="${BAD_SVG}" alt="html-should-strip"><img src="https://example.com/ok.png" alt="ok">`
    rewriteResolvedImages(root, resolveImage)

    const [blocked, allowed] = [...root.querySelectorAll('img')]
    expect(blocked.getAttribute('src')).toBeNull()
    expect(blocked.getAttribute('alt')).toBe('html-should-strip')
    expect(allowed.getAttribute('src')).toBe('https://example.com/ok.png')
  })

  it('leaves images without src alone when already empty', () => {
    const root = document.createElement('div')
    root.innerHTML = '<img alt="empty">'
    rewriteResolvedImages(root, resolveImage)
    expect(root.querySelector('img')!.hasAttribute('src')).toBe(false)
  })

  it('table card parses rejected data: image as <img> without src, never as raw text', () => {
    const source = `| md | html |\n| --- | --- |\n| ![table](${BAD_SVG}) | ok |\n`
    const card = renderTable(source, resolveImage)
    const image = card.querySelector('img')
    expect(image).not.toBeNull()
    expect(image!.getAttribute('src')).toBeNull()
    expect(image!.getAttribute('alt')).toBe('table')
    expect(card.textContent).not.toContain('data:image/svg+xml')
    expect(card.textContent).not.toContain('![table]')
  })

  it('data: link href is still dropped by DOMPurify', () => {
    const card = renderTable(`| a |\n| --- |\n| [x](${BAD_SVG}) |\n`, resolveImage)
    const link = card.querySelector('a')
    expect(link?.getAttribute('href') ?? null).toBeNull()
  })

  it('javascript: image still not parsed', () => {
    const card = renderTable('| a |\n| --- |\n| ![x](javascript:alert(1)) |\n', resolveImage)
    expect(card.querySelector('img')).toBeNull()
  })

  // todo 2026.10.05/08 同路径：表格卡片与容器一样消化 {w=} / align=，勿把属性当正文露出
  it('table card applies {w=} on cell images and drops the attr text', () => {
    const source = ['| pic |', '| --- |', '| ![](https://example.com/a.webp) {w=366px} |', ''].join(
      '\n'
    )
    const card = renderTable(source, (src) => src)
    const image = card.querySelector('img')
    expect(image?.getAttribute('src')).toBe('https://example.com/a.webp')
    expect(image?.style.width).toBe('366px')
    expect(card.textContent ?? '').not.toContain('w=366')
    expect(card.textContent ?? '').not.toContain('{w=')
  })

  it('table card centers a cell image when align=center is set', () => {
    const source = '| a |\n| --- |\n| ![](https://example.com/a.webp) {w=50% align=center} |\n'
    const card = renderTable(source, (src) => src)
    const image = card.querySelector('img')
    expect(image?.style.width).toBe('50%')
    expect(image?.style.marginLeft).toBe('auto')
    expect(image?.style.marginRight).toBe('auto')
    expect(card.textContent ?? '').not.toContain('align=')
  })

  it('table card leaves a brace run that is not an image attr', () => {
    const source = '| a |\n| --- |\n| ![](https://example.com/a.webp) {not-an-attr} |\n'
    const card = renderTable(source, (src) => src)
    expect(card.querySelector('img')?.style.width).toBe('')
    expect(card.textContent ?? '').toContain('{not-an-attr}')
  })

  it('mounts a resize handle on editable table card images', () => {
    const commits: Array<{ index: number; width?: string }> = []
    const source = '| pic |\n| --- |\n| ![](https://example.com/a.webp) {w=366px} |\n'
    const card = renderTable(source, (src) => src, new Map(), {
      readOnly: false,
      commit: (index, next) => commits.push({ index, width: next.width })
    })
    const frame = card.querySelector('.cm-lp-image-frame')
    const handle = card.querySelector('.cm-lp-image-handle')
    const image = card.querySelector('img')
    expect(frame).not.toBeNull()
    expect(handle).not.toBeNull()
    expect(frame?.contains(image!)).toBe(true)
    expect((frame as HTMLElement).style.width).toBe('366px')
    expect(card.textContent ?? '').not.toContain('{w=')

    handle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, button: 0 }))
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 160 }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 160 }))
    expect(commits).toHaveLength(1)
    expect(commits[0]?.index).toBe(0)
    expect(commits[0]?.width).toMatch(/^\d+px$/)
  })

  it('read-only table card keeps caption + ⋯ (preview) but no resize handle', () => {
    const source = '| pic |\n| --- |\n| ![封面](https://example.com/a.webp) {w=366px} |\n'
    const card = renderTable(source, (src) => src, new Map(), {
      readOnly: true,
      commit: () => undefined
    })
    expect(card.querySelector('.cm-lp-image-handle')).toBeNull()
    expect(card.querySelector('.cm-lp-image-more')).not.toBeNull()
    expect(card.querySelector<HTMLElement>('.cm-lp-image-frame')?.style.width).toBe('366px')
    expect(card.querySelector('.cm-lp-image-caption')?.textContent).toBe('封面')
  })
})
