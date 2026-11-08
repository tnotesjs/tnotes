import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import linkAttributes from 'markdown-it-link-attributes'
import { installMarkdownMath } from '../../agent/agentMarkdown'
import DOMPurify from 'dompurify'
import CodeGroup from '@tnotesjs/ui/code-group'
import CodeBlock from '@tnotesjs/ui/code-block'
import { alertIcon, ALERT_LABELS, ALERT_TYPES, isAlertType } from '@tnotesjs/ui/alerts'
import { parseImageAttrs } from '@tnotesjs/ui/image-markdown'
import { useLineBreaks, type LineBreakMode } from '@tnotesjs/ui/line-breaks'
import { createApp, h, type App } from 'vue'
import { createImageMoreButton, type ImageAssetContext } from '../../livePreview/imageMenu'
import { createImageResizeHandles } from '../../livePreview/imageResize'
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
const CALLOUT_TYPES = new Set(['quote', 'tip', 'warning', 'danger'])

/** 可视化会收成卡片的 `:::` 类型。其余（例如已移除的 note）留在源码里。 */
export const KNOWN_CONTAINER_TYPES = new Set([
  ...CALLOUT_TYPES,
  'details',
  'code-group',
  'swiper',
  'footprints'
])

export function isKnownContainerName(name: string): boolean {
  return KNOWN_CONTAINER_TYPES.has(name.toLowerCase())
}

/** Callouts that use structured title+body editing (fences stay locked). */
export const STRUCTURED_CALLOUT_TYPES = new Set(['tip', 'quote', 'warning', 'danger', 'details'])

/** tip/info/warning/danger are visual ProseMirror containers; details stays an atom. */
export const VISUAL_CALLOUT_TYPES = new Set(['tip', 'quote', 'warning', 'danger'])

export type VisualCalloutType = 'tip' | 'quote' | 'warning' | 'danger'

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
  const name = (next.name ?? (parsed.name || 'quote')).toLowerCase()
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

const markdownIts = new Map<LineBreakMode, InstanceType<typeof MarkdownIt>>()

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

function getMarkdownIt(lineBreaks: LineBreakMode = 'commonmark'): InstanceType<typeof MarkdownIt> {
  const cached = markdownIts.get(lineBreaks)
  if (cached) return cached
  const instance = new MarkdownIt({ html: true, linkify: true, breaks: false })
  instance.use(taskLists)
  instance.use(linkAttributes, { attrs: { target: '_self', rel: 'noopener' } })
  installMarkdownMath(instance)
  allowDataUrlsInParser(instance)
  numberMarkdownImages(instance)
  useLineBreaks(instance, lineBreaks)

  markdownIts.set(lineBreaks, instance)
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
  markCheckedTasks(host)
  return host.innerHTML
}

