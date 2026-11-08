import { foldedRanges, syntaxTree } from '@codemirror/language'
import { EditorSelection, type ChangeSpec, type EditorState } from '@codemirror/state'
import {
  EditorView,
  RectangleMarker,
  ViewPlugin,
  WidgetType,
  layer,
  type Command,
  type ViewUpdate
} from '@codemirror/view'

import { buildAlertHeading } from '../editor/markdown/containerBody'
import {
  calloutExpanded,
  calloutLayout,
  hasCalloutBody,
  isCalloutCollapsed,
  setCalloutExpanded,
  type CalloutBlock
} from './calloutLayout'
import { FOLD_CHEVRON_SVG } from './headingFold'
import { livePreviewEnabled } from './host'

function blockAtHeader(state: EditorState, pos: number): CalloutBlock | null {
  return (
    calloutLayout(state).blocks.find((block) => pos >= block.open.from && pos <= block.open.to) ??
    null
  )
}

function openLineText(block: CalloutBlock, name: string, title: string, indent: string): string {
  return `${indent}${block.colons} ${name}${title.trim() ? ` ${title.trim()}` : ''}`
}

/** 改类型或标题：只重写开启行 */
export function commitCalloutHeader(
  view: EditorView,
  block: CalloutBlock,
  next: { name?: string; title?: string }
): void {
  const line = view.state.doc.sliceString(block.open.from, block.open.to)
  const indent = /^\s*/.exec(line)?.[0] ?? ''
  const insert = openLineText(block, next.name ?? block.type, next.title ?? block.title, indent)
  if (insert === line) return
  view.dispatch({
    changes: { from: block.open.from, to: block.open.to, insert },
    userEvent: 'input.callout'
  })
}

/** 去掉开启行和结束行，正文原样留下 */
export function unwrapCallout(view: EditorView, block: CalloutBlock): void {
  const changes: ChangeSpec[] = []
  let cursor = block.open.from
  if (!hasCalloutBody(block)) {
    changes.push({ from: block.open.from, to: block.end })
  } else {
    changes.push({ from: block.open.from, to: block.bodyFrom })
    if (block.close) changes.push({ from: block.bodyTo, to: block.close.to })
    cursor = block.bodyFrom
  }
  const changeSet = view.state.changes(changes)
  view.dispatch({
    changes: changeSet,
    selection: EditorSelection.cursor(changeSet.mapPos(cursor, 1)),
    userEvent: 'delete.callout',
    scrollIntoView: true
  })
  view.focus()
}

function focusBody(view: EditorView, block: CalloutBlock): void {
  if (!hasCalloutBody(block)) {
    view.dispatch({
      changes: { from: block.open.to, insert: '\n' },
      selection: EditorSelection.cursor(block.open.to + 1),
      userEvent: 'input.callout'
    })
  } else {
    view.dispatch({
      effects: setCalloutExpanded.of({ pos: block.open.from, expanded: true }),
      selection: EditorSelection.cursor(view.state.doc.lineAt(block.bodyFrom).to),
      scrollIntoView: true,
      userEvent: 'select'
    })
  }
  view.focus()
}

/** 光标挪出这一块：优先放到块后一行，没有就放到块前一行末尾 */
function selectionOutside(state: EditorState, block: CalloutBlock): number | null {
  const doc = state.doc
  if (block.end < doc.length) return block.end + 1
  if (block.open.from > 0) return block.open.from - 1
  return null
}

function toggleDetails(view: EditorView, block: CalloutBlock): void {
  const state = view.state
  const collapsed = isCalloutCollapsed(state, block)
  if (collapsed) {
    view.dispatch({ effects: setCalloutExpanded.of({ pos: block.open.from, expanded: true }) })
    return
  }
  const inside = state.selection.ranges.some(
    (range) => range.to >= block.bodyFrom && range.from <= block.bodyTo
  )
  const outside = inside ? selectionOutside(state, block) : null
  if (inside && outside == null) return
  view.dispatch({
    effects: setCalloutExpanded.of({ pos: block.open.from, expanded: false }),
    selection: outside == null ? undefined : EditorSelection.cursor(outside)
  })
}

/** 开启行换成的标题栏：类型图标（点开换类型 / 取消容器）+ 可编辑标题，details 多一个开合箭头 */
export class CalloutHeaderWidget extends WidgetType {
  constructor(
    readonly type: string,
    readonly title: string,
    /** null：不可收起 */
    readonly collapsed: boolean | null,
    readonly readOnly: boolean
  ) {
    super()
  }

