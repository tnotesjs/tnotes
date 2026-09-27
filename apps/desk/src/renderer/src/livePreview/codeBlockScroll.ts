import { EditorView, ViewPlugin, WidgetType, type ViewUpdate } from '@codemirror/view'

import { codeLineGutterWidth } from './codeLines'

let nextScrollUid = 0

/** 不换行代码块底部的那一条横向滚动条。每一行自己的滚动条被样式藏掉，由这里带动。 */
export class CodeHScrollWidget extends WidgetType {
  get estimatedHeight(): number {
    return 0
  }

  constructor(private readonly blockKey: number) {
    super()
  }

  eq(other: CodeHScrollWidget): boolean {
    return other.blockKey === this.blockKey
  }

  toDOM(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'cm-lp-code-hscroll is-idle'
    bar.dataset.codeScroll = String(this.blockKey)
    bar.dataset.scrollUid = String(++nextScrollUid)
    bar.setAttribute('aria-hidden', 'true')
    const inner = document.createElement('div')
    inner.className = 'cm-lp-code-hscroll-inner'
    // 行宽规则放在组件里：CodeMirror 会把行元素上不属于装饰的属性（包括 style）改回去，组件内部它不管。
    const rule = document.createElement('style')
    rule.className = 'cm-lp-code-hscroll-rule'
    bar.append(inner, rule)
    return bar
  }

  ignoreEvent(): boolean {
    return true
  }
}

/**
 * 把滚轮换成这一块的横向位移。
 * Shift + 纵向滚轮在能滚动的行上会被浏览器改成 deltaX；空行没有溢出，滚轮仍是 deltaY，这里同样当成横向。
 */
export function codeBlockWheelDelta(event: WheelEvent): number {
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? 400
        : 1
  if (event.shiftKey) return (event.deltaX !== 0 ? event.deltaX : event.deltaY) * unit
  if (event.deltaX !== 0 && Math.abs(event.deltaX) >= Math.abs(event.deltaY))
    return event.deltaX * unit
  return 0
}

function codeBlockScrollLeft(root: ParentNode, id: string): number {
  const bar = root.querySelector<HTMLElement>(
    `.cm-lp-code-hscroll[data-code-scroll="${CSS.escape(id)}"]`
  )
  return bar?.scrollLeft ?? 0
}

function codeBlockMaxScroll(root: ParentNode, id: string): number {
  let max = 0
  const selector = `[data-code-scroll="${CSS.escape(id)}"]`
  for (const node of root.querySelectorAll<HTMLElement>(selector)) {
    max = Math.max(max, node.scrollWidth - node.clientWidth)
  }
  return max
}

export function syncCodeBlockScroll(
  root: ParentNode,
  id: string,
  scrollLeft: number,
  source: EventTarget | null
): void {
  const selector = `[data-code-scroll="${CSS.escape(id)}"]`
  for (const node of root.querySelectorAll<HTMLElement>(selector)) {
    if (node !== source && node.scrollLeft !== scrollLeft) node.scrollLeft = scrollLeft
  }
}

/** 同一块里每一行的占位都撑到最长一行的宽度；按滚动条所在的编辑器限定，分屏的同一篇笔记互不影响。 */
export function codeBlockWidthRule(uid: string, id: string, width: number): string {
  const bar = `.cm-lp-code-hscroll[data-scroll-uid="${CSS.escape(uid)}"]`
  const line = `.cm-line[data-code-scroll="${CSS.escape(id)}"]`
  return `.cm-content:has(> ${bar}) > ${line}::after { width: ${width}px; }`
}

/** 按块内最长一行的溢出宽度撑开底部滚动条；没有溢出时收成 0 高。 */
export function layoutCodeBlockScroll(root: ParentNode): void {
  for (const bar of root.querySelectorAll<HTMLElement>('.cm-lp-code-hscroll')) {
    const id = bar.dataset.codeScroll
    const inner = bar.querySelector<HTMLElement>('.cm-lp-code-hscroll-inner')
    if (!id || !inner) continue
    const lines = [
      ...root.querySelectorAll<HTMLElement>(`.cm-line[data-code-scroll="${CSS.escape(id)}"]`)
    ]
    // 先去掉占位再量，否则最长一行变短后，旧的占位宽度会一直撑着。
    const rule = bar.querySelector<HTMLStyleElement>('style.cm-lp-code-hscroll-rule')
    if (rule?.textContent) rule.textContent = ''
    const widest = lines.reduce((value, line) => Math.max(value, line.scrollWidth), 0)
    if (rule) rule.textContent = codeBlockWidthRule(bar.dataset.scrollUid ?? '', id, widest)
    let overflow = 0
    for (const line of lines) {
      overflow = Math.max(overflow, line.scrollWidth - line.clientWidth)
    }
    const width = `${bar.clientWidth + Math.max(0, overflow)}px`
    if (inner.style.width !== width) inner.style.width = width
    bar.classList.toggle('is-idle', overflow <= 1)
  }
}