/** 已完成任务的正文套上和实时预览相同的删除线。线只画在文字上，不穿过复选框。 */
function markCheckedTasks(host: HTMLElement): void {
  host.querySelectorAll<HTMLInputElement>('.task-list-item-checkbox:checked').forEach((box) => {
    const parent = box.parentNode
    if (!parent || box.nextSibling == null) return
    const done = document.createElement('span')
    done.className = 'cm-lp-task-done'
    while (box.nextSibling) done.append(box.nextSibling)
    parent.append(done)
  })
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
  definitions?: ReadonlyMap<string, string>,
  lineBreaks: LineBreakMode = 'commonmark'
): string {
  const raw = getMarkdownIt(lineBreaks).render(withLinkDefinitions(body, definitions))
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
  const hosts = [element, ...element.querySelectorAll<HTMLElement>('[data-tn-vue-mount]')]
  for (const host of hosts) {
    const app = mountedCodeGroups.get(host)
    if (!app) continue
    app.unmount()
    mountedCodeGroups.delete(host)
  }
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
  group.dataset.tnVueMount = '1'
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
  asset?(): ImageAssetContext | null
  /** 卡片因改宽度重建后仍停在这一张，而不是回到第一张。 */
  activeIndex?: number
  onActivate?(index: number): void
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
  frame.append(
    ...createImageResizeHandles(frame, {
      minWidth: MIN_SLIDE_WIDTH,
      maxWidth: () => Math.max(MIN_SLIDE_WIDTH, bounds.getBoundingClientRect().width),
      enabled: () => !editor.readOnly,
      commit: (width) => editor.commit(index, { width })
    })
  )

  // 与正文 / 表格图片同一套「⋯」系统菜单（预览 / 对齐 / 原始大小 / 删除）
  const actions = document.createElement('span')
  actions.className = 'cm-lp-image-actions'
  actions.append(
    createImageMoreButton(
      img,
      () => ({
        align: slide.align ?? 'center',
        hasWidth: Boolean(slide.width),
        editable: !editor.readOnly,
        src: slide.src,
        asset: editor.asset?.() ?? null
      }),
      {
        // 幻灯片默认居中：选「居中」时去掉写出来的 align=
        align: (align) => editor.commit(index, { align: align === 'center' ? null : align }),
        resetSize: () => editor.commit(index, { width: '' }),
        remove: () => editor.commit(index, { remove: true }),
        replaceSrc: (src) => editor.commit(index, { src }),
        resize: (width) => editor.commit(index, { width })
      }
    )
  )
  frame.append(actions)
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
  hydrateTnSwipers(root, {
    activeIndex: editor?.activeIndex,
    onActivate: editor?.onActivate
  })
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
  body: HTMLElement,
  detailsSession?: DetailsSessionOptions,
  calloutEditor?: CalloutEditor
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
    summary.append(fold)
    summary.append(buildAlertHeading(name, title, calloutEditor))
    summary.addEventListener('click', (event) => {
      if (
        (event.target as HTMLElement | null)?.closest(
          '.tn-alert-icon-button, .tn-alert-menu, .tn-alert-title-input'
        )
      ) {
        return
      }
      event.preventDefault()
      details.open = !details.open
      detailsSession?.onOpenChange?.(details.open)
    })
    details.append(summary, body)
    return details
  }

  if (CALLOUT_TYPES.has(name)) {
    const block = document.createElement('div')
    block.className = `tn-custom-block ${name}`
    const titleEl = document.createElement('p')
    titleEl.className = 'tn-custom-block-title'
    titleEl.append(buildAlertHeading(name, title, calloutEditor))
    block.append(titleEl, body)
    return block
  }

  const block = document.createElement('div')
  block.className = `tn-custom-block ${name}`
  block.append(body)
  return block
}

export interface CalloutEditor {
  readOnly: boolean
  commit(next: { name?: string; title?: string }): void
  /** 去掉容器，正文留在原处；不传时菜单里没有这一项 */
  unwrap?(): void
  /** 标题框里按回车：焦点回到正文 */
  exit?(): void
}

function defaultAlertLabel(name: string): string {
  return isAlertType(name) ? ALERT_LABELS[name] : name.toUpperCase()
}

const UNWRAP_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>'

