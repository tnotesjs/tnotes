import { syntaxTree } from '@codemirror/language'
import { Facet, StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'

import { parseFenceTitleFromMeta } from '../editor/markdown/fenceInfo'
import { CardWidget, isKnownComponent, setCodeGroupTab, type CardKind } from './cards'
import { livePreviewEnabled } from './host'
import { readImage } from './images'
import {
  BulletWidget,
  CheckboxWidget,
  CodeFenceHeaderWidget,
  EmptyWidget,
  FrontmatterWidget,
  HorizontalRuleWidget,
  ImageWidget,
  MathWidget,
  revealAt
} from './widgets'

import type { SyntaxNode } from '@lezer/common'

/** 被块级组件替换掉的源码范围（整行），键盘上下移动时据此「走进」卡片。 */
export interface HiddenBlock {
  from: number
  to: number
}

interface LivePreviewState {
  decorations: DecorationSet
  blocks: HiddenBlock[]
}

const hidden = Decoration.replace({})

/** 编辑器是否有焦点：没有焦点时不露出任何源码（点到别处时文档是干净的渲染结果） */
export const setFocused = StateEffect.define<boolean>()
/** 鼠标拖选进行中：冻结露出范围，避免拖选经过的元素反复露出/隐藏导致排版跳动 */
const setPointerSelecting = StateEffect.define<boolean>()

interface InteractionState {
  focused: boolean
  pointerSelecting: boolean
}

const interactionField = StateField.define<InteractionState>({
  create: () => ({ focused: false, pointerSelecting: false }),
  update(value, tr) {
    let next = value
    for (const effect of tr.effects) {
      if (effect.is(setFocused)) next = { ...next, focused: effect.value }
      if (effect.is(setPointerSelecting)) next = { ...next, pointerSelecting: effect.value }
    }
    return next
  }
})

const pointerTracker = ViewPlugin.fromClass(
  class {
    private readonly onUp: () => void
    constructor(private readonly view: EditorView) {
      this.onUp = () => {
        window.removeEventListener('mouseup', this.onUp, true)
        if (this.view.state.field(interactionField).pointerSelecting) {
          this.view.dispatch({ effects: setPointerSelecting.of(false) })
        }
      }
    }

    start(): void {
      window.addEventListener('mouseup', this.onUp, true)
      this.view.dispatch({ effects: setPointerSelecting.of(true) })
    }

    destroy(): void {
      window.removeEventListener('mouseup', this.onUp, true)
    }
  },
  {
    eventHandlers: {
      mousedown(event) {
        if (event.button !== 0 || event.detail > 1) return
        // 按在正文文字上才冻结；点组件（图片、卡片）由组件自己处理
        const target = event.target as HTMLElement | null
        if (target?.closest('.cm-lp-card, .cm-lp-image, .cm-lp-math, .cm-lp-frontmatter, button, input')) return
        this.start()
      }
    }
  }
)

class BreakWidget extends WidgetType {
  constructor(private readonly block: boolean) {
    super()
  }

  eq(other: BreakWidget): boolean {
    return other.block === this.block
  }

  toDOM(): HTMLElement {
    if (!this.block) return document.createElement('br')
    const spacer = document.createElement('div')
    spacer.className = 'cm-lp-break'
    return spacer
  }
}

const BREAK_TAG = /^<br\s*\/?>$/i

/** 卡片里的组件（如笔记表格）需要知道当前知识库。 */
export const cardKnowledgeBase = Facet.define<string, string>({
  combine: (values) => values[values.length - 1] ?? ''
})

/** 代码组当前显示的是第几个标签页（键：容器起点，随编辑映射）。 */
export const codeGroupTabs = StateField.define<Map<number, number>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value
    if (tr.docChanged && value.size > 0) {
      next = new Map()
      for (const [pos, index] of value) next.set(tr.changes.mapPos(pos), index)
    }
    for (const effect of tr.effects) {
      if (!effect.is(setCodeGroupTab)) continue
      if (next === value) next = new Map(value)
      next.set(effect.value.pos, effect.value.index)
    }
    return next
  }
})

interface FencePanel {
  from: number
  to: number
  label: string
}

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/

