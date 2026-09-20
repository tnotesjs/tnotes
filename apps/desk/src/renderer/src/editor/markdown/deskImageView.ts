import { imageSchema } from '@milkdown/kit/preset/commonmark'
import { $view } from '@milkdown/kit/utils'
import {
  normalizeImageAlign,
  normalizeImageWidth,
  serializeImageMarkdown,
  type ImageAlign
} from '@tnotesjs/ui/image-markdown'

import { applyImageClipboardAttrs } from './imageAttrs'
import { resolveMarkdownImageUrl } from '../../markdown/markdownAssetUrl'
import { COPY_ICON, EXPAND_ICON } from '../../markdown/copyIcons'
import {
  canvasAssetRevision,
  cachedCanvasSource,
  probeCanvasSource,
  subscribeCanvasPreview
} from '../excalidraw/canvasImage'
import { subscribeExcalidrawSession } from '../excalidraw/sessionRegistry'
import { resolveNoteAssetRelPath } from '../../markdown/noteAssetPath'
import { useEditorStore } from '../../stores/editor'
import { useWorkspaceStore } from '../../stores/workspace'

import { NodeSelection } from '@milkdown/kit/prose/state'

import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'

const MIN_WIDTH = 80
const COMPACT_WIDTH = 120
const COMPACT_HEIGHT = 40
const SIZE_PRESETS = [25, 50, 75, 100] as const
const CORNERS = ['tl', 'tr', 'br', 'bl'] as const
type Corner = (typeof CORNERS)[number]

const DELETE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>'
const MORE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>'
/** 画布图片专用：去标签页里编辑 */
const CANVAS_EDIT_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'
/** 「正在编辑中」的笔：盖在图中央 */
const CANVAS_EDITING_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'
const SIZE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="6" width="12" height="12" rx="1"/><path d="M16 10h4v10H10v-4"/></svg>'
const CAPTION_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h16"/></svg>'
const ALIGN_ICONS: Record<ImageAlign, string> = {
  left: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h14"/></svg>',
  center:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M5 18h14"/></svg>',
  right:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M10 12h10M6 18h14"/></svg>'
}

