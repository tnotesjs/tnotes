import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import linkAttributes from 'markdown-it-link-attributes'
import { installMarkdownMath } from '../../agent/agentMarkdown'
import DOMPurify from 'dompurify'
import CodeGroup from '@tnotesjs/ui/code-group'
import { parseImageAttrs } from '@tnotesjs/ui/image-markdown'
import { createApp, h, type App } from 'vue'
import { createImageMoreButton } from '../../livePreview/imageMenu'
import {
  enhanceCardImages,
  keepFirstImagePerCell,
  numberMarkdownImages,
  type CardImageEditor
} from '../../livePreview/cardImages'
import { FOLD_CHEVRON_SVG } from '../../livePreview/headingFold'

import {
  hydrateTnSwipers,
  parseSwiperSlides,
  SWIPER_EMPTY_TEXT,
  swiperSlideTabTitle,
  type SwiperSlideChange,
  type SwiperSlideEntry
} from './swiperSlides'

export interface ParsedContainer {
  name: string
  title: string
  body: string
  hasBody: boolean
}

/** Fence-aware parse used when rewriting structured callouts. */
export interface ParsedContainerFences extends ParsedContainer {
  /** Opening fence markers only, e.g. `:::` or `::::` (with leading indent). */
  openColons: string
  /** Closing fence line as stored (trimmed trailing blanks excluded from index). */
  closeLine: string
  /** Whether the original source ended with a trailing newline after the close fence. */
  trailingNewline: boolean
}

export type ResolveImage = (src: string) => string

const COLLAPSIBLE_TYPES = new Set(['details'])
const CALLOUT_TYPES = new Set(['info', 'tip', 'warning', 'danger', 'note'])

/** Callouts that use structured title+body editing (fences stay locked). */
export const STRUCTURED_CALLOUT_TYPES = new Set(['tip', 'info', 'warning', 'danger', 'details'])

/** tip/info/warning/danger are visual ProseMirror containers; details stays an atom. */
export const VISUAL_CALLOUT_TYPES = new Set(['tip', 'info', 'warning', 'danger'])

export type VisualCalloutType = 'tip' | 'info' | 'warning' | 'danger'

export function isStructuredCalloutName(name: string): boolean {
  return STRUCTURED_CALLOUT_TYPES.has(name.toLowerCase())
}

export function isVisualCalloutName(name: string): boolean {
  return VISUAL_CALLOUT_TYPES.has(name.toLowerCase())
}

export function isVisualCalloutSource(source: string): boolean {
  return isVisualCalloutName(parseContainerSource(source).name)
}

export function isStructuredCalloutSource(source: string): boolean {
  return isStructuredCalloutName(parseContainerSource(source).name)
}

/**
 * Splits a `::: name [title] ... :::` source block into its name, optional
 * Container title (the bare text after the name, not a `[label]`) and
 * the inner body. Blank lines at the body edges are stripped.
 */
export function parseContainerSource(source: string): ParsedContainer {
  const { name, title, body, hasBody } = parseContainerFences(source)
  return { name, title, body, hasBody }
}