/** 代码组正文里的每个围栏代码块（按行扫描，与 containerBody 的取法一致）。 */
function codeGroupPanels(state: EditorState, bodyFrom: number, bodyTo: number): FencePanel[] {
  const doc = state.doc
  const panels: FencePanel[] = []
  let line = doc.lineAt(bodyFrom)
  let open: { from: number; marker: string; label: string } | null = null
  for (;;) {
    const match = FENCE_LINE.exec(line.text)
    if (open) {
      if (match && match[1][0] === open.marker[0] && match[1].length >= open.marker.length && !match[2].trim()) {
        panels.push({ from: open.from, to: line.to, label: open.label })
        open = null
      }
    } else if (match) {
      const info = match[2].trim()
      const lang = info.split(/\s+/)[0] ?? ''
      const title = parseFenceTitleFromMeta(info.slice(lang.length).trim()) || /\[([^\]]+)\]/.exec(info)?.[1] || ''
      open = { from: line.from, marker: match[1], label: title || lang || `代码 ${panels.length + 1}` }
    }
    if (line.to >= bodyTo || line.number >= doc.lines) break
    line = doc.line(line.number + 1)
  }
  if (open) panels.push({ from: open.from, to: doc.lineAt(bodyTo).to, label: open.label })
  return panels
}

class CodeGroupTabsWidget extends WidgetType {
  constructor(
    private readonly labels: string[],
    private readonly active: number,
    private readonly containerFrom: number
  ) {
    super()
  }

  eq(other: CodeGroupTabsWidget): boolean {
    return other.active === this.active && other.labels.join('\n') === this.labels.join('\n')
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('span')
    bar.className = 'cm-lp-code-tabs'
    this.labels.forEach((label, index) => {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = index === this.active ? 'is-active' : ''
      tab.textContent = label
      tab.addEventListener('mousedown', (event) => {
        event.preventDefault()
        let pos: number
        try {
          pos = view.posAtDOM(bar)
        } catch {
          pos = this.containerFrom
        }
        const state = view.state
        const open = state.doc.lineAt(pos)
        const tree = syntaxTree(state)
        let container: SyntaxNode | null = tree.resolveInner(open.from, 1)
        while (container && container.name !== 'Container') container = container.parent
        const body = container?.getChild('ContainerBody')
        const panels = body ? codeGroupPanels(state, body.from, body.to) : []
        const panel = panels[index]
        view.dispatch({ effects: setCodeGroupTab.of({ pos: open.from, index }) })
        if (panel) {
          const firstCodeLine = state.doc.lineAt(panel.from).number + 1
          const target = firstCodeLine <= state.doc.lines ? state.doc.line(firstCodeLine).from : panel.from
          revealAt(view, Math.min(target, panel.to))
        }
      })
      bar.append(tab)
    })
    return bar
  }

  ignoreEvent(): boolean {
    return true
  }
}

