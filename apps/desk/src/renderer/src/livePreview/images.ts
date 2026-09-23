import { syntaxTree } from '@codemirror/language'
import { formatImageAttrs, parseImageAttrs, type ImageAlign } from '@tnotesjs/ui/image-markdown'

import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

const ATTR_AFTER_IMAGE = /^[ \t]*\{[^}\n]*\}/

export interface ImageSyntax {
  /** `![` 的位置 */
  from: number
  /** `)` 之后的位置（不含属性块） */
  to: number
  /** 属性块 `{…}` 的范围（没有时两者都等于 `to`） */
  attrFrom: number
  attrTo: number
  alt: string
  src: string
  width: string
  align: ImageAlign
}

/** 从 Image 语法节点读出图片信息（含紧跟其后的 `{w=… align=…}` 属性块）。 */
export function readImage(state: EditorState, node: SyntaxNode): ImageSyntax | null {
  if (node.name !== 'Image') return null
  const doc = state.doc
  let src = ''
  let altFrom = node.from + 2
  let altTo = altFrom
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'URL') src = doc.sliceString(child.from, child.to)
    if (child.name === 'LinkMark' && doc.sliceString(child.from, child.to) === ']') {
      altTo = child.from
    }
  }
  if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1)
  const alt = doc.sliceString(altFrom, Math.max(altFrom, altTo))
  const line = doc.lineAt(node.to)
  const rest = doc.sliceString(node.to, line.to)
  const attrMatch = ATTR_AFTER_IMAGE.exec(rest)
  let attrFrom = node.to
  let attrTo = node.to
  let width = ''
  let align: ImageAlign = 'left'
  if (attrMatch) {
    const parsed = parseImageAttrs(attrMatch[0])
    if (parsed.rest === '') {
      attrFrom = node.to
      attrTo = node.to + attrMatch[0].length
      width = parsed.width
      align = parsed.align
    }
  }
  if (altTo < altFrom) altFrom = altTo
  return { from: node.from, to: node.to, attrFrom, attrTo, alt, src, width, align }
}

/** 找到覆盖 `pos` 的图片语法（组件事件发生时按当前文档重新定位，不信任旧坐标）。 */
export function imageAt(state: EditorState, pos: number): ImageSyntax | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1)
  while (node && node.name !== 'Image') node = node.parent
  return node ? readImage(state, node) : null
}

/** 改写图片属性块：返回要应用的单个修改（宽度或对齐为默认值时整块去掉）。 */
export function imageAttrChange(
  image: ImageSyntax,
  next: { width?: string; align?: ImageAlign }
): { from: number; to: number; insert: string } {
  const attrs = formatImageAttrs({
    width: next.width ?? image.width,
    align: next.align ?? image.align
  })
  return {
    from: image.attrFrom,
    to: image.attrTo,
    insert: attrs ? ` ${attrs}` : ''
  }
}