export function parseContainerFences(source: string): ParsedContainerFences {
  const trailingNewline = /\r?\n$/.test(source)
  const normalized = source.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  // Drop a single trailing empty segment from the final newline so close-fence
  // detection sees the real last content line.
  if (trailingNewline && lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  const opening = lines[0] ?? ''
  const match = opening.match(/^( {0,3}:{3,})[ \t]*([A-Za-z][\w-]*)?([ \t]+([\s\S]*))?$/)
  const openColons = match?.[1] ?? ':::'
  const name = (match?.[2] ?? '').toLowerCase()
  const title = (match?.[4] ?? '').trim()

  let end = lines.length - 1
  while (end >= 0 && lines[end].trim() === '') end -= 1
  let closeLine = openColons
  if (end >= 0 && /^ {0,3}:{3,}[ \t]*$/.test(lines[end])) {
    closeLine = lines[end].replace(/\s+$/, '')
    end -= 1
  }
  let start = 1
  while (start <= end && lines[start].trim() === '') start += 1
  while (end >= start && lines[end].trim() === '') end -= 1
  const body = start <= end ? lines.slice(start, end + 1).join('\n') : ''
  return {
    name,
    title,
    body,
    hasBody: body.trim().length > 0,
    openColons,
    closeLine,
    trailingNewline
  }
}

/**
 * Rebuilds a container source from structured title/body edits,
 * reusing the original colon count / close fence when possible.
 */
export function rebuildContainerSource(
  previousSource: string,
  next: { title: string; body: string; name?: string }
): string {
  const parsed = parseContainerFences(previousSource)
  const name = (next.name ?? (parsed.name || 'info')).toLowerCase()
  const title = next.title.trim()
  const openLine = title ? `${parsed.openColons} ${name} ${title}` : `${parsed.openColons} ${name}`
  const body = next.body.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '')
  const closeLine = parsed.closeLine || parsed.openColons
  const core =
    body.length > 0 ? `${openLine}\n\n${body}\n\n${closeLine}` : `${openLine}\n\n\n${closeLine}`
  return parsed.trailingNewline || previousSource === '' ? `${core}\n` : core
}

/**
 * 打开结构化容器编辑时的基线。用户没有改动（且源码没被外部改过）时返回原始源码，
 * 让调用方跳过一次「按模板重建」——重建只做空白/冒号规范化，会把未改动的块弄脏。
 */
export function preservedContainerSource(
  baseline: { source: string; title: string; body: string } | null,
  currentSource: string,
  draft: { title?: string; body: string }
): string | null {
  if (!baseline) return null
  if (currentSource !== baseline.source) return null
  if (draft.body !== baseline.body) return null
  if (draft.title !== undefined && draft.title.trim() !== baseline.title.trim()) return null
  return baseline.source
}

let markdownIt: InstanceType<typeof MarkdownIt> | null = null

/**
 * markdown-it 默认 validateLink 只放行 data:image/(gif|png|jpeg|webp)，其余 data:（如 svg）
 * 会让 `![](data:…)` 解析失败、整段源码当纯文本显示出来。卡片里图片地址统一交给
 * resolveImage 白名单处理（拒绝即去掉 src、显示裂图），所以解析阶段对 data: 放行；
 * 普通链接若被默认规则拒绝，则去掉 href（DOMPurify 不会剥 a 上的 data: href）。
 * javascript:/vbscript:/file: 照旧解析失败。
 */
export function allowDataUrlsInParser(instance: InstanceType<typeof MarkdownIt>): void {
  const defaultValidate = instance.validateLink.bind(instance)
  instance.validateLink = (url: string) => defaultValidate(url) || /^data:/i.test(url.trim())
  instance.core.ruler.push('tn_strip_data_link_href', (state) => {
    for (const block of state.tokens) {
      for (const token of block.children ?? []) {
        if (token.type !== 'link_open') continue
        const href = token.attrGet('href')
        if (href !== null && !defaultValidate(String(href))) {
          token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'href')
        }
      }
    }
  })
}

function getMarkdownIt(): InstanceType<typeof MarkdownIt> {
  if (markdownIt) return markdownIt
  const instance = new MarkdownIt({ html: true, linkify: true, breaks: false })
  instance.use(taskLists)
  instance.use(linkAttributes, { attrs: { target: '_self', rel: 'noopener' } })
  installMarkdownMath(instance)
  allowDataUrlsInParser(instance)
  numberMarkdownImages(instance)

  markdownIt = instance
  return instance
}

function rewriteImageSources(html: string, resolveImage: ResolveImage): string {
  const host = document.createElement('div')
  host.innerHTML = html
  host.querySelectorAll('img').forEach((image) => {
    const source = image.getAttribute('src') ?? ''
    const resolved = source ? resolveImage(source) : ''
    if (resolved) image.setAttribute('src', resolved)
    else image.removeAttribute('src')
    applyImageSizeAttrs(image)
  })
  return host.innerHTML
}