function build(state: EditorState): LivePreviewState {
  if (!state.facet(livePreviewEnabled)) return { decorations: Decoration.none, blocks: [] }
  const doc = state.doc
  const ranges: Range<Decoration>[] = []
  const blocks: HiddenBlock[] = []
  const selection = state.field(interactionField, false)?.focused === false ? [] : state.selection.ranges
  const touches = (from: number, to: number): boolean =>
    selection.some((range) => range.from <= to && range.to >= from)
  const lineTouched = (pos: number): boolean => {
    const line = doc.lineAt(pos)
    return touches(line.from, line.to)
  }
  const hide = (from: number, to: number): void => {
    if (to > from) ranges.push(hidden.range(from, to))
  }
  const lineClass = (pos: number, className: string): void => {
    ranges.push(Decoration.line({ class: className }).range(doc.lineAt(pos).from))
  }
  const linesClass = (from: number, to: number, className: string): void => {
    const first = doc.lineAt(from).number
    const last = doc.lineAt(to).number
    for (let number = first; number <= last; number += 1) {
      ranges.push(Decoration.line({ class: className }).range(doc.line(number).from))
    }
  }
  /** 整行替换为组件；节点前面有列表/引用前缀时退回行内替换 */
  const replaceBlock = (from: number, to: number, widget: WidgetType): void => {
    const start = doc.lineAt(from)
    const end = doc.lineAt(to)
    const atLineStart = doc.sliceString(start.from, from).trim() === ''
    if (atLineStart) {
      ranges.push(Decoration.replace({ widget, block: true }).range(start.from, end.to))
      blocks.push({ from: start.from, to: end.to })
    } else {
      ranges.push(Decoration.replace({ widget }).range(from, to))
    }
  }
  const kbId = state.facet(cardKnowledgeBase)
  const card = (node: SyntaxNode, kind: CardKind, revealOffset: number): void => {
    const start = doc.lineAt(node.from)
    const source = doc.sliceString(start.from, node.to)
    replaceBlock(node.from, node.to, new CardWidget(kind, source, revealOffset, kbId))
  }
  const listDepth = (node: SyntaxNode): number => {
    let depth = -1
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.name === 'BulletList' || parent.name === 'OrderedList') depth += 1
    }
    return Math.max(0, depth)
  }

  syntaxTree(state).iterate({
    enter(ref) {
      const node = ref.node
      const { from, to } = ref
      const name = ref.name
      if (name.startsWith('ATXHeading')) {
        const level = Number(name.slice(-1))
        lineClass(from, `cm-lp-heading cm-lp-h${level}`)
        if (!lineTouched(from)) {
          const line = doc.lineAt(from)
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name !== 'HeaderMark') continue
            if (child.from <= from) {
              let end = child.to
              while (end < line.to && doc.sliceString(end, end + 1) === ' ') end += 1
              hide(line.from, end)
            } else {
              let start = child.from
              while (start > line.from && doc.sliceString(start - 1, start) === ' ') start -= 1
              hide(start, child.to)
            }
          }
        }
        return
      }
      switch (name) {
        case 'SetextHeading1':
        case 'SetextHeading2': {
          const level = name.endsWith('1') ? 1 : 2
          const mark = node.getChild('HeaderMark')
          const textEnd = mark ? doc.lineAt(mark.from).from - 1 : to
          linesClass(from, Math.max(from, textEnd), `cm-lp-heading cm-lp-h${level}`)
          if (mark && !touches(from, to)) hide(mark.from, mark.to)
          return
        }
        case 'Blockquote':
          linesClass(from, to, 'cm-lp-quote')
          return
        case 'QuoteMark': {
          if (lineTouched(from)) return
          const next = doc.sliceString(to, to + 1)
          hide(from, next === ' ' ? to + 1 : to)
          return
        }
        case 'ListMark': {
          const list = node.parent?.parent
          if (list?.name === 'BulletList') {
            if (!touches(from, to)) {
              ranges.push(Decoration.replace({ widget: new BulletWidget(listDepth(node)) }).range(from, to))
            }
          } else {
            ranges.push(Decoration.mark({ class: 'cm-lp-ol-mark' }).range(from, to))
          }
          return
        }
        case 'TaskMarker': {
          if (touches(from, to)) return
          const checked = /x/i.test(doc.sliceString(from + 1, from + 2))
          ranges.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(from, to))
          if (checked) {
            const line = doc.lineAt(to)
            if (line.to > to) ranges.push(Decoration.mark({ class: 'cm-lp-task-done' }).range(to, line.to))
          }
          return
        }
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough': {
          if (touches(from, to)) return
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name === 'EmphasisMark' || child.name === 'StrikethroughMark') {
              hide(child.from, child.to)
            }
          }
          return
        }
        case 'InlineCode': {
          const marks = node.getChildren('CodeMark')
          const open = marks[0]
          const close = marks[marks.length - 1]
          if (open && close && close.from > open.to) {
            ranges.push(Decoration.mark({ class: 'cm-lp-inline-code' }).range(open.to, close.from))
          }
          if (!touches(from, to)) for (const mark of marks) hide(mark.from, mark.to)
          return false
        }
        case 'Link': {
          const marks = node.getChildren('LinkMark')
          const url = node.getChild('URL')
          const href = url ? doc.sliceString(url.from, url.to) : ''
          const closeBracket = marks.find((mark) => doc.sliceString(mark.from, mark.to) === ']')
          const textFrom = from + 1
          const textTo = closeBracket ? closeBracket.from : to
          if (textTo > textFrom) {
            ranges.push(
              Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': href } }).range(textFrom, textTo)
            )
          }
          if (!touches(from, to)) {
            hide(from, textFrom)
            hide(textTo, to)
          }
          return
        }
        case 'Autolink': {
          const url = node.getChild('URL')
          if (url) {
            ranges.push(
              Decoration.mark({
                class: 'cm-lp-link',
                attributes: { 'data-href': doc.sliceString(url.from, url.to) }
              }).range(url.from, url.to)
            )
          }
          if (!touches(from, to)) {
            hide(from, from + 1)
            hide(to - 1, to)
          }
          return false
        }
        case 'URL': {
          const parent = node.parent?.name
          if (parent === 'Link' || parent === 'Image' || parent === 'Autolink') return
          ranges.push(
            Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': doc.sliceString(from, to) } }).range(
              from,
              to
            )
          )
          return
        }
        case 'Image': {
          const image = readImage(state, node)
          if (!image) return false
          if (!touches(image.from, image.attrTo)) {
            ranges.push(
              Decoration.replace({
                widget: new ImageWidget(image.src, image.alt, image.width, image.align, false)
              }).range(image.from, image.attrTo)
            )
          } else {
            ranges.push(
              Decoration.widget({
                widget: new ImageWidget(image.src, image.alt, image.width, image.align, true),
                side: 1
              }).range(image.attrTo)
            )
          }
          return false
        }
        case 'InlineMath': {
          if (touches(from, to)) return false
          const content = node.getChild('MathContent')
          const source = content ? doc.sliceString(content.from, content.to) : ''
          ranges.push(Decoration.replace({ widget: new MathWidget(source, false) }).range(from, to))
          return false
        }
        case 'BlockMath': {
          if (touches(from, to)) {
            linesClass(from, to, 'cm-lp-source-block')
            return false
          }
          const content = node.getChild('MathContent')
          const source = content ? doc.sliceString(content.from, content.to) : ''
          replaceBlock(from, to, new MathWidget(source, true))
          return false
        }
        case 'Escape':
          if (!touches(from, to)) hide(from, from + 1)
          return false
        case 'HorizontalRule':
          if (!lineTouched(from)) {
            ranges.push(Decoration.replace({ widget: new HorizontalRuleWidget() }).range(from, to))
          }
          return false
        case 'FencedCode': {
          const info = node.getChild('CodeInfo')
          const infoText = info ? doc.sliceString(info.from, info.to).trim() : ''
          const lang = infoText.split(/\s+/)[0]?.toLowerCase() ?? ''
          const openLine = doc.lineAt(from)
          const closeLine = doc.lineAt(to)
          if (lang === 'mermaid' || lang === 'mindmap') {
            if (!touches(from, to)) {
              card(node, lang, openLine.to - openLine.from + 1)
              return false
            }
            linesClass(from, to, 'cm-lp-codeblock')
            return false
          }
          for (let number = openLine.number; number <= closeLine.number; number += 1) {
            const className =
              number === openLine.number
                ? 'cm-lp-codeblock cm-lp-codeblock-first'
                : number === closeLine.number
                  ? 'cm-lp-codeblock cm-lp-codeblock-last'
                  : 'cm-lp-codeblock'
            ranges.push(Decoration.line({ class: className }).range(doc.line(number).from))
          }
          if (!touches(from, to)) {
            const meta = infoText.slice(lang.length).trim()
            const title = parseFenceTitleFromMeta(meta) || /\[([^\]]+)\]/.exec(meta)?.[1] || ''
            const codeText = node.getChild('CodeText')
            const code = codeText ? doc.sliceString(codeText.from, codeText.to) : ''
            ranges.push(
              Decoration.replace({ widget: new CodeFenceHeaderWidget(lang, title, code) }).range(
                Math.max(openLine.from, from),
                openLine.to
              )
            )
            const closeMarks = node.getChildren('CodeMark')
            const closing = closeMarks.length > 1 ? closeMarks[closeMarks.length - 1] : null
            if (closing && closeLine.number > openLine.number) {
              ranges.push(Decoration.replace({ widget: new EmptyWidget() }).range(closing.from, closing.to))
            }
          }
          return false
        }
        case 'Container': {
          const infoNode = node.getChild('ContainerInfo')
          const info = infoNode ? doc.sliceString(infoNode.from, infoNode.to).trim() : ''
          const containerName = info.split(/\s+/)[0]?.toLowerCase() ?? ''
          const openLine = doc.lineAt(from)
          const closeLine = doc.lineAt(to)
          if (!touches(from, to)) {
            card(node, 'container', openLine.to - openLine.from + 1)
            return false
          }
          const body = node.getChild('ContainerBody')
          if (containerName === 'code-group' && body) {
            const panels = codeGroupPanels(state, body.from, body.to)
            const head = state.selection.main.head
            let active = panels.findIndex((panel) => head >= panel.from && head <= panel.to)
            if (active < 0) active = state.field(codeGroupTabs).get(openLine.from) ?? 0
            active = Math.min(Math.max(0, active), Math.max(0, panels.length - 1))
            ranges.push(
              Decoration.replace({
                widget: new CodeGroupTabsWidget(
                  panels.map((panel) => panel.label),
                  active,
                  openLine.from
                )
              }).range(openLine.from, openLine.to)
            )
            panels.forEach((panel, index) => {
              if (index === active) {
                linesClass(panel.from, panel.to, 'cm-lp-codeblock')
                return
              }
              const start = doc.lineAt(panel.from)
              const end = doc.lineAt(panel.to)
              ranges.push(Decoration.replace({ block: true }).range(start.from, end.to))
            })
            if (closeLine.number > openLine.number) lineClass(closeLine.from, 'cm-lp-container-mark')
            return false
          }
          lineClass(openLine.from, `cm-lp-container-mark cm-lp-container-open cm-lp-callout-${containerName}`)
          if (body) linesClass(body.from, body.to, `cm-lp-container-body cm-lp-callout-${containerName}`)
          if (closeLine.number > openLine.number) {
            lineClass(closeLine.from, `cm-lp-container-mark cm-lp-container-close cm-lp-callout-${containerName}`)
          }
          return false
        }
        case 'Frontmatter': {
          if (touches(from, to)) {
            linesClass(from, to, 'cm-lp-source-block cm-lp-frontmatter-source')
            return false
          }
          const body = node.getChild('FrontmatterBody')
          replaceBlock(from, to, new FrontmatterWidget(body ? doc.sliceString(body.from, body.to) : ''))
          return false
        }
        case 'HTMLTag': {
          if (BREAK_TAG.test(doc.sliceString(from, to)) && !touches(from, to)) {
            ranges.push(Decoration.replace({ widget: new BreakWidget(false) }).range(from, to))
          }
          return false
        }
        case 'HTMLBlock': {
          const source = doc.sliceString(from, to)
          if (BREAK_TAG.test(source.trim())) {
            if (!lineTouched(from)) ranges.push(Decoration.replace({ widget: new BreakWidget(true) }).range(from, to))
            return false
          }
          if (touches(from, to)) {
            linesClass(from, to, 'cm-lp-source-block')
            return false
          }
          card(node, isKnownComponent(source) ? 'component' : 'html', 0)
          return false
        }
        case 'CommentBlock':
          linesClass(from, to, 'cm-lp-comment-block')
          return false
        case 'Table': {
          if (touches(from, to)) {
            linesClass(from, to, 'cm-lp-source-block cm-lp-table-source')
            return false
          }
          card(node, 'table', 2)
          return false
        }
        default:
          return
      }
    }
  })

  return { decorations: Decoration.set(ranges, true), blocks }
}

const livePreviewStateField = StateField.define<LivePreviewState>({
  create: (state) => build(state),
  update(value, tr) {
    const modeChanged = tr.startState.facet(livePreviewEnabled) !== tr.state.facet(livePreviewEnabled)
    const interactionChanged = tr.startState.field(interactionField) !== tr.state.field(interactionField)
    const frozen = tr.state.field(interactionField).pointerSelecting && !tr.docChanged && !interactionChanged
    if (frozen) return value
    if (
      tr.docChanged ||
      tr.selection ||
      modeChanged ||
      interactionChanged ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
      tr.effects.some((effect) => effect.is(setCodeGroupTab))
    ) {
      return build(tr.state)
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

/** 实时预览显示层（含焦点与拖选状态跟踪） */
export const livePreviewField: Extension = [
  interactionField,
  livePreviewStateField,
  pointerTracker,
  EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing))
]

/** 当前被组件整块替换掉的源码范围 */
export function hiddenBlocks(state: EditorState): HiddenBlock[] {
  return state.field(livePreviewStateField, false)?.blocks ?? []
}
