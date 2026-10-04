<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  caretOffsetFromPoint,
  cloneSubtree,
  parseMarkdown,
  richSelectionRect,
  serializeSubtree,
  wrapTextLines
} from '@tnotesjs/mindmap-core'
import type {
  InlineFormat,
  InlineLink,
  MindmapNode,
  MindmapSession,
  RichInlineEditorElement
} from '@tnotesjs/mindmap-core'
import LinkPopover from './LinkPopover.vue'
import RichInlineEditor from './RichInlineEditor.vue'
import SelectionToolbar from './SelectionToolbar.vue'
import { resolveAfterDropLevel } from './outlineDrag'

const props = defineProps<{
  session: MindmapSession
  /** 每次文档/选中/折叠/聚焦变化时 +1，驱动本组件重算 */
  version: number
  resolveImageSrc?: (src: string) => string
}>()

function resolvedImageSrc(src: string): string {
  return props.resolveImageSrc?.(src) ?? src
}

const emit = defineEmits<{
  imagePreview: [src: string]
  requestSearch: []
  pasteImage: [anchorId: string, blob: Blob]
}>()

const ROW_HEIGHT = 32
const TITLE_LINE = 36
/** 与幕布一致：每层水平步进 */
const INDENT = 28
/** 与 .outline-view padding-top / .outline-title margin-bottom 保持一致 */
const VIEW_PADDING_TOP = 12
const TITLE_MARGIN_BOTTOM = 8
const TEXT_LINE = 22
/** 折叠按钮占位（叠在父级圆点列，不额外把圆点挤开） */
const COLLAPSE_LEAD = 18
const BULLET_SIZE = 22
/** 深度 0 圆点中心 X；装饰线与祖先圆点对齐 */
const BULLET_CENTER = COLLAPSE_LEAD + BULLET_SIZE / 2
/** 大纲行左侧控件占位（折叠列 + 圆点 + 间隙） */
const ROW_CHROME = COLLAPSE_LEAD + BULLET_SIZE + 8
/** 大纲图片默认/边界宽度（与 md `|宽度` 一致） */
const DEFAULT_OUTLINE_IMG_W = 240
const MIN_IMG_W = 80
const MAX_IMG_W = 720
const IMG_BLOCK_PAD = 10
const IMG_MAX_H = 480

function gutterWidth(depth: number): number {
  return COLLAPSE_LEAD + depth * INDENT + BULLET_SIZE
}

interface Row {
  node: MindmapNode
  depth: number
  index: number
  top: number
  height: number
  textHeight: number
}

/** src → 宽/高比；加载后更新以正确计算行高 */
const imageAspects = ref(new Map<string, number>())
/** 拖拽调宽时的即时预览宽度 */
const liveImageWidth = ref<Map<string, number>>(new Map())
/** 编辑中未提交文案（数据源仍为一行；用于避免 :value 重渲染冲掉输入） */
const draftTexts = ref(new Map<string, string>())
/** 编辑中未提交文案的折行高度 */
const draftTextHeights = ref(new Map<string, number>())
/** 外层内容区宽度，驱动折行 */
const containerWidth = ref(800)

let measureCtx: CanvasRenderingContext2D | null = null
function measureOutlineText(text: string, fontSize: number): number {
  if (typeof document === 'undefined') return text.length * fontSize * 0.6
  if (!measureCtx) {
    const c = document.createElement('canvas')
    measureCtx = c.getContext('2d')
  }
  if (!measureCtx) return text.length * fontSize * 0.6
  measureCtx.font = `${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`
  return measureCtx.measureText(text).width
}

function contentAreaWidth(): number {
  // .outline-view padding: 12px 24px
  return Math.max(80, containerWidth.value - 48)
}

function outlineTextMaxWidth(depth: number, hasCheckbox: boolean, hasLink: boolean): number {
  const chrome = depth * INDENT + ROW_CHROME + (hasCheckbox ? 20 : 0) + (hasLink ? 24 : 0) + 12
  return Math.max(60, contentAreaWidth() - chrome)
}

function measureTextBlockHeight(
  text: string,
  maxWidth: number,
  fontSize: number,
  lineHeight: number,
  minHeight: number
): number {
  const lines = wrapTextLines(text || ' ', maxWidth, (s) => measureOutlineText(s, fontSize))
  return Math.max(minHeight, lines.length * lineHeight + 8)
}

function displayImageWidth(node: MindmapNode): number {
  const live = liveImageWidth.value.get(node.id)
  if (live != null) return live
  return node.content.image?.width ?? DEFAULT_OUTLINE_IMG_W
}

function imageBlockHeight(node: MindmapNode): number {
  if (!node.content.image) return 0
  const w = displayImageWidth(node)
  const aspect = imageAspects.value.get(node.content.image.src) ?? 1
  const h = Math.round(w / Math.max(aspect, 0.15))
  return Math.min(h, IMG_MAX_H) + IMG_BLOCK_PAD
}

function layoutDisplayText(node: MindmapNode): string {
  // 大纲始终按用户看到的文案排版，Markdown 标记只存在于源码层。
  return node.content.text
}

function measureRowTextHeight(node: MindmapNode, depth: number): number {
  const draft = draftTextHeights.value.get(node.id)
  if (draft != null) return draft
  const maxW = outlineTextMaxWidth(depth, node.content.checked !== null, !!node.content.link)
  return measureTextBlockHeight(layoutDisplayText(node), maxW, 15, TEXT_LINE, ROW_HEIGHT)
}

/** 列表行 = 聚焦根的后代（不含根本身；根作为上方标题渲染，对齐幕布） */
const rows = computed<Row[]>(() => {
  if (props.version < 0) return []
  const root = props.session.focusRootNode
  const out: Row[] = []
  let top = 0
  const walk = (n: MindmapNode, depth: number) => {
    if (n.collapsed) return
    for (const c of n.children) {
      const textHeight = measureRowTextHeight(c, depth)
      const height = textHeight + imageBlockHeight(c)
      out.push({ node: c, depth, index: out.length, top, height, textHeight })
      top += height
      walk(c, depth + 1)
    }
  }
  walk(root, 0)
  return out
})

const titleHeight = computed(() => {
  if (props.version < 0) return 56
  const root = props.session.focusRootNode
  const draft = draftTextHeights.value.get(root.id)
  const textH =
    draft ?? measureTextBlockHeight(layoutDisplayText(root), contentAreaWidth(), 28, TITLE_LINE, 56)
  return textH + imageBlockHeight(root)
})

const totalListHeight = computed(() => {
  const list = rows.value
  if (list.length === 0) return 0
  const last = list[list.length - 1]
  return last.top + last.height
})

const focusRoot = computed(() => {
  if (props.version < 0) return null
  return props.session.focusRootNode
})

const selectedId = computed(() => {
  if (props.version < 0) return null
  return props.session.selectedNode?.id ?? null
})

const selectedIds = computed(() => {
  if (props.version < 0) return new Set<string>()
  return props.session.selectionIds
})

const matches = computed(() => {
  if (props.version < 0) return new Set<string>()
  return props.session.matches
})

// ---------- 虚拟滚动 ----------

const containerRef = ref<HTMLElement>()
const scrollTop = ref(0)
const viewportH = ref(600)

/** 列表（spacer）相对滚动内容顶部的偏移：padding + 标题 + 标题下边距 */
function listChromeHeight(): number {
  return VIEW_PADDING_TOP + titleHeight.value + TITLE_MARGIN_BOTTOM
}

const listScrollTop = computed(() => Math.max(0, scrollTop.value - listChromeHeight()))

const startIndex = computed(() => {
  const list = rows.value
  const y = listScrollTop.value
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].top + list[mid].height < y) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, lo - 2)
})

const endIndex = computed(() => {
  const list = rows.value
  const y = listScrollTop.value + viewportH.value
  let i = startIndex.value
  while (i < list.length && list[i].top < y) i++
  return Math.min(list.length, i + 2)
})

const visibleRows = computed(() => rows.value.slice(startIndex.value, endIndex.value))

function onScroll() {
  scrollTop.value = containerRef.value?.scrollTop ?? 0
  textSelection.value = null
  if (linkEditor.value?.mode === 'existing') linkEditor.value = null
}

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  if (containerRef.value) {
    viewportH.value = containerRef.value.clientHeight || 600
    containerWidth.value = containerRef.value.clientWidth || 800
    resizeObserver = new ResizeObserver(() => {
      const el = containerRef.value
      if (!el) return
      viewportH.value = el.clientHeight || 600
      containerWidth.value = el.clientWidth || 800
    })
    resizeObserver.observe(containerRef.value)
  }
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  stopRangeSelect?.()
  if (linkLeaveTimer) clearTimeout(linkLeaveTimer)
})

const focusPathKey = computed(() => {
  if (props.version < 0) return ''
  return props.session.focusPath.map((node) => node.id).join('/')
})

// ---------- 行焦点（焦点 = 选中 = 编辑态，幕布式） ----------

const focusedId = ref<string | null>(null)
const hoveredId = ref<string | null>(null)

interface TextSelectionState {
  nodeId: string
  start: number
  end: number
  position: { left: number; top: number }
}

interface LinkEditorState {
  mode: 'selection' | 'existing'
  nodeId: string
  url: string
  position: { left: number; top: number }
  start?: number
  end?: number
  rawStart?: number
  rawEnd?: number
}

const textSelection = ref<TextSelectionState | null>(null)
const linkEditor = ref<LinkEditorState | null>(null)
const linkPopoverRef = ref<InstanceType<typeof LinkPopover> | null>(null)
const imagePickerRef = ref<HTMLInputElement>()
const pendingImageAnchorId = ref<string | null>(null)
let linkLeaveTimer: ReturnType<typeof setTimeout> | null = null

