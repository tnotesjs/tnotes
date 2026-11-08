import { syntaxTree } from '@codemirror/language'
import { StateEffect, StateField, type EditorState } from '@codemirror/state'

import type { Tree } from '@lezer/common'

export type CalloutType = 'tip' | 'quote' | 'warning' | 'danger' | 'details'

export interface LineSpan {
  from: number
  to: number
}

/** 一个原地编辑的提示块。行范围都是整行（含缩进）。 */
export interface CalloutBlock {
  type: CalloutType
  title: string
  /** 开启行的冒号串，例如 `:::` 或 `::::` */
  colons: string
  open: LineSpan
  /** 没闭合时到文档末尾都算正文（与 markdown-it-container 一致） */
  close: LineSpan | null
  /** 第一行正文行首；没有正文时为 -1 */
  bodyFrom: number
  /** 最后一行正文行尾；没有正文时为 -1 */
  bodyTo: number
  /** 整块结束（结束行行尾；没闭合时是最后一行正文行尾） */
  end: number
}

export interface CalloutLayout {
  blocks: CalloutBlock[]
  /** 容器里又写的 `:::` 容器：不嵌套渲染，露出源码 */
  nested: LineSpan[]
}

const OPEN_LINE = /^\s*(:{3,})[ \t]*(\S+)[ \t]*(.*)$/
const CLOSE_LINE = /^\s*(:{3,})[ \t]*$/

const cache = new WeakMap<Tree, CalloutLayout>()

/**
 * 顶层的 Callout 复合块（见 language.ts）。容器里再出现的开启行不嵌套，从它到冒号数够的
 * 结束行（或外层结尾）露出源码，与静态站一致。
 */
export function calloutLayout(state: EditorState): CalloutLayout {
  const tree = syntaxTree(state)
  const cached = cache.get(tree)
  if (cached) return cached
  const doc = state.doc
  const blocks: CalloutBlock[] = []
  const nested: LineSpan[] = []
  const cursor = tree.cursor()
  if (cursor.firstChild()) {
    do {
      if (cursor.name !== 'Callout') continue
      const node = cursor.node
      const openLine = doc.lineAt(node.from)
      const match = OPEN_LINE.exec(openLine.text)
      if (!match) continue
      const marks = node.getChildren('CalloutMark')
      const last = marks[marks.length - 1]
      const closeLine = last && last.from > openLine.to ? doc.lineAt(last.from) : null
      const close =
        closeLine && CLOSE_LINE.test(closeLine.text)
          ? { from: closeLine.from, to: closeLine.to }
          : null
      const lastNumber = close ? doc.lineAt(close.from).number - 1 : doc.lineAt(node.to).number
      const hasBody = lastNumber > openLine.number
      const bodyTo = hasBody ? doc.line(lastNumber).to : -1
      blocks.push({
        type: match[2].toLowerCase() as CalloutType,
        title: match[3].trim(),
        colons: match[1],
        open: { from: openLine.from, to: openLine.to },
        close,
        bodyFrom: hasBody ? doc.line(openLine.number + 1).from : -1,
        bodyTo,
        end: close ? close.to : Math.max(openLine.to, bodyTo)
      })
      let inner: { from: number; colons: number } | null = null
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'CalloutOpen' && !inner) {
          const line = doc.lineAt(child.from)
          inner = { from: line.from, colons: OPEN_LINE.exec(line.text)?.[1].length ?? 3 }
        } else if (child.name === 'CalloutClose' && inner) {
          const line = doc.lineAt(child.from)
          if ((CLOSE_LINE.exec(line.text)?.[1].length ?? 0) >= inner.colons) {
            nested.push({ from: inner.from, to: line.to })
            inner = null
          }
        }
      }
      if (inner) nested.push({ from: inner.from, to: hasBody ? bodyTo : openLine.to })
    } while (cursor.nextSibling())
  }
  const layout = { blocks, nested }
  cache.set(tree, layout)
  return layout
}

export function hasCalloutBody(block: CalloutBlock): boolean {
  return block.bodyFrom >= 0
}

/** pos 落在哪个提示块的正文里（开启行、结束行不算） */
export function calloutBodyAt(state: EditorState, pos: number): CalloutBlock | null {
  return (
    calloutLayout(state).blocks.find(
      (block) => hasCalloutBody(block) && pos >= block.bodyFrom && pos <= block.bodyTo
    ) ?? null
  )
}

/** 展开过的 details（键是开启行行首），默认收起 */
export const setCalloutExpanded = StateEffect.define<{ pos: number; expanded: boolean }>({
  map: (value, mapping) => ({ ...value, pos: mapping.mapPos(value.pos, 1) })
})

export const calloutExpanded = StateField.define<readonly number[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged ? value.map((pos) => tr.changes.mapPos(pos, 1)) : value
    for (const effect of tr.effects) {
      if (!effect.is(setCalloutExpanded)) continue
      const { pos, expanded } = effect.value
      next = next.filter((item) => item !== pos)
      if (expanded) next = [...next, pos]
    }
    return next
  }
})

/** details 收起时正文看不见；选区落进正文时自动展开 */
export function isCalloutCollapsed(state: EditorState, block: CalloutBlock): boolean {
  if (block.type !== 'details' || !hasCalloutBody(block)) return false
  if (state.field(calloutExpanded, false)?.includes(block.open.from)) return false
  return !state.selection.ranges.some(
    (range) => range.to >= block.bodyFrom && range.from <= block.bodyTo
  )
}

/**
 * 可视化里光标不能停的整行：开启行（换成标题栏）、结束行（高度为 0）、收起的正文。
 * 返回值是行首位置判断用的区间（左闭右闭）。
 */
export function calloutHiddenLines(state: EditorState): LineSpan[] {
  const spans: LineSpan[] = []
  for (const block of calloutLayout(state).blocks) {
    spans.push(block.open)
    if (isCalloutCollapsed(state, block)) spans.push({ from: block.bodyFrom, to: block.bodyTo })
    if (block.close) spans.push(block.close)
  }
  return spans
}