export function createDeskImageView(options: {
  knowledgeBaseId: () => string
  noteUuid: () => string
  /** 当前笔记的 KB 相对路径：把图片 src 解析成 assets/ 下的路径（画布判据要用） */
  noteRelPath: () => string
  isReadOnly: () => boolean
  writeClipboard?: (text: string) => Promise<void> | void
}): MilkdownPlugin {
  return $view(imageSchema.node, () => (initialNode, view, getPos) => {
    let current = initialNode
    let selected = false
    let hovered = false
    let captionOpen = Boolean(String(initialNode.attrs.alt ?? '').trim())
    let openPanel: 'size' | 'align' | 'more' | '' = ''

    const figure = document.createElement('figure')
    figure.className = 'tn-image desk-image'
    // 描述浮层不在 figure 里（必须脱离 contenteditable 子树），DOM 顺序也不等于图片
    // 顺序。用图片节点位置把「图片 ↔ 浮层」关联起来：多张图同 x 同宽时也能确定归属。
    figure.dataset.imagePos = String(getPos())
    figure.contentEditable = 'false'
    figure.style.display = 'block'
    figure.style.width = '100%'
    const chrome = document.createElement('div')
    chrome.className = 'desk-image__chrome'
    const toolbar = document.createElement('div')
    toolbar.className = 'desk-image__toolbar'
    const sizeWrap = document.createElement('div')
    sizeWrap.className = 'desk-image__tool-wrap'
    const sizeButton = toolButton(SIZE_ICON, '宽高', '宽高')
    const captionButton = toolButton(CAPTION_ICON, '描述', '描述')
    const alignWrap = document.createElement('div')
    alignWrap.className = 'desk-image__tool-wrap'
    const alignButton = toolButton(ALIGN_ICONS.left, '对齐', '对齐')
    alignButton.classList.add('desk-image__align-trigger')

    const sizePanel = document.createElement('div')
    sizePanel.className = 'desk-image__panel desk-image__size-panel'
    const widthInput = numberField('宽')
    const heightInput = numberField('高')
    const presets = document.createElement('div')
    presets.className = 'desk-image__presets'
    for (const amount of SIZE_PRESETS) {
      const preset = document.createElement('button')
      preset.type = 'button'
      preset.className = 'desk-image__preset'
      preset.textContent = `${amount}%`
      preset.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        writeAttrs(view, getPos, { width: `${amount}%` })
        closePanels()
      })
      presets.append(preset)
    }
    sizePanel.append(widthInput.row, heightInput.row, presets)
    sizeWrap.append(sizeButton, sizePanel)

    const alignPanel = document.createElement('div')
    alignPanel.className = 'desk-image__panel desk-image__align-panel'
    const alignActions: Array<{ align: ImageAlign; label: string }> = [
      { align: 'left', label: '左对齐' },
      { align: 'center', label: '居中对齐' },
      { align: 'right', label: '右对齐' }
    ]
    for (const item of alignActions) {
      const action = document.createElement('button')
      action.type = 'button'
      action.className = 'desk-image__menu-item'
      action.dataset.align = item.align
      action.setAttribute('aria-label', item.label)
      action.dataset.label = item.label
      action.innerHTML = ALIGN_ICONS[item.align]
      action.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        writeAttrs(view, getPos, { align: item.align })
        closePanels()
      })
      alignPanel.append(action)
    }
    alignWrap.append(alignButton, alignPanel)
    // 「编辑」只对画布图片出现（同名 .excalidraw 存在时），见 syncCanvas()
    const canvasEditButton = toolButton(CANVAS_EDIT_ICON, '编辑', '在标签页里编辑画布')
    canvasEditButton.classList.add('desk-image__canvas-edit')
    canvasEditButton.hidden = true
    toolbar.append(sizeWrap, captionButton, alignWrap, canvasEditButton)
    chrome.append(toolbar)

    const stage = document.createElement('div')
    stage.className = 'desk-image__stage'
    const stack = document.createElement('div')
    stack.className = 'desk-image__stack'
    const frame = document.createElement('div')
    frame.className = 'desk-image__frame'
    const image = document.createElement('img')
    image.draggable = false
    const ghost = document.createElement('div')
    ghost.className = 'desk-image__ghost'
    ghost.hidden = true
    const sizeLabel = document.createElement('div')
    sizeLabel.className = 'desk-image__size-label'
    ghost.append(sizeLabel)
    const handles = Object.fromEntries(
      CORNERS.map((corner) => {
        const handle = document.createElement('div')
        handle.className = `desk-image__handle desk-image__handle--${corner}`
        handle.dataset.corner = corner
        return [corner, handle]
      })
    ) as Record<Corner, HTMLDivElement>

    const quick = document.createElement('div')
    quick.className = 'desk-image__quick'
    const previewButton = iconButton(EXPAND_ICON, '全屏')
    const deleteButton = iconButton(DELETE_ICON, '删除')
    const copyButton = iconButton(COPY_ICON, '复制')
    copyButton.classList.add('desk-image__copy')
    const moreButton = iconButton(MORE_ICON, '更多')
    moreButton.classList.add('desk-image__more')
    const dividerA = document.createElement('span')
    dividerA.className = 'desk-image__quick-divider'
    const dividerB = document.createElement('span')
    dividerB.className = 'desk-image__quick-divider'
    quick.append(previewButton, dividerA, deleteButton, dividerB, copyButton, moreButton)

    const morePanel = document.createElement('div')
    morePanel.className = 'desk-image__panel desk-image__more-panel'
    const morePreview = menuItem(EXPAND_ICON, '全屏')
    const moreDelete = menuItem(DELETE_ICON, '删除')
    const moreCopy = menuItem(COPY_ICON, '复制')
    morePanel.append(morePreview, moreDelete, moreCopy)

    const caption = document.createElement('input')
    // 声明为"不可编辑区域里的表单控件"：prosemirror 不会把它当正文内容处理
    caption.contentEditable = 'false'
    caption.type = 'text'
    caption.className = 'desk-image__caption'
    caption.placeholder = '添加图片描述'
    caption.spellcheck = false
    caption.size = 1
    /**
     * 描述输入框挂在**contenteditable 子树之外**（编辑器宿主的绝对定位浮层）。
     *
     * 为什么必须这样：这个 NodeView 在 ProseMirror 的 contenteditable 树内，而
     * ProseMirror 会把树里的 `<input>` 当"正文内容"读取 —— 实测在描述框里逐字输入
     * 「XY」时，图片的 alt 先被写成 `示X例`（在光标处插入），随后 change 又把这个
     * 坏值写回文档，看起来就是"图片被文字替换"。
     * 事件层的所有拦截都无效（`stopEvent` 返回 true、figure/caption 捕获与冒泡
     * `stopPropagation`、编辑器根捕获拦截都试过），因为污染来自 **DOM 读取**而不是
     * 事件冒泡；所以只能在结构上把输入框移出那棵树。
     */
    const captionRow = document.createElement('div')
    captionRow.className = 'desk-image__caption-row'
    captionRow.contentEditable = 'false'
    captionRow.append(caption)
    // 先挂在 figure 上，mount 后再移到宿主（NodeView 的 dom 必须自洽，二者都要在）
    captionRow.dataset.deskImageCaption = 'true'
    captionRow.dataset.imagePos = figure.dataset.imagePos

    // 「正在编辑中」：该画布的标签页开着时，盖在图正中的一支笔
    const editingBadge = document.createElement('div')
    editingBadge.className = 'desk-image__editing'
    editingBadge.hidden = true
    editingBadge.innerHTML = `${CANVAS_EDITING_ICON}<span>编辑中</span>`

    frame.append(
      image,
      ghost,
      editingBadge,
      ...CORNERS.map((corner) => handles[corner]),
      quick,
      morePanel,
      chrome
    )
    stack.append(frame)
    stage.append(stack)
    figure.append(stage)

    const isolate = (event: Event): void => {
      event.stopPropagation()
    }
    for (const node of [chrome, sizePanel, alignPanel, quick, morePanel, caption]) {
      node.addEventListener('mousedown', isolate)
      node.addEventListener('pointerdown', isolate)
    }
    /**
     * 描述框里的按键**绝不能被正文编辑器拿到**。
     *
     * 实测（真实逐字输入）：图片处于选中态时，输入框里的 keydown/input 会冒泡到
     * ProseMirror，被当成"替换选中内容"，于是输入的字被写进图片的 alt ——
     * 例如 alt「示例图」里输入「风景照」会得到 `![示风景照例图]`，
     * 看起来就是"图片被替换成文字"。
     *
     * `stopEvent` 在可编辑态原本一律返回 false，所以这里是唯一的拦截点；
     * 只对描述框内的事件返回 true，A 不误伤正文。
     */
    const fromCaption = (event: Event): boolean =>
      event.target instanceof Node && caption.contains(event.target)
    /**
     * 描述框的输入类事件在**捕获阶段**就被 figure（NodeView 根）吃掉。
     *
     * 只在 stopEvent 里拦不够：实测（真实逐字输入）即使 stopEvent 对
     * keypress/beforeinput 返回 true，输入框的值依然被写成 `示X例`——
     * 事件仍被正文方向处理了一次。捕获阶段停在 figure 上更早、更彻底。
     */
    const captionEventKinds = new Set([
      'keydown',
      'keypress',
      'keyup',
      'beforeinput',
      'input',
      'textInput',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'paste',
      'cut',
      'copy'
    ])
    caption.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        caption.blur()
      }
      if (event.key === 'Escape') {
        // 放弃本次输入：把值还原成当前属性值再失焦
        event.preventDefault()
        caption.value = String(current.attrs.alt ?? '')
        caption.blur()
      }
    })
    // 中文输入法：写入属性只发生在 change / blur（浏览器保证组字期间不触发 change），
    // 且组字事件本身被 stopEvent 拦在 NodeView 内，不会进正文。
    // 打开/聚焦描述框时光标落在**末尾**（继续编辑现有描述的自然预期）。
    // 不这样做时，自动化点击与部分打开路径会把光标留在 0，新输入会插到旧描述前面。
    /**
     * 打开描述框：聚焦并把光标放到末尾（继续编辑现有描述的自然预期）。
     *
     * 需要等**下一帧**再落光标：此刻浮层刚挂上/刚做完定位，浏览器随后可能再落一次
     * 默认选区（实测聚焦早于布局完成时光标会停在 0，新输入被插到旧描述前面）。
     */
    const focusCaption = (): void => {
      caption.focus()
      const place = (): void => {
        if (document.activeElement !== caption) return
        const end = caption.value.length
        if (end > 0) caption.setSelectionRange(end, end)
      }
      place()
      requestAnimationFrame(place)
    }
    caption.addEventListener('change', () => {
      writeAttrs(view, getPos, { alt: caption.value.trim() })
    })
    caption.addEventListener('blur', () => {
      const alt = caption.value.trim()
      writeAttrs(view, getPos, { alt })
      captionOpen = Boolean(alt)
      syncChrome()
    })

    sizeButton.addEventListener('click', (event) => {
      event.preventDefault()
      togglePanel('size')
      if (openPanel === 'size') fillSizeInputs()
    })
    captionButton.addEventListener('click', (event) => {
      event.preventDefault()
      captionOpen = true
      closePanels()
      syncChrome()
      focusCaption()
    })
    alignButton.addEventListener('click', (event) => {
      event.preventDefault()
      togglePanel('align')
    })
    moreButton.addEventListener('click', (event) => {
      event.preventDefault()
      togglePanel('more')
    })

    const preview = (): void => {
      closePanels()
      document.dispatchEvent(new CustomEvent('tn:preview-image', { detail: image }))
    }
    const remove = (): void => {
      closePanels()
      deleteImage(view, getPos)
    }
    const copyMarkdown = (): void => {
      closePanels()
      void options.writeClipboard?.(
        serializeImageMarkdown({
          alt: String(current.attrs.alt ?? ''),
          src: String(current.attrs.src ?? ''),
          title: String(current.attrs.title ?? ''),
          width: String(current.attrs.width ?? ''),
          align: normalizeImageAlign(String(current.attrs.align ?? ''))
        })
      )
    }
    previewButton.addEventListener('click', (event) => {
      event.preventDefault()
      preview()
    })
    deleteButton.addEventListener('click', (event) => {
      event.preventDefault()
      remove()
    })
    copyButton.addEventListener('click', (event) => {
      event.preventDefault()
      copyMarkdown()
    })
    morePreview.addEventListener('click', (event) => {
      event.preventDefault()
      preview()
    })
    moreDelete.addEventListener('click', (event) => {
      event.preventDefault()
      remove()
    })
    moreCopy.addEventListener('click', (event) => {
      event.preventDefault()
      copyMarkdown()
    })

    const commitManualSize = (axis: 'width' | 'height'): void => {
      const aspect = currentAspect()
      const next =
        axis === 'width'
          ? Number.parseInt(widthInput.input.value, 10)
          : Math.round(Number.parseInt(heightInput.input.value, 10) * aspect)
      if (!Number.isFinite(next)) {
        fillSizeInputs()
        return
      }
      writeAttrs(view, getPos, { width: `${clampWidth(next)}px` })
    }
    widthInput.input.addEventListener('change', () => commitManualSize('width'))
    heightInput.input.addEventListener('change', () => commitManualSize('height'))
    widthInput.input.addEventListener('input', () => {
      const width = Number.parseInt(widthInput.input.value, 10)
      const aspect = currentAspect()
      if (!Number.isFinite(width) || aspect <= 0) return
      heightInput.input.value = String(Math.max(1, Math.round(width / aspect)))
    })
    heightInput.input.addEventListener('input', () => {
      const height = Number.parseInt(heightInput.input.value, 10)
      const aspect = currentAspect()
      if (!Number.isFinite(height) || aspect <= 0) return
      widthInput.input.value = String(Math.max(1, Math.round(height * aspect)))
    })

    let drag: { corner: Corner; aspect: number; anchorX: number; anchorY: number } | null = null
    const applyDisplayWidth = (width: string): void => {
      if (width) {
        stack.style.width = width
        stack.classList.add('is-sized')
        image.style.width = '100%'
      } else {
        stack.style.removeProperty('width')
        stack.classList.remove('is-sized')
        image.style.removeProperty('width')
      }
    }
    const applyPreviewWidth = (width: number): void => {
      const next = clampWidth(width)
      applyDisplayWidth(`${next}px`)
      const height = Math.max(1, Math.round(next / Math.max(currentAspect(), 0.01)))
      sizeLabel.textContent = `${next} × ${height}`
    }
    const beginDrag = (corner: Corner, event: PointerEvent): void => {
      if (options.isReadOnly() || event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const rect = image.getBoundingClientRect()
      if (rect.height <= 0 || rect.width <= 0) return
      const anchor = oppositeCorner(corner, rect)
      drag = {
        corner,
        aspect: rect.width / rect.height,
        anchorX: anchor.x,
        anchorY: anchor.y
      }
      closePanels()
      ghost.hidden = false
      figure.classList.add('is-resizing')
      document.body.classList.add('is-resizing-image')
      handles[corner].setPointerCapture(event.pointerId)
      applyPreviewWidth(rect.width)
    }
    const onDrag = (event: PointerEvent): void => {
      if (!drag) return
      event.preventDefault()
      const fromX = Math.abs(event.clientX - drag.anchorX)
      const fromY = Math.abs(event.clientY - drag.anchorY) * drag.aspect
      applyPreviewWidth(Math.max(fromX, fromY))
    }
    const endDrag = (event: PointerEvent): void => {
      if (!drag) return
      const width = image.getBoundingClientRect().width
      const handle = handles[drag.corner]
      drag = null
      ghost.hidden = true
      figure.classList.remove('is-resizing')
      document.body.classList.remove('is-resizing-image')
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
      writeAttrs(view, getPos, { width: `${Math.round(width)}px` })
    }
    for (const corner of CORNERS) {
      handles[corner].addEventListener('pointerdown', (event) => beginDrag(corner, event))
      handles[corner].addEventListener('pointermove', onDrag)
      handles[corner].addEventListener('pointerup', endDrag)
      handles[corner].addEventListener('pointercancel', endDrag)
    }

    figure.addEventListener('mouseenter', () => {
      hovered = true
      syncChrome()
    })
    figure.addEventListener('mouseleave', () => {
      hovered = false
      if (openPanel !== 'more') syncChrome()
    })
    figure.addEventListener('click', (event) => {
      if (!options.isReadOnly()) return
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('.desk-image__caption, .desk-image__caption-row')
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      preview()
    })
    image.addEventListener('load', () => {
      syncCompact()
      if (openPanel === 'size') fillSizeInputs()
    })

    const onDocumentPointerDown = (event: PointerEvent): void => {
      if (!openPanel) return
      const target = event.target
      if (target instanceof Node && figure.contains(target)) return
      closePanels()
    }
    document.addEventListener('pointerdown', onDocumentPointerDown)
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => syncCompact()) : null
    observer?.observe(frame)

    const currentAspect = (): number => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        return image.naturalWidth / image.naturalHeight
      }
      const rect = image.getBoundingClientRect()
      return rect.height > 0 ? rect.width / rect.height : 1
    }
    const maxWidth = (): number => Math.max(MIN_WIDTH, figure.clientWidth || MIN_WIDTH)
    const clampWidth = (width: number): number =>
      Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, width)))
    const fillSizeInputs = (): void => {
      const rect = image.getBoundingClientRect()
      widthInput.input.value = String(Math.round(rect.width) || '')
      heightInput.input.value = String(Math.round(rect.height) || '')
    }
    const togglePanel = (panel: typeof openPanel): void => {
      openPanel = openPanel === panel ? '' : panel
      syncChrome()
    }
    const closePanels = (): void => {
      if (!openPanel) return
      openPanel = ''
      syncChrome()
    }
    const syncCompact = (): void => {
      const rect = image.getBoundingClientRect()
      figure.classList.toggle(
        'is-compact',
        rect.width > 0 && (rect.width < COMPACT_WIDTH || rect.height < COMPACT_HEIGHT)
      )
    }
    const syncChrome = (): void => {
      const readOnly = options.isReadOnly()
      const showQuick = !readOnly && (hovered || selected || openPanel === 'more')
      const showToolbar = !readOnly && selected
      const alt = String(current.attrs.alt ?? '').trim()
      chrome.hidden = !showToolbar
      sizePanel.hidden = openPanel !== 'size'
      alignPanel.hidden = openPanel !== 'align'
      morePanel.hidden = openPanel !== 'more'
      quick.hidden = !showQuick
      figure.dataset.panel = openPanel
      caption.hidden = readOnly ? !alt : !(alt || captionOpen)
      captionRow.hidden = caption.hidden
      caption.readOnly = readOnly
      caption.classList.toggle('is-readonly', readOnly)
      figure.classList.toggle('is-readonly', readOnly)
      figure.classList.toggle('is-more-open', openPanel === 'more')
      figure.classList.toggle('tn-preview-ignore', !readOnly)
      figure.classList.toggle('has-caption', !caption.hidden)
      for (const corner of CORNERS) handles[corner].hidden = readOnly || !selected
      syncCompact()
      positionCaptionRow()
    }

    /**
     * 描述浮层的宿主 = 编辑器宿主的**滚动容器** `.milkdown-markdown-editor__canvas`。
     *
     * 不能在 NodeView 构造时把 `view.dom.parentElement` 定死，这里有两个实测过的坑：
     *  1) 构造时机有两种：首次打开笔记时父元素还是 canvas，而重开笔记（文档内容在
     *     editor 建好之后才 replaceAll 进去）时父元素已经是 Milkdown 的 `.milkdown`
     *     容器；
     *  2) `.milkdown` 容器会被 Milkdown 在插件视图重建时**整个换掉**（旧的连同里面的
     *     浮层一起从文档中移除）。定死的引用指向的正是被丢弃的那个容器，之后浮层
     *     再也回不到文档里（实测：重开笔记后「描述」按钮点得开，但全文档查不到
     *     `input.desk-image__caption`，E2E 在下一步 30s 超时）。
     * canvas 由 Vue 渲染、编辑器生命周期内稳定不变，所以每次都按 closest 重新解析。
     */
    let pinnedHostPosition: HTMLElement | null = null

    const resolveCaptionHost = (): HTMLElement =>
      (view.dom.closest('.milkdown-markdown-editor__canvas') as HTMLElement | null) ??
      view.dom.parentElement ??
      view.dom

    // 构造期即挂载：`caption.focus()` 可能发生在首次 render/syncChrome 之前，
    // 那时元素若还不在文档里，光标会停在 0（实测：后续输入被插到旧描述前面）。
    resolveCaptionHost().append(captionRow)

    /**
     * 描述浮层占的高度要在正文流里补回来。
     *
     * 浮层必须是**绝对定位**（它得在 contenteditable 之外，见上面 `caption` 的说明），
     * 于是它完全不占布局：figure 的高度只算图片，下一个块紧贴图片下沿开始，
     * 描述就压在它上面（实测：图片带描述时，下方代码块的表头被描述行盖住）。
     *
     * 补法：按浮层**实测高度**把间距写回 figure 的下外边距 ——
     * 不写死常量，字号 / 行高 / 缩放变化时同样成立；没有描述时清成空串，
     * 不留多余间距。
     *
     * 为什么用 margin 而不是 padding：padding 会算进 figure 自身的盒高，
     * 而浮层正是按 `figureRect.bottom` 定位的 —— 会自己把自己往下推（正反馈）。
     * margin 在 border box 之外，`figureRect.bottom` 不受影响，一次收敛。
     * 外层 `p.desk-standalone-image` 的 `margin: 8px 0` 与本值相邻折叠，
     * 取较大者，所以"图片下沿 → 下个块"的间距恒 ≥ 本值，不会被它吃掉。
     */
    const CAPTION_OFFSET_PX = 4
    const CAPTION_TAIL_GAP_PX = 8
    const reserveCaptionSpace = (): void => {
      // hidden 时 offsetHeight 恒为 0，这里不用再看 hidden
      const height = captionRow.offsetHeight
      const next = height > 0 ? `${CAPTION_OFFSET_PX + height + CAPTION_TAIL_GAP_PX}px` : ''
      if (figure.style.marginBottom !== next) figure.style.marginBottom = next
    }

    const positionCaptionRow = (): void => {
      const host = resolveCaptionHost()
      if (captionRow.parentElement !== host) host.append(captionRow)
      // 先补间距再定位：两者读的是同一轮布局，顺序不影响结果，
      // 但隐藏时要靠这一句把间距清掉（下面的 hidden 分支会提前返回）。
      reserveCaptionSpace()
      // 只接管"本来就是 static"的宿主：宿主若自带定位（例如 canvas 是 relative），
      // 内联写 relative 是等价的；而 destroy 时只清掉自己写的那次，不覆盖别人的值。
      if (getComputedStyle(host).position === 'static') {
        host.style.position = 'relative'
        pinnedHostPosition = host
      }
      if (captionRow.hidden) return
      const hostRect = host.getBoundingClientRect()
      const figureRect = figure.getBoundingClientRect()
      // 图片还没布局完（首次挂载时实测 figureRect 全 0）就写 minWidth 会把浮层
      // 永久锁成 0 宽：既看不见也点不到，而且之后没有任何事件会重算。此时只挂 DOM，
      // 等 ResizeObserver / 下一次重定位拿到真实尺寸再写。
      if (figureRect.width <= 0) return
      // 宿主自己就是滚动容器：绝对定位的后代随内容一起滚动，所以 left/top 必须是
      // **内容坐标**（加上宿主的 scrollLeft/scrollTop）。用可视坐标会在滚动时被
      // 重复补偿、浮层反向漂移（实测偏差 583px 的"悬挂控件"）。
      // 描述框跟**图片本身**对齐（frame 是图片盒子；stage 是整块容器）：水平位置与
      // 宽度都取 frame —— 若 left 用 figure、minWidth 用 frame，同一个浮层就会有两套
      // 基准（实测：点「居中对齐」后 left 停在 figure 的左沿 618，宽度却已按图片收成
      // 335，浮层整体偏左 168px）。垂直仍贴 figure 下沿。
      const frameRect = (
        figure.querySelector('.desk-image__frame') ?? figure
      ).getBoundingClientRect()
      captionRow.style.left = `${frameRect.left - hostRect.left + host.scrollLeft}px`
      captionRow.style.top = `${figureRect.bottom - hostRect.top + host.scrollTop + CAPTION_OFFSET_PX}px`
      captionRow.style.minWidth = `${frameRect.width}px`
      captionRow.style.maxWidth = `${frameRect.width}px`
      // 同步期间若浏览器把光标留在了开头（聚焦早于挂载/定位时会这样），补到末尾。
      // 只在"已聚焦且仍在 0"时补，所以不会覆盖用户自己点的位置。
      if (
        document.activeElement === caption &&
        caption.selectionStart === 0 &&
        caption.value.length > 0
      ) {
        caption.setSelectionRange(caption.value.length, caption.value.length)
      }
    }

    /**
     * 浮层要跟着图片走：滚动、容器尺寸变化时都重新定位。
     *
     * 浮层挂在滚动容器里，滚动时本来就随内容走；重定位是给宿主的退化分支
     * （解析不到 canvas 时）与尺寸变化兜底。监听挂在 document/window 这种稳定目标上，
     * 不随宿主解析结果变化，destroy 时也一定摘得掉。scroll 不冒泡，用 capture
     * 才能收到任意滚动容器（真正的滚动容器实测是 `.milkdown-markdown-editor__canvas`，
     * `overflow-y: auto`，`.note-editor-area` / `.editor-group-body` 都不能滚）的滚动。
     */
    // 稍后再量一次：改尺寸 / 改对齐这类操作会先同步改 DOM、再派发观察器回调，
    // 回调里读到的仍是**改动前**的布局（实测：点「居中对齐」后图片从 335px 变 670px，
    // 行宽停在 335px）。rAF 在同一帧布局之前触发，仍然读到旧值；用 timeout 把量测
    // 推到本轮样式/布局重算之后。
    let captionRetry = 0
    const reposition = (): void => {
      if (captionRow.hidden) return
      positionCaptionRow()
      if (captionRetry) return
      captionRetry = setTimeout(() => {
        captionRetry = 0
        if (!captionRow.hidden) positionCaptionRow()
      }, 0) as unknown as number
    }
    document.addEventListener('scroll', reposition, { capture: true, passive: true })
    window.addEventListener('resize', reposition)
    // 首次挂载时图片尚未布局（figureRect 全 0），positionCaptionRow 会主动跳过；
    // 布局完成后由 ResizeObserver 补一次定位。桌面窗口缩放（window resize）与
    // 拖拽改尺寸都覆盖得到。
    // 让浮层跟上图片。三种信号都要，缺一不可：
    //  1) ResizeObserver(宿主内容盒)：内容增删 / 拖拽改尺寸 / 窗口变化；
    //  2) ResizeObserver(图片)：图片自身尺寸变化；
    //  3) MutationObserver(内容子树)：**只有位移、尺寸没变**的情况 —— 实测首屏图片
    //     异步完成布局时后面的图片整体下移 424px，宿主内容盒高度与图片自身尺寸都
    //     没变，1) 2) 都不会触发，浮层就停在旧位置（与图片错位 257px）。
    //     图片布局完成时会给 img 写内联尺寸，正好落在 3) 的捕获范围里。
    // 观察目标都取稳定对象（宿主 / figure / view.dom），destroy 时成对断开。
    const captionObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            positionCaptionRow()
          })
    captionObserver?.observe(resolveCaptionHost())
    captionObserver?.observe(figure)
    const captionMutations =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            positionCaptionRow()
          })
    captionMutations?.observe(view.dom, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'width', 'height', 'src']
    })

    /**
     * 画布图片状态：同名 `.excalidraw` 的 KB 相对路径（null = 普通图片），
     * 标签页是否开着，以及订阅的取消函数。
     */
    let canvasSource: string | null = null
    let canvasSvgRelPath = ''
    let canvasOpen = false
    let canvasPreview = ''
    let canvasTeardown: Array<() => void> = []

    /** 笔记里的相对路径 → assets/ 下的 KB 相对路径（不是 `.svg` 就直接放弃） */
    const canvasRelPathFor = (src: string): string => {
      if (!src || src.startsWith('data:') || /^[a-z][a-z\d+.-]*:/i.test(src)) return ''
      if (!src.split(/[?#]/, 1)[0]?.toLowerCase().endsWith('.svg')) return ''
      const noteRelPath = options.noteRelPath()
      if (!noteRelPath) return ''
      return resolveNoteAssetRelPath(noteRelPath, src) ?? ''
    }

    const applyCanvasImageSrc = (): void => {
      const source = String(current.attrs.src ?? '')
      const presentationUrl = resolveMarkdownImageUrl(
        source,
        options.knowledgeBaseId(),
        options.noteUuid()
      )
      // 编辑期间用内存里导出的那张（实时）；没预览过才读文件，并带上版本号绕开同 URL 缓存
      const live = canvasPreview
      const withRevision =
        !live && presentationUrl && canvasSource
          ? `${presentationUrl}&rev=${canvasAssetRevision(options.knowledgeBaseId(), canvasSource)}`
          : presentationUrl
      const next = live || withRevision
      if (next) image.setAttribute('src', next)
      else image.removeAttribute('src')
      image.classList.toggle('is-unavailable', !next)
    }

    const applyEditingBadge = (): void => {
      editingBadge.hidden = !canvasOpen
      figure.classList.toggle('is-canvas-editing', canvasOpen)
    }

    const teardownCanvas = (): void => {
      for (const off of canvasTeardown) off()
      canvasTeardown = []
      canvasSource = null
      canvasSvgRelPath = ''
      canvasOpen = false
      canvasPreview = ''
      canvasEditButton.hidden = true
      figure.classList.remove('is-canvas')
      applyEditingBadge()
    }

    /** 认下这张图画布：挂「编辑」按钮、实时预览、编辑中徽标 */
    const attachCanvas = (sourceRelPath: string, svgRelPath: string): void => {
      teardownCanvas()
      canvasSource = sourceRelPath
      canvasSvgRelPath = svgRelPath
      figure.classList.add('is-canvas')
      canvasEditButton.hidden = options.isReadOnly()
      canvasTeardown.push(
        subscribeExcalidrawSession(options.knowledgeBaseId(), sourceRelPath, (open) => {
          canvasOpen = open
          // 预览不清空：它比磁盘上那份新（写盘是节流的），关掉标签页也要显示最新内容
          applyEditingBadge()
          applyCanvasImageSrc()
        }),
        subscribeCanvasPreview(options.knowledgeBaseId(), sourceRelPath, (dataUrl) => {
          canvasPreview = dataUrl
          applyCanvasImageSrc()
        })
      )
      canvasEditButton.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        openCanvasTab(sourceRelPath)
      }
    }

    /** 判据：同名 `.excalidraw` 在 → 画布；不在 → 普通图片 */
    const syncCanvas = (): void => {
      const svgRelPath = canvasRelPathFor(String(current.attrs.src ?? ''))
      if (!svgRelPath) {
        teardownCanvas()
        return
      }
      if (canvasSvgRelPath === svgRelPath) return
      const knowledgeBaseId = options.knowledgeBaseId()
      const cached = cachedCanvasSource(knowledgeBaseId, svgRelPath)
      if (cached !== undefined) {
        if (cached) attachCanvas(cached, svgRelPath)
        else teardownCanvas()
        return
      }
      canvasSvgRelPath = svgRelPath
      void probeCanvasSource(knowledgeBaseId, svgRelPath).then((source) => {
        if (canvasSvgRelPath !== svgRelPath) return
        if (source) attachCanvas(source, svgRelPath)
        else teardownCanvas()
      })
    }

    /** 打开/聚焦该画布的标签页 */
    const openCanvasTab = (sourceRelPath: string): void => {
      const knowledgeBaseId = options.knowledgeBaseId()
      const workspace = useWorkspaceStore()
      const knowledgeBase =
        workspace.overview.allKnowledgeBases.find((item) => item.id === knowledgeBaseId) ?? null
      if (!knowledgeBase) {
        workspace.error = `无法打开画布标签页：${sourceRelPath}`
        return
      }
      useEditorStore().openExcalidraw(knowledgeBase, sourceRelPath)
    }

    const render = (node: ProseMirrorNode, nextSelected: boolean): void => {
      current = node
      selected = nextSelected
      const source = String(node.attrs.src ?? '')
      syncCanvas()
      applyCanvasImageSrc()
      const alt = String(node.attrs.alt ?? '')
      image.setAttribute('alt', alt)
      const title = String(node.attrs.title ?? '')
      if (title) image.setAttribute('title', title)
      else image.removeAttribute('title')
      if (!figure.classList.contains('is-resizing')) {
        applyDisplayWidth(normalizeImageWidth(String(node.attrs.width ?? '')))
      }
      image.style.maxWidth = '100%'
      image.style.height = 'auto'
      const align = normalizeImageAlign(String(node.attrs.align ?? ''))
      applyImageClipboardAttrs(image, { src: source, width: String(node.attrs.width ?? ''), align })
      applyImageClipboardAttrs(figure, {
        src: source,
        width: String(node.attrs.width ?? ''),
        align
      })
      figure.classList.toggle('tn-image--center', align === 'center')
      figure.classList.toggle('tn-image--right', align === 'right')
      figure.classList.toggle('is-selected', selected && !options.isReadOnly())
      alignButton.innerHTML = ALIGN_ICONS[align]
      // 描述框**聚焦时绝不回写它的值**：每次节点更新都会走 render，若无条件
      // `caption.value = alt`，用户正在输入的内容会被文档旧值重置/回灌
      // （实测表现为输入结束时 alt 变成"旧描述 + 新输入"）。
      if (document.activeElement !== caption) caption.value = alt
      if (alt) captionOpen = true
      syncChrome()
      // 改对齐只改 margin、改尺寸只改内联宽度：figure 的**盒子尺寸与内容盒都没变**，
      // ResizeObserver / MutationObserver 都不会触发，浮层会停在旧的位置（实测：
      // 点「居中对齐」后图片中心 953，浮层中心仍停在 785.5 / 左对齐的 x 618）。
      // 所以每次按新属性渲染完，直接重定位一次。
      if (!captionRow.hidden) positionCaptionRow()
    }

    render(initialNode, false)
    return {
      dom: figure,
      update: (nextNode) => {
        if (nextNode.type !== current.type) return false
        render(nextNode, selected)
        return true
      },
      selectNode: () => render(current, !options.isReadOnly()),
      deselectNode: () => {
        captionOpen = Boolean(String(current.attrs.alt ?? '').trim())
        closePanels()
        render(current, false)
      },
      stopEvent: (event) => {
        // 描述框内的输入类事件一律自己处理，绝不让正文编辑器拿到（见 caption 处注释）
        if (fromCaption(event) && captionEventKinds.has(event.type)) return true
        if (!options.isReadOnly()) return false
        return (
          event instanceof MouseEvent ||
          event instanceof PointerEvent ||
          event.type.startsWith('mouse') ||
          event.type.startsWith('pointer')
        )
      },
      ignoreMutation: () => true,
      destroy: () => {
        document.removeEventListener('scroll', reposition, { capture: true })
        window.removeEventListener('resize', reposition)
        captionObserver?.disconnect()
        captionMutations?.disconnect()
        if (captionRetry) clearTimeout(captionRetry)
        captionRetry = 0
        if (pinnedHostPosition && pinnedHostPosition.style.position === 'relative') {
          pinnedHostPosition.style.position = ''
        }
        pinnedHostPosition = null
        captionRow.remove()
        teardownCanvas()
        observer?.disconnect()
        document.removeEventListener('pointerdown', onDocumentPointerDown)
        document.body.classList.remove('is-resizing-image')
      }
    }
  })
}

