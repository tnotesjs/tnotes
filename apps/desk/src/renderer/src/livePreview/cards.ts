import { StateEffect } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

import {
  destroyContainerPreview,
  renderContainerFromSource
} from '../editor/markdown/containerBody'
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
  mountMermaidPreview,
  mountMindmapPreview,
  mountNotesTablePreview,
  mountWordListPreview
} from '../editor/markdown/componentPreview'
import { parseFencedCode } from '../editor/markdown/diagramRenderer'
import { mindmapPreviewMarkdown } from '../editor/markdown/mindmapFence'
import { livePreviewHost } from './host'
import { revealAt } from './widgets'

export type CardKind = 'container' | 'mermaid' | 'mindmap' | 'component' | 'html' | 'table'

/** 用户在卡片里切换了代码组标签：记下来，露出源码时显示同一页。 */
export const setCodeGroupTab = StateEffect.define<{ pos: number; index: number }>({
  map: (value, mapping) => ({ pos: mapping.mapPos(value.pos), index: value.index })
})

/** 卡片高度缓存：让滚动到屏幕外的卡片有接近真实的估算高度，减少滚动跳动。 */
const measuredHeights = new Map<string, number>()

let inlineRenderer: InstanceType<typeof MarkdownIt> | null = null
function markdownRenderer(): InstanceType<typeof MarkdownIt> {
  inlineRenderer ??= new MarkdownIt({ html: true, linkify: true, breaks: false })
  return inlineRenderer
}

/** 卡片里这些元素有自己的交互，点它们不应该把光标移进源码。 */
const INTERACTIVE = 'button, a, input, select, textarea, summary, video, iframe, [role="tab"], .tn-swiper-tabs, .swiper-button-prev, .swiper-button-next'

interface Mounted {
  destroy(): void
}

const mounted = new WeakMap<HTMLElement, Mounted>()

function renderTable(source: string, resolveImage: (src: string) => string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cm-lp-table-card tn-prose'
  const html = DOMPurify.sanitize(markdownRenderer().render(source))
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

function mountComponent(host: HTMLElement, source: string, knowledgeBaseId: string): Mounted | null {
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
      needSort: parsed?.needSort
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
    if (ids.length && knowledgeBaseId) {
      void window.desk.notes
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
    private readonly knowledgeBaseId: string
  ) {
    super()
  }

  eq(other: CardWidget): boolean {
    return other.kind === this.kind && other.source === this.source
  }

  get estimatedHeight(): number {
    return measuredHeights.get(`${this.kind}:${this.source}`) ?? -1
  }

  toDOM(view: EditorView): HTMLElement {
    const host = view.state.facet(livePreviewHost)
    const card = document.createElement('div')
    card.className = `cm-lp-card cm-lp-card-${this.kind}`
    const body = this.renderBody(card, host.resolveImage)
    if (body) card.append(body)
    card.addEventListener('mousedown', (event) => {
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

  private renderBody(card: HTMLElement, resolveImage: (src: string) => string): HTMLElement | null {
    switch (this.kind) {
      case 'container': {
        const element = renderContainerFromSource(this.source, resolveImage)
        mounted.set(card, { destroy: () => destroyContainerPreview(element) })
        return element
      }
      case 'mermaid': {
        const hostEl = document.createElement('div')
        hostEl.className = 'cm-lp-diagram'
        const fence = parseFencedCode(this.source)
        const handle = mountMermaidPreview(hostEl, { source: fence.code, center: fence.center })
        mounted.set(card, { destroy: () => handle.unmount() })
        return hostEl
      }
      case 'mindmap': {
        const hostEl = document.createElement('div')
        hostEl.className = 'cm-lp-diagram cm-lp-mindmap'
        const preview = mindmapPreviewMarkdown(this.source)
        const handle = mountMindmapPreview(hostEl, {
          source: preview.markdown,
          initialExpandLevel: preview.initialExpandLevel,
          editable: false,
          expandLevelControl: false,
          resolveImageSrc: resolveImage
        })
        mounted.set(card, { destroy: () => handle.unmount() })
        return hostEl
      }
      case 'component': {
        const hostEl = document.createElement('div')
        hostEl.className = 'cm-lp-component'
        const handle = mountComponent(hostEl, this.source, this.knowledgeBaseId)
        if (handle) mounted.set(card, handle)
        return hostEl
      }
      case 'html':
        return renderHtml(this.source, resolveImage)
      case 'table':
        return renderTable(this.source, resolveImage)
    }
  }

  destroy(dom: HTMLElement): void {
    mounted.get(dom)?.destroy()
    mounted.delete(dom)
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'dragstart'
  }
}
