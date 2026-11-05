import { clearImageSizeMask, syncImageSizeMask } from './imageSizeMask'

/** 与 `normalizeImageWidth` 的下限一致 */
export const MIN_IMAGE_INPUT_WIDTH = 16

/** 右下角排第一：`querySelector('.cm-lp-image-handle')` 取到的仍是向右拖变宽的那个 */
const CORNERS = ['se', 'sw', 'ne', 'nw'] as const
type Corner = (typeof CORNERS)[number]

export interface ImageResizeOptions {
  minWidth: number
  maxWidth(): number
  /** 只读时把手不响应 */
  enabled?(): boolean
  /** 松手时写回的布局像素宽度，如 `320px` */
  commit(width: string): void
}

/**
 * 四角等比缩放把手。Markdown 只存宽度，高度随原图比例，所以比例天然锁定；
 * 拖左侧两角时水平位移取反，竖向位移按当前宽高比折算成宽度，取变化更大的一边。
 */
export function createImageResizeHandles(
  frame: HTMLElement,
  options: ImageResizeOptions
): HTMLElement[] {
  return CORNERS.map((corner) => {
    const handle = document.createElement('span')
    handle.className = `cm-lp-image-handle is-${corner}`
    handle.title = '拖动等比缩放'
    handle.addEventListener('mousedown', (event) => startDrag(event, corner, frame, options))
    return handle
  })
}

