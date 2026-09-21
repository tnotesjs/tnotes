/**
 * 源码视图（Monaco）的 Markdown 折叠范围：**纯函数**，不依赖 Monaco，便于单测。
 *
 * 两类范围（与验收要求一致）：
 * - **标题章节**：从标题行到「下一个同级或更高级标题的上一行」；最后一个章节到文末。
 *   只认 ATX 标题（`#`..`######` 且后面是空白或行尾），且**围栏代码块里的 `#` 不算标题**。
 * - **围栏代码块**：起始围栏行到闭合围栏行（未闭合则到文末），` ``` ` 与 `~~~` 都支持，
 *   让"折叠代码块"折的是**整块**，而不是缩进片段。
 *
 * 行号一律 **1-based**（与 Monaco 的 `FoldingRange` 一致，避免调用方来回换算）。
 */

export interface MarkdownFoldRange {
  /** 1-based 起始行 */
  start: number
  /** 1-based 结束行（含） */
  end: number
  kind: 'heading' | 'code'
  /** 标题级别 1..6；代码块为 null */
  level: number | null
}

interface OpenFence {
  char: '`' | '~'
  length: number
  startLine: number
}

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ATX_HEADING_PATTERN = /^ {0,3}(#{1,6})(?:[ \t]|$)/

/** 扫描源码，产出全部可折叠范围（已按起始行排序） */
export function markdownFoldRanges(text: string): MarkdownFoldRange[] {
  const lines = text.split(/\r?\n/)
  const ranges: MarkdownFoldRange[] = []
  const headings: { line: number; level: number }[] = []
  let fence: OpenFence | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNumber = index + 1
    const fenceMatch = FENCE_PATTERN.exec(line)

    if (fence) {
      // 闭合围栏：同一种字符、长度不短于起始围栏、后面只剩空白
      const closes =
        fenceMatch !== null &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim() === ''
      if (!closes) continue
      if (lineNumber > fence.startLine) {
        ranges.push({ start: fence.startLine, end: lineNumber, kind: 'code', level: null })
      }
      fence = null
      continue
    }

    if (fenceMatch) {
      // 反引号围栏的 info string 里不能再出现反引号（CommonMark）——那种行不是围栏起始
      if (fenceMatch[1][0] === '`' && fenceMatch[2].includes('`')) continue
      fence = {
        char: fenceMatch[1][0] as '`' | '~',
        length: fenceMatch[1].length,
        startLine: lineNumber
      }
      continue
    }

    const headingMatch = ATX_HEADING_PATTERN.exec(line)
    if (headingMatch) headings.push({ line: lineNumber, level: headingMatch[1].length })
  }

  // 未闭合围栏：一直折到文末
  if (fence && lines.length > fence.startLine) {
    ranges.push({ start: fence.startLine, end: lines.length, kind: 'code', level: null })
  }

  headings.forEach((heading, index) => {
    let end = lines.length
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) {
        end = headings[next].line - 1
        break
      }
    }
    // 相邻标题（章节里没有正文）不产出范围 —— 折了也没有内容可折
    if (end > heading.line) {
      ranges.push({ start: heading.line, end, kind: 'heading', level: heading.level })
    }
  })

  return ranges.sort((a, b) => a.start - b.start || a.end - b.end)
}

/**
 * 折叠命令要作用的**标题行**（0-based，直接喂给 Monaco 的
 * `editor.fold` / `editor.unfold` 的 `selectionLines`）。
 *
 * 语义与可视化编辑器里的 `applyHeadingFoldCommand` 对齐：
 * - `fold-all` / `unfold-all`：全部标题章节；
 * - `fold-level-N` / `unfold-level-N`：只动 N 级标题。
 * 只取**有正文的**章节：空章节没有折叠范围，把它的行交出去会误折到外层章节。
 */
export function headingFoldTargetLines(command: string, text: string): number[] {
  const headings = markdownFoldRanges(text).filter((range) => range.kind === 'heading')
  const levelMatch = /^(?:fold|unfold)-level-([1-6])$/.exec(command)
  const targets = levelMatch
    ? headings.filter((range) => range.level === Number(levelMatch[1]))
    : headings
  return targets.map((range) => range.start - 1)
}