/** 块外图片由 `readImage` 吃掉 ` {w=…}`。markdown-it 卡片（容器/表格）同一段语法会留在图后面。 */
export function applyImageSizeAttrs(image: HTMLImageElement): void {
  const text = image.nextSibling
  if (!text || text.nodeType !== Node.TEXT_NODE) return
  const raw = text.textContent ?? ''
  if (!raw.includes('{')) return
  const parsed = parseImageAttrs(raw)
  if (parsed.rest !== '') return
  text.remove()
  if (parsed.width) image.style.width = parsed.width
  if (parsed.align === 'center') {
    image.style.display = 'block'
    image.style.marginLeft = 'auto'
    image.style.marginRight = 'auto'
  } else if (parsed.align === 'right') {
    image.style.display = 'block'
    image.style.marginLeft = 'auto'
  }
}

/** 把笔记级链接定义拼到片段末尾，供单独渲染的卡片（容器/表格）解析引用链接。 */
export function withLinkDefinitions(
  body: string,
  definitions?: ReadonlyMap<string, string>
): string {
  if (!definitions || definitions.size === 0) return body
  const lines = [...definitions.entries()].map(([label, url]) => {
    const destination = /[\s()]/.test(url) ? `<${url.replaceAll('>', '%3E')}>` : url
    return `[${label}]: ${destination}`
  })
  return `${body.replace(/\s*$/, '')}\n\n${lines.join('\n')}\n`
}

function renderBody(
  body: string,
  resolveImage: ResolveImage,
  definitions?: ReadonlyMap<string, string>
): string {
  const raw = getMarkdownIt().render(withLinkDefinitions(body, definitions))
  const sanitized = DOMPurify.sanitize(raw)
  return rewriteImageSources(sanitized, resolveImage)
}

interface CodeFence {
  filename: string
  lang: string
  info: string
  code: string
}

function collectFences(bodyMarkdown: string): CodeFence[] {
  const fences: CodeFence[] = []
  const tokens = getMarkdownIt().parse(bodyMarkdown, {})
  for (const token of tokens) {
    if (token.type !== 'fence') continue
    const info = String(token.info ?? '')
    const lang = info.match(/^\S+/)?.[0] ?? ''
    const meta = info.slice(lang.length).trim()
    const filename = meta.replace(/^\[|\]$/g, '').trim()
    fences.push({ filename, lang, info, code: token.content.replace(/\n$/, '') })
  }
  return fences
}

const mountedCodeGroups = new WeakMap<HTMLElement, App>()

export function destroyContainerPreview(element: HTMLElement | null | undefined): void {
  if (!element) return
  const app = mountedCodeGroups.get(element)
  if (!app) return
  app.unmount()
  mountedCodeGroups.delete(element)
}

function assembleCodeGroup(fences: CodeFence[]): HTMLElement {
  const group = document.createElement('div')
  group.className = 'custom-block custom-block-code-group'
  const items = fences.map((fence, index) => ({
    code: fence.code,
    info:
      fence.info ||
      [fence.lang, fence.filename ? `[${fence.filename}]` : ''].filter(Boolean).join(' '),
    key: `${fence.filename || fence.lang || 'code'}-${index}`
  }))
  const app = createApp({ render: () => h(CodeGroup, { items }) })
  app.mount(group)
  mountedCodeGroups.set(group, app)
  return group
}

function buildCodeGroup(bodyMarkdown: string): HTMLElement {
  return assembleCodeGroup(collectFences(bodyMarkdown))
}

/** Desk 可视化里改某张幻灯片的宽度或对齐。站点渲染不传。 */
export interface SwiperSlideEditor {
  readOnly: boolean
  commit(index: number, next: SwiperSlideChange): void
}

const MIN_SLIDE_WIDTH = 48

