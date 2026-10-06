import { syntaxTree } from '@codemirror/language'
import { EditorState, StateEffect } from '@codemirror/state'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView, WidgetType } from '@codemirror/view'
import DOMPurify from 'dompurify'
import type { SyntaxNode } from '@lezer/common'
import MarkdownIt from 'markdown-it'

import {
  allowDataUrlsInParser,
  applyImageSizeAttrs,
  destroyContainerPreview,
  renderContainerFromSource,
  withLinkDefinitions
} from '../editor/markdown/containerBody'
import { updateSwiperSlideAttrs, type SwiperSlideChange } from '../editor/markdown/swiperSlides'
import {
  isBilibiliVideoSource,
  isNotesTableSource,
  isWordListSource,
  parseBilibiliVideoSource,
  parseNotesTableSource,
  parseWordListSource
} from '../editor/markdown/componentBody'
import {
  mountBilibiliVideoPreview,
  mountFootprintsPreview,
  mountMermaidPreview,
  mountMindmapPreview,
  mountNotesTablePreview,
  mountWordListPreview,
  type MindmapPreviewProps
} from '../editor/markdown/componentPreview'
import { parseFencedCode, rebuildMermaidFence } from '../editor/markdown/diagramRenderer'
import { mindmapPreviewMarkdown, rebuildMindmapFence } from '../editor/markdown/mindmapFence'
import { clampMindmapHeight, deskWordListStorageScope, parseFootprintsSource } from '@tnotesjs/ui'
import { installMarkdownMath } from '../agent/agentMarkdown'
import { livePreviewHost, type LivePreviewHost } from './host'
import {
  enhanceCardImages,
  keepFirstImagePerCell,
  numberMarkdownImages,
  type CardImageChange,
  type CardImageEditor
} from './cardImages'
import { imageAttrChange, imageDeleteChange, readImage, type ImageSyntax } from './images'
import { revealAt } from './widgets'

export type CardKind = 'container' | 'mermaid' | 'mindmap' | 'component' | 'html' | 'table'

function definitionKey(definitions: ReadonlyMap<string, string>): string {
  return [...definitions.entries()]
    .map(([label, url]) => `${label} ${url}`)
    .sort()
    .join('\n')
}

/** 用户在卡片里切换了代码组标签：记下来，露出源码时显示同一页。 */
export const setCodeGroupTab = StateEffect.define<{ pos: number; index: number }>({
  map: (value, mapping) => ({ pos: mapping.mapPos(value.pos), index: value.index })
})

/** 卡片高度缓存：让滚动到屏幕外的卡片有接近真实的估算高度，减少滚动跳动。 */
const measuredHeights = new Map<string, number>()

let inlineRenderer: InstanceType<typeof MarkdownIt> | null = null
function markdownRenderer(): InstanceType<typeof MarkdownIt> {
  if (!inlineRenderer) {
    inlineRenderer = new MarkdownIt({ html: true, linkify: true, breaks: false })
    installMarkdownMath(inlineRenderer)
    allowDataUrlsInParser(inlineRenderer)
    numberMarkdownImages(inlineRenderer)
  }
  return inlineRenderer
}

/** 卡片里这些元素有自己的交互，点它们不应该把光标移进源码。 */
const INTERACTIVE =
  'button, a, input, select, textarea, summary, video, iframe, [role="tab"], .tn-swiper-tabs, .tn-swiper-resize, .cm-lp-image-handle, .cm-lp-image-more, .swiper-button-prev, .swiper-button-next, .rightClickMenu'

interface Mounted {
  destroy(): void
  /** 思维导图自己写回围栏后换成新源码，保留同一个画布（选中、缩放、正在编辑的节点都不丢） */
  updateSource?(source: string): void
}

const mounted = new WeakMap<HTMLElement, Mounted>()

/**
 * details 折叠开合：会话内记忆（不写回笔记）。
 * key 去掉 `{w=… align=…}`，图片改宽/对齐后仍命中，避免卡片重建后自动收起。
 */
const detailsOpenSession = new Map<string, boolean>()

