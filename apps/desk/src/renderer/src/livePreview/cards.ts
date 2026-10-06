import { syntaxTree } from '@codemirror/language'
import { StateEffect } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

import {
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
  }
  return inlineRenderer
}

/** 卡片里这些元素有自己的交互，点它们不应该把光标移进源码。 */
const INTERACTIVE =
  'button, a, input, select, textarea, summary, video, iframe, [role="tab"], .tn-swiper-tabs, .tn-swiper-resize, .tn-swiper-image-toolbar, .swiper-button-prev, .swiper-button-next, .rightClickMenu'

interface Mounted {
  destroy(): void
  /** 思维导图自己写回围栏后换成新源码，保留同一个画布（选中、缩放、正在编辑的节点都不丢） */
  updateSource?(source: string): void
}

const mounted = new WeakMap<HTMLElement, Mounted>()

function renderTable(
  source: string,
  resolveImage: (src: string) => string,
  definitions: ReadonlyMap<string, string> = new Map()
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cm-lp-table-card tn-prose'
  // 表格卡片单独渲染，需拼上笔记级 LinkReference，否则 `[文字][1]` 无 href
  const html = DOMPurify.sanitize(
    markdownRenderer().render(withLinkDefinitions(source, definitions))
  )
  wrapper.innerHTML = html
  wrapper.querySelectorAll('img').forEach((image) => {
    const resolved = resolveImage(image.getAttribute('src') ?? '')
    if (resolved) image.setAttribute('src', resolved)
    else image.removeAttribute('src')
  })
  return wrapper
}

function renderHtml(source: string, resolveImage: (src: string) => string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cm-lp-html-card tn-prose'
  wrapper.innerHTML = DOMPurify.sanitize(source)
  wrapper.querySelectorAll('img').forEach((image) => {
    const resolved = resolveImage(image.getAttribute('src') ?? '')
    if (resolved) image.setAttribute('src', resolved)
  })
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
        const element = renderContainerFromSource(this.source, resolveImage, this.definitions, {
          readOnly: host.isReadOnly(),
          commit: (index, next) => commitSwiperSlide(view, card, index, next)
        })
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
        return renderTable(this.source, resolveImage, this.definitions)
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
