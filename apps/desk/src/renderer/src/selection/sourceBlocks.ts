/**
 * 源码视图的"相关块"扫描（纯函数，可单测）。
 *
 * 源码视图有**逐字原文**，所以这里给出的块 Markdown 就是模型里的原文切片
 * （`source: 'raw'`），不做任何重新序列化 —— 与可视化视图的 `reserialized` 区分开。
 *
 * 只返回**与选区相交**的块，不附带整篇笔记。
 */

export interface SourceBlockScan {
  kind: string
  /** 块的 Markdown（原文切片） */
  markdown: string
  /** 1-based 行范围（含） */
  startLine: number
  endLine: number
  /** 块在原文里的字符偏移（0-based，结束不含） */
  startOffset: number
  endOffset: number
}

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/
const CONTAINER_PATTERN = /^ {0,3}:{3,}/
const HEADING_PATTERN = /^ {0,3}#{1,6}(?:[ \t]|$)/
const LIST_PATTERN = /^ {0,3}(?:[-+*]|\d{1,9}[.)])([ \t]+)/
const QUOTE_PATTERN = /^ {0,3}>/

interface SourceLine {
  text: string
  /** 该行在原文里的起始偏移 */
  start: number
  /** 该行结束偏移（不含换行符） */
  contentEnd: number
  /** 含换行符的结束偏移 */
  rawEnd: number
}

function toLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let offset = 0
  for (const raw of text.split('\n')) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    lines.push({
      text,
      start: offset,
      contentEnd: offset + text.length,
      rawEnd: offset + raw.length
    })
    offset += raw.length + 1
  }
  return lines
}

function isListContinuation(candidate: string): boolean {
  return candidate.trim() !== '' && /^ {1,}[^\s]/.test(candidate)
}

/**
 * 扫描出所有块（行级状态机）：围栏代码 / `:::` 容器 / 标题 / 列表 / 引用 / 段落。
 * 空行结束普通块；围栏与容器的内容整块算一块（未闭合则到文末）。
 */
export function scanSourceBlocks(text: string): SourceBlockScan[] {
  const lines = toLines(text)
  const blocks: SourceBlockScan[] = []
  let index = 0

  const push = (kind: string, from: number, to: number): void => {
    const first = lines[from]
    const last = lines[to]
    blocks.push({
      kind,
      markdown: text.slice(first.start, last.contentEnd),
      startLine: from + 1,
      endLine: to + 1,
      startOffset: first.start,
      endOffset: last.contentEnd
    })
  }

  while (index < lines.length) {
    const line = lines[index].text
    if (line.trim() === '') {
      index += 1
      continue
    }

    const fence = FENCE_PATTERN.exec(line)
    if (fence) {
      const char = fence[1][0]
      const length = fence[1].length
      let end = index
      for (let next = index + 1; next < lines.length; next += 1) {
        end = next
        const candidate = FENCE_PATTERN.exec(lines[next].text)
        if (candidate && candidate[1][0] === char && candidate[1].length >= length) break
      }
      push('code', index, end)
      index = end + 1
      continue
    }

    if (CONTAINER_PATTERN.test(line)) {
      let end = index
      for (let next = index + 1; next < lines.length; next += 1) {
        end = next
        const candidate = lines[next].text.trim()
        if (candidate === ':::') break
      }
      push('container', index, end)
      index = end + 1
      continue
    }

    if (HEADING_PATTERN.test(line)) {
      push('heading', index, index)
      index += 1
      continue
    }

    if (LIST_PATTERN.test(line)) {
      let end = index
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next].text
        if (candidate.trim() === '') break
        if (!LIST_PATTERN.test(candidate) && !isListContinuation(candidate)) break
        end = next
      }
      push('list', index, end)
      index = end + 1
      continue
    }

    if (QUOTE_PATTERN.test(line)) {
      let end = index
      for (let next = index + 1; next < lines.length; next += 1) {
        if (!QUOTE_PATTERN.test(lines[next].text)) break
        end = next
      }
      push('blockquote', index, end)
      index = end + 1
      continue
    }

    let end = index
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next].text
      if (candidate.trim() === '') break
      if (
        FENCE_PATTERN.test(candidate) ||
        CONTAINER_PATTERN.test(candidate) ||
        HEADING_PATTERN.test(candidate) ||
        LIST_PATTERN.test(candidate) ||
        QUOTE_PATTERN.test(candidate)
      ) {
        break
      }
      end = next
    }
    push('paragraph', index, end)
    index = end + 1
  }

  return blocks
}

/**
 * 第 n 个围栏代码块的**正文范围**（相对传入 Markdown 的偏移）。
 *
 * 代码组面板里的 CodeMirror 坐标是"面板正文"的坐标，要落回源码就得知道
 * 那是第几个围栏 —— 这里**按结构**数围栏，不按文字匹配，所以两个面板里
 * 有同样的代码也不会指错。
 */
export function nthFenceBodyRange(
  markdown: string,
  index: number
): { startOffset: number; endOffset: number } | null {
  if (index < 0) return null
  const lines = toLines(markdown)
  let seen = 0
  let cursor = 0
  while (cursor < lines.length) {
    const fence = FENCE_PATTERN.exec(lines[cursor].text)
    if (!fence) {
      cursor += 1
      continue
    }
    const char = fence[1][0]
    const length = fence[1].length
    // `rawEnd` 指向行尾换行符本身，正文从它后面一个字符开始
    const lineEnd = lines[cursor].rawEnd
    const bodyStart = markdown[lineEnd] === '\n' ? lineEnd + 1 : lineEnd
    let end = cursor
    let closed = false
    for (let next = cursor + 1; next < lines.length; next += 1) {
      const candidate = FENCE_PATTERN.exec(lines[next].text)
      if (candidate && candidate[1][0] === char && candidate[1].length >= length) {
        end = next
        closed = true
        break
      }
      end = next
    }
    // 没闭合的围栏：正文一直到文档末尾（不把最后一行当成结束标记切掉）
    const bodyEnd = closed ? lines[end].start : markdown.length
    if (seen === index) {
      return { startOffset: bodyStart, endOffset: Math.max(bodyStart, bodyEnd) }
    }
    seen += 1
    cursor = end + 1
  }
  return null
}

/** 与 [startOffset, endOffset) 相交的块（端点接触也算相交） */
export function sourceBlocksForOffsets(
  text: string,
  startOffset: number,
  endOffset: number
): SourceBlockScan[] {
  return scanSourceBlocks(text).filter(
    (block) => startOffset <= block.endOffset && endOffset >= block.startOffset
  )
}