export const codeBlockScrollSync = ViewPlugin.fromClass(
  class {
    private syncing = false

    private readonly onScroll = (event: Event): void => {
      if (this.syncing) return
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const id = target.dataset.codeScroll
      if (!id) return
      this.apply(id, target.scrollLeft, target)
    }

    private revealPending = false

    private readonly onWheel = (event: WheelEvent): void => {
      if (this.syncing) return
      const delta = codeBlockWheelDelta(event)
      if (delta === 0) return
      const target = event.target
      const element =
        target instanceof Element ? target : target instanceof Node ? target.parentElement : null
      const line = element?.closest<HTMLElement>('.cm-line[data-code-scroll]')
      if (!line || !this.view.dom.contains(line)) return
      const id = line.dataset.codeScroll
      if (!id) return
      event.preventDefault()
      const next = Math.max(
        0,
        Math.min(
          codeBlockMaxScroll(this.view.dom, id),
          codeBlockScrollLeft(this.view.dom, id) + delta
        )
      )
      this.apply(id, next, null)
    }

    constructor(private readonly view: EditorView) {
      this.view.dom.addEventListener('scroll', this.onScroll, true)
      this.view.dom.addEventListener('wheel', this.onWheel, { capture: true, passive: false })
      this.schedule()
    }

    update(update: ViewUpdate): void {
      if (update.selectionSet) this.revealPending = true
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.selectionSet
      ) {
        this.schedule()
      }
    }

    destroy(): void {
      this.view.dom.removeEventListener('scroll', this.onScroll, true)
      this.view.dom.removeEventListener('wheel', this.onWheel, true)
    }

    private schedule(): void {
      const plugin = this
      this.view.requestMeasure({
        key: this,
        read(measureView) {
          const reveal = plugin.revealPending
          plugin.revealPending = false
          return {
            root: measureView.dom,
            scroll: reveal ? readCursorScroll(measureView) : null
          }
        },
        write(value) {
          if (value.root.isConnected) {
            layoutCodeBlockScroll(value.root)
            // 短行刚被补宽，按底部滚动条的位置再对齐一次，否则它们还停在 0。
            for (const bar of value.root.querySelectorAll<HTMLElement>('.cm-lp-code-hscroll')) {
              const id = bar.dataset.codeScroll
              if (id) plugin.apply(id, bar.scrollLeft, null)
            }
          }
          if (value.scroll) plugin.apply(value.scroll.id, value.scroll.left, null)
        }
      })
    }

    private apply(id: string, scrollLeft: number, source: EventTarget | null): void {
      this.syncing = true
      try {
        syncCodeBlockScroll(this.view.dom, id, scrollLeft, source)
      } finally {
        this.syncing = false
      }
    }
  }
)

/** 在测量阶段读光标位置。更新过程中读布局会让编辑器直接报错。 */
function readCursorScroll(view: EditorView): { id: string; left: number } | null {
  const head = view.state.selection.main.head
  const dom = view.domAtPos(head)
  const node = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement
  const line = node?.closest<HTMLElement>('.cm-line[data-code-scroll]')
  const id = line?.dataset.codeScroll
  if (!line || !id) return null
  const coords = view.coordsAtPos(head)
  if (!coords) return null
  const box = line.getBoundingClientRect()
  if (box.width < 8 || (coords.left === 0 && coords.right === 0 && coords.top === 0)) return null
  const leftEdge = box.left + codeLineGutterWidth(line)
  const rightEdge = box.right - 12
  let next = line.scrollLeft
  if (coords.left > rightEdge) next += coords.left - rightEdge + 16
  else if (coords.right < leftEdge) next -= leftEdge - coords.right + 16
  else return null
  return { id, left: Math.max(0, next) }
}