export function detailsSessionKey(noteUuid: string, source: string): string {
  const normalized = source.replace(/\r\n?/g, '\n')
  const nl = normalized.indexOf('\n')
  const head = nl < 0 ? normalized : normalized.slice(0, nl)
  // 去掉 `{w=… align=…}` 及其两侧空白，改图宽/对齐后 key 仍稳定
  const rest = (nl < 0 ? '' : normalized.slice(nl + 1))
    .replace(/\s*\{[^}\n]*\}/g, '')
    .replace(/[ \t]+\n/g, '\n')
  return `${noteUuid}\0${head}\0${rest}`
}

/** 单测用：清空会话折叠记忆 */
export function clearDetailsOpenSession(): void {
  detailsOpenSession.clear()
}

export function rewriteResolvedImages(
  root: ParentNode,
  resolveImage: (src: string) => string
): void {
  root.querySelectorAll('img').forEach((image) => {
    const resolved = resolveImage(image.getAttribute('src') ?? '')
    if (resolved) image.setAttribute('src', resolved)
    else image.removeAttribute('src')
    // 与容器卡片一致：markdown-it 不会吃掉 ` {w=…}`，表格/HTML 卡片要在 DOM 里剥掉并套宽度
    applyImageSizeAttrs(image)
  })
}

/** 表格卡片图片的改动：宽度 / 对齐写回 `{w=… align=…}`，或删掉整张图。 */
export type TableImageChange = CardImageChange

/** Desk 可视化里表格单元格图片的拖拽宽度 + 「⋯」菜单。 */
export type TableImageEditor = CardImageEditor

/** `:::` 提示块（info / tip / warning / danger / details …）正文图片的改动，同表格。 */
export type ContainerImageChange = CardImageChange

export function renderTable(
  source: string,
  resolveImage: (src: string) => string,
  definitions: ReadonlyMap<string, string> = new Map(),
  editor?: TableImageEditor
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cm-lp-table-card tn-prose'
  // 表格卡片单独渲染，需拼上笔记级 LinkReference，否则 `[文字][1]` 无 href
  // DOMPurify（happy-dom / 部分环境）会剥掉 <table> 只留 thead/tbody，
  // 再赋给 innerHTML 时浏览器会丢掉单元格；包回 <table> 保住 td/th，「一格一图」才认得出格。
  const rendered = markdownRenderer().render(withLinkDefinitions(source, definitions))
  const cleaned = DOMPurify.sanitize(rendered)
  const html =
    !/<table\b/i.test(cleaned) && /<(?:thead|tbody|tr)\b/i.test(cleaned)
      ? `<table>${cleaned}</table>`
      : cleaned
  wrapper.innerHTML = html
  rewriteResolvedImages(wrapper, resolveImage)
  // 一格一图（同思维导图节点）：每格只留第一张可用 markdown 图，其余直接不渲染（只读也一样）
  keepFirstImagePerCell(wrapper)
  if (editor)
    enhanceCardImages(wrapper, editor, 'cm-lp-table-image', { firstPassablePerCell: true })
  return wrapper
}

function renderHtml(source: string, resolveImage: (src: string) => string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cm-lp-html-card tn-prose'
  wrapper.innerHTML = DOMPurify.sanitize(source)
  rewriteResolvedImages(wrapper, resolveImage)
  return wrapper
}

function mountComponent(
  host: HTMLElement,
  source: string,
  knowledgeBaseId: string,
  noteUuid: string
): Mounted | null {
  if (isBilibiliVideoSource(source)) {
    const parsed = parseBilibiliVideoSource(source)
    const handle = mountBilibiliVideoPreview(host, {
      id: parsed?.id ?? '',
      autoplay: parsed?.autoplay,
      muted: parsed?.muted
    })
    return { destroy: () => handle.unmount() }
  }
  if (isWordListSource(source)) {
    const parsed = parseWordListSource(source)
    const handle = mountWordListPreview(host, {
      words: parsed?.words ?? [],
      needSort: parsed?.needSort,
      // 勾选态按「知识库 + 笔记」隔离：Desk 所有笔记共用一个 index.html，pathname 不区分笔记
      storageScope: deskWordListStorageScope(knowledgeBaseId, noteUuid)
    })
    return { destroy: () => handle.unmount() }
  }
  if (isNotesTableSource(source)) {
    const ids = parseNotesTableSource(source)?.ids ?? []
    const handle = mountNotesTablePreview(host, {
      notes: [],
      missingIds: [],
      error: ids.length ? null : '错误: ids 数组不能为空'
    })
    const notesApi = window.desk?.notes
    if (ids.length && knowledgeBaseId && notesApi) {
      void notesApi
        .resolveTable({ knowledgeBaseId, ids })
        .then((result) => {
          if (!result.ok) {
            handle.update({ notes: [], missingIds: [], error: result.error.message })
            return
          }
          handle.update({
            notes: result.value.notes.map((row) => ({
              id: row.id,
              title: row.title,
              description: row.description,
              url: row.noteUuid ? `desk-note://${encodeURIComponent(row.noteUuid)}` : '#'
            })),
            missingIds: result.value.missingIds,
            error: null
          })
        })
        .catch((cause: unknown) => {
          handle.update({
            notes: [],
            missingIds: [],
            error: cause instanceof Error ? cause.message : String(cause)
          })
        })
    }
    return { destroy: () => handle.unmount() }
  }
  return null
}