function startDrag(
  event: MouseEvent,
  corner: Corner,
  frame: HTMLElement,
  options: ImageResizeOptions
): void {
  event.preventDefault()
  event.stopPropagation()
  if (options.enabled && !options.enabled()) return
  const rect = frame.getBoundingClientRect()
  const startWidth = Math.max(options.minWidth, rect.width || frame.offsetWidth || options.minWidth)
  // 编辑区可能带 CSS 缩放：拖动距离按屏幕像素算，写回布局像素
  const zoom = startWidth / Math.max(1, frame.offsetWidth || startWidth)
  const ratio = rect.height > 0 ? startWidth / rect.height : 0
  const signX = corner.endsWith('w') ? -1 : 1
  const signY = corner.startsWith('n') ? -1 : 1
  const maxWidth = Math.max(options.minWidth, options.maxWidth())
  const startX = event.clientX
  const startY = event.clientY
  let width = startWidth
  const layoutPx = (): string => `${Math.round(width / zoom)}px`
  const move = (moveEvent: MouseEvent): void => {
    const byX = signX * (moveEvent.clientX - startX)
    const byY = ratio ? signY * (moveEvent.clientY - startY) * ratio : 0
    const delta = Math.abs(byY) > Math.abs(byX) ? byY : byX
    width = Math.min(maxWidth, Math.max(options.minWidth, startWidth + delta))
    frame.style.width = layoutPx()
    syncImageSizeMask(frame)
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    clearImageSizeMask(frame)
    options.commit(layoutPx())
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

/** 宽高互算：按原图比例；比例未知时只认宽度 */
export function linkedHeight(width: number, image: HTMLImageElement): number | null {
  if (!image.naturalWidth || !image.naturalHeight) return null
  return Math.round((width * image.naturalHeight) / image.naturalWidth)
}

export function linkedWidth(height: number, image: HTMLImageElement): number | null {
  if (!image.naturalWidth || !image.naturalHeight) return null
  return Math.round((height * image.naturalWidth) / image.naturalHeight)
}

let openPopover: HTMLElement | null = null
let detachPopoverScroll: (() => void) | null = null

export function closeImageSizePopover(): void {
  detachPopoverScroll?.()
  detachPopoverScroll = null
  openPopover?.remove()
  openPopover = null
}

const SIZE_PRESETS = [25, 50, 75, 100] as const

/**
 * 「调整尺寸…」浮层：宽、高两个输入框，加上相对原图的 25/50/75/100。
 * 改一边另一边按原图比例跟着变，合法数字立即写回宽度；只写宽度，下限 16px。
 */
export function openImageSizePopover(
  image: HTMLImageElement,
  frame: HTMLElement,
  commit: (width: string) => void
): HTMLElement {
  closeImageSizePopover()
  const popover = document.createElement('div')
  popover.className = 'cm-lp-image-size-popover'
  popover.setAttribute('role', 'dialog')
  popover.setAttribute('aria-label', '调整图片尺寸')

  const fields = document.createElement('div')
  fields.className = 'cm-lp-image-size-fields'
  const field = (label: string): HTMLInputElement => {
    const wrap = document.createElement('label')
    const text = document.createElement('span')
    text.textContent = label
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '1'
    input.step = '1'
    input.setAttribute('aria-label', label === '宽' ? '宽度' : '高度')
    wrap.append(text, input)
    fields.append(wrap)
    return input
  }
  const widthInput = field('宽')
  const heightInput = field('高')
  popover.append(fields)

  const currentWidth = Math.round(frame.offsetWidth || image.width || image.naturalWidth || 0)
  widthInput.value = currentWidth ? String(currentWidth) : ''
  const initialHeight = linkedHeight(currentWidth, image)
  heightInput.value = initialHeight ? String(initialHeight) : ''
  heightInput.disabled = initialHeight === null

  const presets = document.createElement('div')
  presets.className = 'cm-lp-image-size-presets'
  const presetButtons: HTMLButtonElement[] = []
  for (const percent of SIZE_PRESETS) {
    if (percent === 100) {
      const gap = document.createElement('span')
      gap.className = 'cm-lp-image-size-preset-gap'
      gap.setAttribute('aria-hidden', 'true')
      presets.append(gap)
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = `${percent}%`
    button.dataset.percent = String(percent)
    button.disabled = !image.naturalWidth
    presetButtons.push(button)
    presets.append(button)
  }
  popover.append(presets)

  const markPreset = (width: number): void => {
    const natural = image.naturalWidth
    for (const button of presetButtons) {
      const percent = Number(button.dataset.percent)
      const target = natural ? Math.round((natural * percent) / 100) : 0
      button.classList.toggle('is-active', natural > 0 && Math.abs(target - width) <= 1)
    }
  }

  const applyWidth = (px: number): void => {
    const value = Math.max(MIN_IMAGE_INPUT_WIDTH, Math.round(px))
    widthInput.value = String(value)
    const nextHeight = linkedHeight(value, image)
    if (nextHeight !== null) heightInput.value = String(nextHeight)
    markPreset(value)
    commit(`${value}px`)
  }

  widthInput.addEventListener('input', () => {
    const raw = Number(widthInput.value)
    if (!Number.isFinite(raw) || raw <= 0) return
    const next = linkedHeight(raw, image)
    if (next !== null) heightInput.value = String(next)
    applyWidth(raw)
  })
  heightInput.addEventListener('input', () => {
    const raw = Number(heightInput.value)
    if (!Number.isFinite(raw) || raw <= 0) return
    const next = linkedWidth(raw, image)
    if (next === null) return
    applyWidth(next)
  })
  for (const button of presetButtons) {
    button.addEventListener('click', () => {
      const percent = Number(button.dataset.percent)
      if (!image.naturalWidth) return
      applyWidth((image.naturalWidth * percent) / 100)
    })
  }
  markPreset(currentWidth)

  popover.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      closeImageSizePopover()
    }
  })
  // 不让编辑器把这里的点击当成移动光标
  popover.addEventListener('mousedown', (event) => event.stopPropagation())

  const rect = frame.getBoundingClientRect()
  document.body.append(popover)
  // 贴在图片上沿上方一行。长图若挂在下沿，浮层会落到视口外面。
  const gap = 6
  popover.style.left = `${Math.round(rect.left)}px`
  popover.style.top = `${Math.max(8, Math.round(rect.top - popover.offsetHeight - gap))}px`
  openPopover = popover
  const outside = (event: MouseEvent): void => {
    if (openPopover !== popover) {
      document.removeEventListener('mousedown', outside, true)
      return
    }
    if (!popover.contains(event.target as Node)) {
      document.removeEventListener('mousedown', outside, true)
      closeImageSizePopover()
    }
  }
  document.addEventListener('mousedown', outside, true)
  widthInput.focus()
  widthInput.select()
  // 聚焦输入框时编辑器可能顺带滚一下，等这次过了再监听，避免刚打开就被关掉。
  queueMicrotask(() => {
    if (openPopover !== popover) return
    const targets: EventTarget[] = [window, document]
    for (let node: Node | null = frame.parentNode; node; node = node.parentNode) targets.push(node)
    const onScroll = (): void => {
      if (openPopover === popover) closeImageSizePopover()
    }
    for (const target of targets) target.addEventListener('scroll', onScroll)
    detachPopoverScroll = () => {
      for (const target of targets) target.removeEventListener('scroll', onScroll)
    }
  })
  return popover
}
