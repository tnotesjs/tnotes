/**
 * 块内"纯文本偏移 → 源码偏移"的**结构化**映射（纯函数，可单测）。
 *
 * 为什么不能 `indexOf`：源码里除了正文，还有**不显示出来的内容** ——
 * 链接地址、图片 src、HTML 属性……它们完全可能包含与正文一模一样的字符串。
 * `[x](AAA) AAA` 里选中链接后面的那个 `AAA`，从纯文本偏移 2 起 `indexOf` 会先命中
 * 链接地址里的 `AAA`（偏移 4），锚点就指到了用户没选的地方。
 *
 * 做法是按**结构**逐个内容节点顺序推进：
 *
 * - 每个文本节点的文字必须从当前位置起在源码里逐字命中（允许 Markdown 反斜杠转义）；
 * - 命中点不能落在"不参与正文"的区间里（链接 / 图片的地址与标题、HTML 标签）；
 * - 从上一个内容节点到命中点之间，只允许标记字符或不参与正文的区间；
 * - 图片、行内公式、HTML、硬换行等原子节点按各自的语法**整体**跳过，认不出来就拒绝；
 * - 走完整个块之后，源码必须只剩标记 —— 否则说明这段源码根本不是这个块。
 *
 * 任何一步对不上都返回 `null`：调用方据此**拒绝固定**，绝不猜一个位置出来。
 */
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'

/** 源码里"不参与正文"的区间（链接 / 图片的地址与标题、HTML 标签） */
export interface SourceInterval {
  start: number
  end: number
}