watch(focusPathKey, () => {
  // 进入/退出子树聚焦时，聚焦根应先以富文本标题展示，而不是继续停留在
  // 编辑态；先提交当前受控草稿，再清理局部选区与浮层。
  const active = document.activeElement
  if (isInlineEditorElement(active)) {
    const activeNode = props.session.document.find(active.dataset.id ?? '')
    if (activeNode) commitRow(activeNode, active)
  }
  focusedId.value = null
  textSelection.value = null
  linkEditor.value = null
  draftTexts.value = new Map()
  draftTextHeights.value = new Map()
  scrollTop.value = 0
  if (containerRef.value) containerRef.value.scrollTop = 0
  nextTick(() => containerRef.value?.focus())
})

function inputOf(id: string): RichInlineEditorElement | null {
  return containerRef.value?.querySelector(`.rich-inline-editor[data-id="${id}"]`) ?? null
}

function isInlineEditorElement(value: unknown): value is RichInlineEditorElement {
  return value instanceof HTMLDivElement && value.classList.contains('rich-inline-editor')
}

/** 聚焦某行并放置光标（col 省略时到末尾）；DOM 更新后可能需多拍再试 */
function focusRow(id: string, col?: number) {
  focusedId.value = id
  const attempt = (left: number) => {
    nextTick(() => {
      const input = inputOf(id)
      if (!input) {
        if (left > 0) attempt(left - 1)
        return
      }
      input.focus()
      const pos = col === undefined ? input.value.length : Math.min(col, input.value.length)
      input.setSelectionRange(pos, pos)
    })
  }
  attempt(3)
}

function focusRowRange(id: string, start: number, end: number) {
  focusedId.value = id
  nextTick(() => {
    const input = inputOf(id)
    if (!input) return
    input.focus()
    input.setSelectionRange(Math.min(start, input.value.length), Math.min(end, input.value.length))
    syncTextSelection(id, input)
  })
}

function selectionPosition(input: RichInlineEditorElement): { left: number; top: number } {
  const rect = richSelectionRect(input)
  return {
    left: Math.max(190, Math.min(window.innerWidth - 190, rect.left + rect.width / 2)),
    top: Math.max(58, rect.top - 8)
  }
}

function syncTextSelection(nodeId: string, input: RichInlineEditorElement) {
  const start = input.selectionStart ?? 0
  const end = input.selectionEnd ?? 0
  if (start === end || props.session.document.find(nodeId)?.content.image) {
    if (textSelection.value?.nodeId === nodeId) textSelection.value = null
    return
  }
  textSelection.value = { nodeId, start, end, position: selectionPosition(input) }
}

function onTextSelection(node: MindmapNode, event: Event) {
  syncTextSelection(node.id, event.currentTarget as RichInlineEditorElement)
}

const selectedTextFormats = computed<Partial<Record<InlineFormat, boolean>>>(() => {
  if (props.version < 0) return {}
  const selection = textSelection.value
  if (!selection) return {}
  const formats: InlineFormat[] = ['bold', 'italic', 'underline', 'strike', 'highlight', 'code']
  return Object.fromEntries(
    formats.map((format) => [
      format,
      props.session.inlineFormatActive(selection.nodeId, selection.start, selection.end, format)
    ])
  )
})

const multiSelectionPosition = computed(() => {
  if (props.version < 0 || props.session.selectionIds.size <= 1 || textSelection.value) return null
  const id = props.session.selectedNode?.id
  if (!id) return null
  const row = containerRef.value?.querySelector(
    `.outline-row[data-node-id="${id}"]`
  ) as HTMLElement | null
  if (!row) return null
  const rect = row.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    return { left: Math.max(180, window.innerWidth / 2), top: 60 }
  }
  if (rect.bottom < 48 || rect.top > window.innerHeight) return null
  return {
    left: Math.max(180, Math.min(window.innerWidth - 180, rect.left + rect.width / 2)),
    top: Math.max(58, rect.top - 8)
  }
})

function restoreTextSelection(selection: TextSelectionState) {
  nextTick(() => focusRowRange(selection.nodeId, selection.start, selection.end))
}

function applyTextFormat(format: InlineFormat) {
  const selection = textSelection.value
  if (!selection) return
  const node = props.session.document.find(selection.nodeId)
  const input = inputOf(selection.nodeId)
  if (!node || !input) return
  commitRow(node, input)
  props.session.toggleNodeInlineFormat(selection.nodeId, selection.start, selection.end, format)
  restoreTextSelection(selection)
}

function applyNodeFormat(format: InlineFormat) {
  props.session.formatSelectedNodes(format)
}

function clearTextFormat() {
  const selection = textSelection.value
  if (!selection) return
  const node = props.session.document.find(selection.nodeId)
  const input = inputOf(selection.nodeId)
  if (!node || !input) return
  commitRow(node, input)
  props.session.clearNodeInlineFormats(selection.nodeId, selection.start, selection.end)
  restoreTextSelection(selection)
}

function clearNodeFormats() {
  props.session.clearSelectedNodeFormats()
}

function toggleSelectionTask() {
  const selection = textSelection.value
  if (selection) props.session.toggleTask(selection.nodeId)
  else props.session.toggleTaskSelectedNodes()
}

function removeToolbarSelection() {
  textSelection.value = null
  linkEditor.value = null
  props.session.removeSelectedNodes()
  containerRef.value?.focus()
}

async function copySelectedFromToolbar() {
  const text = serializeSelection()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 浏览器拒绝异步剪贴板时，仍可使用系统 Cmd/Ctrl+C 的既有路径。
  }
}

async function cutSelectedToClipboard() {
  const text = serializeSelection()
  if (!text) return
  const ids = [...props.session.selectionIds]
  try {
    await navigator.clipboard.writeText(text)
    props.session.removeNodesByIds(ids)
    containerRef.value?.focus()
  } catch {
    // 剪贴板写入失败时不能删除节点，避免剪切造成数据丢失。
  }
}

function openSelectionLinkEditor() {
  const selection = textSelection.value
  if (!selection) return
  linkEditor.value = {
    mode: 'selection',
    nodeId: selection.nodeId,
    start: selection.start,
    end: selection.end,
    url: 'https://',
    position: { left: selection.position.left, top: selection.position.top + 12 }
  }
  nextTick(() => linkPopoverRef.value?.focusInput())
}

function requestSelectionImage() {
  pendingImageAnchorId.value = textSelection.value?.nodeId ?? props.session.selectedNode?.id ?? null
  imagePickerRef.value?.click()
}

function onSelectionImagePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const anchorId = pendingImageAnchorId.value ?? textSelection.value?.nodeId
  pendingImageAnchorId.value = null
  if (file && anchorId) emit('pasteImage', anchorId, file)
}

function focusTitle(col?: number) {
  const root = focusRoot.value
  if (!root) return
  focusRow(root.id, col)
}

function scrollRowIntoView(index: number) {
  const el = containerRef.value
  const row = rows.value[index]
  if (!el || !row) return
  const target = listChromeHeight() + row.top
  const bottom = target + row.height
  if (target < el.scrollTop) el.scrollTop = Math.max(0, target - 8)
  else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight + 8
}

function locateNode(id: string) {
  const session = props.session
  session.expandAncestors(id)
  session.select(id)
  nextTick(() => {
    if (id === session.focusRootNode.id) {
      focusTitle()
      return
    }
    const idx = rows.value.findIndex((r) => r.node.id === id)
    if (idx >= 0) scrollRowIntoView(idx)
  })
}

defineExpose({ locateNode, selectAllFromHost, undoFromHost, redoFromHost })

// ---------- 行内编辑行为（光标感知，对齐幕布） ----------

function imageMarkdown(alt: string, src: string, width: number | null): string {
  const w = width != null && width > 0 ? `|${Math.round(width)}` : ''
  return `![${alt || '图片'}${w}](${src})`
}

function commitRow(node: MindmapNode, input: RichInlineEditorElement): boolean {
  const session = props.session
  const typed = input.value.trim().replace(/\n/g, '')
  clearDraft(node.id)
  // 图片节点：行内文案 = 描述（alt），保留 src / 宽度
  if (node.content.image) {
    const img = node.content.image
    if (typed !== img.alt) {
      session.updateNodeRaw(node.id, imageMarkdown(typed, img.src, img.width))
      input.markCommitted()
      return true
    }
    input.markCommitted()
    return false
  }
  // contenteditable 草稿已经是合法 Markdown；直接提交 raw，保留全部行内 marks / href。
  const raw = typed === '' ? '' : input.rawValue.trim()
  if (raw !== node.content.raw) {
    session.updateNodeRaw(node.id, raw)
    input.markCommitted()
    return true
  }
  input.markCommitted()
  return false
}

function commitEditorPayload(node: MindmapNode, payload: { raw: string; text: string }) {
  clearDraft(node.id)
  if (node.content.image) {
    const image = node.content.image
    if (payload.text !== image.alt) {
      props.session.updateNodeRaw(node.id, imageMarkdown(payload.text, image.src, image.width))
    }
  } else if (payload.raw !== node.content.raw) {
    props.session.updateNodeRaw(node.id, payload.raw)
  }
  inputOf(node.id)?.markCommitted()
}

function clearDraft(id: string) {
  let changed = false
  if (draftTextHeights.value.has(id)) {
    const next = new Map(draftTextHeights.value)
    next.delete(id)
    draftTextHeights.value = next
    changed = true
  }
  if (draftTexts.value.has(id)) {
    const next = new Map(draftTexts.value)
    next.delete(id)
    draftTexts.value = next
    changed = true
  }
  return changed
}

function syncDraftText(node: MindmapNode, depth: number | null, text: string) {
  if (draftTexts.value.get(node.id) !== text) {
    const next = new Map(draftTexts.value)
    next.set(node.id, text)
    draftTexts.value = next
  }
  const isTitle = depth == null
  const maxW = isTitle
    ? contentAreaWidth()
    : outlineTextMaxWidth(depth, node.content.checked !== null, !!node.content.link)
  const h = measureTextBlockHeight(
    text,
    maxW,
    isTitle ? 28 : 15,
    isTitle ? TITLE_LINE : TEXT_LINE,
    isTitle ? 56 : ROW_HEIGHT
  )
  if (draftTextHeights.value.get(node.id) !== h) {
    const next = new Map(draftTextHeights.value)
    next.set(node.id, h)
    draftTextHeights.value = next
  }
}