  eq(other: CalloutHeaderWidget): boolean {
    return (
      other.type === this.type &&
      other.title === this.title &&
      other.collapsed === this.collapsed &&
      other.readOnly === this.readOnly
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = `cm-lp-callout-header tn-alert-${this.type}`
    const current = (): CalloutBlock | null => {
      let pos: number
      try {
        pos = view.posAtDOM(wrap)
      } catch {
        return null
      }
      return blockAtHeader(view.state, pos)
    }
    if (this.collapsed != null) {
      const fold = document.createElement('button')
      fold.type = 'button'
      fold.className = `cm-lp-callout-fold${this.collapsed ? ' is-collapsed' : ''}`
      fold.setAttribute('aria-label', this.collapsed ? '展开' : '收起')
      fold.setAttribute('aria-expanded', String(!this.collapsed))
      fold.innerHTML = FOLD_CHEVRON_SVG
      fold.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
      })
      fold.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const block = current()
        if (block) toggleDetails(view, block)
      })
      wrap.append(fold)
    }
    wrap.append(
      buildAlertHeading(this.type, this.title, {
        readOnly: this.readOnly,
        commit: (next) => {
          const block = current()
          if (!block) return
          commitCalloutHeader(view, block, next)
          if (next.name) view.focus()
        },
        unwrap: () => {
          const block = current()
          if (block) unwrapCallout(view, block)
        },
        exit: () => {
          const block = current()
          if (block) focusBody(view, block)
        }
      })
    )
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

function foldSignature(state: EditorState): string {
  const parts: string[] = []
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    parts.push(`${from}:${to}`)
  })
  return parts.join(',')
}

/** 标题折叠把后面的高亮块收进不可见区间。色条若仍按行盒取坐标，会缩到标题行上。 */
function hiddenByFold(state: EditorState, pos: number): boolean {
  let hidden = false
  foldedRanges(state).between(pos, pos, (from, to) => {
    if (pos > from && pos < to) hidden = true
  })
  return hidden
}

/** 左侧色条：一块一条，跨过正文里的代码块、表格卡片等块级组件也不断开 */
export const calloutBars = layer({
  above: false,
  class: 'cm-lp-callout-bars',
  update: (update) =>
    update.docChanged ||
    update.geometryChanged ||
    update.viewportChanged ||
    update.selectionSet ||
    update.startState.field(calloutExpanded, false) !==
      update.state.field(calloutExpanded, false) ||
    foldSignature(update.startState) !== foldSignature(update.state),
  markers(view) {
    if (!view.state.facet(livePreviewEnabled)) return []
    const { blocks } = calloutLayout(view.state)
    if (blocks.length === 0) return []
    const scroller = view.scrollDOM.getBoundingClientRect()
    const content = view.contentDOM.getBoundingClientRect()
    const padding = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0
    const baseTop = scroller.top - view.scrollDOM.scrollTop
    const left = content.left + padding - (scroller.left - view.scrollDOM.scrollLeft)
    const { from, to } = view.viewport
    const markers: RectangleMarker[] = []
    for (const block of blocks) {
      if (block.end < from || block.open.from > to) continue
      if (hiddenByFold(view.state, block.open.from)) continue
      const last =
        hasCalloutBody(block) && !isCalloutCollapsed(view.state, block)
          ? block.bodyTo
          : block.open.from
      const top = view.lineBlockAt(block.open.from).top
      const bottom = view.lineBlockAt(last).bottom
      markers.push(
        new RectangleMarker(
          `cm-lp-callout-bar tn-alert-${block.type}`,
          left,
          top + view.documentTop - baseTop,
          null,
          Math.max(0, bottom - top)
        )
      )
    }
    return markers
  }
})

/**
 * 正文里的块级组件（表格卡片、代码横向滚动条…）不是行，拿不到行装饰；
 * 落在提示块正文里的就补一个类名，和正文一起缩进到色条右边。
 */
export const calloutWidgetInset = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.schedule()
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) this.schedule()
    }

    schedule(): void {
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          const enabled = view.state.facet(livePreviewEnabled)
          const { blocks } = calloutLayout(view.state)
          const marks: Array<[HTMLElement, boolean]> = []
          for (const child of Array.from(view.contentDOM.children)) {
            if (!(child instanceof HTMLElement) || child.classList.contains('cm-line')) continue
            let inside = false
            if (enabled && blocks.length > 0) {
              try {
                const pos = view.posAtDOM(child)
                inside = blocks.some(
                  (block) => hasCalloutBody(block) && pos >= block.bodyFrom && pos <= block.end
                )
              } catch {
                inside = false
              }
            }
            marks.push([child, inside])
          }
          return marks
        },
        write: (marks) => {
          for (const [element, inside] of marks)
            element.classList.toggle('cm-lp-callout-inset', inside)
        }
      })
    }
  }
)

function inFencedCode(state: EditorState, pos: number): boolean {
  for (
    let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(
      state
    ).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true
  }
  return false
}

function editable(view: EditorView): boolean {
  return view.state.facet(livePreviewEnabled) && !view.state.readOnly
}

/**
 * 退格：
 * - 正文第一行行首：去掉容器（正文是空的就整块删掉）。
 * - 容器后面一行行首：不把这一行接到看不见的 `:::` 后面；空行直接删掉，光标回到正文末尾。
 */
