import { EditorView, WidgetType } from '@codemirror/view'
import katex from 'katex'

import { writeClipboardText } from '../clipboardText'
import { imageAt, imageAttrChange } from './images'
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
      const marker = view.state.doc.sliceString(pos, pos + 3)
      if (!/^\[[ xX]\]$/.test(marker)) return
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' },
        userEvent: 'input.toggle-task'
      })
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

export class CodeFenceHeaderWidget extends WidgetType {
  constructor(
    private readonly lang: string,
    private readonly title: string,
    private readonly code: string
  ) {
    super()
  }

  eq(other: CodeFenceHeaderWidget): boolean {
    return other.lang === this.lang && other.title === this.title && other.code === this.code
  }

  toDOM(view: EditorView): HTMLElement {
    const header = document.createElement('span')
    header.className = 'cm-lp-code-header'
    const label = document.createElement('span')
    label.className = 'cm-lp-code-lang'
    label.textContent = this.title || this.lang || 'text'
    header.append(label)
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'cm-lp-code-copy'
    copy.textContent = '复制'
    copy.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void writeClipboardText(this.code).then((ok) => {
        copy.textContent = ok ? '已复制' : '复制失败'
        window.setTimeout(() => (copy.textContent = '复制'), 1200)
      })
    })
    header.append(copy)
    header.addEventListener('mousedown', (event) => {
      if (event.target === copy) return
      event.preventDefault()
      const pos = widgetPos(view, header)
      if (pos == null) return
      revealAt(view, view.state.doc.lineAt(pos).to)
    })
    return header
  }

  ignoreEvent(): boolean {
    return true
  }
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
    frame.append(toolbar)

    if (this.alt) {
      const caption = document.createElement('span')
      caption.className = 'cm-lp-image-caption'
      caption.textContent = this.alt
      figure.append(frame, caption)
    } else {
      figure.append(frame)
    }

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
      event.preventDefault()
      const pos = widgetPos(view, figure)
      if (pos != null) revealAt(view, pos + 2)
    })
    return figure
  }

  private applyAttrs(view: EditorView, dom: HTMLElement, next: { width?: string; align?: ImageAlign }): void {
    if (view.state.readOnly) return
    const pos = widgetPos(view, dom)
    if (pos == null) return
    // 源码露出时组件排在源码之后：往前找这张图的语法
    const image = imageAt(view.state, this.revealed ? Math.max(0, pos - 1) : pos + 1)
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
      row.className = 'cm-lp-frontmatter-row'
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
