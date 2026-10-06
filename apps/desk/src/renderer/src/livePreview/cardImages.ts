import type MarkdownIt from 'markdown-it'
import type { ImageAlign } from '@tnotesjs/ui/image-markdown'

import { createImageMoreButton } from './imageMenu'

/**
 * markdown-it 渲染的卡片（表格、`:::` 提示块）里的图片，与正文 ImageWidget 共用同一套外观：
 * 拖拽宽度把手 + 「⋯」系统菜单（预览 / 对齐 / 原始大小 / 删除）+ 标题。
 */

/** 卡片图片的改动：宽度 / 对齐写回 `{w=… align=…}`，或删掉整张图。 */
export type CardImageChange = { width?: string; align?: ImageAlign } | { remove: true }

export interface CardImageEditor {
  readOnly: boolean
  /** `expectedSrc` 是 markdown-it 归一化后的原始地址，写回前核对第 N 张图没对错 */
  commit(index: number, next: CardImageChange, expectedSrc?: string): void
}

/**
 * markdown 写法的图片按出现顺序编号（手写 `<img>` 标签不编号、不可编辑），
 * 写回时对上源码里第 N 个 Image 语法节点；`data-tn-md-src` 用来核对没对错图。
 */
export function numberMarkdownImages(instance: InstanceType<typeof MarkdownIt>): void {
  instance.core.ruler.push('tn_number_images', (state) => {
    let index = 0
    for (const block of state.tokens) {
      for (const token of block.children ?? []) {
        if (token.type !== 'image') continue
        token.attrSet('data-tn-md-image', String(index))
        token.attrSet('data-tn-md-src', String(token.attrGet('src') ?? ''))
        index += 1
      }
    }
  })
}

const MIN_CARD_IMAGE_WIDTH = 48

function inlineAlign(image: HTMLImageElement): ImageAlign {
  const { marginLeft, marginRight } = image.style
  if (marginLeft === 'auto' && marginRight === 'auto') return 'center'
  if (marginLeft === 'auto') return 'right'
  return 'left'
}

export interface EnhanceCardImagesOptions {
  /**
   * 表格单元格「一格一图」：每个 `td`/`th` 只给「第一张白名单通过（有 src）的 markdown 图」加拖拽/⋯。
   * 同格其余图片应先用 {@link keepFirstImagePerCell} 从 DOM 里删掉；写回仍用该图自己的全局 index。
   */
  firstPassablePerCell?: boolean
}

function firstPassableMarkdownImage(cell: Element): HTMLImageElement | null {
  for (const image of cell.querySelectorAll<HTMLImageElement>('img[data-tn-md-image]')) {
    if (image.getAttribute('src')) return image
  }
  return null
}

/** 删掉一张图；若外层是只包着它的链接，链接一起删，避免留下空 `<a>`。 */
function removeImage(image: HTMLImageElement): void {
  const parent = image.parentElement
  image.remove()
  if (parent?.tagName === 'A' && !parent.textContent?.trim() && !parent.querySelector('img')) {
    parent.remove()
  }
}

/**
 * 表格单元格「一格一图」（与思维导图节点一致）：每个 `td`/`th` 只保留第一张白名单通过（有 src）的
 * markdown 图，同格其余图片（后续 markdown 图、被剥掉 src 的图、手写 `<img>`）直接从 DOM 删除，
 * 不留无控件的裸图，也不弹选择提示。格内没有可用的 markdown 图时不动（被拒图仍按 08 策略无 src 保留）。
 */
export function keepFirstImagePerCell(root: ParentNode): void {
  root.querySelectorAll('td, th').forEach((cell) => {
    const keep = firstPassableMarkdownImage(cell)
    if (!keep) return
    cell.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
      if (image !== keep) removeImage(image)
    })
  })
}

/** 表格单元格：挑出每格第一张白名单通过的 markdown 图（有 src）；其它格内 markdown 图忽略。 */
export function pickFirstPassableMarkdownImagesPerCell(root: ParentNode): HTMLImageElement[] {
  const picked: HTMLImageElement[] = []
  const claimed = new Set<Element>()
  root.querySelectorAll<HTMLImageElement>('img[data-tn-md-image]').forEach((image) => {
    if (image.closest('.cm-lp-image-frame')) return
    const cell = image.closest('td, th')
    if (!cell) {
      if (image.getAttribute('src')) picked.push(image)
      return
    }
    if (claimed.has(cell)) return
    if (!image.getAttribute('src')) return
    claimed.add(cell)
    picked.push(image)
  })
  return picked
}