function toolButton(icon: string, label: string, title: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'desk-image__tool'
  button.title = title || label
  button.setAttribute('aria-label', label)
  button.dataset.label = label
  button.innerHTML = icon
  return button
}

function iconButton(icon: string, title: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'desk-image__quick-btn'
  button.title = title
  button.innerHTML = icon
  return button
}

function menuItem(icon: string, label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'desk-image__menu-item'
  button.setAttribute('aria-label', label)
  button.dataset.label = label
  button.innerHTML = icon
  return button
}

function numberField(label: string): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = document.createElement('label')
  row.className = 'desk-image__field'
  const text = document.createElement('span')
  text.textContent = label
  const input = document.createElement('input')
  input.type = 'text'
  input.inputMode = 'numeric'
  input.autocomplete = 'off'
  input.spellcheck = false
  row.append(text, input)
  return { row, input }
}

function oppositeCorner(corner: Corner, rect: DOMRect): { x: number; y: number } {
  if (corner === 'tl') return { x: rect.right, y: rect.bottom }
  if (corner === 'tr') return { x: rect.left, y: rect.bottom }
  if (corner === 'bl') return { x: rect.right, y: rect.top }
  return { x: rect.left, y: rect.top }
}

function writeAttrs(
  view: EditorView,
  getPos: () => number | undefined,
  patch: { alt?: string; width?: string; align?: ImageAlign }
): void {
  if (view.isDestroyed) return
  const pos = getPos()
  if (pos == null) return
  const current = view.state.doc.nodeAt(pos)
  if (!current || current.type.name !== 'image') return
  const next = { ...current.attrs, ...patch }
  if (
    String(current.attrs.alt ?? '') === String(next.alt ?? '') &&
    String(current.attrs.width ?? '') === String(next.width ?? '') &&
    String(current.attrs.align ?? 'left') === String(next.align ?? 'left')
  ) {
    return
  }
  const tr = view.state.tr.setNodeMarkup(pos, undefined, next)
  view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)))
}

function deleteImage(view: EditorView, getPos: () => number | undefined): void {
  if (view.isDestroyed) return
  const pos = getPos()
  if (pos == null) return
  const current = view.state.doc.nodeAt(pos)
  if (!current || current.type.name !== 'image') return
  view.dispatch(view.state.tr.delete(pos, pos + current.nodeSize))
}
