import { EditorView, WidgetType } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import katex from 'katex'

import { writeClipboardText } from '../clipboardText'
import { applyFenceLanguage, applyFenceTitle } from '../editor/markdown/fenceInfo'
import { CHEVRON_DOWN_ICON, COLLAPSE_ICON, COPY_ICON, EXPAND_ICON } from '../markdown/copyIcons'
import { toggleCodeCollapse, toggleCodeFullscreen } from './codeBlockChrome'
import {
  cachedCanvasSource,
  canvasAssetRevision,
  probeCanvasSource,
  subscribeCanvasPreview
} from '../editor/excalidraw/canvasImage'
import { subscribeExcalidrawSession } from '../editor/excalidraw/sessionRegistry'
import { resolveNoteAssetRelPath } from '../markdown/noteAssetPath'
import { imageBefore, imageAttrChange } from './images'
import { livePreviewHost } from './host'

import type { ImageAlign } from '@tnotesjs/ui/image-markdown'

/** 组件内事件发生时，按组件在文档里的**当前**位置找回源码（组件可能被复用、坐标会变）。 */
function widgetPos(view: EditorView, dom: HTMLElement): number | null {
  try {
    return view.posAtDOM(dom)
  } catch {
    return null
  }
}

/**
 * 勾选框是替换掉 `[ ]` 的组件，点击坐标经常落在这段语法的前面或后面。
 * 在附近找唯一的任务标记，找不到就不改。
 */
export function taskToggleChange(
  content: string,
  pos: number
): { from: number; to: number; insert: string } | null {
  const start = Math.max(0, pos - 8)
  const slice = content.slice(start, Math.min(content.length, pos + 8))
  const match = /\[( |x|X)\]/.exec(slice)
  if (!match || match.index == null) return null
  const from = start + match.index + 1
  return { from, to: from + 1, insert: match[1] === ' ' ? 'x' : ' ' }
}

/** 点击组件后把光标放进它的源码里（露出源码）。 */
export function revealAt(view: EditorView, pos: number): void {
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: false, userEvent: 'select.pointer' })
  view.focus()
}

export class BulletWidget extends WidgetType {
  constructor(private readonly depth: number) {
    super()
  }

  eq(other: BulletWidget): boolean {
    return other.depth === this.depth
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-lp-bullet'
    span.textContent = ['•', '◦', '▪'][this.depth % 3]
    return span
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super()
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-task'
    box.checked = this.checked
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const pos = widgetPos(view, box)
      if (pos == null || view.state.readOnly) return
      const change = taskToggleChange(view.state.doc.toString(), pos)
      if (!change) return
      view.dispatch({ changes: change, userEvent: 'input.toggle-task' })
    })
    return box
  }

  ignoreEvent(): boolean {
    return true
  }
}

export class HorizontalRuleWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const hr = document.createElement('span')
    hr.className = 'cm-lp-hr'
    return hr
  }
}

/** 隐藏代码块结束围栏时用的空占位（保持行存在，光标仍能落上去）。 */
export class EmptyWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-lp-empty'
    return span
  }
}

/** 标题或语言输入写回围栏后，新画出来的输入框把焦点接回去。 */
let restoreCodeField: 'title' | 'lang' | null = null

function fenceTitleRange(lineFrom: number, opening: string): { from: number; to: number } {
  const end = opening.lastIndexOf(']')
  const start = opening.lastIndexOf('[')
  if (start < 0 || end < start) return { from: lineFrom + opening.length, to: lineFrom + opening.length }
  return { from: lineFrom + start + 1, to: lineFrom + end }
}

