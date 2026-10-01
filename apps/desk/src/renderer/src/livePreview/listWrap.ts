import { foldedRanges, syntaxTree } from '@codemirror/language'
import { countColumn, type EditorState, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'

import { livePreviewEnabled } from './host'
import { isListItemFolded, listItemFoldRange, ListFoldToggle } from './listFold'

import type { SyntaxNode } from '@lezer/common'

const OPAQUE = new Set([
  'FencedCode',
  'CodeBlock',
  'Table',
  'HTMLBlock',
  'CommentBlock',
  'Frontmatter'
])

export interface ListLineIndent {
  /** 行首空白占的列数（制表符按 tabSize 展开）。源码视图里续行从这一列开始。 */
  indent: number
  /** 行首空白的字符数 */
  leading: number
  /** 各级父列表项标记所在的列，源码视图用来画缩进参考线。 */
  guides: number[]
  /** 所属列表项的层级，顶层是 0。可视化视图按它缩进。 */
  depth: number
  /** 这一行是不是列表项的首行（带标记） */
  marker: boolean
}

/** 列表里的一行（首行或续段），不在代码块、表格等整块里。 */
export function listLineIndent(state: EditorState, lineFrom: number): ListLineIndent | null {
  const doc = state.doc
  const line = doc.lineAt(lineFrom)
  if (!line.text.trim()) return null
  const leading = /^[ \t]*/.exec(line.text)?.[0] ?? ''
  const indent = countColumn(leading, state.tabSize)

  let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from + leading.length, 1)
  const items: SyntaxNode[] = []
  for (; node; node = node.parent) {
    if (OPAQUE.has(node.name)) return null
    if (node.name === 'ListItem') items.push(node)
  }
  if (items.length === 0) return null

  let marker = false
  const guides: number[] = []
  for (const item of items) {
    const mark = item.getChild('ListMark')
    if (!mark) continue
    const markLine = doc.lineAt(mark.from)
    if (markLine.from === line.from) {
      if (item === items[0]) marker = true
      continue
    }
    const column = countColumn(markLine.text.slice(0, mark.from - markLine.from), state.tabSize)
    if (column < indent) guides.push(column)
  }
  guides.sort((a, b) => a - b)
  return {
    indent,
    leading: leading.length,
    guides: [...new Set(guides)],
    depth: items.length - 1,
    marker
  }
}

/** 源码视图：续行对齐到行首缩进（和 VSCode 的 wrappingIndent: same 一样），父级标记列上画参考线。 */
function sourceLineDecoration({ indent, guides }: ListLineIndent): Decoration | null {
  if (indent === 0 && guides.length === 0) return null
  const style = [
    `--lp-indent:${indent}`,
    ...guideStyle(guides.map((column) => `calc(${column} * var(--lp-space-w, 0.6em))`))
  ]
  return Decoration.line({ class: 'cm-lp-list-indent', attributes: { style: style.join(';') } })
}

const GUIDE_LAYER = 'linear-gradient(var(--lp-guide-color), var(--lp-guide-color))'

/** 竖向参考线：每个位置画一条 1px 宽、整行高的线（行连起来就是一条贯通的线）。 */
function guideStyle(positions: string[]): string[] {
  if (positions.length === 0) return []
  return [
    `background-image:${positions.map(() => GUIDE_LAYER).join(',')}`,
    `background-position:${positions.map((x) => `${x} 0`).join(',')}`,
    `background-size:${positions.map(() => '1px 100%').join(',')}`,
    'background-repeat:no-repeat'
  ]
}

/** 可视化：参考线落在每一级父项圆点的中心；续段还要加上所属项自己那一级。 */
function visualGuidePositions({ depth, marker }: ListLineIndent): string[] {
  const levels = marker ? depth : depth + 1
  return Array.from(
    { length: levels },
    (_, level) =>
      `calc(var(--lp-list-base, 0px) + ${level} * var(--lp-step) + var(--lp-bullet-center))`
  )
}

const hiddenIndent = Decoration.replace({})

function buildDecorations(view: EditorView): DecorationSet {
  const state = view.state
  const visual = state.facet(livePreviewEnabled)
  const ranges: Range<Decoration>[] = []
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos)
      const info = listLineIndent(state, line.from)
      if (info && !visual) {
        const decoration = sourceLineDecoration(info)
        if (decoration) ranges.push(decoration.range(line.from))
      } else if (info) {
        // 可视化：层级缩进固定（对齐语雀），不跟源码里写了几个空格走；行首空白藏起来。
        ranges.push(
          Decoration.line({
            class: info.marker ? 'cm-lp-li' : 'cm-lp-li cm-lp-li-cont',
            attributes: {
              style: [`--lp-depth:${info.depth}`, ...guideStyle(visualGuidePositions(info))].join(
                ';'
              )
            }
          }).range(line.from)
        )
        if (info.leading > 0) ranges.push(hiddenIndent.range(line.from, line.from + info.leading))
        if (info.marker) {
          const fold = listItemFoldRange(state, line.from)
          if (fold) {
            ranges.push(
              Decoration.widget({
                widget: new ListFoldToggle(isListItemFolded(state, fold)),
                side: -1
              }).range(line.from + info.leading)
            )
          }
        }
      }
      if (line.to >= state.doc.length) break
      pos = line.to + 1
    }
  }
  return Decoration.set(ranges, true)
}

/** 源码字体里一个空格的宽度。行首空白按列数乘它，就是续行要让出的距离。 */
function spaceWidth(view: EditorView): number | null {
  const line = view.contentDOM.querySelector<HTMLElement>('.cm-line')
  const style = getComputedStyle(line ?? view.contentDOM)
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return null
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const width = context.measureText('    ').width / 4
  const spacing = Number.parseFloat(style.letterSpacing)
  return width + (Number.isFinite(spacing) ? spacing : 0)
}

/**
 * 列表的缩进与折叠。
 * - 可视化：按层级固定缩进，续行对齐正文，标记左侧有折叠三角。
 * - 源码：续行保留行首缩进，画出父级缩进参考线。
 */
export const listWrapIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private width = ''

    constructor(private readonly view: EditorView) {
      this.decorations = buildDecorations(view)
      this.measure()
      void document.fonts?.ready.then(() => this.measure())
    }

    update(update: ViewUpdate): void {
      const modeChanged =
        update.startState.facet(livePreviewEnabled) !== update.state.facet(livePreviewEnabled)
      if (
        update.docChanged ||
        update.viewportChanged ||
        modeChanged ||
        foldedRanges(update.startState) !== foldedRanges(update.state) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view)
      }
      if (update.geometryChanged || modeChanged) this.measure()
    }

    private measure(): void {
      this.view.requestMeasure({
        key: this,
        read: (view) => spaceWidth(view),
        write: (width) => {
          if (width == null || width <= 0) return
          const next = `${width.toFixed(3)}px`
          if (next === this.width) return
          this.width = next
          this.view.dom.style.setProperty('--lp-space-w', next)
        }
      })
    }
  },
  { decorations: (plugin) => plugin.decorations }
)
