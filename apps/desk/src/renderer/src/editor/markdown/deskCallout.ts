/**
 * Callouts (tip / info / warning / danger).
 *
 * Source mapping:
 *   ::: tip {A}
 *   {B}
 *   :::
 * Title chrome edits A; inner ProseMirror blocks (including code_block) edit B.
 */

import { $nodeSchema, $remark } from '@milkdown/kit/utils'
import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model'

import { isVisualCalloutName, type VisualCalloutType } from './containerBody'

import type { MarkdownNode } from '@milkdown/kit/transformer'

export const DESK_CALLOUT_TYPES = ['tip', 'quote', 'warning', 'danger'] as const

const CALLOUT_START =
  /^<!--desk-callout:v1:(tip|info|warning|danger):([A-Za-z0-9+/]*={0,2}):([A-Za-z0-9+/]*={0,2})-->$/
const CALLOUT_END = '<!--/desk-callout:v1-->'
const CALLOUT_END_RE = /^<!--\/desk-callout:v1-->$/

export const DEFAULT_CALLOUT_TITLE: Record<VisualCalloutType, string> = {
  tip: 'TIP',
  info: 'INFO',
  warning: 'WARNING',
  danger: 'DANGER'
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function decodeBase64(value: string): string {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new TextDecoder().decode(bytes)
}

export interface ProjectedCalloutMarker {
  calloutType: VisualCalloutType
  title: string
  openColons: string
}

export function createDeskCalloutStartMarker(marker: ProjectedCalloutMarker): string {
  return `<!--desk-callout:v1:${marker.calloutType}:${encodeBase64(marker.title)}:${encodeBase64(marker.openColons)}-->`
}

export function readDeskCalloutStartMarker(value: string): ProjectedCalloutMarker | null {
  const match = value.trim().match(CALLOUT_START)
  if (!match) return null
  try {
    const calloutType = match[1] as VisualCalloutType
    if (!isVisualCalloutName(calloutType)) return null
    return {
      calloutType,
      title: decodeBase64(match[2] ?? ''),
      openColons: decodeBase64(match[3] ?? '') || ':::'
    }
  } catch {
    return null
  }
}

export function isDeskCalloutEndMarker(value: string): boolean {
  return CALLOUT_END_RE.test(value.trim())
}

/** Wraps already-projected inner markdown in callout start/end markers. */
export function wrapProjectedCalloutBody(
  marker: ProjectedCalloutMarker,
  innerProjected: string
): string {
  const start = createDeskCalloutStartMarker(marker)
  const body = innerProjected.replace(/^\n+|\n+$/g, '')
  // 结束标记前必须留一个空行：body 末行若是 <br /> 这类独立 HTML 标签，它会开一个
  // 「遇到空行才结束」的 HTML 块，把紧随其后的结束标记一起吞掉 —— 于是结束标记失效、
  // 高亮块把后面的块全吃进来，保存时那些块无人认领被静默丢弃（222 丢失的那个 bug）。
  return body ? `${start}\n\n${body}\n\n${CALLOUT_END}` : `${start}\n\n${CALLOUT_END}`
}

interface CalloutMarkdownNode extends MarkdownNode {
  type: string
  value?: string
  children?: CalloutMarkdownNode[]
  calloutType?: string
  title?: string
  openColons?: string
}

function htmlValue(node: CalloutMarkdownNode): string | null {
  if (node.type === 'html') return String(node.value ?? '')
  const only = node.type === 'paragraph' && node.children?.length === 1 ? node.children[0] : null
  if (only?.type === 'html') return String(only.value ?? '')
  return null
}

function wrapCalloutChildren(children: CalloutMarkdownNode[]): CalloutMarkdownNode[] {
  const output: CalloutMarkdownNode[] = []
  for (let index = 0; index < children.length; index += 1) {
    const start = readDeskCalloutStartMarker(htmlValue(children[index]) ?? '')
    if (!start) {
      const child = children[index]
      if (child.children) child.children = wrapCalloutChildren(child.children)
      output.push(child)
      continue
    }

    let depth = 1
    const inner: CalloutMarkdownNode[] = []
    for (index += 1; index < children.length; index += 1) {
      const value = htmlValue(children[index]) ?? ''
      if (readDeskCalloutStartMarker(value)) {
        depth += 1
        inner.push(children[index])
        continue
      }
      if (isDeskCalloutEndMarker(value)) {
        depth -= 1
        if (depth === 0) break
        inner.push(children[index])
        continue
      }
      inner.push(children[index])
    }

    output.push({
      type: 'deskCallout',
      calloutType: start.calloutType,
      title: start.title,
      openColons: start.openColons,
      children: wrapCalloutChildren(inner)
    })
  }
  return output
}

export function wrapDeskCallouts(tree: MarkdownNode): void {
  const node = tree as CalloutMarkdownNode
  if (!node.children) return
  node.children = wrapCalloutChildren(node.children)
}

function maxInnerColonFence(markdown: string): number {
  let max = 2
  let codeFence: { marker: '`' | '~'; length: number } | null = null
  for (const line of markdown.split('\n')) {
    if (codeFence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (close && close[1][0] === codeFence.marker && close[1].length >= codeFence.length) {
        codeFence = null
      }
      continue
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
      codeFence = { marker: open[1][0] as '`' | '~', length: open[1].length }
      continue
    }
    const colons = line.match(/^ {0,3}(:{3,})(?:[ \t]|[A-Za-z]|$)/)?.[1]
    if (colons) max = Math.max(max, colons.length)
  }
  return max
}

export function calloutFenceForInner(openColons: string, innerMarkdown: string): string {
  const needed = maxInnerColonFence(innerMarkdown) + 1
  const current = /^:{3,}$/.test(openColons) ? openColons.length : 3
  return ':'.repeat(Math.max(needed, current, 3))
}

export function serializeCalloutMarkdown(options: {
  calloutType: string
  title: string
  openColons: string
  inner: string
}): string {
  const inner = options.inner.replace(/^\n+|\n+$/g, '')
  const fence = calloutFenceForInner(options.openColons, inner)
  const type = isVisualCalloutName(options.calloutType) ? options.calloutType : 'tip'
  const title = options.title.trim()
  const openLine = title ? `${fence} ${type} ${title}` : `${fence} ${type}`
  return inner ? `${openLine}\n\n${inner}\n\n${fence}` : `${openLine}\n\n\n${fence}`
}

export function serializeDeskCalloutMdast(
  node: CalloutMarkdownNode,
  _parent: unknown,
  state: { containerFlow: (node: unknown, info: unknown) => string },
  info: unknown
): string {
  const inner = state.containerFlow(node, info)
  return serializeCalloutMarkdown({
    calloutType: String(node.calloutType ?? 'tip'),
    title: String(node.title ?? ''),
    openColons: String(node.openColons ?? ':::'),
    inner
  })
}

export const deskCalloutRemark = $remark('deskCallout', () => {
  return function deskCalloutPlugin() {
    const data = this.data() as { toMarkdownExtensions?: unknown[] }
    const extensions = Array.isArray(data.toMarkdownExtensions) ? data.toMarkdownExtensions : []
    extensions.push({
      handlers: {
        deskCallout: serializeDeskCalloutMdast
      }
    })
    data.toMarkdownExtensions = extensions
    return (tree) => {
      wrapDeskCallouts(tree as MarkdownNode)
    }
  }
})

const CALLOUT_DOM_TYPES = new Set(DESK_CALLOUT_TYPES)

export const deskCalloutSchema = $nodeSchema('deskCallout', () => ({
  content: 'block+',
  group: 'block',
  isolating: true,
  defining: true,
  selectable: true,
  attrs: {
    calloutType: { default: 'tip', validate: 'string' },
    title: { default: '', validate: 'string' },
    openColons: { default: ':::', validate: 'string' }
  },
  parseDOM: [
    {
      tag: 'div[data-type="desk-callout"]',
      contentElement: '.custom-block-body',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false
        const calloutType = String(dom.dataset.callout ?? 'tip')
        if (!CALLOUT_DOM_TYPES.has(calloutType as VisualCalloutType)) return false
        return {
          calloutType,
          title: dom.dataset.title ?? '',
          openColons: dom.dataset.openColons || ':::'
        }
      }
    }
  ],
  toDOM: (node) => {
    const calloutType = String(node.attrs.calloutType ?? 'tip')
    const title = String(node.attrs.title ?? '')
    const openColons = String(node.attrs.openColons ?? ':::')
    const label = title.trim() || DEFAULT_CALLOUT_TITLE[calloutType as VisualCalloutType] || 'TIP'
    return [
      'div',
      {
        class: `desk-callout custom-block custom-block-${calloutType}`,
        'data-type': 'desk-callout',
        'data-callout': calloutType,
        'data-title': title,
        'data-open-colons': openColons
      },
      ['p', { class: 'custom-block-title' }, label],
      ['div', { class: 'custom-block-body' }, 0]
    ]
  },
  parseMarkdown: {
    match: (node) => node.type === 'deskCallout',
    runner: (state, node, type) => {
      state.openNode(type, {
        calloutType: String(node.calloutType ?? 'tip'),
        title: String(node.title ?? ''),
        openColons: String(node.openColons ?? ':::')
      })
      const children = Array.isArray(node.children) ? node.children : []
      state.next(children)
      state.closeNode()
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'deskCallout',
    runner: (state, node) => {
      state.openNode('deskCallout', undefined, {
        calloutType: String(node.attrs.calloutType ?? 'tip'),
        title: String(node.attrs.title ?? ''),
        openColons: String(node.attrs.openColons ?? ':::')
      })
      state.next(node.content)
      state.closeNode()
    }
  }
}))

export function isDeskCalloutNode(node: { type: { name: string } }): boolean {
  return node.type.name === 'deskCallout'
}

export function calloutDepthAt($pos: ResolvedPos): number {
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if (isDeskCalloutNode($pos.node(depth))) return depth
  }
  return -1
}

