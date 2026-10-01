import { syntaxTree } from '@codemirror/language'

import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

/** CommonMark 标签：去掉首尾空白，连续空白折成一个空格，再按大小写不敏感比较。 */
export function normalizeLinkLabel(inner: string): string {
  return inner
    .trim()
    .replace(/[ \t\r\n]+/g, ' ')
    .toLowerCase()
}

function unwrapLabel(source: string): string {
  if (source.startsWith('[') && source.endsWith(']') && source.length >= 2)
    return source.slice(1, -1)
  return source
}

function destination(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('<') && trimmed.endsWith('>') && trimmed.length >= 2)
    return trimmed.slice(1, -1).trim()
  return trimmed
}

/** 全文的链接定义。同名标签以第一次出现的为准。 */
export function linkDefinitions(state: EditorState): Map<string, string> {
  const map = new Map<string, string>()
  const doc = state.doc
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'LinkReference') return
      const label = node.node.getChild('LinkLabel')
      const url = node.node.getChild('URL')
      if (!label || !url) return false
      const key = normalizeLinkLabel(unwrapLabel(doc.sliceString(label.from, label.to)))
      if (key && !map.has(key)) map.set(key, destination(doc.sliceString(url.from, url.to)))
      return false
    }
  })
  return map
}

function linkInnerText(state: EditorState, node: SyntaxNode): string {
  const close = node
    .getChildren('LinkMark')
    .find((mark) => state.doc.sliceString(mark.from, mark.to) === ']')
  if (!close || close.from <= node.from + 1) return ''
  return state.doc.sliceString(node.from + 1, close.from)
}

/**
 * 行内链接用子节点 URL。
 * `[描述][1]` / `[描述][]` / `[描述]` 没有 URL，按标签到 LinkReference 里取地址。
 */
export function hrefForLink(
  state: EditorState,
  node: SyntaxNode,
  definitions: Map<string, string>
): string {
  const url = node.getChild('URL')
  if (url) return state.doc.sliceString(url.from, url.to)
  const marks = node.getChildren('LinkMark')
  if (marks.some((mark) => state.doc.sliceString(mark.from, mark.to) === '(')) return ''
  const label = node.getChild('LinkLabel')
  let key = label
    ? normalizeLinkLabel(unwrapLabel(state.doc.sliceString(label.from, label.to)))
    : ''
  if (!key) key = normalizeLinkLabel(linkInnerText(state, node))
  return (key && definitions.get(key)) || ''
}