function onRowDraftChange(node: MindmapNode, depth: number | null, payload: { text: string }) {
  syncDraftText(node, depth, payload.text)
}

/**
 * textarea 没有原生 caretClientRect；用同样排版样式的隐藏镜像判断光标是否位于首/末视觉行。
 * 仅在跨节点导航前调用，行内上下移动仍交给浏览器原生处理。
 */
function caretVisualBoundary(input: RichInlineEditorElement): { first: boolean; last: boolean } {
  const value = input.value
  const position = input.selectionStart ?? 0
  if (value.length === 0 || input.clientWidth === 0) return { first: true, last: true }

  const style = getComputedStyle(input)
  const mirror = document.createElement('div')
  const copied = [
    'boxSizing',
    'width',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontFamily',
    'fontSize',
    'fontStyle',
    'fontWeight',
    'fontVariant',
    'lineHeight',
    'letterSpacing',
    'textTransform',
    'textIndent',
    'textAlign',
    'tabSize',
    'whiteSpace',
    'wordBreak',
    'overflowWrap'
  ] as const
  for (const property of copied) {
    mirror.style.setProperty(
      property.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`),
      style[property] as string
    )
  }
  mirror.style.position = 'fixed'
  mirror.style.left = '-10000px'
  mirror.style.top = '0'
  mirror.style.height = 'auto'
  mirror.style.minHeight = '0'
  mirror.style.maxHeight = 'none'
  mirror.style.overflow = 'hidden'
  mirror.style.visibility = 'hidden'
  mirror.style.pointerEvents = 'none'
  document.body.append(mirror)

  const topAt = (offset: number) => {
    mirror.textContent = value.slice(0, offset)
    const marker = document.createElement('span')
    marker.textContent = value.slice(offset, offset + 1) || '\u200b'
    mirror.append(marker)
    const top = marker.offsetTop
    marker.remove()
    return top
  }
  const firstTop = topAt(0)
  const currentTop = topAt(position)
  const lastTop = topAt(value.length)
  mirror.remove()
  return { first: currentTop <= firstTop + 1, last: currentTop >= lastTop - 1 }
}

function inlineFormatShortcut(event: KeyboardEvent, hasSelection = true): InlineFormat | null {
  const key = event.key.toLowerCase()
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null
  if (key === 'b' && !event.shiftKey) return 'bold'
  if (key === 'i' && !event.shiftKey) return 'italic'
  if (key === 'u' && !event.shiftKey) return 'underline'
  if (key === 'enter' && !event.shiftKey && hasSelection) return 'strike'
  if ((key === 's' || key === 'x') && event.shiftKey) return 'strike'
  if (key === 'h' && event.shiftKey) return 'highlight'
  if (key === 'e' && !event.shiftKey) return 'code'
  return null
}

function applyInputFormatShortcut(
  node: MindmapNode,
  input: RichInlineEditorElement,
  format: InlineFormat
) {
  // 图片节点的文字是图片说明：纯文本，不接受行内格式
  if (node.content.image) return
  const caretStart = input.selectionStart ?? 0
  const caretEnd = input.selectionEnd ?? 0
  if (input.value.length === 0) return
  const collapsed = caretStart === caretEnd
  const start = collapsed ? 0 : caretStart
  const end = collapsed ? input.value.length : caretEnd
  commitRow(node, input)
  props.session.toggleNodeInlineFormat(node.id, start, end, format)
  if (collapsed) {
    textSelection.value = null
    nextTick(() => {
      const editor = inputOf(node.id)
      editor?.focus()
      editor?.setSelectionRange(caretStart, caretStart)
    })
  } else {
    const selection: TextSelectionState = {
      nodeId: node.id,
      start,
      end,
      position: selectionPosition(input)
    }
    textSelection.value = selection
    restoreTextSelection(selection)
  }
}

function applyInputClearFormats(node: MindmapNode, input: RichInlineEditorElement) {
  // 图片节点的文字是图片说明：纯文本，不接受行内格式
  if (node.content.image) return
  const caretStart = input.selectionStart ?? 0
  const caretEnd = input.selectionEnd ?? 0
  if (input.value.length === 0) return
  const collapsed = caretStart === caretEnd
  const start = collapsed ? 0 : caretStart
  const end = collapsed ? input.value.length : caretEnd
  commitRow(node, input)
  props.session.clearNodeInlineFormats(node.id, start, end)
  if (collapsed) {
    textSelection.value = null
    nextTick(() => {
      const editor = inputOf(node.id)
      editor?.focus()
      editor?.setSelectionRange(caretStart, caretStart)
    })
  } else {
    const selection: TextSelectionState = {
      nodeId: node.id,
      start,
      end,
      position: selectionPosition(input)
    }
    textSelection.value = selection
    restoreTextSelection(selection)
  }
}

function onTitleKeydown(e: KeyboardEvent) {
  const root = focusRoot.value
  if (!root) return
  if (focusedId.value !== root.id) return
  const session = props.session
  const input = e.currentTarget as RichInlineEditorElement
  if (e.isComposing || input.isComposing) return
  e.stopPropagation()

  const mod = e.metaKey || e.ctrlKey
  if ((e.key === '.' || e.key === '>') && (mod || e.altKey)) {
    e.preventDefault()
    commitRow(root, input)
    if (mod && e.altKey && e.shiftKey) session.toggleCollapseAll()
    else session.toggleCollapse(root.id)
    focusTitle(input.selectionStart ?? 0)
    return
  }
  if (mod) {
    const key = e.key.toLowerCase()
    if (key === '\\') {
      e.preventDefault()
      applyInputClearFormats(root, input)
      return
    }
    const format = inlineFormatShortcut(e, input.selectionStart !== input.selectionEnd)
    if (format) {
      e.preventDefault()
      applyInputFormatShortcut(root, input, format)
      return
    }
    if (key === 'z' || key === 'y') {
      e.preventDefault()
      commitRow(root, input)
      if (key === 'z' && !e.shiftKey) session.undo()
      else session.redo()
    } else if (key === 'f') {
      e.preventDefault()
      emit('requestSearch')
    } else if (key === '[') {
      e.preventDefault()
      commitRow(root, input)
      if (session.focusPath.length > 0) {
        session.exitFocusTo(session.focusPath.length - 1)
        focusRow(root.id)
      }
    } else if (key === 'a') {
      // Nested under ProseMirror: native Cmd+A selects the whole note. Select
      // within this field first; escalate to all outline rows when already full.
      e.preventDefault()
      const fullySelected = input.selectionStart === 0 && input.selectionEnd === input.value.length
      if (fullySelected) {
        commitRow(root, input)
        selectAllRows()
      } else {
        input.setSelectionRange?.(0, input.value.length)
      }
    }
    return
  }

  switch (e.key) {
    case 'Enter': {
      e.preventDefault()
      commitRow(root, input)
      // 幕布：标题行尾 Enter → 聚焦首个子节点；无子节点则新建
      if (root.children.length > 0) {
        focusRow(root.children[0].id, 0)
      } else {
        const created = session.insertChildOf(root.id, 0)
        if (created) focusRow(created.id, 0)
      }
      break
    }
    case 'ArrowDown': {
      if (input.selectionStart !== input.selectionEnd || !caretVisualBoundary(input).last) break
      e.preventDefault()
      commitRow(root, input)
      if (rows.value.length > 0) focusRow(rows.value[0].node.id, input.selectionStart ?? 0)
      break
    }
    case 'Escape': {
      e.preventDefault()
      commitRow(root, input)
      containerRef.value?.focus()
      break
    }
  }
}

function onEditKeydown(node: MindmapNode, e: KeyboardEvent) {
  if (focusedId.value !== node.id) return
  const session = props.session
  const input = e.currentTarget as RichInlineEditorElement
  if (e.isComposing || input.isComposing) return
  e.stopPropagation()

  const mod = e.metaKey || e.ctrlKey
  if ((e.key === '.' || e.key === '>') && (mod || e.altKey)) {
    e.preventDefault()
    commitRow(node, input)
    if (mod && e.altKey && e.shiftKey) session.toggleCollapseAll()
    else if (mod && e.shiftKey) session.toggleCollapseSiblings(node.id)
    else session.toggleCollapse(node.id)
    focusRow(node.id, input.selectionStart ?? 0)
    return
  }
  if (e.altKey && !mod && e.key === 'Enter') {
    e.preventDefault()
    pendingImageAnchorId.value = node.id
    imagePickerRef.value?.click()
    return
  }
  if (mod) {
    const key = e.key.toLowerCase()
    const col = input.selectionStart ?? 0
    if (key === '\\') {
      e.preventDefault()
      applyInputClearFormats(node, input)
      return
    }
    const format = inlineFormatShortcut(e, input.selectionStart !== input.selectionEnd)
    if (format) {
      e.preventDefault()
      applyInputFormatShortcut(node, input, format)
    } else if (key === 'k' && !e.shiftKey && input.selectionStart !== input.selectionEnd) {
      e.preventDefault()
      syncTextSelection(node.id, input)
      openSelectionLinkEditor()
    } else if (key === 'z' || key === 'y') {
      e.preventDefault()
      commitRow(node, input)
      if (key === 'z' && !e.shiftKey) session.undo()
      else session.redo()
    } else if (key === 'f') {
      e.preventDefault()
      emit('requestSearch')
    } else if (key === ']') {
      e.preventDefault()
      commitRow(node, input)
      session.focusNode(node.id)
    } else if (key === '[') {
      e.preventDefault()
      commitRow(node, input)
      if (session.focusPath.length > 0) {
        session.exitFocusTo(session.focusPath.length - 1)
        focusRow(node.id, col)
      }
    } else if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      commitRow(node, input)
      session.moveSelectedNodes(e.key === 'ArrowUp' ? -1 : 1)
      focusRow(node.id, col)
    } else if (e.shiftKey && (key === 'backspace' || key === 'd')) {
      e.preventDefault()
      commitRow(node, input)
      session.removeSelectedNodes()
      containerRef.value?.focus()
    } else if (e.shiftKey && key === 'l') {
      e.preventDefault()
      commitRow(node, input)
      session.toggleTaskSelectedNodes()
      focusRow(node.id, col)
    } else if (e.shiftKey && key === 'k') {
      e.preventDefault()
      commitRow(node, input)
      session.toggleCheckedSelectedNodes()
      focusRow(node.id, col)
    } else if (key === 'd') {
      e.preventDefault()
      commitRow(node, input)
      session.duplicateSelectedNodes()
      containerRef.value?.focus()
    } else if (key === 'enter') {
      // Cmd/Ctrl+Enter：新建子节点（脑图视图同款）
      e.preventDefault()
      commitRow(node, input)
      const created = session.insertChildOf(node.id)
      if (created) focusRow(created.id, 0)
    } else if (key === 'a') {
      // Nested under ProseMirror: native Cmd+A selects the whole note. Select
      // within this field first; escalate to all outline rows when already full.
      e.preventDefault()
      const fullySelected = input.selectionStart === 0 && input.selectionEnd === input.value.length
      if (fullySelected) {
        commitRow(node, input)
        selectAllRows()
      } else {
        input.setSelectionRange?.(0, input.value.length)
      }
    }
    return
  }

  if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault()
    commitRow(node, input)
    extendSelection(e.key === 'ArrowUp' ? -1 : 1)
    containerRef.value?.focus()
    return
  }

  const start = input.selectionStart ?? 0
  const end = input.selectionEnd ?? 0
  const collapsedSelection = start === end
  const value = input.value
  const list = rows.value
  const rowIndex = list.findIndex((r) => r.node.id === node.id)
  const prevRow = rowIndex > 0 ? list[rowIndex - 1] : null
  const nextRow = rowIndex >= 0 && rowIndex < list.length - 1 ? list[rowIndex + 1] : null
  const root = session.focusRootNode

  switch (e.key) {
    case 'Enter': {
      e.preventDefault()
      if (start === 0 && end === 0 && value.length > 0) {
        const created = session.insertBeforeOf(node.id)
        if (created) focusRow(created.id, 0)
      } else if (end < value.length) {
        const before = value.slice(0, start)
        const after = value.slice(end)
        clearDraft(node.id)
        input.value = before
        let created: MindmapNode | null = null
        session.transact((doc) => {
          if (node.content.image) {
            const img = node.content.image
            doc.updateRaw(node, imageMarkdown(before, img.src, img.width))
          } else {
            doc.updateDisplayText(node, before)
          }
          created = doc.insertAfter(node, after)
        })
        if (created) {
          session.select((created as MindmapNode).id)
          focusRow((created as MindmapNode).id, 0)
        }
      } else {
        commitRow(node, input)
        const created = session.insertSiblingOf(node.id)
        if (created) {
          session.select(created.id)
          focusRow(created.id, 0)
        }
      }
      break
    }
    case 'Backspace': {
      if (!collapsedSelection || start > 0) break
      e.preventDefault()
      if (!prevRow) {
        // 列表首行：空行删除后回到标题；有内容则不与标题合并（幕布行为）
        if (value.length === 0) {
          if (node.children.length > 0) break
          session.removeNode(node.id)
          focusTitle()
        }
        break
      }
      if (value.length === 0) {
        if (node.children.length > 0) break
        const prevId = prevRow.node.id
        const prevLen = prevRow.node.content.text.length
        session.removeNode(node.id)
        focusRow(prevId, prevLen)
      } else if (node.parent && node.parent.children[0] === node) {
        // 首个子节点行首 Backspace：升级（聚焦根/文档根的直接子节点除外）
        if (node.parent === session.document.root || node.parent === root) break
        session.outdentNode(node.id)
        focusRow(node.id, 0)
      } else {
        const prevId = prevRow.node.id
        const prevLen = prevRow.node.content.text.length
        session.transact((doc) => {
          doc.updateDisplayText(prevRow.node, prevRow.node.content.text + value)
          for (const c of [...node.children])
            doc.move(c, prevRow.node, prevRow.node.children.length)
          doc.remove(node)
        })
        session.select(prevId)
        focusRow(prevId, prevLen)
      }
      break
    }
    case 'Delete': {
      if (!collapsedSelection || end < value.length) break
      if (!nextRow || nextRow.node.children.length > 0) break
      e.preventDefault()
      const nextText = nextRow.node.content.text
      session.transact((doc) => {
        doc.updateDisplayText(node, value + nextText)
        doc.remove(nextRow.node)
      })
      focusRow(node.id, value.length)
      break
    }
    case 'Tab': {
      e.preventDefault()
      const col = input.selectionStart ?? 0
      commitRow(node, input)
      if (e.shiftKey) session.outdentNode(node.id)
      else session.indentNode(node.id)
      focusRow(node.id, col)
      break
    }
    case 'Escape': {
      e.preventDefault()
      commitRow(node, input)
      containerRef.value?.focus()
      break
    }
    case 'ArrowUp': {
      if (!collapsedSelection || !caretVisualBoundary(input).first) break
      e.preventDefault()
      commitRow(node, input)
      if (prevRow) focusRow(prevRow.node.id, start)
      else focusTitle(start)
      break
    }
    case 'ArrowDown': {
      if (!collapsedSelection || !caretVisualBoundary(input).last) break
      e.preventDefault()
      commitRow(node, input)
      if (nextRow) focusRow(nextRow.node.id, start)
      break
    }
    case 'ArrowLeft': {
      if (!collapsedSelection || start > 0) break
      e.preventDefault()
      commitRow(node, input)
      if (prevRow) focusRow(prevRow.node.id)
      else focusTitle()
      break
    }
    case 'ArrowRight': {
      if (!collapsedSelection || end < value.length) break
      e.preventDefault()
      commitRow(node, input)
      if (nextRow) focusRow(nextRow.node.id, 0)
      break
    }
  }
}

function onRowInputBlur(node: MindmapNode, e: FocusEvent) {
  const input = e.currentTarget as RichInlineEditorElement
  commitRow(node, input)
  if (focusedId.value === node.id) focusedId.value = null
  if (!linkEditor.value && textSelection.value?.nodeId === node.id) textSelection.value = null
}

function onRowInputFocus(node: MindmapNode, e?: FocusEvent) {
  focusedId.value = node.id
  props.session.select(node.id)
  const input = (e?.currentTarget as RichInlineEditorElement | undefined) ?? inputOf(node.id)
  if (input && !draftTexts.value.has(node.id)) {
    const next = new Map(draftTexts.value)
    next.set(node.id, input.value)
    draftTexts.value = next
  }
}

// ---------- 复制 / 剪切 / 粘贴 ----------

const LIST_LINE_RE = /^\s*[-*+]\s+/

function selectedRoots(): MindmapNode[] {
  const ids = props.session.selectionIds
  return props.session.selectedNodes.filter((node) => {
    if (node === props.session.focusRootNode || node === props.session.document.root) return false
    let parent = node.parent
    while (parent) {
      if (ids.has(parent.id)) return false
      parent = parent.parent
    }
    return true
  })
}

function serializeSelection(): string {
  return selectedRoots()
    .map((node) => serializeSubtree(node))
    .join('\n')
}

function selectAllRows() {
  const list = rows.value
  if (list.length === 0) return
  props.session.selectMany(
    list.map((row) => row.node.id),
    list[list.length - 1].node.id,
    list[0].node.id
  )
  containerRef.value?.focus()
}

/** Desk host Mod+A when focus isn't on a row editor target. */
function selectAllFromHost(): void {
  const active = document.activeElement
  if (active && containerRef.value?.contains(active) && 'selectionStart' in active) {
    const input = active as RichInlineEditorElement
    const len = input.value?.length ?? 0
    const fullySelected = (input.selectionStart ?? 0) === 0 && (input.selectionEnd ?? 0) === len
    if (!fullySelected && typeof input.setSelectionRange === 'function') {
      input.setSelectionRange(0, len)
      return
    }
  }
  selectAllRows()
}

function commitFocusedRowIfAny(): void {
  const id = focusedId.value
  if (!id) return
  const node = props.session.document.find(id)
  const active = document.activeElement
  if (!node || !active || !containerRef.value?.contains(active)) return
  if (!('selectionStart' in active)) return
  commitRow(node, active as RichInlineEditorElement)
}

/** Desk host Mod+Z — commit in-flight row edit then undo session history. */
function undoFromHost(): void {
  commitFocusedRowIfAny()
  props.session.undo()
  containerRef.value?.focus()
}

/** Desk host Mod+Shift+Z / Mod+Y. */
function redoFromHost(): void {
  commitFocusedRowIfAny()
  props.session.redo()
  containerRef.value?.focus()
}

function extendSelectionTo(index: number) {
  const list = rows.value
  const target = list[index]
  if (!target) return
  const anchorId =
    props.session.selectionAnchor?.id ?? props.session.selectedNode?.id ?? target.node.id
  const anchorIndex = list.findIndex((row) => row.node.id === anchorId)
  const normalizedAnchor = anchorIndex >= 0 ? anchorIndex : index
  const from = Math.min(normalizedAnchor, index)
  const to = Math.max(normalizedAnchor, index)
  props.session.selectMany(
    list.slice(from, to + 1).map((row) => row.node.id),
    target.node.id,
    list[normalizedAnchor].node.id
  )
  scrollRowIntoView(index)
}

function extendSelection(direction: -1 | 1) {
  const list = rows.value
  if (list.length === 0) return
  const selected = props.session.selectedNode
  const current = selected ? list.findIndex((row) => row.node.id === selected.id) : -1
  const next =
    current < 0
      ? direction > 0
        ? 0
        : list.length - 1
      : Math.max(0, Math.min(list.length - 1, current + direction))
  extendSelectionTo(next)
}

function onEditorPasteImage(node: MindmapNode, image: Blob) {
  const input = inputOf(node.id)
  if (input) commitRow(node, input)
  emit('pasteImage', node.id, image)
}

function onEditorPasteMultiline(node: MindmapNode, text: string) {
  const session = props.session
  const input = inputOf(node.id)
  if (input) commitRow(node, input)

  const fragment = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      if (LIST_LINE_RE.test(l)) return l
      const m = /^(\s*)(.*)$/.exec(l)!
      return `${m[1]}- ${m[2]}`
    })
    .join('\n')
  const { doc: tmp } = parseMarkdown(`# _\n\n${fragment}\n`)
  const nodes = tmp.root.children.map((c) => cloneSubtree(c))
  if (nodes.length === 0) return

  const currentText = node.content.text.trim()
  session.transact((doc) => {
    let anchor = node
    if (currentText === '' && node !== doc.root && node !== session.focusRootNode) {
      const first = nodes.shift()!
      doc.updateRaw(node, first.content.raw)
      for (const c of [...first.children]) doc.move(c, node, node.children.length)
    } else if (node.content.image) {
      const img = node.content.image
      if (currentText !== img.alt) {
        doc.updateRaw(node, imageMarkdown(currentText, img.src, img.width))
      }
    } else if (currentText !== node.content.text) {
      doc.updateDisplayText(node, currentText)
    }
    // 粘贴到标题：插入为标题的子节点
    if (node === session.focusRootNode) {
      let index = node.children.length
      for (const n of nodes) {
        const inserted = doc.addNode(node, n.content, index++)
        inserted.collapsed = n.collapsed
        for (const c of [...n.children]) doc.move(c, inserted, inserted.children.length)
      }
      return
    }
    const parent = anchor.parent ?? doc.root
    let index = parent.children.indexOf(anchor) + 1
    for (const n of nodes) {
      const inserted = doc.addNode(parent, n.content, index++)
      inserted.collapsed = n.collapsed
      for (const c of [...n.children]) doc.move(c, inserted, inserted.children.length)
    }
  })
  session.select(node.id)
}

function onCopy(node: MindmapNode, e: ClipboardEvent) {
  const input = e.currentTarget as RichInlineEditorElement
  if (input.selectionStart !== input.selectionEnd) return
  e.preventDefault()
  const text =
    props.session.selectionIds.size > 1 && props.session.selectionIds.has(node.id)
      ? serializeSelection()
      : serializeSubtree(node)
  e.clipboardData?.setData('text/plain', text)
}

function onCut(node: MindmapNode, e: ClipboardEvent) {
  const input = e.currentTarget as RichInlineEditorElement
  if (input.selectionStart !== input.selectionEnd) return
  e.preventDefault()
  if (props.session.selectionIds.size > 1 && props.session.selectionIds.has(node.id)) {
    e.clipboardData?.setData('text/plain', serializeSelection())
    props.session.removeSelectedNodes()
  } else {
    e.clipboardData?.setData('text/plain', serializeSubtree(node))
    if (node !== props.session.document.root && node !== props.session.focusRootNode) {
      props.session.removeNode(node.id)
    }
  }
}

function onContainerCopy(e: ClipboardEvent) {
  if (props.session.selectionIds.size === 0) return
  const text = serializeSelection()
  if (!text) return
  e.preventDefault()
  e.clipboardData?.setData('text/plain', text)
}

function onContainerCut(e: ClipboardEvent) {
  if (props.session.selectionIds.size === 0) return
  const text = serializeSelection()
  if (!text) return
  e.preventDefault()
  e.clipboardData?.setData('text/plain', text)
  props.session.removeSelectedNodes()
}

// ---------- 行点击 / bullet / 折叠 ----------

let suppressRowClick = false

function onBulletClick(node: MindmapNode, e: MouseEvent) {
  e.stopPropagation()
  if (suppressRowClick) return
  props.session.focusNode(node.id)
}

function onArrowClick(node: MindmapNode, e: MouseEvent) {
  e.stopPropagation()
  if (suppressRowClick) return
  props.session.toggleCollapse(node.id)
}

function onCheckboxClick(node: MindmapNode, e: MouseEvent) {
  e.stopPropagation()
  props.session.toggleChecked(node.id)
}

function onInlineDisplayClick(node: MindmapNode, e: MouseEvent) {
  e.stopPropagation()
  if ((e.target as HTMLElement | null)?.closest('.inline-run.link')) return
  if (focusedId.value === node.id) return
  const editor = e.currentTarget as HTMLElement
  focusRow(node.id, caretOffsetFromPoint(editor, e.clientX, e.clientY))
}

function navigableUrl(raw: string): string | null {
  const url = raw.trim()
  if (!url || /^(?:javascript|data|vbscript):/i.test(url)) return null
  if (/^(?:https?|mailto|tel):/i.test(url) || /^(?:[./#]|\/)/.test(url)) return url
  return `https://${url}`
}

function onInlineLinkClick(link: InlineLink, event: Event) {
  event.preventDefault()
  event.stopPropagation()
  const url = navigableUrl(link.url)
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}

function keepLinkPopover() {
  if (linkLeaveTimer) clearTimeout(linkLeaveTimer)
  linkLeaveTimer = null
}

function closeLinkPopoverSoon() {
  keepLinkPopover()
  linkLeaveTimer = setTimeout(() => {
    if (linkEditor.value?.mode === 'existing') linkEditor.value = null
  }, 180)
}

function onInlineLinkEnter(node: MindmapNode, link: InlineLink, event: MouseEvent) {
  if (linkEditor.value?.mode === 'selection') return
  keepLinkPopover()
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  linkEditor.value = {
    mode: 'existing',
    nodeId: node.id,
    rawStart: link.rawStart,
    rawEnd: link.rawEnd,
    url: link.url,
    position: {
      left: Math.max(220, Math.min(window.innerWidth - 220, rect.left + rect.width / 2)),
      top: Math.min(window.innerHeight - 54, rect.bottom + 6)
    }
  }
}

function onTitleLinkEnter(link: InlineLink, event: MouseEvent) {
  const root = focusRoot.value
  if (root) onInlineLinkEnter(root, link, event)
}

function saveLink(url: string) {
  const editor = linkEditor.value
  if (!editor) return
  if (editor.mode === 'existing') {
    props.session.updateNodeInlineLink(editor.nodeId, editor.rawStart!, editor.rawEnd!, url)
  } else {
    props.session.setNodeInlineLink(editor.nodeId, editor.start!, editor.end!, url)
  }
  linkEditor.value = null
  const selection = textSelection.value
  if (selection) restoreTextSelection(selection)
}

function removeLink() {
  const editor = linkEditor.value
  if (!editor) return
  if (editor.mode === 'existing') {
    props.session.updateNodeInlineLink(editor.nodeId, editor.rawStart!, editor.rawEnd!, null)
  } else {
    props.session.setNodeInlineLink(editor.nodeId, editor.start!, editor.end!, null)
  }
  linkEditor.value = null
}

function onImageClick(node: MindmapNode, e: MouseEvent) {
  e.stopPropagation()
  if (node.content.image) emit('imagePreview', resolvedImageSrc(node.content.image.src))
}

function onOutlineImageLoad(src: string, e: Event) {
  const el = e.target as HTMLImageElement
  if (!el.naturalWidth || !el.naturalHeight) return
  const aspect = el.naturalWidth / el.naturalHeight
  if (imageAspects.value.get(src) === aspect) return
  const next = new Map(imageAspects.value)
  next.set(src, aspect)
  imageAspects.value = next
}

interface ImgResizeState {
  id: string
  startX: number
  startW: number
}

let imgResize: ImgResizeState | null = null

function onImageResizePointerDown(node: MindmapNode, e: PointerEvent) {
  if (e.button !== 0 || !node.content.image) return
  e.preventDefault()
  e.stopPropagation()
  imgResize = {
    id: node.id,
    startX: e.clientX,
    startW: node.content.image.width ?? DEFAULT_OUTLINE_IMG_W
  }
  suppressRowClick = true
  window.addEventListener('pointermove', onImageResizeMove)
  window.addEventListener('pointerup', onImageResizeUp, { once: true })
}

function onImageResizeMove(e: PointerEvent) {
  if (!imgResize) return
  const next = Math.max(
    MIN_IMG_W,
    Math.min(MAX_IMG_W, Math.round(imgResize.startW + (e.clientX - imgResize.startX)))
  )
  const map = new Map(liveImageWidth.value)
  map.set(imgResize.id, next)
  liveImageWidth.value = map
}

function onImageResizeUp() {
  window.removeEventListener('pointermove', onImageResizeMove)
  const state = imgResize
  imgResize = null
  setTimeout(() => (suppressRowClick = false), 0)
  if (!state) return
  const w = liveImageWidth.value.get(state.id) ?? state.startW
  const map = new Map(liveImageWidth.value)
  map.delete(state.id)
  liveImageWidth.value = map
  if (w !== state.startW) props.session.setImageWidth(state.id, w)
}

// ---------- 键盘导航（焦点在容器、非编辑态时） ----------

function onKeydown(e: KeyboardEvent) {
  const session = props.session
  const sel = session.selectedNode
  const mod = e.metaKey || e.ctrlKey
  const key = e.key.toLowerCase()

  if (mod && key === '\\' && session.selectionIds.size > 0) {
    e.preventDefault()
    session.clearSelectedNodeFormats()
    return
  }

  const format = inlineFormatShortcut(e, session.selectionIds.size > 1)
  if (format && session.selectionIds.size > 0) {
    e.preventDefault()
    session.formatSelectedNodes(format)
    return
  }

  if (mod && key === 'a') {
    e.preventDefault()
    selectAllRows()
    return
  }

  if (mod && key === 'z') {
    e.preventDefault()
    if (e.shiftKey) session.redo()
    else session.undo()
    return
  }
  if (mod && key === 'y') {
    e.preventDefault()
    session.redo()
    return
  }
  if (mod && key === 'f') {
    e.preventDefault()
    emit('requestSearch')
    return
  }
  if (mod && !e.shiftKey && key === 'x' && session.selectionIds.size > 0) {
    e.preventDefault()
    void cutSelectedToClipboard()
    return
  }
  if ((e.key === '.' || e.key === '>') && (mod || e.altKey)) {
    e.preventDefault()
    if (mod && e.altKey && e.shiftKey) session.toggleCollapseAll()
    else if (mod && e.shiftKey && sel) session.toggleCollapseSiblings(sel.id)
    else if (sel) session.toggleCollapse(sel.id)
    return
  }
  if (mod && e.key === ']') {
    e.preventDefault()
    if (sel) {
      session.focusNode(sel.id)
      focusTitle()
    }
    return
  }
  if (mod && e.key === '[') {
    e.preventDefault()
    if (session.focusPath.length > 0) session.exitFocusTo(session.focusPath.length - 1)
    return
  }
  if (mod && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault()
    session.moveSelectedNodes(e.key === 'ArrowUp' ? -1 : 1)
    return
  }
  if (mod && e.shiftKey && (key === 'backspace' || key === 'd')) {
    e.preventDefault()
    session.removeSelectedNodes()
    return
  }
  if (mod && e.shiftKey && key === 'l') {
    e.preventDefault()
    session.toggleTaskSelectedNodes()
    return
  }
  if (mod && e.shiftKey && key === 'k') {
    e.preventDefault()
    session.toggleCheckedSelectedNodes()
    return
  }
  if (mod && key === 'd') {
    e.preventDefault()
    session.duplicateSelectedNodes()
    return
  }

  const list = rows.value
  const idx = sel ? list.findIndex((r) => r.node.id === sel.id) : -1
  const root = session.focusRootNode

  switch (e.key) {
    case 'Enter':
      e.preventDefault()
      if (sel) focusRow(sel.id)
      else focusTitle()
      break
    case 'Tab':
      e.preventDefault()
      if (sel && sel !== root) {
        if (e.shiftKey) session.outdentSelectedNodes()
        else session.indentSelectedNodes()
      }
      break
    case 'Delete':
    case 'Backspace':
      e.preventDefault()
      if (sel && sel !== root) session.removeSelectedNodes()
      break
    case 'ArrowUp':
    case 'ArrowDown': {
      e.preventDefault()
      if (e.shiftKey) {
        extendSelection(e.key === 'ArrowDown' ? 1 : -1)
        break
      }
      if (list.length === 0) {
        session.select(root.id)
        break
      }
      if (sel?.id === root.id && e.key === 'ArrowDown') {
        session.select(list[0].node.id)
        scrollRowIntoView(0)
        break
      }
      const next =
        idx < 0
          ? list[0]
          : list[Math.max(0, Math.min(list.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))]
      session.select(next.node.id)
      scrollRowIntoView(next.index)
      break
    }
    case 'ArrowLeft':
      e.preventDefault()
      if (sel && sel !== root) {
        if (sel.children.length > 0 && !sel.collapsed) session.toggleCollapse(sel.id)
        else if (sel.parent) session.select(sel.parent.id)
      }
      break
    case 'ArrowRight':
      e.preventDefault()
      if (sel) {
        if (sel.collapsed) session.toggleCollapse(sel.id)
        else if (sel.children.length > 0) session.select(sel.children[0].id)
      }
      break
  }
}

// ---------- 鼠标跨节点连续选择 ----------

const rangeSelecting = ref(false)
let stopRangeSelect: (() => void) | null = null

function onRowPointerDown(row: Row, e: PointerEvent) {
  if (e.button !== 0) return
  const target = e.target as HTMLElement | null
  if (target?.closest('.row-gutter, .row-checkbox, .row-badge, .row-image, .row-image-handle'))
    return

  if (e.shiftKey) {
    e.preventDefault()
    const active = document.activeElement
    if (isInlineEditorElement(active)) active.blur()
    extendSelectionTo(row.index)
    containerRef.value?.focus()
    return
  }

  stopRangeSelect?.()
  const pointerId = e.pointerId
  const startIndex = row.index
  const startY = e.clientY
  let dragging = false

  const cleanup = () => {
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    document.removeEventListener('pointercancel', onUp)
    if (dragging) {
      document.body.style.removeProperty('user-select')
      document.body.style.removeProperty('-webkit-user-select')
      setTimeout(() => (rangeSelecting.value = false), 0)
    }
    stopRangeSelect = null
  }
  const onMove = (ev: PointerEvent) => {
    if (ev.isTrusted && ev.pointerId !== pointerId) return
    const index = rowIndexAt(ev.clientY)
    if (index < 0) return
    if (!dragging) {
      if (index === startIndex || Math.abs(ev.clientY - startY) < 5) return
      dragging = true
      rangeSelecting.value = true
      document.body.style.setProperty('user-select', 'none')
      document.body.style.setProperty('-webkit-user-select', 'none')
      const active = document.activeElement
      if (isInlineEditorElement(active)) active.blur()
      window.getSelection()?.removeAllRanges()
    }
    ev.preventDefault()
    const from = Math.min(startIndex, index)
    const to = Math.max(startIndex, index)
    const selected = rows.value.slice(from, to + 1)
    props.session.selectMany(
      selected.map((item) => item.node.id),
      rows.value[index]?.node.id ?? null,
      rows.value[startIndex]?.node.id ?? null
    )
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.isTrusted && ev.pointerId !== pointerId) return
    cleanup()
    if (dragging) containerRef.value?.focus()
  }

  stopRangeSelect = cleanup
  document.addEventListener('pointermove', onMove, { passive: false })
  document.addEventListener('pointerup', onUp)
  document.addEventListener('pointercancel', onUp)
}

// ---------- 拖拽移动（幕布口径：圆点发起；横线 + 层级线高亮） ----------

interface DropIndicator {
  type: 'before' | 'after' | 'child'
  targetId: string
  /** 相对 .outline-spacer 的横线位置 */
  top: number
  left: number
  width: number
  /** child：高亮与父级圆点对齐的那一列引导线（depth 值） */
  guideDepth: number | null
}

interface DragState {
  id: string
  startY: number
  dragging: boolean
  pointerX: number
  pointerY: number
  indicator: DropIndicator | null
}

const drag = ref<DragState | null>(null)

function bulletCenterX(depth: number): number {
  return COLLAPSE_LEAD + depth * INDENT + BULLET_SIZE / 2
}

function isUnderAncestor(node: MindmapNode, ancestorId: string): boolean {
  let p = node.parent
  while (p) {
    if (p.id === ancestorId) return true
    p = p.parent
  }
  return false
}

function isDropGuideHighlighted(row: Row, guideDepth: number): boolean {
  const ind = drag.value?.indicator
  if (!ind || ind.type !== 'child' || ind.guideDepth !== guideDepth) return false
  return row.node.id === ind.targetId || isUnderAncestor(row.node, ind.targetId)
}

function onGripPointerDown(node: MindmapNode, e: PointerEvent) {
  if (e.button !== 0) return
  if (node === props.session.focusRootNode) return
  e.preventDefault()
  const grip = e.currentTarget as HTMLElement | null
  try {
    grip?.setPointerCapture?.(e.pointerId)
  } catch {
    /* ignore */
  }
  document.body.style.setProperty('user-select', 'none')
  document.body.style.setProperty('-webkit-user-select', 'none')
  window.getSelection()?.removeAllRanges()
  const pointerId = e.pointerId
  // 阈值前不写 drag ref，避免重渲染拆掉 grip 上的 capture/监听
  const pending: DragState = {
    id: node.id,
    startY: e.clientY,
    dragging: false,
    pointerX: e.clientX,
    pointerY: e.clientY,
    indicator: null
  }
  let finished = false
  const startX = e.clientX
  const onMove = (ev: PointerEvent) => {
    if (ev.isTrusted && ev.pointerId !== pointerId) return
    pending.pointerX = ev.clientX
    pending.pointerY = ev.clientY
    const moved =
      pending.dragging ||
      Math.abs(ev.clientY - pending.startY) >= 5 ||
      Math.abs(ev.clientX - startX) >= 5
    if (!moved) return
    if (!pending.dragging) {
      pending.dragging = true
      suppressRowClick = true
      window.getSelection()?.removeAllRanges()
    }
    pending.indicator = calcDropIndicator(ev.clientX, ev.clientY, pending.id)
    drag.value = { ...pending }
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.isTrusted && ev.pointerId !== pointerId) return
    if (finished) return
    finished = true
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    document.removeEventListener('pointercancel', onUp)
    try {
      if (grip?.hasPointerCapture?.(pointerId)) grip.releasePointerCapture(pointerId)
    } catch {
      /* ignore */
    }
    onDragUp()
  }
  // 只挂 document：setPointerCapture 后事件仍冒泡到 document；避免 grip 重渲染丢监听
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
  document.addEventListener('pointercancel', onUp)
}

/** 用 spacer 可视坐标命中行，避免 padding/标题 margin 造成的偏移 */
function rowIndexAt(clientY: number): number {
  const el = containerRef.value
  const spacer = el?.querySelector('.outline-spacer') as HTMLElement | null
  if (!el || !spacer) return -1
  const y = clientY - spacer.getBoundingClientRect().top
  const list = rows.value
  if (list.length === 0) return -1
  if (y < 0) return 0
  for (let i = 0; i < list.length; i++) {
    const row = list[i]
    if (y < row.top + row.height) return i
  }
  return list.length - 1
}

function descendantCount(node: MindmapNode): number {
  return node.children.reduce((total, child) => total + 1 + descendantCount(child), 0)
}

/** 幕布式落点：下半区锚定当前行，偏右/有子则收为子节点，否则插到同级之后（可左移升层） */
function calcDropIndicator(clientX: number, clientY: number, dragId: string): DropIndicator | null {
  const el = containerRef.value
  const spacer = el?.querySelector('.outline-spacer') as HTMLElement | null
  if (!el || !spacer) return null
  const list = rows.value
  if (list.length === 0) return null

  const idx = rowIndexAt(clientY)
  if (idx < 0) return null
  const hit = list[idx]
  const hitEl = el.querySelector(
    `.outline-row[data-node-id="${hit.node.id}"]`
  ) as HTMLElement | null
  if (!hitEl) return null
  const hitRect = hitEl.getBoundingClientRect()
  const midY = (hitRect.top + hitRect.bottom) / 2

  // 锚定节点：指针在行下半 → 本行；上半 → 上一行（幕布 _calcDropOperation）
  let anchorIdx = idx
  if (clientY <= midY) {
    if (idx === 0) {
      // 插到列表最前：作为聚焦根的第一个子节点之前 → before 首行
      if (hit.node.id === dragId || isUnderAncestor(hit.node, dragId)) return null
      return lineIndicator('before', hit, 0, spacer)
    }
    anchorIdx = idx - 1
  }

  // 落在被拖节点或其子树上时，改锚定到最近的合法邻居
  while (
    anchorIdx >= 0 &&
    (list[anchorIdx].node.id === dragId || isUnderAncestor(list[anchorIdx].node, dragId))
  ) {
    anchorIdx -= 1
  }
  if (anchorIdx < 0) {
    const first = list.find((r) => r.node.id !== dragId && !isUnderAncestor(r.node, dragId))
    if (!first) return null
    return lineIndicator('before', first, first.depth, spacer)
  }
  const anchor = list[anchorIdx]

  const anchorEl = el.querySelector(
    `.outline-row[data-node-id="${anchor.node.id}"]`
  ) as HTMLElement | null
  const anchorRect = (anchorEl ?? hitEl).getBoundingClientRect()
  const indentEdge = anchorRect.left + anchor.depth * INDENT
  const hasVisibleKids = anchor.node.children.some((c) => c.id !== dragId) && !anchor.node.collapsed
  // 偏右超过一层缩进，或目标已有展开子节点 → 收为第一个子节点（幕布口径）
  if ((hasVisibleKids || clientX > indentEdge + INDENT) && !anchor.node.collapsed) {
    return lineIndicator('child', anchor, anchor.depth + 1, spacer)
  }

  // 向左拖：按指针所在缩进层级逐级提升。不能只允许“末子”提升，
  // 否则有后续兄弟的节点永远无法拖回顶层。
  const resolved = resolveAfterDropLevel(
    anchor.node,
    props.session.focusRootNode,
    clientX,
    indentEdge,
    anchor.depth,
    INDENT
  )
  const place = resolved.node
  const depth = resolved.depth
  if (place.id === dragId || isUnderAncestor(place, dragId)) return null

  const placeRow = list.find((r) => r.node.id === place.id) ?? anchor
  // 横线画在指针锚定行附近（幕布画在 curNode）；提交时插到 place 之后
  const visual = lineIndicator('after', anchor, depth, spacer)
  visual.targetId = placeRow.node.id
  return visual
}

function lineIndicator(
  type: 'before' | 'after' | 'child',
  row: Row,
  lineDepth: number,
  spacer: HTMLElement
): DropIndicator {
  const top =
    type === 'before'
      ? row.top
      : type === 'after'
        ? row.top + row.height
        : row.top + Math.min(row.textHeight, ROW_HEIGHT)
  const lineLeft = Math.max(0, COLLAPSE_LEAD + Math.max(0, lineDepth) * INDENT)
  const width = Math.max(120, spacer.clientWidth - lineLeft - 8)
  return {
    type,
    targetId: row.node.id,
    top,
    left: lineLeft,
    width,
    guideDepth: type === 'child' ? row.depth : null
  }
}

function onDragUp() {
  document.body.style.removeProperty('user-select')
  document.body.style.removeProperty('-webkit-user-select')
  window.getSelection()?.removeAllRanges()
  const d = drag.value
  drag.value = null
  setTimeout(() => (suppressRowClick = false), 0)
  if (!d?.dragging || !d.indicator) return
  const session = props.session
  const target = session.document.find(d.indicator.targetId)
  if (!target) return
  if (d.indicator.type === 'child') {
    session.moveNode(d.id, target.id, 0)
  } else if (target.parent) {
    const idx = target.parent.children.indexOf(target)
    session.moveNode(d.id, target.parent.id, d.indicator.type === 'before' ? idx : idx + 1)
  }
  session.select(d.id)
}
</script>

<template>
  <div
    ref="containerRef"
    class="outline-view"
    :class="{ 'is-dragging': !!drag?.dragging, 'is-range-selecting': rangeSelecting }"
    tabindex="0"
    @scroll="onScroll"
    @keydown="onKeydown"
    @copy="onContainerCopy"
    @cut="onContainerCut"
  >
    <div
      v-if="focusRoot"
      class="outline-title"
      :class="{
        'is-selected': focusRoot.id === selectedId,
        'has-image': !!focusRoot.content.image
      }"
      :style="{ minHeight: `${titleHeight}px` }"
    >
      <RichInlineEditor
        class="title-input"
        :class="{ 'is-view-mode': focusedId !== focusRoot.id }"
        :editor-id="focusRoot.id"
        :raw="focusRoot.content.image ? focusRoot.content.text : focusRoot.content.raw"
        :active="focusedId === focusRoot.id"
        :placeholder="focusRoot.content.image ? '图片描述' : '标题'"
        paste-mode="outline"
        :style="{ height: `${Math.max(36, titleHeight - imageBlockHeight(focusRoot))}px` }"
        @click="onInlineDisplayClick(focusRoot, $event)"
        @focus="onRowInputFocus(focusRoot, $event)"
        @blur="onRowInputBlur(focusRoot, $event)"
        @draft-change="onRowDraftChange(focusRoot, null, $event)"
        @commit="commitEditorPayload(focusRoot, $event)"
        @keydown="onTitleKeydown"
        @keyup="onTextSelection(focusRoot, $event)"
        @mouseup="onTextSelection(focusRoot, $event)"
        @select="onTextSelection(focusRoot, $event)"
        @copy="onCopy(focusRoot, $event)"
        @cut="onCut(focusRoot, $event)"
        @paste-image="onEditorPasteImage(focusRoot, $event)"
        @paste-multiline="onEditorPasteMultiline(focusRoot, $event)"
        @link-enter="onTitleLinkEnter"
        @link-leave="closeLinkPopoverSoon"
        @link-click="onInlineLinkClick"
      />
      <div v-if="focusRoot.content.image" class="title-image">
        <div class="row-image-frame" :style="{ width: `${displayImageWidth(focusRoot)}px` }">
          <img
            class="row-image-img"
            :src="resolvedImageSrc(focusRoot.content.image.src)"
            :alt="focusRoot.content.image.alt"
            draggable="false"
            @load="onOutlineImageLoad(focusRoot.content.image.src, $event)"
            @click="onImageClick(focusRoot, $event)"
          />
          <span
            class="row-image-handle"
            title="拖动调节宽度"
            @pointerdown="onImageResizePointerDown(focusRoot, $event)"
          />
        </div>
      </div>
    </div>

    <div class="outline-spacer" :style="{ height: `${totalListHeight}px` }">
      <div
        v-for="row in visibleRows"
        :key="row.node.id"
        class="outline-row"
        :data-node-id="row.node.id"
        :class="{
          'is-selected': selectedIds.has(row.node.id),
          'is-matched': matches.has(row.node.id),
          'is-hovered': hoveredId === row.node.id,
          'has-image': !!row.node.content.image,
          'is-drag-source': drag?.dragging && drag.id === row.node.id
        }"
        :style="{ top: `${row.top}px`, height: `${row.height}px` }"
        @mouseenter="hoveredId = row.node.id"
        @mouseleave="hoveredId = null"
        @pointerdown.capture="onRowPointerDown(row, $event)"
      >
        <!-- 引导线与祖先圆点中心对齐（幕布 indent-item 口径） -->
        <span class="row-indents" :style="{ width: `${gutterWidth(row.depth)}px` }">
          <i
            v-for="i in row.depth"
            :key="i"
            class="indent-guide"
            :class="{ 'is-drop-highlight': isDropGuideHighlighted(row, i - 1) }"
            :style="{ left: `${(i - 1) * INDENT + BULLET_CENTER}px` }"
          />
          <!-- 收为子节点时：在目标行自身圆点列补一条高亮层级线 -->
          <i
            v-if="drag?.indicator?.type === 'child' && drag.indicator.targetId === row.node.id"
            class="indent-guide is-drop-highlight is-drop-parent"
            :style="{ left: `${bulletCenterX(row.depth)}px` }"
          />
        </span>

        <div class="row-main">
          <span
            class="row-gutter"
            :style="{ width: `${gutterWidth(row.depth)}px` }"
            @pointerdown="onGripPointerDown(row.node, $event)"
          >
            <button
              v-if="row.node.children.length > 0"
              type="button"
              class="row-collapse"
              :class="{
                collapsed: row.node.collapsed,
                visible: hoveredId === row.node.id || row.node.collapsed
              }"
              :style="{
                left: `${row.depth > 0 ? (row.depth - 1) * INDENT + BULLET_CENTER - COLLAPSE_LEAD / 2 : 0}px`
              }"
              title="折叠/展开"
              @click="onArrowClick(row.node, $event)"
              @pointerdown.stop="onGripPointerDown(row.node, $event)"
            />
            <span
              class="row-bullet"
              :class="{
                'has-children': row.node.children.length > 0,
                collapsed: row.node.collapsed
              }"
              :style="{ left: `${COLLAPSE_LEAD + row.depth * INDENT}px` }"
              title="点击进入主题"
              @click="onBulletClick(row.node, $event)"
              @pointerdown.stop="onGripPointerDown(row.node, $event)"
            >
              <i class="bullet-dot" />
              <span
                v-if="row.node.collapsed && row.node.children.length > 0"
                class="bullet-count"
                >{{ descendantCount(row.node) }}</span
              >
            </span>
          </span>

          <button
            v-if="row.node.content.checked !== null"
            type="button"
            class="row-checkbox"
            :class="{ checked: row.node.content.checked }"
            role="checkbox"
            :aria-checked="row.node.content.checked"
            :title="row.node.content.checked ? '标记为未完成' : '标记为已完成'"
            @click="onCheckboxClick(row.node, $event)"
          >
            <svg v-if="row.node.content.checked" viewBox="0 0 16 16" aria-hidden="true">
              <path d="m3.5 8 3 3 6-6" />
            </svg>
          </button>

          <RichInlineEditor
            class="row-input"
            :class="{
              'is-task-done': row.node.content.checked === true,
              'is-view-mode': focusedId !== row.node.id
            }"
            :editor-id="row.node.id"
            :raw="row.node.content.image ? row.node.content.text : row.node.content.raw"
            :active="focusedId === row.node.id"
            :done="row.node.content.checked === true"
            :placeholder="row.node.content.image ? '图片描述' : undefined"
            paste-mode="outline"
            :style="{ height: `${row.textHeight - 8}px` }"
            @click="onInlineDisplayClick(row.node, $event)"
            @focus="onRowInputFocus(row.node, $event)"
            @blur="onRowInputBlur(row.node, $event)"
            @draft-change="onRowDraftChange(row.node, row.depth, $event)"
            @commit="commitEditorPayload(row.node, $event)"
            @keydown="onEditKeydown(row.node, $event)"
            @keyup="onTextSelection(row.node, $event)"
            @mouseup="onTextSelection(row.node, $event)"
            @select="onTextSelection(row.node, $event)"
            @copy="onCopy(row.node, $event)"
            @cut="onCut(row.node, $event)"
            @paste-image="onEditorPasteImage(row.node, $event)"
            @paste-multiline="onEditorPasteMultiline(row.node, $event)"
            @link-enter="(link, event) => onInlineLinkEnter(row.node, link, event)"
            @link-leave="closeLinkPopoverSoon"
            @link-click="onInlineLinkClick"
          />
        </div>

        <div
          v-if="row.node.content.image"
          class="row-image"
          :style="{ marginLeft: `${gutterWidth(row.depth)}px` }"
        >
          <div class="row-image-frame" :style="{ width: `${displayImageWidth(row.node)}px` }">
            <img
              class="row-image-img"
              :src="resolvedImageSrc(row.node.content.image.src)"
              :alt="row.node.content.image.alt"
              draggable="false"
              @load="onOutlineImageLoad(row.node.content.image.src, $event)"
              @click="onImageClick(row.node, $event)"
            />
            <span
              class="row-image-handle"
              title="拖动调节宽度"
              @pointerdown="onImageResizePointerDown(row.node, $event)"
            />
          </div>
        </div>
      </div>

      <div
        v-if="drag?.dragging && drag.indicator"
        class="drop-line"
        :data-drop-type="drag.indicator.type"
        :data-drop-target="drag.indicator.targetId"
        :data-guide-depth="drag.indicator.guideDepth ?? ''"
        :style="{
          top: `${drag.indicator.top}px`,
          left: `${drag.indicator.left}px`,
          width: `${drag.indicator.width}px`
        }"
      />
    </div>

    <div
      v-if="drag?.dragging"
      class="outline-drag-widget"
      :style="{ left: `${drag.pointerX}px`, top: `${drag.pointerY}px` }"
    >
      <i class="bullet-dot" />
    </div>

    <input
      ref="imagePickerRef"
      type="file"
      accept="image/*"
      hidden
      @change="onSelectionImagePicked"
    />

    <SelectionToolbar
      v-if="textSelection && !linkEditor"
      mode="text"
      :position="textSelection.position"
      :active-formats="selectedTextFormats"
      @format="applyTextFormat"
      @task="toggleSelectionTask"
      @image="requestSelectionImage"
      @link="openSelectionLinkEditor"
      @clear="clearTextFormat"
      @delete="removeToolbarSelection"
    />
    <SelectionToolbar
      v-else-if="multiSelectionPosition && !linkEditor"
      mode="nodes"
      :position="multiSelectionPosition"
      @format="applyNodeFormat"
      @task="toggleSelectionTask"
      @copy="copySelectedFromToolbar"
      @clear="clearNodeFormats"
      @delete="removeToolbarSelection"
    />
    <LinkPopover
      v-if="linkEditor"
      ref="linkPopoverRef"
      :url="linkEditor.url"
      :position="linkEditor.position"
      :start-editing="linkEditor.mode === 'selection'"
      @save="saveLink"
      @remove="removeLink"
      @keep="keepLinkPopover"
      @leave="closeLinkPopoverSoon"
      @close="linkEditor = null"
    />
  </div>