/** 链接 / autolink 的判据：`<scheme:…>` 与 `<user@host>` 是**正文**，不是 HTML 标签 */
const AUTOLINK_PATTERN = /^(?:[A-Za-z][A-Za-z0-9+.-]*:[^\s<>]*|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/

/** Markdown 的标记字符（跳过的部分由它们组成才算"只是标记"）；空白也算 */
const MARKUP_CHARS = new Set('`*_~[]()!<>{}#-+.=:|\\/"\'$&;?,^%\t\n\r '.split(''))

/** 从 `open` 处的 `(` 找到配对的 `)`（跳过转义与引号里的内容） */
function matchClosingParen(source: string, open: number): number {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      index += 1
      while (index < source.length && source[index] !== char) {
        if (source[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * 源码里"不参与正文"的区间。
 *
 * 只认两类结构性语法（不做通用 Markdown 解析）：`](地址 "标题")` 与 HTML 标签。
 */
export function invisibleSourceIntervals(source: string): SourceInterval[] {
  const intervals: SourceInterval[] = []
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === ']' && source[index + 1] === '(') {
      const close = matchClosingParen(source, index + 1)
      if (close > index + 1) {
        intervals.push({ start: index + 2, end: close })
        index = close
        continue
      }
    }
    if (source[index] === '<') {
      const close = source.indexOf('>', index + 1)
      const inner = close > index ? source.slice(index + 1, close) : null
      if (inner != null && !inner.includes('\n') && !AUTOLINK_PATTERN.test(inner)) {
        intervals.push({ start: index, end: close + 1 })
        index = close
      }
    }
  }
  return intervals
}

function isInsideInterval(offset: number, intervals: SourceInterval[]): boolean {
  return intervals.some((interval) => offset >= interval.start && offset < interval.end)
}

function overlapsIntervals(start: number, end: number, intervals: SourceInterval[]): boolean {
  return intervals.some((interval) => start < interval.end && end > interval.start)
}

/** [from, to) 里只能是标记字符或不参与正文的区间 */
function isMarkupOnly(
  source: string,
  from: number,
  to: number,
  intervals: SourceInterval[]
): boolean {
  for (let index = from; index < to; index += 1) {
    if (isInsideInterval(index, intervals)) continue
    if (!MARKUP_CHARS.has(source[index]!)) return false
  }
  return true
}

/** 源码从 `index` 起是否正好是 `text`（允许对每个字符加反斜杠转义）；返回消耗的长度 */
function matchTextAt(source: string, index: number, text: string): number {
  let cursor = index
  for (let offset = 0; offset < text.length; offset += 1) {
    const char = text[offset]!
    if (source[cursor] === '\\' && source[cursor + 1] === char) {
      cursor += 2
      continue
    }
    if (source[cursor] !== char) return 0
    cursor += 1
  }
  return cursor - index
}

/**
 * 从 `from` 起找 `text` 在**正文里**的位置。
 *
 * 跳过链接地址 / HTML 属性里的同字符串，也不允许把别的正文甩在身后
 * （跳过的部分必须是标记）—— 这两条一起保证"命中的就是结构上该命中的那一处"。
 */
function findPlainText(
  source: string,
  text: string,
  from: number,
  intervals: SourceInterval[]
): { start: number; end: number } | null {
  for (let index = from; index < source.length; index += 1) {
    const length = matchTextAt(source, index, text)
    if (length === 0) continue
    const end = index + length
    if (overlapsIntervals(index, end, intervals)) continue
    if (!isMarkupOnly(source, from, index, intervals)) return null
    return { start: index, end }
  }
  return null
}

/** 图片：`![alt](src "title")` —— 整体跳过（alt 与 src 都不参与正文） */
function consumeImage(source: string, from: number): number | null {
  if (!source.startsWith('![', from)) return null
  let cursor = from + 2
  let bracket = 1
  while (cursor < source.length && bracket > 0) {
    const char = source[cursor]
    if (char === '\\') {
      cursor += 2
      continue
    }
    if (char === '[') bracket += 1
    else if (char === ']') bracket -= 1
    cursor += 1
  }
  if (bracket !== 0 || source[cursor] !== '(') return null
  const close = matchClosingParen(source, cursor)
  return close > cursor ? close + 1 : null
}

/** HTML 标签 / 注释：`<…>` */
function consumeHtml(source: string, from: number): number | null {
  if (source[from] !== '<') return null
  const close = source.indexOf('>', from + 1)
  if (close < 0) return null
  const inner = source.slice(from + 1, close)
  if (inner.includes('\n') || AUTOLINK_PATTERN.test(inner)) return null
  return close + 1
}

/** 行内公式：`$…$`（`$$…$$` 也认） */
function consumeInlineMath(source: string, from: number): number | null {
  if (source[from] !== '$') return null
  const width = source.startsWith('$$', from) ? 2 : 1
  const close = source.indexOf(width === 2 ? '$$' : '$', from + width)
  if (close < 0) return null
  return close + width
}

/** 硬换行：`\\\n` / 两个以上空格 + 换行 / `<br>` 系列 */
function consumeHardBreak(source: string, from: number): number | null {
  const rest = source.slice(from)
  if (/^\\\r?\n/.test(rest)) return from + (rest.startsWith('\\\r\n') ? 3 : 2)
  const spaces = /^ {2,}\r?\n/.exec(rest)
  if (spaces) return from + spaces[0].length
  const br = /^<br\s*\/?>\r?\n?/i.exec(rest)
  if (br) return from + br[0].length
  return null
}

/** 分隔线：`---` / `***` / `___` */
function consumeThematicBreak(source: string, from: number): number | null {
  const match = /^(?:-{3,}|\*{3,}|_{3,})[ \t]*(?:\r?\n|$)/.exec(source.slice(from))
  return match ? from + match[0].length : null
}

/**
 * 原子 / 结构化行内节点在源码里占的区间（返回结束偏移）。
 *
 * 按**语法**认，不按节点名认（不同 preset 对硬换行、公式的命名不一致）；
 * 认不出来就返回 null —— 调用方据此拒绝固定，而不是猜。
 */
function consumeAtom(source: string, from: number): number | null {
  return (
    consumeImage(source, from) ??
    consumeHtml(source, from) ??
    consumeInlineMath(source, from) ??
    consumeHardBreak(source, from) ??
    consumeThematicBreak(source, from)
  )
}

/** 块内一个内容节点（文本或原子）在纯文本 / 源码里的范围 */
export interface InlineSourceSpan {
  plainStart: number
  plainEnd: number
  sourceStart: number
  sourceEnd: number
  /**
   * 文本节点的**逐字符**源码位置（长度 = 纯文本长度 + 1）。
   * 有转义时源码比正文长（`\*` 两个字符对应正文一个 `*`），不能按线性比例换算。
   */
  positions?: number[]
}

/** 收集块里所有"承载内容"的叶子（文本 / 原子），按文档顺序 */
function contentLeaves(
  block: ProseMirrorNode,
  blockPosition: number
): { node: ProseMirrorNode; position: number }[] {
  const leaves: { node: ProseMirrorNode; position: number }[] = []
  const walk = (node: ProseMirrorNode, position: number): void => {
    if (node.isText || node.isLeaf) {
      leaves.push({ node, position })
      return
    }
    node.forEach((child, offset) => walk(child, position + 1 + offset))
  }
  block.forEach((child, offset) => walk(child, blockPosition + 1 + offset))
  return leaves
}

/**
 * 把块内纯文本范围 `[plainFrom, plainTo)` 映射成源码偏移范围。
 *
 * 纯文本偏移口径与 `doc.textBetween(from, to, '\n', '\n')` 完全一致
 * （块之间一个 `\n`、原子节点一个 `\n`），所以调用方直接用它算出的偏移即可。
 * 任何一处对不上都返回 null。
 */
export function mapPlainRangeInBlock(
  doc: ProseMirrorNode,
  blockPosition: number,
  block: ProseMirrorNode,
  source: string,
  plainFrom: number,
  plainTo: number
): { start: number; length: number } | null {
  if (plainTo < plainFrom) return null
  const contentStart = blockPosition + 1
  const contentEnd = blockPosition + block.nodeSize - 1
  const plainAt = (position: number): number =>
    doc.textBetween(
      contentStart,
      Math.max(contentStart, Math.min(position, contentEnd)),
      '\n',
      '\n'
    ).length

  const intervals = invisibleSourceIntervals(source)
  const spans: InlineSourceSpan[] = []
  let cursor = 0
  for (const leaf of contentLeaves(block, blockPosition)) {
    const plainStart = plainAt(leaf.position)
    const plainEnd = plainAt(leaf.position + leaf.node.nodeSize)
    if (leaf.node.isText) {
      const text = leaf.node.text ?? ''
      if (!text) continue
      const found = findPlainText(source, text, cursor, intervals)
      if (!found) return null
      const positions = textPositions(source, found.start, text)
      spans.push({
        plainStart,
        plainEnd,
        sourceStart: found.start,
        sourceEnd: positions[positions.length - 1] ?? found.end,
        positions
      })
      cursor = positions[positions.length - 1] ?? found.end
      continue
    }
    const end = consumeAtom(source, cursor)
    if (end == null) return null
    spans.push({ plainStart, plainEnd, sourceStart: cursor, sourceEnd: end })
    cursor = end
  }
  // 整个块走完之后源码只剩标记 → 这一段源码确实就是这个块
  if (!isMarkupOnly(source, cursor, source.length, intervals)) return null

  const parts = spans.filter((span) => span.plainEnd > plainFrom && span.plainStart < plainTo)
  if (parts.length === 0) return null
  const first = parts[0]!
  const last = parts[parts.length - 1]!
  const start = sourceOffsetAt(first, Math.max(plainFrom, first.plainStart))
  const end = sourceOffsetAt(last, Math.min(plainTo, last.plainEnd))
  if (end <= start) return null
  return { start, length: end - start }
}

/** 文本节点：逐字符算源码位置（转义会让源码比正文长） */
function textPositions(source: string, start: number, text: string): number[] {
  const positions = [start]
  let cursor = start
  for (let offset = 0; offset < text.length; offset += 1) {
    const char = text[offset]!
    cursor += source[cursor] === '\\' && source[cursor + 1] === char ? 2 : 1
    positions.push(cursor)
  }
  return positions
}

/** 纯文本偏移 → 该 span 内的源码偏移 */
function sourceOffsetAt(span: InlineSourceSpan, plainOffset: number): number {
  const local = plainOffset - span.plainStart
  const width = span.plainEnd - span.plainStart
  if (local <= 0) return span.sourceStart
  if (local >= width) return span.sourceEnd
  return span.positions?.[local] ?? span.sourceStart
}