/** 由组件源码判断是不是 desk 认识的 Vue 组件（其它 HTML 块按普通 HTML 渲染）。 */
export function isKnownComponent(source: string): boolean {
  return isBilibiliVideoSource(source) || isWordListSource(source) || isNotesTableSource(source)
}

export class CardWidget extends WidgetType {
  constructor(
    readonly kind: CardKind,
    readonly source: string,
    /** 点击卡片后光标落在源码里的哪个位置（相对卡片起点） */
    private readonly revealOffset: number,
    private readonly knowledgeBaseId: string,
    /** 围栏外的链接定义。容器、导图和表格单独渲染，源码没变时定义变了也要重画。 */
    private readonly definitions: ReadonlyMap<string, string> = new Map(),
    /** 当前笔记；WordList 勾选态按「知识库 + 笔记」存，换笔记要重画。 */
    private readonly noteUuid: string = ''
  ) {
    super()
  }

  eq(other: CardWidget): boolean {
    return (
      other.kind === this.kind &&
      other.source === this.source &&
      other.knowledgeBaseId === this.knowledgeBaseId &&
      other.noteUuid === this.noteUuid &&
      definitionKey(other.definitions) === definitionKey(this.definitions)
    )
  }

  get estimatedHeight(): number {
    return measuredHeights.get(`${this.kind}:${this.source}`) ?? -1
  }

  toDOM(view: EditorView): HTMLElement {
    const host = view.state.facet(livePreviewHost)
    const card = document.createElement('div')
    card.className = `cm-lp-card cm-lp-card-${this.kind}`
    const body = this.renderBody(card, host, view)
    if (body) card.append(body)
    card.addEventListener('mousedown', (event) => {
      // 思维导图在卡片里直接编辑，点它不进源码；要看源码用导图自己的「源码」视图。
      if (this.kind === 'mindmap') return
      const target = event.target as HTMLElement | null
      if (target?.closest(INTERACTIVE)) return
      event.preventDefault()
      let pos: number
      try {
        pos = view.posAtDOM(card)
      } catch {
        return
      }
      if (this.kind === 'container') {
        const panels = [...card.querySelectorAll<HTMLElement>('.tn-code-group__panel')]
        const active = panels.findIndex((panel) => !panel.hidden)
        if (active >= 0) {
          view.dispatch({ effects: setCodeGroupTab.of({ pos, index: active }) })
        }
      }
      revealAt(view, Math.min(view.state.doc.length, pos + this.revealOffset))
    })
    requestAnimationFrame(() => {
      const height = card.getBoundingClientRect().height
      if (height > 0) measuredHeights.set(`${this.kind}:${this.source}`, height)
    })
    return card
  }

