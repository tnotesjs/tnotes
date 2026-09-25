import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import linkAttributes from 'markdown-it-link-attributes'
import DOMPurify from 'dompurify'
import CodeGroup from '@tnotesjs/ui/code-group'
import { createApp, h, type App } from 'vue'

import { hydrateTnSwipers, parseSwiperSlides, swiperSlideTabTitle } from './swiperSlides'

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

function getMarkdownIt(): InstanceType<typeof MarkdownIt> {
  if (markdownIt) return markdownIt
  const instance = new MarkdownIt({ html: true, linkify: true, breaks: false })
  instance.use(taskLists)
  instance.use(linkAttributes, { attrs: { target: '_self', rel: 'noopener' } })

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
  })
  return host.innerHTML
}

function renderBody(body: string, resolveImage: ResolveImage): string {
  const raw = getMarkdownIt().render(body)
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

function buildSwiper(bodyMarkdown: string, resolveImage: ResolveImage): HTMLElement {
  const slides = parseSwiperSlides(bodyMarkdown)
  const root = document.createElement('div')
  root.className = 'tn-swiper'
  const tabs = document.createElement('div')
  tabs.className = 'tn-swiper-tabs'
  const container = document.createElement('div')
  container.className = 'swiper-container'
  const wrapper = document.createElement('div')
  wrapper.className = 'swiper-wrapper'

  for (const slide of slides) {
    const slideEl = document.createElement('div')
    slideEl.className = 'swiper-slide'
    slideEl.dataset.title = swiperSlideTabTitle(slide)
    const img = document.createElement('img')
    img.src = resolveImage(slide.src) || slide.src
    img.alt = slide.alt
    slideEl.append(img)
    wrapper.append(slideEl)
  }

  container.append(wrapper)
  root.append(tabs, container)
  // Shared site/Desk activation: tabs, prev/next, single visible slide.
  hydrateTnSwipers(root)
  return root
}

function buildContainerDom(name: string, title: string, bodyHtml: string): HTMLElement {
  if (COLLAPSIBLE_TYPES.has(name)) {
    const details = document.createElement('details')
    details.className = 'tn-custom-block details'
    const summary = document.createElement('summary')
    summary.textContent = title || '详情'
    // Keep the toggle deterministic inside the non-editable atom rather than
    // relying on the browser default (which ProseMirror can swallow).
    summary.addEventListener('click', (event) => {
      event.preventDefault()
      details.open = !details.open
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
  resolveImage: ResolveImage = defaultResolveImage
): HTMLElement {
  const { name, title, body, hasBody } = parseContainerSource(source)
  if (name === 'code-group') return buildCodeGroup(body)
  if (name === 'swiper') return buildSwiper(body, resolveImage)
  if (name === 'footprints') {
    // Desk mounts the shared Vue Footprints; return a lightweight host shell here.
    const host = document.createElement('div')
    host.className = 'desk-raw-block__component-preview desk-footprints-host'
    host.dataset.footprints = '1'
    return host
  }
  const bodyHtml = hasBody ? renderBody(body, resolveImage) : ''
  return buildContainerDom(name, title, bodyHtml)
}
