// @vitest-environment happy-dom
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderTable, tableImageChange, type TableImageChange } from './cards'
import { imageDeleteChange, imageAt } from './images'
import { requestImagePreview, runImageMenuAction } from './imageMenu'
import { tnotesMarkdown } from './language'

function stateOf(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [tnotesMarkdown()] })
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}

function apply(doc: string, index: number, next: TableImageChange, src = ''): string | null {
  const state = stateOf(doc)
  const pos = doc.indexOf('|')
  const change = tableImageChange(state, pos, index, next, src)
  if (!change) return null
  return state.update({ changes: change }).state.doc.toString()
}

afterEach(() => {
  document.body.replaceChildren()
})

const TABLE = [
  '前文',
  '',
  '| a | b |',
  '| --- | --- |',
  '| `![code](x.png)` ![one](https://e.com/1.png) | <img src="raw.png"> ![two](./two.png){w=120px} |',
  '',
  '后文'
].join('\n')

describe('table card image chrome', () => {
  it('numbers only markdown images (skips code spans and raw <img>) and wraps them like body images', () => {
    const card = renderTable(TABLE, (src) => src, new Map(), {
      readOnly: false,
      commit: () => undefined
    })
    const figures = [...card.querySelectorAll('.cm-lp-table-image')]
    expect(figures).toHaveLength(2)
    expect(figures.map((figure) => figure.querySelector('img')?.dataset.tnMdImage)).toEqual([
      '0',
      '1'
    ])
    expect(
      figures.map((figure) => figure.querySelector('.cm-lp-image-caption')?.textContent)
    ).toEqual(['one', 'two'])
    expect(figures[1]?.querySelector<HTMLElement>('.cm-lp-image-frame')?.style.width).toBe('120px')
    expect(card.querySelectorAll('.cm-lp-image-handle')).toHaveLength(2)
    expect(card.querySelectorAll('.cm-lp-image-more')).toHaveLength(2)
    // 旧的「左 / 中 / 右 / 原始大小」横条已移除
    expect(card.querySelector('.cm-lp-image-toolbar')).toBeNull()
    // 一格一图：第二格已有 markdown 图 two，手写 <img> 不再渲染
    const raw = [...card.querySelectorAll('img')].find(
      (img) => img.getAttribute('src') === 'raw.png'
    )
    expect(raw).toBeUndefined()
    expect(card.querySelectorAll('img')).toHaveLength(2)
  })

  it('moves align=center onto the figure class', () => {
    const card = renderTable(
      '| a |\n| --- |\n| ![](https://e.com/a.png) {w=50% align=center} |\n',
      (src) => src,
      new Map(),
      { readOnly: false, commit: () => undefined }
    )
    const figure = card.querySelector<HTMLElement>('.cm-lp-table-image')
    expect(figure?.classList.contains('is-center')).toBe(true)
    expect(figure?.querySelector('img')?.getAttribute('style')).toBeNull()
  })

  it('writes {w=…} back on the Nth markdown image of the table source', () => {
    const next = apply(TABLE, 1, { width: '240px' })
    expect(next).toContain('![two](./two.png) {w=240px} |')
    expect(next).toContain('![one](https://e.com/1.png) |')
    expect(next).toContain('`![code](x.png)`')
    expect(apply(TABLE, 0, { width: '88px' })).toContain('![one](https://e.com/1.png) {w=88px} |')
  })

  it('aligns, resets size and deletes table images without breaking the row', () => {
    expect(apply(TABLE, 1, { align: 'right' })).toContain(
      '![two](./two.png) {w=120px align=right} |'
    )
    expect(apply(TABLE, 1, { width: '' })).toContain('![two](./two.png) |')
    const removed = apply(TABLE, 0, { remove: true })
    expect(removed).toContain('| `![code](x.png)`  | <img src="raw.png"> ![two]')
    expect(removed?.split('\n')).toHaveLength(TABLE.split('\n').length)
  })

  it('refuses to write when the expected src does not match (never edits the wrong image)', () => {
    expect(apply(TABLE, 0, { width: '100px' }, 'https://e.com/OTHER.png')).toBeNull()
    expect(apply(TABLE, 0, { width: '100px' }, 'https://e.com/1.png')).toContain('{w=100px}')
    expect(apply(TABLE, 5, { width: '100px' })).toBeNull()
  })

  it('table drag commits the layout width with index + expected src', () => {
    const commits: Array<[number, TableImageChange, string | undefined]> = []
    const card = renderTable(TABLE, (src) => src, new Map(), {
      readOnly: false,
      commit: (index, next, src) => commits.push([index, next, src])
    })
    document.body.append(card)
    const handle = card.querySelectorAll('.cm-lp-image-handle')[1]!
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 180 }))
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 180 }))
    expect(commits).toHaveLength(1)
    expect(commits[0]?.[0]).toBe(1)
    expect(commits[0]?.[1]).toEqual({ width: expect.stringMatching(/^\d+px$/) })
    expect(commits[0]?.[2]).toBe('./two.png')
  })
})