/**
 * 把卡片里带编号的 markdown 图片包成与正文 ImageWidget 同构的结构：
 * `.cm-lp-image.is-{align}` > `.cm-lp-image-frame`（img + 右侧拖拽把手 + 「⋯」）+ 标题。
 * `applyImageSizeAttrs` 先把 `{w=… align=…}` 落到 img 行内样式上，这里搬到外框/类名。
 * `figureClass` 区分所在卡片（`cm-lp-table-image` / `cm-lp-container-image`），供样式微调。
 */
export function enhanceCardImages(
  root: HTMLElement,
  editor: CardImageEditor,
  figureClass: string,
  options: EnhanceCardImagesOptions = {}
): void {
  const images = options.firstPassablePerCell
    ? pickFirstPassableMarkdownImagesPerCell(root)
    : [...root.querySelectorAll<HTMLImageElement>('img[data-tn-md-image]')]
  for (const image of images) {
    if (image.closest('.cm-lp-image-frame')) continue
    const parent = image.parentNode
    if (!parent) continue
    const index = Number(image.dataset.tnMdImage)
    const expectedSrc = image.dataset.tnMdSrc ?? ''
    const width = image.style.width
    const align = inlineAlign(image)
    for (const prop of ['width', 'max-width', 'height', 'display', 'margin-left', 'margin-right']) {
      image.style.removeProperty(prop)
    }
    if (!image.getAttribute('style')) image.removeAttribute('style')
    image.draggable = false

    const figure = document.createElement('span')
    figure.className = `cm-lp-image ${figureClass} is-${align}`
    const frame = document.createElement('span')
    frame.className = 'cm-lp-image-frame'
    if (width) frame.style.width = width
    parent.insertBefore(figure, image)
    frame.append(image)
    figure.append(frame)

    if (!editor.readOnly) {
      const handle = document.createElement('span')
      handle.className = 'cm-lp-image-handle'
      handle.title = '拖动调整宽度'
      handle.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const startX = event.clientX
        const measured = frame.getBoundingClientRect().width || frame.offsetWidth
        const startWidth = Math.max(MIN_CARD_IMAGE_WIDTH, measured || MIN_CARD_IMAGE_WIDTH)
        // 编辑区可能带 CSS 缩放：拖动距离按屏幕像素算，写回布局像素
        const zoom = startWidth / Math.max(1, frame.offsetWidth || startWidth)
        const maxWidth = Math.max(
          MIN_CARD_IMAGE_WIDTH,
          root.getBoundingClientRect().width || startWidth * 4
        )
        let nextWidth = startWidth
        const layoutPx = (): string => `${Math.round(nextWidth / zoom)}px`
        const move = (moveEvent: MouseEvent): void => {
          nextWidth = Math.min(
            maxWidth,
            Math.max(MIN_CARD_IMAGE_WIDTH, startWidth + moveEvent.clientX - startX)
          )
          frame.style.width = layoutPx()
        }
        const up = (): void => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          editor.commit(index, { width: layoutPx() }, expectedSrc)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      })
      frame.append(handle)
    }

    const actions = document.createElement('span')
    actions.className = 'cm-lp-image-actions'
    actions.append(
      createImageMoreButton(
        image,
        () => ({ align, hasWidth: Boolean(width), editable: !editor.readOnly }),
        {
          align: (next) => editor.commit(index, { align: next }, expectedSrc),
          resetSize: () => editor.commit(index, { width: '' }, expectedSrc),
          remove: () => editor.commit(index, { remove: true }, expectedSrc)
        }
      )
    )
    frame.append(actions)

    const alt = image.getAttribute('alt') ?? ''
    if (alt) {
      const caption = document.createElement('span')
      caption.className = 'cm-lp-image-caption'
      caption.textContent = alt
      figure.append(caption)
    }
  }
}
