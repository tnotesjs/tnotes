import type { ImageAlign } from '@tnotesjs/ui/image-markdown'

import type { ContextMenuAction } from '../../../shared/contracts'

/** 正文图片与表格卡片图片共用的「⋯」更多菜单（系统菜单）。 */
export interface ImageMenuState {
  align: ImageAlign
  hasWidth: boolean
  editable: boolean
}

export interface ImageMenuHandlers {
  align(align: ImageAlign): void
  resetSize(): void
  remove(): void
}

/**
 * 交给全局 `<ImagePreview />`：带上 img 元素本身，预览按它所在的编辑器根收集同组图片，
 * 不扫整页 document（多个标签的编辑器同时挂着，会串图）。
 */
export function requestImagePreview(image: HTMLImageElement): void {
  if (!image.getAttribute('src')) return
  image.dispatchEvent(new CustomEvent('tn:preview-image', { bubbles: true, detail: image }))
}

export function runImageMenuAction(
  action: ContextMenuAction | null,
  image: HTMLImageElement,
  handlers: ImageMenuHandlers
): void {
  switch (action) {
    case 'image-preview':
      requestImagePreview(image)
      return
    case 'image-align-left':
      handlers.align('left')
      return
    case 'image-align-center':
      handlers.align('center')
      return
    case 'image-align-right':
      handlers.align('right')
      return
    case 'image-reset-size':
      handlers.resetSize()
      return
    case 'image-delete':
      handlers.remove()
      return
    default:
  }
}

async function openImageMenu(
  image: HTMLImageElement,
  state: ImageMenuState,
  handlers: ImageMenuHandlers
): Promise<void> {
  const app = window.desk?.app
  if (!app) return
  const result = await app.showContextMenu({ kind: 'image', ...state })
  if (!result.ok) return
  runImageMenuAction(result.value, image, handlers)
}

const MORE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></g></svg>'

/** 图片右上角悬停出现的「⋯」按钮；点开系统菜单。状态在点开时现取（避免拿到旧的对齐/宽度）。 */
export function createImageMoreButton(
  image: HTMLImageElement,
  state: () => ImageMenuState,
  handlers: ImageMenuHandlers
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'cm-lp-image-more'
  button.title = '更多图片操作'
  button.setAttribute('aria-label', '更多图片操作')
  button.innerHTML = MORE_ICON
  // 不抢编辑器焦点、不让卡片 / 图片的 mousedown 把光标移进源码
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    void openImageMenu(image, state(), handlers)
  })
  return button
}
