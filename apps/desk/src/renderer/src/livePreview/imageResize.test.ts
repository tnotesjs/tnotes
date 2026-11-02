// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  closeImageSizePopover,
  createImageResizeHandles,
  openImageSizePopover
} from './imageResize'

afterEach(() => {
  closeImageSizePopover()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function frameOf(width: number, height: number): HTMLElement {
  const frame = document.createElement('span')
  document.body.append(frame)
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
    width,
    height,
    left: 10,
    top: 10,
    right: 10 + width,
    bottom: 10 + height,
    x: 10,
    y: 10,
    toJSON: () => ({})
  })
  Object.defineProperty(frame, 'offsetWidth', { value: width })
  return frame
}

function drag(handle: HTMLElement, dx: number, dy: number): void {
  handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true }))
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 + dx, clientY: 100 + dy }))
  window.dispatchEvent(new MouseEvent('mouseup'))
}

function imageOf(naturalWidth: number, naturalHeight: number): HTMLImageElement {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { value: naturalWidth })
  Object.defineProperty(image, 'naturalHeight', { value: naturalHeight })
  return image
}

describe('four-corner image resize', () => {
  it('creates one handle per corner, bottom-right first', () => {
    const handles = createImageResizeHandles(frameOf(200, 100), {
      minWidth: 48,
      maxWidth: () => 800,
      commit: vi.fn()
    })
    expect(handles.map((handle) => handle.className)).toEqual([
      'cm-lp-image-handle is-se',
      'cm-lp-image-handle is-sw',
      'cm-lp-image-handle is-ne',
      'cm-lp-image-handle is-nw'
    ])
  })

  it('grows from right corners when dragging right and from left corners when dragging left', () => {
    const commit = vi.fn()
    const frame = frameOf(200, 100)
    const [se, sw] = createImageResizeHandles(frame, { minWidth: 48, maxWidth: () => 800, commit })
    drag(se!, 40, 0)
    expect(commit).toHaveBeenLastCalledWith('240px')
    drag(sw!, -40, 0)
    expect(commit).toHaveBeenLastCalledWith('240px')
    drag(sw!, 40, 0)
    expect(commit).toHaveBeenLastCalledWith('160px')
  })

  it('turns a mostly vertical drag into width through the aspect ratio', () => {
    const commit = vi.fn()
    const [se, , ne] = createImageResizeHandles(frameOf(200, 100), {
      minWidth: 48,
      maxWidth: () => 800,
      commit
    })
    drag(se!, 0, 30)
    expect(commit).toHaveBeenLastCalledWith('260px')
    drag(ne!, 0, -30)
    expect(commit).toHaveBeenLastCalledWith('260px')
  })

  it('clamps to the minimum and maximum width and ignores drags when disabled', () => {
    const commit = vi.fn()
    const [se] = createImageResizeHandles(frameOf(200, 100), {
      minWidth: 48,
      maxWidth: () => 300,
      commit
    })
    drag(se!, -500, 0)
    expect(commit).toHaveBeenLastCalledWith('48px')
    drag(se!, 500, 0)
    expect(commit).toHaveBeenLastCalledWith('300px')

    const blocked = vi.fn()
    const [locked] = createImageResizeHandles(frameOf(200, 100), {
      minWidth: 48,
      maxWidth: () => 800,
      enabled: () => false,
      commit: blocked
    })
    drag(locked!, 40, 0)
    expect(blocked).not.toHaveBeenCalled()
  })
})

describe('resize popover', () => {
  function inputs(): [HTMLInputElement, HTMLInputElement] {
    const all = document.querySelectorAll<HTMLInputElement>('.cm-lp-image-size-popover input')
    return [all[0]!, all[1]!]
  }

  it('links width and height by the natural ratio and writes only the width', () => {
    const commit = vi.fn()
    openImageSizePopover(imageOf(800, 400), frameOf(200, 100), commit)
    const [width, height] = inputs()
    expect(width.value).toBe('200')
    expect(height.value).toBe('100')

    height.value = '150'
    height.dispatchEvent(new Event('input'))
    expect(width.value).toBe('300')

    width.value = '120'
    width.dispatchEvent(new Event('input'))
    expect(height.value).toBe('60')

    width.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(commit).toHaveBeenCalledWith('120px')
    expect(document.querySelector('.cm-lp-image-size-popover')).toBeNull()
  })

  it('floors tiny widths at 16px and closes on Escape without writing', () => {
    const commit = vi.fn()
    openImageSizePopover(imageOf(100, 100), frameOf(100, 100), commit)
    const [width] = inputs()
    width.value = '3'
    width.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(commit).toHaveBeenCalledWith('16px')

    const cancelled = vi.fn()
    openImageSizePopover(imageOf(100, 100), frameOf(100, 100), cancelled)
    inputs()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(cancelled).not.toHaveBeenCalled()
    expect(document.querySelector('.cm-lp-image-size-popover')).toBeNull()
  })
})