function fenceLanguageRange(lineFrom: number, opening: string): { from: number; to: number } {
  const match = /^( {0,3}(?:`{3,}|~{3,}))([ \t]*)(\S+)?/.exec(opening)
  const token = match?.[3] ?? ''
  if (!token || token.startsWith('[') || token.startsWith('{')) {
    const at = lineFrom + (match?.[1].length ?? 3)
    return { from: at, to: at }
  }
  const from = lineFrom + opening.indexOf(token)
  return { from, to: from + token.length }
}

export class CodeFenceHeaderWidget extends WidgetType {
  constructor(
    private readonly lang: string,
    private readonly title: string,
    private readonly code: string,
    private readonly openFrom: number,
    private readonly collapsed: boolean,
    private readonly fullscreen: boolean,
    private readonly showFold = true
  ) {
    super()
  }

  eq(other: CodeFenceHeaderWidget): boolean {
    return (
      other.lang === this.lang &&
      other.title === this.title &&
      other.code === this.code &&
      other.openFrom === this.openFrom &&
      other.collapsed === this.collapsed &&
      other.fullscreen === this.fullscreen &&
      other.showFold === this.showFold
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const header = document.createElement('span')
    header.className = 'cm-lp-code-header'
    if (this.showFold) {
      const fold = iconButton(this.collapsed ? '展开代码' : '折叠代码', CHEVRON_DOWN_ICON, 'cm-lp-code-fold')
      if (this.collapsed) fold.classList.add('is-collapsed')
      fold.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const line = view.state.doc.lineAt(this.openFrom)
        view.dispatch({
          effects: toggleCodeCollapse.of(line.from),
          selection: { anchor: line.to },
          userEvent: 'select.code-clamp'
        })
      })
      header.append(fold)
    }

    const title = document.createElement('input')
    title.type = 'text'
    title.className = 'cm-lp-code-title'
    title.placeholder = '代码块名称'
    title.spellcheck = false
    title.value = this.title
    const commitTitle = (): void => {
      const line = view.state.doc.lineAt(this.openFrom)
      const next = applyFenceTitle(line.text, title.value)
      if (next === line.text) {
        if (document.activeElement === title) return
        const range = fenceTitleRange(line.from, line.text)
        view.dispatch({ selection: EditorSelection.range(range.from, range.to) })
        return
      }
      restoreCodeField = 'title'
      const range = fenceTitleRange(line.from, next)
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: next },
        selection: EditorSelection.range(range.from, range.to)
      })
    }
    title.addEventListener('input', commitTitle)

    const lang = document.createElement('input')
    lang.type = 'text'
    lang.className = 'cm-lp-code-lang-input'
    lang.placeholder = 'text'
    lang.spellcheck = false
    lang.value = this.lang
    const commitLang = (): void => {
      const line = view.state.doc.lineAt(this.openFrom)
      const next = applyFenceLanguage(line.text, lang.value)
      const span = fenceLanguageRange(line.from, next === line.text ? line.text : next)
      if (next === line.text) {
        if (document.activeElement === lang) return
        view.dispatch({ selection: EditorSelection.range(span.from, span.to) })
        return
      }
      restoreCodeField = 'lang'
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: next },
        selection: EditorSelection.range(span.from, span.to)
      })
    }
    lang.addEventListener('input', commitLang)

    const copy = iconButton('复制', COPY_ICON, 'cm-lp-code-copy')
    copy.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void writeClipboardText(this.code).then((ok) => {
        copy.title = ok ? '已复制' : '复制失败'
        window.setTimeout(() => (copy.title = '复制'), 1200)
      })
    })

    const fullscreen = iconButton(this.fullscreen ? '退出全屏' : '全屏代码', this.fullscreen ? COLLAPSE_ICON : EXPAND_ICON, 'cm-lp-code-expand')
    fullscreen.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const line = view.state.doc.lineAt(this.openFrom)
      view.dispatch({ effects: toggleCodeFullscreen.of(line.from) })
    })

    header.append(title, lang, copy, fullscreen)
    if (restoreCodeField) {
      const which = restoreCodeField
      restoreCodeField = null
      queueMicrotask(() => {
        const input = which === 'title' ? title : lang
        input.focus()
        const pos = input.value.length
        input.setSelectionRange(pos, pos)
      })
    }
    return header
  }

  ignoreEvent(): boolean {
    return true
  }
}

function iconButton(label: string, svg: string, className: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.title = label
  button.setAttribute('aria-label', label)
  button.innerHTML = svg
  return button
}

function renderMath(source: string, displayMode: boolean): string {
  try {
    return katex.renderToString(source, { throwOnError: false, displayMode, output: 'html' })
  } catch {
    return ''
  }
}

export class MathWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly displayMode: boolean
  ) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.source === this.source && other.displayMode === this.displayMode
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement(this.displayMode ? 'div' : 'span')
    host.className = this.displayMode ? 'cm-lp-math cm-lp-math-block' : 'cm-lp-math'
    const html = renderMath(this.source, this.displayMode)
    if (html) host.innerHTML = html
    else host.textContent = this.source
    host.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const pos = widgetPos(view, host)
      if (pos != null) revealAt(view, pos + (this.displayMode ? 2 : 1))
    })
    return host
  }

  ignoreEvent(): boolean {
    return true
  }
}

const MIN_IMAGE_WIDTH = 48

const imageCanvasTeardown = new WeakMap<HTMLElement, () => void>()

function canvasSvgRelPath(noteRelPath: string, src: string): string {
  if (!src || src.startsWith('data:') || /^[a-z][a-z\d+.-]*:/i.test(src)) return ''
  if (!src.split(/[?#]/, 1)[0]?.toLowerCase().endsWith('.svg')) return ''
  if (!noteRelPath) return ''
  return resolveNoteAssetRelPath(noteRelPath, src) ?? ''
}

export class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
    private readonly width: string,
    private readonly align: ImageAlign,
    /** 源码已露出时，组件只做预览，点击不再移动光标 */
    private readonly revealed: boolean
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.align === this.align &&
      other.revealed === this.revealed
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const host = view.state.facet(livePreviewHost)
    const figure = document.createElement('span')
    figure.className = `cm-lp-image is-${this.align}${this.revealed ? ' is-revealed' : ''}`
    const frame = document.createElement('span')
    frame.className = 'cm-lp-image-frame'
    const img = document.createElement('img')
    img.src = host.resolveImage(this.src)
    img.alt = this.alt
    img.draggable = false
    if (this.width) frame.style.width = this.width
    frame.append(img)

    const handle = document.createElement('span')
    handle.className = 'cm-lp-image-handle'
    handle.title = '拖动调整宽度'
    frame.append(handle)

    const toolbar = document.createElement('span')
    toolbar.className = 'cm-lp-image-toolbar'
    const aligns: Array<[ImageAlign, string]> = [
      ['left', '左'],
      ['center', '中'],
      ['right', '右']
    ]
    for (const [align, label] of aligns) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.title = `${label}对齐`
      if (align === this.align) button.classList.add('is-active')
      button.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.applyAttrs(view, figure, { align })
      })
      toolbar.append(button)
    }
    const reset = document.createElement('button')
    reset.type = 'button'
    reset.textContent = '原始大小'
    reset.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.applyAttrs(view, figure, { width: '' })
    })
    toolbar.append(reset)

    const edit = document.createElement('button')
    edit.type = 'button'
    edit.textContent = '编辑'
    edit.title = '在标签页里编辑画布'
    edit.hidden = true
    edit.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const sourceRelPath = edit.dataset.sourceRelPath
      if (sourceRelPath) host.openCanvas(sourceRelPath)
    })
    toolbar.append(edit)

    const editingBadge = document.createElement('span')
    editingBadge.className = 'cm-lp-image-editing'
    editingBadge.textContent = '编辑中'
    editingBadge.hidden = true
    frame.append(toolbar, editingBadge)

    if (this.alt) {
      const caption = document.createElement('span')
      caption.className = 'cm-lp-image-caption'
      caption.textContent = this.alt
      figure.append(frame, caption)
    } else {
      figure.append(frame)
    }

    const teardowns: Array<() => void> = []
    let canvasPreview = ''
    let canvasOpen = false
    let sourceRelPath: string | null = null

    const applyImageSrc = (): void => {
      const presentationUrl = host.resolveImage(this.src)
      const live = canvasPreview
      const withRevision =
        !live && presentationUrl && sourceRelPath
          ? `${presentationUrl}${presentationUrl.includes('?') ? '&' : '?'}rev=${canvasAssetRevision(host.knowledgeBaseId, sourceRelPath)}`
          : presentationUrl
      const next = live || withRevision
      if (next) img.src = next
      else img.removeAttribute('src')
    }

    const attachCanvas = (source: string): void => {
      for (const off of teardowns.splice(0)) off()
      sourceRelPath = source
      figure.classList.add('is-canvas')
      edit.dataset.sourceRelPath = source
      edit.hidden = host.isReadOnly()
      teardowns.push(
        subscribeExcalidrawSession(host.knowledgeBaseId, source, (open) => {
          canvasOpen = open
          editingBadge.hidden = !open
          figure.classList.toggle('is-canvas-editing', open)
          applyImageSrc()
        }),
        subscribeCanvasPreview(host.knowledgeBaseId, source, (dataUrl) => {
          canvasPreview = dataUrl
          applyImageSrc()
        })
      )
      applyImageSrc()
    }

    const svgRelPath = canvasSvgRelPath(host.noteRelPath, this.src)
    if (svgRelPath && host.knowledgeBaseId) {
      const cached = cachedCanvasSource(host.knowledgeBaseId, svgRelPath)
      if (cached) {
        attachCanvas(cached)
      } else if (cached === undefined) {
        void probeCanvasSource(host.knowledgeBaseId, svgRelPath).then((source) => {
          if (!source || !figure.isConnected) return
          attachCanvas(source)
        })
      }
    }

    imageCanvasTeardown.set(figure, () => {
      for (const off of teardowns.splice(0)) off()
      void canvasOpen
    })

    handle.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (view.state.readOnly) return
      const startX = event.clientX
      const startWidth = frame.getBoundingClientRect().width
      const maxWidth = Math.max(MIN_IMAGE_WIDTH, view.contentDOM.getBoundingClientRect().width)
      const zoom = startWidth / Math.max(1, frame.offsetWidth)
      let width = startWidth
      const move = (moveEvent: MouseEvent): void => {
        width = Math.min(maxWidth, Math.max(MIN_IMAGE_WIDTH, startWidth + moveEvent.clientX - startX))
        frame.style.width = `${Math.round(width / zoom)}px`
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        this.applyAttrs(view, figure, { width: `${Math.round(width / zoom)}px` })
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })

    figure.addEventListener('mousedown', (event) => {
      if (this.revealed) return
      const target = event.target as HTMLElement | null
      if (target?.closest('button')) return
      event.preventDefault()
      const pos = widgetPos(view, figure)
      if (pos != null) revealAt(view, pos + 2)
    })
    return figure
  }

  destroy(dom: HTMLElement): void {
    imageCanvasTeardown.get(dom)?.()
    imageCanvasTeardown.delete(dom)
  }

  private applyAttrs(view: EditorView, dom: HTMLElement, next: { width?: string; align?: ImageAlign }): void {
    if (view.state.readOnly) return
    const pos = widgetPos(view, dom)
    if (pos == null) return
    const image = imageBefore(view.state, pos)
    if (!image) return
    view.dispatch({ changes: imageAttrChange(image, next), userEvent: 'input.image-attrs' })
  }

  ignoreEvent(): boolean {
    return true
  }
}

interface FrontmatterEntry {
  key: string
  value: string
}

function frontmatterEntries(body: string): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = []
  for (const line of body.split('\n')) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line)
    if (match) entries.push({ key: match[1], value: match[2] })
  }
  return entries
}

export class FrontmatterWidget extends WidgetType {
  constructor(private readonly body: string) {
    super()
  }

  eq(other: FrontmatterWidget): boolean {
    return other.body === this.body
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-lp-frontmatter'
    const title = document.createElement('span')
    title.className = 'cm-lp-frontmatter-title'
    const entries = frontmatterEntries(this.body)
    title.textContent = `属性 · ${entries.length} 项`
    box.append(title)
    for (const entry of entries.slice(0, 6)) {
      const row = document.createElement('span')
      row.className = entry.key === 'id' ? 'cm-lp-frontmatter-row is-locked' : 'cm-lp-frontmatter-row'
      const key = document.createElement('span')
      key.className = 'cm-lp-frontmatter-key'
      key.textContent = entry.key
      const value = document.createElement('span')
      value.textContent = entry.value
      row.append(key, value)
      box.append(row)
    }
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const pos = widgetPos(view, box)
      if (pos != null) revealAt(view, pos + 4)
    })
    return box
  }

  ignoreEvent(): boolean {
    return true
  }
}
