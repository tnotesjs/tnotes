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

export function closeImageSizePopover(): void {
  openPopover?.remove()
  openPopover = null
}

/**
 * 「调整尺寸…」浮层：宽、高两个输入框，改一边另一边按原图比例跟着变。
 * 只写宽度；下限 16px（低于下限按下限写）。
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

  const field = (label: string): HTMLInputElement => {
    const wrap = document.createElement('label')
    const text = document.createElement('span')
    text.textContent = label
    const input = document.createElement('input')
    input.type = 'number'
    input.min = String(MIN_IMAGE_INPUT_WIDTH)
    input.step = '1'
    wrap.append(text, input)
    popover.append(wrap)
    return input
  }
  const widthInput = field('宽')
  const heightInput = field('高')
  const currentWidth = Math.round(frame.offsetWidth || image.width || image.naturalWidth || 0)
  widthInput.value = currentWidth ? String(currentWidth) : ''
  const initialHeight = linkedHeight(currentWidth, image)
  heightInput.value = initialHeight ? String(initialHeight) : ''
  heightInput.disabled = initialHeight === null

  widthInput.addEventListener('input', () => {
    const next = linkedHeight(Number(widthInput.value), image)
    if (next !== null && Number(widthInput.value) > 0) heightInput.value = String(next)
  })
  heightInput.addEventListener('input', () => {
    const next = linkedWidth(Number(heightInput.value), image)
    if (next !== null && Number(heightInput.value) > 0) widthInput.value = String(next)
  })

  const actions = document.createElement('div')
  actions.className = 'cm-lp-image-size-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = '取消'
  const confirm = document.createElement('button')
  confirm.type = 'button'
  confirm.className = 'is-primary'
  confirm.textContent = '确定'
  actions.append(cancel, confirm)
  popover.append(actions)

  const apply = (): void => {
    const value = Math.round(Number(widthInput.value))
    if (!Number.isFinite(value) || value <= 0) {
      widthInput.focus()
      return
    }
    closeImageSizePopover()
    commit(`${Math.max(MIN_IMAGE_INPUT_WIDTH, value)}px`)
  }
  confirm.addEventListener('click', apply)
  cancel.addEventListener('click', closeImageSizePopover)
  popover.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      apply()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeImageSizePopover()
    }
  })
  // 不让编辑器把这里的点击当成移动光标
  popover.addEventListener('mousedown', (event) => event.stopPropagation())

  const rect = frame.getBoundingClientRect()
  popover.style.left = `${Math.round(rect.left)}px`
  popover.style.top = `${Math.round(rect.bottom + 6)}px`
  document.body.append(popover)
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
  return popover
}