function slideAlignClass(entry: SwiperSlideEntry): string {
  return entry.align === 'left' || entry.align === 'right' ? `is-align-${entry.align}` : ''
}

function buildEditableSlide(
  img: HTMLImageElement,
  slide: SwiperSlideEntry,
  index: number,
  editor: SwiperSlideEditor,
  bounds: HTMLElement
): HTMLElement {
  const frame = document.createElement('span')
  frame.className = 'tn-swiper-frame'
  if (slide.width) {
    frame.style.width = slide.width
    img.style.width = '100%'
    img.style.maxWidth = '100%'
    img.style.height = 'auto'
  }
  frame.append(img)

  const handle = document.createElement('span')
  handle.className = 'tn-swiper-resize'
  handle.title = '拖动调整宽度'
  handle.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = frame.getBoundingClientRect().width
    const zoom = startWidth / Math.max(1, frame.offsetWidth)
    const maxWidth = Math.max(MIN_SLIDE_WIDTH, bounds.getBoundingClientRect().width)
    let width = startWidth
    const move = (moveEvent: MouseEvent): void => {
      width = Math.min(maxWidth, Math.max(MIN_SLIDE_WIDTH, startWidth + moveEvent.clientX - startX))
      frame.style.width = `${Math.round(width / zoom)}px`
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      editor.commit(index, { width: `${Math.round(width / zoom)}px` })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })

  // 与正文 / 表格图片同一套「⋯」系统菜单（预览 / 对齐 / 原始大小 / 删除）
  const actions = document.createElement('span')
  actions.className = 'cm-lp-image-actions'
  actions.append(
    createImageMoreButton(
      img,
      () => ({
        align: slide.align ?? 'center',
        hasWidth: Boolean(slide.width),
        editable: !editor.readOnly
      }),
      {
        // 幻灯片默认居中：选「居中」时去掉写出来的 align=
        align: (align) => editor.commit(index, { align: align === 'center' ? null : align }),
        resetSize: () => editor.commit(index, { width: '' }),
        remove: () => editor.commit(index, { remove: true })
      }
    )
  )
  frame.append(handle, actions)
  return frame
}

function buildSwiper(
  bodyMarkdown: string,
  resolveImage: ResolveImage,
  editor?: SwiperSlideEditor
): HTMLElement {
  const slides = parseSwiperSlides(bodyMarkdown)
  const visibleSlides = slides.flatMap((slide, index) => {
    const resolved = resolveImage(slide.src)
    return resolved ? [{ slide, index, resolved }] : []
  })
  const root = document.createElement('div')
  root.className = 'tn-swiper'
  if (visibleSlides.length === 0) {
    root.classList.add('is-empty')
    const container = document.createElement('div')
    container.className = 'swiper-container'
    const empty = document.createElement('p')
    empty.className = 'tn-swiper-empty'
    empty.textContent = SWIPER_EMPTY_TEXT
    container.append(empty)
    root.append(container)
    return root
  }
  const tabs = document.createElement('div')
  tabs.className = 'tn-swiper-tabs'
  const container = document.createElement('div')
  container.className = 'swiper-container'
  const wrapper = document.createElement('div')
  wrapper.className = 'swiper-wrapper'
  const editable = Boolean(editor && !editor.readOnly)

  visibleSlides.forEach(({ slide, index, resolved }) => {
    const slideEl = document.createElement('div')
    slideEl.className = 'swiper-slide'
    const alignClass = slideAlignClass(slide)
    if (alignClass) slideEl.classList.add(alignClass)
    slideEl.dataset.title = swiperSlideTabTitle(slide)
    const img = document.createElement('img')
    img.src = resolved
    img.alt = slide.alt
    if (!editable) {
      if (slide.width) img.style.width = slide.width
      slideEl.append(img)
    } else {
      // Keep original fence index so width/align commits still target the right line.
      slideEl.append(buildEditableSlide(img, slide, index, editor!, container))
    }
    wrapper.append(slideEl)
  })

  container.append(wrapper)
  root.append(tabs, container)
  // Shared site/Desk activation: tabs, prev/next, single visible slide.
  hydrateTnSwipers(root)
  return root
}