  private renderBody(
    card: HTMLElement,
    host: LivePreviewHost,
    view: EditorView
  ): HTMLElement | null {
    const resolveImage = host.resolveImage.bind(host)
    switch (this.kind) {
      case 'container': {
        const detailsKey = detailsSessionKey(this.noteUuid, this.source)
        const element = renderContainerFromSource(
          this.source,
          resolveImage,
          this.definitions,
          {
            readOnly: host.isReadOnly(),
            commit: (index, next) => commitSwiperSlide(view, card, index, next)
          },
          {
            readOnly: host.isReadOnly(),
            commit: (index, next, expectedSrc) =>
              commitContainerImage(view, card, index, next, expectedSrc)
          },
          {
            open: detailsOpenSession.get(detailsKey) ?? false,
            onOpenChange: (open) => {
              detailsOpenSession.set(detailsKey, open)
            }
          }
        )
        if (element.dataset.footprints === '1') {
          const payload = parseFootprintsSource(this.source)
          const handle = mountFootprintsPreview(element, {
            ...payload,
            images: payload.images.map((src) => resolveImage(src)).filter(Boolean)
          })
          mounted.set(card, {
            destroy: () => {
              handle.unmount()
              destroyContainerPreview(element)
            }
          })
        } else {
          mounted.set(card, { destroy: () => destroyContainerPreview(element) })
        }
        return element
      }
      case 'mermaid': {
        const hostEl = document.createElement('div')
        hostEl.className = 'cm-lp-diagram'
        const fence = parseFencedCode(this.source)
        const handle = mountMermaidPreview(hostEl, {
          source: fence.code,
          center: fence.center,
          // 居中按图片排版对待：点「居中 / 取消居中」写回围栏信息行（`mermaid center` / `mermaid`）
          onCenterChange: (center: boolean) => writeMermaidCenter(view, card, center)
        })
        mounted.set(card, { destroy: () => handle.unmount() })
        return hostEl
      }
      case 'mindmap':
        return renderMindmapCard(card, this.source, host, view, this.definitions)
      case 'component': {
        const hostEl = document.createElement('div')
        hostEl.className = 'cm-lp-component'
        const handle = mountComponent(hostEl, this.source, this.knowledgeBaseId, this.noteUuid)
        if (handle) mounted.set(card, handle)
        return hostEl
      }
      case 'html':
        return renderHtml(this.source, resolveImage)
      case 'table':
        return renderTable(this.source, resolveImage, this.definitions, {
          readOnly: host.isReadOnly(),
          commit: (index, next, expectedSrc) =>
            commitTableImage(view, card, index, next, expectedSrc)
        })
    }
  }

  updateDOM(dom: HTMLElement): boolean {
    const entry = mounted.get(dom)
    if (this.kind !== 'mindmap' || !entry?.updateSource) return false
    entry.updateSource(this.source)
    return true
  }

  destroy(dom: HTMLElement): void {
    mounted.get(dom)?.destroy()
    mounted.delete(dom)
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'dragstart'
  }
}

function commitSwiperSlide(
  view: EditorView,
  card: HTMLElement,
  index: number,
  next: SwiperSlideChange
): void {
  const host = view.state.facet(livePreviewHost)
  if (host.isReadOnly()) return
  let pos: number
  try {
    pos = view.posAtDOM(card)
  } catch {
    return
  }
  const start = syntaxTree(view.state).resolveInner(pos, 1)
  let node: typeof start | null = start
  while (node && node.name !== 'Container') node = node.parent
  if (!node) return
  const from = view.state.doc.lineAt(node.from).from
  const to = node.to
  const current = view.state.doc.sliceString(from, to)
  const updated = updateSwiperSlideAttrs(current, index, next)
  if (updated === current) return
  view.dispatch({
    changes: { from, to, insert: updated },
    userEvent: 'input.swiper'
  })
}

/** `pos` 所在表格里第 `index` 个 Image 语法节点（与 markdown-it 的图片编号同序）。 */
function tableImageAt(state: EditorState, pos: number, index: number): ImageSyntax | null {
  let table: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1)
  while (table && table.name !== 'Table') table = table.parent
  if (!table) return null
  let seen = -1
  let found: ImageSyntax | null = null
  syntaxTree(state).iterate({
    from: table.from,
    to: table.to,
    enter(node) {
      if (found) return false
      if (node.name !== 'Image') return
      seen += 1
      if (seen === index) found = readImage(state, node.node)
      return false
    }
  })
  return found
}

/**
 * 表格卡片第 `index` 张 markdown 图片的写回修改；对不上（找不到 / 地址核对失败 / 无变化）返回 null。
 * `pos` 是卡片在文档里的起点（表格首行）。
 */