export function buildAlertHeading(
  name: string,
  title: string,
  editor?: CalloutEditor
): HTMLElement {
  const heading = document.createElement('span')
  heading.className = 'tn-alert-heading'
  if (!editor || editor.readOnly) {
    const icon = document.createElement('span')
    icon.className = 'tn-alert-icon'
    icon.innerHTML = alertIcon(name)
    const label = document.createElement('span')
    label.className = 'tn-alert-label'
    label.textContent = title || defaultAlertLabel(name)
    heading.append(icon, label)
    return heading
  }

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'tn-alert-icon-button'
  button.innerHTML = `<span class="tn-alert-icon">${alertIcon(name)}</span>`
  button.setAttribute('aria-label', '切换容器类型')
  button.setAttribute('aria-haspopup', 'listbox')
  const menu = document.createElement('div')
  menu.className = 'tn-alert-menu'
  menu.hidden = true
  menu.setAttribute('role', 'listbox')
  const choices: Array<{ id: string; label: string; icon: string; run: () => void }> =
    ALERT_TYPES.map((type) => ({
      id: type,
      label: ALERT_LABELS[type],
      icon: alertIcon(type),
      run: () => {
        if (type !== name) editor.commit({ name: type })
      }
    }))
  if (editor.unwrap) {
    const unwrap = editor.unwrap
    choices.push({ id: 'unwrap', label: '取消容器', icon: UNWRAP_ICON, run: () => unwrap() })
  }
  const current = Math.max(
    0,
    choices.findIndex((choice) => choice.id === name)
  )
  let active = current
  const closeMenu = (): void => {
    menu.hidden = true
    document.removeEventListener('mousedown', onOutside, true)
  }
  const onOutside = (event: MouseEvent): void => {
    if (!heading.contains(event.target as Node | null)) closeMenu()
  }
  const options = choices.map((choice, index) => {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = choice.id === 'unwrap' ? 'tn-alert-option is-unwrap' : 'tn-alert-option'
    option.dataset.type = choice.id
    option.setAttribute('role', 'option')
    option.innerHTML = `<span class="tn-alert-icon">${choice.icon}</span><span>${choice.label}</span>`
    if (choice.id === name) option.setAttribute('aria-selected', 'true')
    option.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    option.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      choice.run()
    })
    menu.append(option)
    return { option, index }
  })
  const paint = (): void => {
    options.forEach(({ option, index }) => option.classList.toggle('is-active', index === active))
  }
  const openMenu = (): void => {
    menu.hidden = false
    active = current
    paint()
    options[active]?.option.focus()
    document.addEventListener('mousedown', onOutside, true)
  }
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (menu.hidden) openMenu()
    else closeMenu()
  })
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      active = (active + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length
      paint()
      options[active]?.option.focus()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      options[active]?.option.click()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      button.focus()
    } else {
      event.stopPropagation()
    }
  })
  const input = document.createElement('input')
  input.className = 'tn-alert-title-input'
  input.value = title
  input.placeholder = defaultAlertLabel(name)
  input.spellcheck = false
  input.setAttribute('aria-label', '容器标题')
  input.addEventListener('mousedown', (event) => event.stopPropagation())
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.isComposing) return
    if (event.key === 'Enter' || event.key === 'ArrowDown') {
      event.preventDefault()
      // 先把焦点交回正文（失焦时 change 会提交标题），提交会重建标题栏
      if (editor.exit) editor.exit()
      else input.blur()
      commitTitle()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      input.value = committed
      if (editor.exit) editor.exit()
      else input.blur()
    }
  })
  let committed = title
  const commitTitle = (): void => {
    if (input.value === committed) return
    committed = input.value
    editor.commit({ title: input.value })
  }
  input.addEventListener('change', commitTitle)
  heading.append(button, input, menu)
  return heading
}

const SPECIAL_FENCE_LANG = new Set(['mermaid', 'mindmap', 'mmd'])

type CalloutSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'source'; text: string }
  | { kind: 'code'; info: string; code: string }
  | { kind: 'code-group'; body: string }