/** Desk / SSG details 折叠块的开合会话（不写回源码）。 */
export interface DetailsSessionOptions {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

function buildContainerDom(
  name: string,
  title: string,
  bodyHtml: string,
  detailsSession?: DetailsSessionOptions
): HTMLElement {
  if (COLLAPSIBLE_TYPES.has(name)) {
    const details = document.createElement('details')
    details.className = 'tn-custom-block details'
    if (detailsSession?.open) details.open = true
    const summary = document.createElement('summary')
    const fold = document.createElement('span')
    fold.className = 'tn-details-fold'
    fold.setAttribute('aria-hidden', 'true')
    fold.innerHTML = FOLD_CHEVRON_SVG
    summary.append(fold, document.createTextNode(title || '详情'))
    // Keep the toggle deterministic inside the non-editable atom rather than
    // relying on the browser default (which ProseMirror can swallow).
    summary.addEventListener('click', (event) => {
      event.preventDefault()
      details.open = !details.open
      detailsSession?.onOpenChange?.(details.open)
    })
    details.append(summary)
    appendHtml(details, bodyHtml)
    return details
  }

  if (CALLOUT_TYPES.has(name)) {
    const block = document.createElement('div')
    block.className = `tn-custom-block ${name}`
    const titleEl = document.createElement('p')
    titleEl.className = 'tn-custom-block-title'
    titleEl.textContent = title || name.toUpperCase()
    block.append(titleEl)
    appendHtml(block, bodyHtml)
    return block
  }

  const block = document.createElement('div')
  block.className = `tn-custom-block ${name}`
  appendHtml(block, bodyHtml)
  return block
}

function appendHtml(parent: HTMLElement, html: string): void {
  if (!html) return
  const holder = document.createElement('div')
  holder.innerHTML = html
  while (holder.firstChild) parent.append(holder.firstChild)
}

const defaultResolveImage: ResolveImage = (src) =>
  src.startsWith('https://') || src.startsWith('data:') || src.startsWith('#') ? src : ''

/**
 * Renders a `:::` container source into a read-only DOM node that mirrors the
 * site's `.tn-custom-block` / `details` structure (same classes as SSG).
 */
export function renderContainerFromSource(
  source: string,
  resolveImage: ResolveImage = defaultResolveImage,
  /** 围栏外的链接定义。容器正文单独渲染，看不到笔记末尾的 `[1]: url`。 */
  definitions?: ReadonlyMap<string, string>,
  swiperEditor?: SwiperSlideEditor,
  /** Desk 可视化：提示块正文图片的拖拽宽度 + 「⋯」菜单（与正文 / 表格图片一致）。站点 / 只读投影不传。 */
  imageEditor?: CardImageEditor,
  /** details：会话内开合记忆（卡片因改图重建时保持展开）。 */
  detailsSession?: DetailsSessionOptions
): HTMLElement {
  const { name, title, body, hasBody } = parseContainerSource(source)
  if (name === 'code-group') return buildCodeGroup(body)
  if (name === 'swiper') return buildSwiper(body, resolveImage, swiperEditor)
  if (name === 'footprints') {
    // Desk mounts the shared Vue Footprints; return a lightweight host shell here.
    const host = document.createElement('div')
    host.className = 'desk-raw-block__component-preview desk-footprints-host'
    host.dataset.footprints = '1'
    return host
  }
  const bodyHtml = hasBody ? renderBody(body, resolveImage, definitions) : ''
  const element = buildContainerDom(name, title, bodyHtml, detailsSession)
  // 提示块里的表格同样「一格一图」：每格只留第一张可用 markdown 图
  keepFirstImagePerCell(element)
  if (imageEditor) enhanceCardImages(element, imageEditor, 'cm-lp-container-image')
  return element
}