describe('image ⋯ menu actions', () => {
  it('maps native menu choices to handlers and preview events', () => {
    const handlers = { align: vi.fn(), resetSize: vi.fn(), remove: vi.fn() }
    const scope = document.createElement('div')
    const image = document.createElement('img')
    image.src = 'https://e.com/a.png'
    scope.append(image)
    document.body.append(scope)
    const previews: EventTarget[] = []
    document.addEventListener(
      'tn:preview-image',
      (event) => {
        previews.push((event as CustomEvent).detail)
      },
      { once: true }
    )

    runImageMenuAction('image-preview', image, handlers)
    runImageMenuAction('image-align-center', image, handlers)
    runImageMenuAction('image-align-left', image, handlers)
    runImageMenuAction('image-reset-size', image, handlers)
    runImageMenuAction('image-delete', image, handlers)
    runImageMenuAction(null, image, handlers)

    expect(previews).toEqual([image])
    expect(handlers.align.mock.calls).toEqual([['center'], ['left']])
    expect(handlers.resetSize).toHaveBeenCalledTimes(1)
    expect(handlers.remove).toHaveBeenCalledTimes(1)
  })

  it('does not request a preview for a broken image without src', () => {
    const image = document.createElement('img')
    document.body.append(image)
    const listener = vi.fn()
    document.addEventListener('tn:preview-image', listener, { once: true })
    requestImagePreview(image)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('body image delete', () => {
  it('removes a standalone image line entirely and keeps inline neighbours', () => {
    const doc = '前文\n\n![a](./a.png) {w=200px}\n\n后文'
    const state = stateOf(doc)
    const image = imageAt(state, doc.indexOf('![a]') + 2)!
    const change = imageDeleteChange(state, image)
    expect(state.update({ changes: change }).state.doc.toString()).toBe('前文\n\n\n后文')

    const inline = '看图 ![b](./b.png) 继续'
    const inlineState = stateOf(inline)
    const inlineImage = imageAt(inlineState, inline.indexOf('![b]') + 2)!
    expect(
      inlineState
        .update({ changes: imageDeleteChange(inlineState, inlineImage) })
        .state.doc.toString()
    ).toBe('看图  继续')
  })
})

describe('table cell one image slot (first passable only)', () => {
  it('only chromes the first whitelist-passable image per cell; no prompt; writeback uses that index', () => {
    const source = [
      '| pics |',
      '| --- |',
      '| ![a](https://e.com/a.png) ![b](https://e.com/b.png) ![c](https://e.com/c.png) |',
      ''
    ].join('\n')
    const commits: Array<[number, TableImageChange, string | undefined]> = []
    const card = renderTable(source, (src) => src, new Map(), {
      readOnly: false,
      commit: (index, next, src) => commits.push([index, next, src])
    })
    const figures = [...card.querySelectorAll('.cm-lp-table-image')]
    expect(figures).toHaveLength(1)
    expect(figures[0]?.querySelector('img')?.dataset.tnMdImage).toBe('0')
    expect(figures[0]?.querySelector('img')?.getAttribute('src')).toBe('https://e.com/a.png')
    // 一格一图：其余两张不渲染（不在 DOM 里，也不是裸 <img>）
    expect(card.querySelectorAll('img')).toHaveLength(1)
    expect(card.querySelector('img[src="https://e.com/b.png"]')).toBeNull()
    expect(card.querySelector('img[src="https://e.com/c.png"]')).toBeNull()
    expect(card.querySelector('td')?.textContent).not.toMatch(/!\[|\]\(/)
    expect(card.querySelectorAll('.cm-lp-image-handle')).toHaveLength(1)
    expect(card.querySelectorAll('.cm-lp-image-more')).toHaveLength(1)

    const handle = card.querySelector('.cm-lp-image-handle')!
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 160 }))
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 160 }))
    expect(commits).toHaveLength(1)
    expect(commits[0]?.[0]).toBe(0)
    expect(commits[0]?.[2]).toBe('https://e.com/a.png')
  })

  it('skips a rejected first image and chromes the next passable one in the cell', () => {
    const bad =
      'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C/svg%3E'
    const source = `| pics |\n| --- |\n| ![bad](${bad}) ![ok](https://e.com/ok.png) |\n`
    const card = renderTable(source, (src) => (src.startsWith('https://') ? src : ''), new Map(), {
      readOnly: false,
      commit: () => undefined
    })
    const figures = [...card.querySelectorAll('.cm-lp-table-image')]
    expect(figures).toHaveLength(1)
    expect(figures[0]?.querySelector('img')?.getAttribute('src')).toBe('https://e.com/ok.png')
    expect(figures[0]?.querySelector('img')?.dataset.tnMdImage).toBe('1')
    // 被拒的 bad 图也不留在格里
    expect(card.querySelectorAll('img')).toHaveLength(1)
  })

  it('read-only table also renders one image per cell; each cell keeps its own first image', () => {
    const source = [
      '| x | y |',
      '| --- | --- |',
      '| ![a](https://e.com/a.png) ![b](https://e.com/b.png) | ![c](https://e.com/c.png) ![d](https://e.com/d.png) ![e](https://e.com/e.png) |',
      ''
    ].join('\n')
    const card = renderTable(source, (src) => src)
    const cells = [...card.querySelectorAll('td')]
    expect(cells.map((cell) => cell.querySelectorAll('img').length)).toEqual([1, 1])
    expect(cells.map((cell) => cell.querySelector('img')?.dataset.tnMdImage)).toEqual(['0', '2'])
  })

  it("editable: second cell writeback still targets that cell's first image index", () => {
    const source = [
      '| x | y |',
      '| --- | --- |',
      '| ![a](https://e.com/a.png) ![b](https://e.com/b.png) | ![c](https://e.com/c.png) ![d](https://e.com/d.png) |',
      ''
    ].join('\n')
    const commits: Array<[number, TableImageChange, string | undefined]> = []
    const card = renderTable(source, (src) => src, new Map(), {
      readOnly: false,
      commit: (index, next, src) => commits.push([index, next, src])
    })
    expect(card.querySelectorAll('img')).toHaveLength(2)
    const handles = [...card.querySelectorAll('.cm-lp-image-handle')]
    expect(handles).toHaveLength(2)
    handles[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150 }))
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 150 }))
    expect(commits[0]?.[0]).toBe(2)
    expect(commits[0]?.[2]).toBe('https://e.com/c.png')
  })

  it('a cell with only a rejected image keeps the src-less <img> (08 policy unchanged)', () => {
    const source = '| pics |\n| --- |\n| ![bad](data:image/png;base64,AAAA) |\n'
    const card = renderTable(source, () => '')
    const images = card.querySelectorAll('img')
    expect(images).toHaveLength(1)
    expect(images[0]?.hasAttribute('src')).toBe(false)
  })

  it('drops a linked extra image together with its now-empty link', () => {
    const source =
      '| pics |\n| --- |\n| ![a](https://e.com/a.png) [![b](https://e.com/b.png)](https://e.com/) |\n'
    const card = renderTable(source, (src) => src)
    expect(card.querySelectorAll('img')).toHaveLength(1)
    expect(card.querySelector('td a')).toBeNull()
  })
})