/** 容器正文：普通 Markdown 与代码 / 代码组可视化，其余 `:::` 和特殊围栏露出源码。 */
export function splitCalloutBody(body: string): CalloutSegment[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const segments: CalloutSegment[] = []
  let markdown: string[] = []
  const flush = (): void => {
    if (!markdown.some((line) => line.trim())) {
      markdown = []
      return
    }
    segments.push({ kind: 'markdown', text: markdown.join('\n') })
    markdown = []
  }
  let index = 0
  while (index < lines.length) {
    const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[index] ?? '')
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      const mark = fence[2]
      const info = fence[3].trim()
      const lang = info.split(/\s+/)[0]?.toLowerCase() ?? ''
      const start = index
      const code: string[] = []
      index += 1
      while (index < lines.length) {
        const close = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(lines[index] ?? '')
        if (close && close[2][0] === mark[0] && close[2].length >= mark.length) break
        code.push(lines[index] ?? '')
        index += 1
      }
      const closed = index < lines.length
      const text = lines.slice(start, closed ? index + 1 : lines.length).join('\n')
      flush()
      if (SPECIAL_FENCE_LANG.has(lang)) segments.push({ kind: 'source', text })
      else segments.push({ kind: 'code', info, code: code.join('\n') })
      if (closed) index += 1
      continue
    }
    const container = /^( {0,3})(:{3,})[ \t]*(.*)$/.exec(lines[index] ?? '')
    if (container?.[3].trim()) {
      const name = container[3].trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      const stack = [container[2].length]
      const start = index
      let innerFence: string | null = null
      index += 1
      while (index < lines.length && stack.length > 0) {
        const line = lines[index] ?? ''
        if (innerFence) {
          if (line.trimEnd().startsWith(innerFence) && line.trim().replace(/[`~]/g, '') === '') {
            innerFence = null
          }
          index += 1
          continue
        }
        const inner = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
        if (inner && !(inner[2][0] === '`' && inner[3].includes('`'))) {
          innerFence = inner[2]
          index += 1
          continue
        }
        const mark = /^( {0,3})(:{3,})[ \t]*(.*)$/.exec(line)
        if (mark && !mark[3].trim() && mark[2].length >= stack[stack.length - 1]) stack.pop()
        else if (mark?.[3].trim()) stack.push(mark[2].length)
        index += 1
      }
      const text = lines.slice(start, index).join('\n')
      flush()
      if (name === 'code-group') {
        const inner = lines.slice(start + 1, stack.length === 0 ? index - 1 : index).join('\n')
        segments.push({ kind: 'code-group', body: inner })
      } else segments.push({ kind: 'source', text })
      continue
    }
    markdown.push(lines[index] ?? '')
    index += 1
  }
  flush()
  return segments
}

function mountVue(host: HTMLElement, render: () => ReturnType<typeof h>): HTMLElement {
  host.dataset.tnVueMount = '1'
  const app = createApp({ render })
  app.mount(host)
  mountedCodeGroups.set(host, app)
  return host
}

function renderCalloutBodyElement(
  body: string,
  resolveImage: ResolveImage,
  definitions?: ReadonlyMap<string, string>,
  lineBreaks: LineBreakMode = 'commonmark'
): HTMLElement {
  const root = document.createElement('div')
  root.className = 'tn-alert-body'
  for (const segment of splitCalloutBody(body)) {
    if (segment.kind === 'markdown') {
      appendHtml(root, renderBody(segment.text, resolveImage, definitions, lineBreaks))
    } else if (segment.kind === 'source') {
      const pre = document.createElement('pre')
      pre.className = 'tn-container-source'
      pre.textContent = segment.text
      root.append(pre)
    } else if (segment.kind === 'code') {
      const host = document.createElement('div')
      host.className = 'tn-alert-code'
      root.append(
        mountVue(host, () =>
          h(CodeBlock, { code: segment.code, info: segment.info, lineNumbers: false })
        )
      )
    } else {
      root.append(buildCodeGroup(segment.body))
    }
  }
  return root
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
  detailsSession?: DetailsSessionOptions,
  calloutEditor?: CalloutEditor,
  lineBreaks: LineBreakMode = 'commonmark'
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
  const bodyEl = hasBody
    ? renderCalloutBodyElement(body, resolveImage, definitions, lineBreaks)
    : document.createElement('div')
  const element = buildContainerDom(name, title, bodyEl, detailsSession, calloutEditor)
  // 提示块里的表格同样「一格一图」：每格只留第一张可用 markdown 图
  keepFirstImagePerCell(element)
  if (imageEditor) enhanceCardImages(element, imageEditor, 'cm-lp-container-image')
  return element
}