export function tableImageChange(
  state: EditorState,
  pos: number,
  index: number,
  next: TableImageChange,
  expectedSrc = ''
): { from: number; to: number; insert: string } | null {
  const image = tableImageAt(state, pos, index)
  if (!image) return null
  // 引用式 `![a][id]` 读不到行内地址，跳过核对；行内地址按 markdown-it 同样归一化后比较
  if (expectedSrc && image.src && markdownRenderer().normalizeLink(image.src) !== expectedSrc) {
    return null
  }
  const changes =
    'remove' in next
      ? imageDeleteChange(state, image, { wholeLine: false })
      : imageAttrChange(image, next)
  if (state.doc.sliceString(changes.from, changes.to) === changes.insert) return null
  return changes
}

function commitTableImage(
  view: EditorView,
  card: HTMLElement,
  index: number,
  next: TableImageChange,
  expectedSrc = ''
): void {
  const host = view.state.facet(livePreviewHost)
  if (host.isReadOnly() || view.state.readOnly) return
  let pos: number
  try {
    pos = view.posAtDOM(card)
  } catch {
    return
  }
  const changes = tableImageChange(view.state, pos, index, next, expectedSrc)
  if (!changes) return
  view.dispatch({
    changes,
    userEvent: 'remove' in next ? 'delete.image' : 'input.image-attrs'
  })
}

/**
 * `:::` 提示块正文第 `index` 张 markdown 图片的写回修改；对不上返回 null。`pos` 是卡片起点（开启行）。
 *
 * 容器在语法树里是叶子（正文不做行内解析），这里把 ContainerBody 单独按 GFM 解析一遍找 Image 节点。
 * 卡片渲染用的 markdown-it 同样没装容器插件，嵌套 `:::` 两边都当普通段落，图片编号一致。
 */
export function containerImageChange(
  state: EditorState,
  pos: number,
  index: number,
  next: ContainerImageChange,
  expectedSrc = ''
): { from: number; to: number; insert: string } | null {
  let container: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1)
  while (container && container.name !== 'Container') container = container.parent
  const body = container?.getChild('ContainerBody')
  if (!body) return null
  const text = state.doc.sliceString(body.from, body.to)
  const bodyState = EditorState.create({ doc: text })
  let seen = -1
  let image: ImageSyntax | null = null
  markdownLanguage.parser.parse(text).iterate({
    enter(node) {
      if (image) return false
      if (node.name !== 'Image') return
      seen += 1
      if (seen === index) image = readImage(bodyState, node.node)
      return false
    }
  })
  const found = image as ImageSyntax | null
  if (!found) return null
  if (expectedSrc && found.src && markdownRenderer().normalizeLink(found.src) !== expectedSrc) {
    return null
  }
  // 独占一行的图删掉整行；和文字同段 / 在表格里只删图本身（imageDeleteChange 自己判断）
  const local =
    'remove' in next ? imageDeleteChange(bodyState, found) : imageAttrChange(found, next)
  if (bodyState.doc.sliceString(local.from, local.to) === local.insert) return null
  return { from: body.from + local.from, to: body.from + local.to, insert: local.insert }
}

function commitContainerImage(
  view: EditorView,
  card: HTMLElement,
  index: number,
  next: ContainerImageChange,
  expectedSrc = ''
): void {
  const host = view.state.facet(livePreviewHost)
  if (host.isReadOnly() || view.state.readOnly) return
  let pos: number
  try {
    pos = view.posAtDOM(card)
  } catch {
    return
  }
  const changes = containerImageChange(view.state, pos, index, next, expectedSrc)
  if (!changes) return
  view.dispatch({
    changes,
    userEvent: 'remove' in next ? 'delete.image' : 'input.image-attrs'
  })
}

/** 卡片所在的这段围栏（```mindmap / ```mermaid）在文档里的当前位置（卡片从行首起，到闭合围栏为止）。 */
function fencedCodeAt(view: EditorView, card: HTMLElement): { from: number; to: number } | null {
  let pos: number
  try {
    pos = view.posAtDOM(card)
  } catch {
    return null
  }
  const { doc } = view.state
  let found: { from: number; to: number } | null = null
  syntaxTree(view.state).iterate({
    from: pos,
    to: Math.min(doc.length, pos + 1),
    enter(node) {
      if (found) return false
      if (node.name !== 'FencedCode') return
      found = { from: doc.lineAt(node.from).from, to: node.to }
      return false
    }
  })
  return found
}

