// @vitest-environment happy-dom
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  beginImageUpload,
  cancelImageUpload,
  finishImageUpload,
  IMAGE_UPLOAD_HINT_DELAY_MS,
  imageUploadExtension
} from './imageUpload'
import {
  bindImageLoadState,
  IMAGE_STATUS_DELAY_MS,
  imageStatusCopy,
  shortenImageAddress
} from './widgets'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
  vi.useRealTimers()
})

function mount(doc = '前文\n'): EditorView {
  const parent = document.createElement('div')
  parent.className = 'live-editor'
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [imageUploadExtension]
    })
  })
  views.push(view)
  return view
}

describe('image address copy', () => {
  it('shortens a remote url to host and file name', () => {
    expect(shortenImageAddress('https://cdn.example.com/images/very/long/photo.png?x=1')).toBe(
      'cdn.example.com/photo.png'
    )
    expect(shortenImageAddress('data:image/png;base64,aaaa')).toBe('')
    expect(shortenImageAddress('./assets/cover.png')).toBe('cover.png')
  })

  it('uses the alt text while loading and adds the address when loading fails', () => {
    expect(imageStatusCopy('loading', '封面', 'https://cdn.example.com/a.png')).toEqual({
      label: '图片加载中',
      detail: '封面'
    })
    expect(imageStatusCopy('error', '封面', 'https://cdn.example.com/a.png')).toEqual({
      label: '图片无法加载',
      detail: '封面 · cdn.example.com/a.png'
    })
    expect(imageStatusCopy('loading', '', 'https://cdn.example.com/a.png').detail).toBe(
      'cdn.example.com/a.png'
    )
  })
})

describe('image load placeholder', () => {
  it('shows a placeholder only after the image is still loading', () => {
    vi.useFakeTimers()
    const frame = document.createElement('span')
    const img = document.createElement('img')
    const caption = document.createElement('span')
    caption.className = 'cm-lp-image-caption'
    caption.textContent = '封面'
    const figure = document.createElement('span')
    figure.append(frame, caption)
    document.body.append(figure)

    let complete = false
    let naturalWidth = 0
    Object.defineProperty(img, 'complete', { get: () => complete })
    Object.defineProperty(img, 'naturalWidth', { get: () => naturalWidth })
    frame.append(img)
    img.setAttribute('src', 'https://cdn.example.com/a.png')

    const status = bindImageLoadState(img, frame, () => ({
      alt: '封面',
      src: 'https://cdn.example.com/a.png'
    }))
    expect(frame.classList.contains('is-pending')).toBe(false)
    expect(caption.hidden).toBe(false)

    vi.advanceTimersByTime(IMAGE_STATUS_DELAY_MS)
    expect(frame.classList.contains('is-pending')).toBe(true)
    expect(frame.textContent).toContain('图片加载中')
    expect(frame.textContent).toContain('封面')
    expect(caption.hidden).toBe(true)

    complete = true
    naturalWidth = 800
    img.dispatchEvent(new Event('load'))
    expect(frame.classList.contains('is-pending')).toBe(false)
    expect(frame.querySelector('.cm-lp-image-status')?.hasAttribute('hidden')).toBe(true)
    expect(caption.hidden).toBe(false)
    status.destroy()
  })

  it('keeps a failed image visible as an error placeholder', () => {
    vi.useFakeTimers()
    const frame = document.createElement('span')
    const img = document.createElement('img')
    Object.defineProperty(img, 'complete', { get: () => false })
    Object.defineProperty(img, 'naturalWidth', { get: () => 0 })
    frame.append(img)
    img.setAttribute('src', 'https://cdn.example.com/missing.png')
    bindImageLoadState(img, frame, () => ({
      alt: '',
      src: 'https://cdn.example.com/missing.png'
    }))
    img.dispatchEvent(new Event('error'))
    expect(frame.classList.contains('is-error')).toBe(true)
    expect(frame.textContent).toContain('图片无法加载')
    expect(frame.textContent).toContain('cdn.example.com/missing.png')
    vi.advanceTimersByTime(IMAGE_STATUS_DELAY_MS)
    expect(frame.classList.contains('is-pending')).toBe(false)
  })
})

describe('image upload placeholder', () => {
  it('leaves the document unchanged until the upload finishes, then inserts the image', () => {
    vi.useFakeTimers()
    const view = mount('前文')
    const id = beginImageUpload(view, view.state.doc.length, '正在上传到图床')
    expect(view.dom.querySelector('.cm-lp-image-upload')).toBeNull()
    expect(view.state.doc.toString()).toBe('前文')

    vi.advanceTimersByTime(IMAGE_UPLOAD_HINT_DELAY_MS)
    expect(view.dom.querySelector('.cm-lp-image-upload')?.textContent).toBe('正在上传到图床')
    expect(view.state.doc.toString()).toBe('前文')

    expect(finishImageUpload(view, id, '\n![](https://cdn.example.com/a.png)\n')).toBe(true)
    expect(view.dom.querySelector('.cm-lp-image-upload')).toBeNull()
    expect(view.state.doc.toString()).toBe('前文\n![](https://cdn.example.com/a.png)\n')
  })

  it('skips the placeholder when the upload returns before the hint delay', () => {
    vi.useFakeTimers()
    const view = mount('前文')
    const id = beginImageUpload(view, 1, '正在保存图片')
    expect(finishImageUpload(view, id, '![](a.png)')).toBe(true)
    vi.advanceTimersByTime(IMAGE_UPLOAD_HINT_DELAY_MS)
    expect(view.dom.querySelector('.cm-lp-image-upload')).toBeNull()
    expect(view.state.doc.toString()).toBe('前![](a.png)文')
  })

  it('drops the placeholder when the upload is cancelled', () => {
    vi.useFakeTimers()
    const view = mount('前文')
    const id = beginImageUpload(view, view.state.doc.length, '正在上传到图床')
    vi.advanceTimersByTime(IMAGE_UPLOAD_HINT_DELAY_MS)
    cancelImageUpload(view, id)
    expect(view.dom.querySelector('.cm-lp-image-upload')).toBeNull()
    expect(view.state.doc.toString()).toBe('前文')
  })

  it('keeps the insertion point when text is typed ahead of a pending upload', () => {
    vi.useFakeTimers()
    const view = mount('前文')
    const id = beginImageUpload(view, 2, '正在上传到图床')
    view.dispatch({
      changes: { from: 2, insert: '补充' },
      selection: EditorSelection.cursor(4)
    })
    expect(finishImageUpload(view, id, '![](a.png)')).toBe(true)
    expect(view.state.doc.toString()).toBe('前文补充![](a.png)')
  })
})