/**
 * True when ArrowUp / ArrowLeft from the caret should enter the callout title
 * instead of leaving the container (title lives outside contentDOM).
 */
export function isCaretEnteringCalloutTitle($head: ResolvedPos, direction: 'up' | 'left'): boolean {
  if (!$head.parent.isTextblock) return false
  const calloutDepth = calloutDepthAt($head)
  if (calloutDepth < 0) return false
  // 只看 callout 内部的祖先链，而且用绝对位置判断「是不是第一个子节点」：
  // index(depth) 在段尾这种边界位置上会指到下一个孩子（实测段落末尾拿到 1），
  // 老代码用 index(depth-1) 更是把 callout 自己在文档里的下标也要求为 0 ——
  // 除第一个 callout 外全都判 false，↑ 就落到 gapcursor 手里跳到文档开头。
  for (let depth = $head.depth; depth > calloutDepth; depth -= 1) {
    if ($head.before(depth) !== $head.before(depth - 1) + 1) return false
  }
  if (direction === 'left') return $head.parentOffset === 0
  return !$head.parent.textBetween(0, $head.parentOffset, '\n', '\n').includes('\n')
}

/**
 * Caret is at the very end of a callout body → the position right after that
 * callout (so ArrowDown / ArrowRight can leave it). Returns null when the caret
 * is elsewhere (inside the body but not at the end, or not in a callout at all).
 *
 * 注意别去检查 callout 之外的层级：callout 后面还有别的块是常态，一旦那样判断，
 * 「从 body 末尾往下走」永远返回 null，按键就落到 PM 的 gapcursor 手里，
 * 被带到一个莫名其妙的 gap（实测直接跳到文档开头）。
 */
