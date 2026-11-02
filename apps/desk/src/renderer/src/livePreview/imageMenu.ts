import type { ImageAlign } from '@tnotesjs/ui/image-markdown'

import { pushToast } from '../stores/toast'
import { openImageSizePopover } from './imageResize'

import type { ContextMenuAction } from '../../../shared/contracts'

/** 拉到本地 / 推到图床需要的笔记上下文 */
export interface ImageAssetContext {
  knowledgeBaseId: string
  noteUuid: string
  /** 当前笔记编辑器里的最新全文（含未保存改动） */
  content(): string
}

/** 正文图片与表格卡片图片共用的「⋯」更多菜单（系统菜单）。 */
export interface ImageMenuState {
  align: ImageAlign
  hasWidth: boolean
  editable: boolean
  /** Markdown 里写的图片地址 */
  src?: string
  asset?: ImageAssetContext | null
}

export interface ImageMenuHandlers {
  align(align: ImageAlign): void
  resetSize(): void
  remove(): void
  /** 只换地址，其它保持不变 */
  replaceSrc?(src: string): void
  /** 「调整尺寸…」确定后写回宽度，如 `320px` */
  resize?(width: string): void
}

export function isRemoteImageSrc(src: string): boolean {
  return /^https?:\/\//i.test(src.trim())
}

/** 知识库 assets 里的图（`../assets/…`、`./assets/…`）；已解码，可直接交给主进程解析 */
export function localAssetSrc(src: string): string | null {
  let decoded = src.trim()
  try {
    decoded = decodeURI(decoded)
  } catch {
    // 保留原样
  }
  return /^(?:\.\.\/|\.\/)?assets\/[^?#]+$/.test(decoded) ? decoded : null
}

function errorText(result: { ok: false; error: { message: string } }): string {
  return result.error.message
}

async function pullRemote(
  src: string,
  asset: ImageAssetContext,
  replaceSrc: (src: string) => void
): Promise<void> {
  const api = window.desk?.attachments
  if (!api) return
  const result = await api.pullRemote({
    knowledgeBaseId: asset.knowledgeBaseId,
    noteUuid: asset.noteUuid,
    url: src.trim()
  })
  if (!result.ok) {
    pushToast(`拉到本地失败：${errorText(result)}`, 'error')
    return
  }
  replaceSrc(result.value.markdownPath)
  pushToast('已拉到本地', 'success')
}

async function pushLocal(
  src: string,
  asset: ImageAssetContext,
  replaceSrc: (src: string) => void
): Promise<void> {
  const api = window.desk?.attachments
  const local = localAssetSrc(src)
  if (!api || !local) return
  const context = { knowledgeBaseId: asset.knowledgeBaseId, noteUuid: asset.noteUuid }
  const pushed = await api.pushLocal({ ...context, src: local })
  if (!pushed.ok) {
    pushToast(`推到图床失败：${errorText(pushed)}`, 'error')
    return
  }
  replaceSrc(pushed.value.markdownPath)
  if (!pushed.value.deleteLocalAfterPush) {
    pushToast('已推到图床', 'success')
    return
  }
  const released = await api.releaseLocal({ ...context, src: local, content: asset.content() })
  const outcome = released.ok ? released.value : null
  if (outcome?.deleted) {
    pushToast('已推到图床，本地文件已删除', 'success')
  } else if (outcome && !outcome.deleted && outcome.reason === 'referenced') {
    pushToast('已推到图床；知识库里还有其它引用，本地文件未删除', 'info')
  } else {
    pushToast('已推到图床，本地文件未删除', 'info')
  }
}

/**
 * 交给全局 `<ImagePreview />`：带上 img 元素本身，预览按它所在的编辑器根收集同组图片，
 * 不扫整页 document（多个标签的编辑器同时挂着，会串图）。
 */
export function requestImagePreview(image: HTMLImageElement): void {
  if (!image.getAttribute('src')) return
  image.dispatchEvent(new CustomEvent('tn:preview-image', { bubbles: true, detail: image }))
}

/** 系统剪贴板解不了的格式（webp / svg 等）：把页面上已显示的图画到 canvas 转成 PNG */
async function rasterizeImage(image: HTMLImageElement): Promise<Uint8Array | null> {
  try {
    if (!image.complete || !image.naturalWidth) await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth || image.width || 300
    canvas.height = image.naturalHeight || image.height || 150
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null
  } catch {
    return null
  }
}

async function copyImage(
  image: HTMLImageElement,
  src: string,
  asset: ImageAssetContext
): Promise<void> {
  const api = window.desk?.attachments
  if (!api) return
  const result = await api.copyImage({ knowledgeBaseId: asset.knowledgeBaseId, src })
  if (!result.ok) {
    pushToast(`复制图片失败：${errorText(result)}`, 'error')
    return
  }
  if (result.value.copied) {
    pushToast('已复制图片', 'success')
    return
  }
  const png = await rasterizeImage(image)
  const fallback = png ? await api.copyImage({ png }) : null
  if (fallback?.ok && fallback.value.copied) pushToast('已复制图片', 'success')
  else pushToast('复制图片失败：无法转换这种图片格式', 'error')
}

async function exportImage(src: string, asset: ImageAssetContext): Promise<void> {
  const api = window.desk?.attachments
  if (!api) return
  const result = await api.exportImage({ knowledgeBaseId: asset.knowledgeBaseId, src })
  if (!result.ok) {
    pushToast(`导出图片失败：${errorText(result)}`, 'error')
    return
  }
  if (result.value.saved) pushToast(`已导出到 ${result.value.filePath}`, 'success')
}

export function runImageMenuAction(
  action: ContextMenuAction | null,
  image: HTMLImageElement,
  handlers: ImageMenuHandlers,
  state?: ImageMenuState
): void | Promise<void> {
  switch (action) {
    case 'image-resize': {
      const frame = image.closest<HTMLElement>('.cm-lp-image-frame, .tn-swiper-frame')
      if (handlers.resize) openImageSizePopover(image, frame ?? image, handlers.resize)
      return
    }
    case 'image-copy':
      if (state?.src && state.asset) return copyImage(image, state.src, state.asset)
      return
    case 'image-export':
      if (state?.src && state.asset) return exportImage(state.src, state.asset)
      return
    case 'image-pull-remote':
      if (state?.src && state.asset && handlers.replaceSrc) {
        return pullRemote(state.src, state.asset, handlers.replaceSrc)
      }
      return
    case 'image-push-local':
      if (state?.src && state.asset && handlers.replaceSrc) {
        return pushLocal(state.src, state.asset, handlers.replaceSrc)
      }
      return
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
  const transferable = Boolean(state.src && state.asset && handlers.replaceSrc)
  const result = await app.showContextMenu({
    kind: 'image',
    align: state.align,
    hasWidth: state.hasWidth,
    editable: state.editable,
    remote: transferable && isRemoteImageSrc(state.src!),
    local: transferable && localAssetSrc(state.src!) !== null,
    copyable: Boolean(state.src && state.asset)
  })
  if (!result.ok) return
  await runImageMenuAction(result.value, image, handlers, state)
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