/** Mermaid 卡片的「居中 / 取消居中」：把 `center` 关键字写回文档里的围栏信息行。 */
function writeMermaidCenter(view: EditorView, card: HTMLElement, center: boolean): void {
  if (view.state.facet(livePreviewHost).isReadOnly()) return
  const range = fencedCodeAt(view, card)
  if (!range) return
  const current = view.state.doc.sliceString(range.from, range.to)
  if (parseFencedCode(current).center === center) return
  const next = rebuildMermaidFence(current, center).replace(/\n$/, '')
  if (next === current) return
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
    userEvent: 'input.mermaid'
  })
}

function renderMindmapCard(
  card: HTMLElement,
  initialSource: string,
  host: LivePreviewHost,
  view: EditorView,
  definitions: ReadonlyMap<string, string>
): HTMLElement {
  let source = initialSource
  const readOnly = host.isReadOnly()
  const wrap = document.createElement('div')
  wrap.className = 'cm-lp-mindmap-wrap'
  const hostEl = document.createElement('div')
  hostEl.className = 'cm-lp-diagram cm-lp-mindmap'

  const writeFence = (build: (fence: string) => string): void => {
    if (host.isReadOnly()) return
    const range = fencedCodeAt(view, card)
    if (!range) return
    const current = view.state.doc.sliceString(range.from, range.to)
    const next = build(current).replace(/\n$/, '')
    if (next === current) return
    source = next
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: next },
      userEvent: 'input.mindmap'
    })
  }

  const propsFor = (fence: string, height?: number): MindmapPreviewProps => {
    const preview = mindmapPreviewMarkdown(fence)
    return {
      // 围栏原文直接交给导图；`[文字][id]` 由导图按笔记里的定义解析，写回时保留引用写法
      source: preview.markdown,
      linkDefinitions: definitions,
      initialExpandLevel: preview.initialExpandLevel,
      height: height ?? preview.height,
      editable: !readOnly,
      expandLevelControl: true,
      resolveImageSrc: host.resolveImage.bind(host),
      writeAsset: readOnly ? undefined : (blob: Blob) => host.writeAsset(blob),
      onMarkdownChange: (markdown: string) =>
        writeFence((fence) => rebuildMindmapFence(fence, { markdown })),
      onExpandLevelChange: (level: number) =>
        writeFence((fence) => rebuildMindmapFence(fence, { initialExpandLevel: level }))
    }
  }

  const handle = mountMindmapPreview(hostEl, propsFor(source))
  wrap.append(hostEl)

  if (!readOnly) {
    const grip = document.createElement('div')
    grip.className = 'cm-lp-mindmap-resize'
    grip.title = '拖动调整高度'
    grip.setAttribute('aria-hidden', 'true')
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const pane = hostEl.querySelector<HTMLElement>('.mindmap-pane')
      const startHeight = pane?.offsetHeight || 440
      // 编辑区可能带 CSS 缩放：拖动距离按屏幕像素算，换回布局像素
      const scale = pane ? pane.getBoundingClientRect().height / Math.max(1, startHeight) : 1
      const startY = event.clientY
      let height = startHeight
      grip.setPointerCapture(event.pointerId)
      card.classList.add('is-resizing')
      const onMove = (move: PointerEvent): void => {
        height = clampMindmapHeight(startHeight + (move.clientY - startY) / (scale || 1))
        handle.update(propsFor(source, height))
        view.requestMeasure()
      }
      const onUp = (): void => {
        grip.removeEventListener('pointermove', onMove)
        grip.removeEventListener('pointerup', onUp)
        grip.removeEventListener('pointercancel', onUp)
        card.classList.remove('is-resizing')
        if (height !== startHeight) {
          writeFence((fence) => rebuildMindmapFence(fence, { height }))
        }
      }
      grip.addEventListener('pointermove', onMove)
      grip.addEventListener('pointerup', onUp)
      grip.addEventListener('pointercancel', onUp)
    })
    wrap.append(grip)
  }

  mounted.set(card, {
    destroy: () => handle.unmount(),
    updateSource: (next) => {
      source = next
      handle.update(propsFor(next))
    }
  })
  return wrap
}