export function calloutBodyExitPosition(
  $head: ResolvedPos,
  direction: 'down' | 'right'
): number | null {
  const calloutDepth = calloutDepthAt($head)
  if (calloutDepth < 1 || !$head.parent.isTextblock) return null
  if (direction === 'right') {
    if ($head.parentOffset !== $head.parent.content.size) return null
  } else if (
    $head.parent
      .textBetween($head.parentOffset, $head.parent.content.size, '\n', '\n')
      .includes('\n')
  ) {
    return null
  }
  // 「当前文本块这个节点」必须正好结束在 callout 内容的末尾：
  // 用绝对位置比较，别用 index() —— 段尾这种边界位置上 index(depth) 会指到下一个
  // 孩子（实测第一段末尾拿到 1 而不是 0，判断直接失效）。
  if ($head.after($head.depth) !== $head.end(calloutDepth)) return null
  return $head.after(calloutDepth)
}

/** Position of the callout entered by ArrowDown / ArrowRight from the block above. */
export function calloutPosEnteredFromAbove(
  $head: ResolvedPos,
  direction: 'down' | 'right'
): number | null {
  if (!$head.parent.isTextblock) return null
  // 光标已经在某个 callout body 里：交给 calloutBodyExitPosition 判断是否到底。
  if (calloutDepthAt($head) >= 1) return calloutBodyExitPosition($head, direction)
  if (direction === 'right') {
    if ($head.parentOffset !== $head.parent.content.size) return null
  } else if (
    $head.parent
      .textBetween($head.parentOffset, $head.parent.content.size, '\n', '\n')
      .includes('\n')
  ) {
    return null
  }
  const pos = $head.after(1)
  const next = $head.doc.resolve(pos).nodeAfter
  if (!next || !isDeskCalloutNode(next)) return null
  return pos
}

export function focusCalloutTitleInput(
  view: { nodeDOM: (pos: number) => Node | null | undefined },
  calloutPos: number,
  caret: number | 'end' | 'start'
): boolean {
  const dom = view.nodeDOM(calloutPos)
  if (!(dom instanceof HTMLElement)) return false
  const title = dom.querySelector('.desk-callout__title')
  if (!(title instanceof HTMLInputElement) || title.readOnly) return false
  const length = title.value.length
  const pos =
    caret === 'end' ? length : caret === 'start' ? 0 : Math.max(0, Math.min(caret, length))
  title.focus()
  title.setSelectionRange(pos, pos)
  return true
}

export function createDeskCalloutNode(
  schema: ProseNode['type']['schema'],
  options: { calloutType: VisualCalloutType; title: string; openColons?: string }
): ProseNode | null {
  const type = schema.nodes.deskCallout
  const paragraph = schema.nodes.paragraph
  if (!type || !paragraph) return null
  return type.create(
    {
      calloutType: options.calloutType,
      title: options.title,
      openColons: options.openColons ?? ':::'
    },
    paragraph.create()
  )
}

export function slashCalloutType(itemId: string): VisualCalloutType | null {
  if (itemId === 'tip' || itemId === 'quote' || itemId === 'warning' || itemId === 'danger') {
    return itemId
  }
  return null
}