</template>

<style scoped>
.outline-view {
  position: relative;
  height: 100%;
  overflow: auto;
  outline: none;
  background: var(--mm-panel-bg);
  padding: 12px 24px 48px;
}
.outline-view.is-dragging,
.outline-view.is-dragging *,
.outline-view.is-range-selecting,
.outline-view.is-range-selecting * {
  user-select: none !important;
  -webkit-user-select: none !important;
  caret-color: transparent;
}
.outline-title {
  position: relative;
  min-height: 56px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  margin-bottom: 8px;
  gap: 8px;
}
.outline-title.has-image {
  min-height: auto;
}
.title-input {
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--mm-text);
  font-size: 28px;
  font-weight: 600;
  line-height: 1.3;
  padding: 4px 0;
  font-family: inherit;
  resize: none;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}
.title-input::placeholder {
  color: var(--mm-text-dim);
  font-weight: 500;
}
.title-input.is-view-mode {
  cursor: text;
}
.title-image {
  flex: none;
  padding: 0 0 8px;
}
.outline-spacer {
  position: relative;
}
.outline-row {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 0;
  padding-right: 12px;
  font-size: 15px;
  color: var(--mm-text);
  overflow: hidden;
}
.row-main {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  min-height: 32px;
  flex: none;
}
.row-image {
  flex: none;
  padding: 0 0 8px;
}
.row-image-frame {
  position: relative;
  max-width: 100%;
  line-height: 0;
  border-radius: 4px;
  overflow: hidden;
  background: color-mix(in srgb, var(--mm-text-dim) 12%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--mm-text-dim) 25%, transparent);
}
.row-image-img {
  display: block;
  width: 100%;
  height: auto;
  max-height: 480px;
  object-fit: contain;
  object-position: left top;
  cursor: zoom-in;
  user-select: none;
}
.row-image-handle {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: ew-resize;
  background: linear-gradient(135deg, transparent 50%, var(--mm-accent) 50%);
  opacity: 0.85;
}
.row-image-frame:hover .row-image-handle {
  opacity: 1;
}
.outline-row.is-selected {
  background: var(--mm-selected-bg);
  border-radius: 4px;
}
.outline-row:hover:not(.is-selected) {
  background: transparent;
}
.outline-row.is-matched .row-input {
  background: rgb(255 213 79 / 0.35);
  border-radius: 3px;
}
.row-indents {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 0;
  pointer-events: none;
}
.row-gutter {
  position: relative;
  flex: none;
  height: 32px;
  cursor: grab;
}
.indent-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 1px solid color-mix(in srgb, var(--mm-text-dim) 70%, transparent);
  pointer-events: none;
}
.indent-guide.is-drop-highlight {
  border-left-width: 2px;
  border-left-color: var(--mm-accent);
}
.outline-row.is-drag-source {
  opacity: 0.45;
}
.outline-row.is-drag-source .row-input {
  pointer-events: none;
}
.drop-line {
  position: absolute;
  height: 2px;
  border-radius: 1px;
  background: var(--mm-accent);
  pointer-events: none;
  z-index: 10;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--mm-accent) 35%, transparent);
}
.outline-drag-widget {
  position: fixed;
  z-index: 40;
  width: 22px;
  height: 22px;
  margin: -11px 0 0 -11px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  border-radius: 4px;
  background: color-mix(in srgb, var(--mm-panel-bg) 85%, var(--mm-accent));
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
}
.outline-drag-widget .bullet-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--mm-accent);
}
.row-collapse {
  position: absolute;
  top: 9px;
  width: 18px;
  height: 14px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  /* Always show for parents — hover-only left an empty gutter that looked
     like a missing drag handle (dots stay on the bullet column). */
  opacity: 1;
  z-index: 1;
}
.row-collapse.visible,
.outline-row:hover .row-collapse {
  opacity: 1;
}
.row-collapse::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 3px;
  border-style: solid;
  border-width: 4px 0 4px 6px;
  border-color: transparent transparent transparent var(--mm-text-dim);
  transform: rotate(90deg);
  transform-origin: 3px 4px;
  transition: transform 0.12s;
}
.row-collapse.collapsed::before {
  transform: rotate(0deg);
}
.row-bullet {
  position: absolute;
  top: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--mm-text-dim);
  font-size: 11px;
  z-index: 1;
}
.row-bullet:hover {
  background: color-mix(in srgb, var(--mm-text-dim) 22%, transparent);
}
.bullet-dot {
  display: block;
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--mm-text-dim, #9aa0a6);
}
.row-bullet.has-children .bullet-dot {
  background: var(--mm-text, #e8eaed);
}
.bullet-count {
  font-size: 10px;
  color: var(--mm-text-dim);
  line-height: 1;
}
.row-checkbox {
  display: inline-flex;
  width: 17px;
  height: 17px;
  flex: none;
  align-items: center;
  justify-content: center;
  margin: 7px 3px 0 0;
  padding: 0;
  border: 1.5px solid color-mix(in srgb, var(--mm-text-dim) 86%, transparent);
  border-radius: 4px;
  outline: 0;
  background: transparent;
  cursor: pointer;
  color: var(--mm-text-dim);
  transition:
    border-color 0.12s,
    background 0.12s,
    box-shadow 0.12s;
}
.row-checkbox.checked {
  border-color: var(--mm-accent);
  background: var(--mm-accent);
  color: white;
}
.row-checkbox:hover {
  border-color: var(--mm-accent);
}
.row-checkbox:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mm-accent) 28%, transparent);
}
.row-checkbox svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.row-input {
  flex: 1;
  min-width: 60px;
  border: none;
  outline: none;
  background: transparent;
  font-size: inherit;
  font-family: inherit;
  color: inherit;
  padding: 4px 2px;
  border-radius: 0;
  caret-color: var(--mm-text);
  resize: none;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.45;
}
.row-input:focus {
  background: transparent;
  box-shadow: none;
}
.row-input.is-view-mode {
  cursor: text;
}
.row-input.is-task-done {
  text-decoration: line-through;
  color: var(--mm-text-dim);
}
</style>