export const calloutBackspace: Command = (view) => {
  if (!editable(view)) return false
  const { state } = view
  const selection = state.selection.main
  if (!selection.empty) return false
  const head = selection.head
  for (const block of calloutLayout(state).blocks) {
    if (hasCalloutBody(block) && head === block.bodyFrom) {
      const body = state.doc.sliceString(block.bodyFrom, block.bodyTo)
      if (body.trim()) {
        unwrapCallout(view, block)
      } else {
        const to = block.end < state.doc.length ? block.end + 1 : block.end
        view.dispatch({
          changes: { from: block.open.from, to },
          selection: EditorSelection.cursor(block.open.from),
          userEvent: 'delete.callout'
        })
      }
      return true
    }
    if (block.close && head === block.close.to + 1) {
      const line = state.doc.lineAt(head)
      const target = hasCalloutBody(block) ? block.bodyTo : null
      if (!line.text.trim()) {
        view.dispatch({
          changes: { from: block.close.to, to: line.to },
          selection: target == null ? undefined : EditorSelection.cursor(target),
          effects:
            target == null
              ? undefined
              : setCalloutExpanded.of({ pos: block.open.from, expanded: true }),
          userEvent: 'delete.backward',
          scrollIntoView: true
        })
      } else if (target != null) {
        view.dispatch({
          selection: EditorSelection.cursor(target),
          effects: setCalloutExpanded.of({ pos: block.open.from, expanded: true }),
          userEvent: 'select',
          scrollIntoView: true
        })
      }
      return true
    }
  }
  return false
}

/** Delete：正文末尾不吞掉结束行，容器前一行末尾不吞掉开启行（空行例外：删掉这一空行） */
export const calloutDelete: Command = (view) => {
  if (!editable(view)) return false
  const { state } = view
  const selection = state.selection.main
  if (!selection.empty) return false
  const head = selection.head
  for (const block of calloutLayout(state).blocks) {
    if (block.close && hasCalloutBody(block) && head === block.bodyTo) return true
    if (block.open.from > 0 && head === block.open.from - 1) {
      const line = state.doc.lineAt(head)
      if (line.text.trim()) return true
      view.dispatch({
        changes: { from: line.from, to: block.open.from },
        selection: EditorSelection.cursor(Math.max(0, line.from - 1)),
        userEvent: 'delete.forward'
      })
      return true
    }
  }
  return false
}

function lineAfterBlock(
  state: EditorState,
  block: CalloutBlock
): { changes?: ChangeSpec; cursor: number } {
  const doc = state.doc
  if (block.end < doc.length) {
    const next = doc.lineAt(block.end + 1)
    if (!next.text.trim()) return { cursor: next.from }
  }
  return { changes: { from: block.end, insert: '\n' }, cursor: block.end }
}

/** 回车：正文最后一行是空行时（且不是唯一一行）离开容器，光标落到容器下面 */
export const calloutEnter: Command = (view) => {
  if (!editable(view)) return false
  const { state } = view
  const selection = state.selection.main
  if (!selection.empty) return false
  const head = selection.head
  const line = state.doc.lineAt(head)
  if (line.text.trim()) return false
  const block = calloutLayout(state).blocks.find(
    (item) =>
      item.close && hasCalloutBody(item) && line.to === item.bodyTo && line.from > item.bodyFrom
  )
  if (!block?.close || inFencedCode(state, line.from)) return false
  const after = lineAfterBlock(state, block)
  const changes: ChangeSpec[] = [{ from: line.from - 1, to: line.to }]
  if (after.changes) changes.push(after.changes)
  const changeSet = state.changes(changes)
  view.dispatch({
    changes: changeSet,
    selection: EditorSelection.cursor(
      after.changes ? changeSet.mapPos(block.end, 1) : changeSet.mapPos(after.cursor)
    ),
    scrollIntoView: true,
    userEvent: 'input.callout'
  })
  return true
}

/** 文档最后一块是提示块时，↓ / → 走出正文末尾就在后面补一行空行 */
function exitAtDocEnd(forward: 'down' | 'right'): Command {
  return (view) => {
    if (!editable(view)) return false
    const { state } = view
    const selection = state.selection.main
    if (!selection.empty) return false
    const doc = state.doc
    const block = calloutLayout(state).blocks.find((item) => item.close && item.end === doc.length)
    if (!block) return false
    const head = selection.head
    const collapsed = isCalloutCollapsed(state, block)
    const lastVisible =
      hasCalloutBody(block) && !collapsed
        ? block.bodyTo
        : block.open.from > 0
          ? block.open.from - 1
          : -1
    if (lastVisible < 0) return false
    const line = doc.lineAt(head)
    if (line.number !== doc.lineAt(lastVisible).number) return false
    if (forward === 'right' && head !== line.to) return false
    if (forward === 'down') {
      const moved = view.moveVertically(selection, true)
      if (moved.head !== head && doc.lineAt(moved.head).number === line.number) return false
    }
    view.dispatch({
      changes: { from: doc.length, insert: '\n' },
      selection: EditorSelection.cursor(doc.length + 1),
      scrollIntoView: true,
      userEvent: 'input.callout'
    })
    return true
  }
}

export const calloutArrowDown = exitAtDocEnd('down')
export const calloutArrowRight = exitAtDocEnd('right')

export const calloutExtension = [calloutExpanded, calloutBars, calloutWidgetInset]
