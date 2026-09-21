/**
 * 源码视图（Monaco）的 Markdown 折叠范围：**纯函数**，不依赖 Monaco，便于单测。
 *
 * 两类范围（与验收要求一致）：
 * - **标题章节**：从标题行到「下一个同级或更高级标题的上一行」；最后一个章节到文末。
 * - **围栏代码块**：起始围栏行到闭合围栏行（未闭合则到文末），` ``` ` 与 `~~~` 都支持，
 *   让"折叠代码块"折的是**整块**，而不是缩进片段。
 *
 * 「哪些 `#` 才算章节标题」这条有三道门（都是实测踩出来的）：
 * 1. **frontmatter 整段跳过** —— 否则 `---\n# metadata comment\nid: x\n---` 里的注释会被当成
 *    章节，命令面板的「全部折叠标题」会去折元数据；
 * 2. **只认顶格 ATX 标题** —— 与可视化编辑器只收集**文档级**标题一致（`collectDocHeadings`
 *    只看顶层）。容器/列表里缩进的 `#`（`> # x`、`  # x`）不参与章节，避免它们把章节范围
 *    伸到容器外面去；
 * 3. **围栏代码块内的 `#` 不算标题**；围栏本身允许带容器前缀（引用 `> ``` `、列表 `- ``` `），
 *    否则引用里的代码块会被当成普通正文、里面的 `#` 又变回"章节"。
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

/** 围栏：最多 3 个前导空格 + 至少 3 个反引号或波浪线 + info string */
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** 顶格 ATX 标题（`#`..`######`，后面必须是空白或行尾） */
const ATX_HEADING_PATTERN = /^(#{1,6})(?:[ \t]|$)/
/** TNotes 容器围栏：`::: tip 标题` 开、`:::` 合（冒号数不少于 3） */
const CONTAINER_PATTERN = /^ {0,3}(:{3,})(.*)$/
const FRONTMATTER_DELIMITER = /^---[ \t]*$/
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/

/**
 * frontmatter 的结束行号（1-based）；没有 frontmatter 或没闭合时返回 0。
 *
 * 与知识库侧的解析对齐（`gray-matter`）：首行必须是独占一行的 `---`，并且后面能找到闭合行；
 * 没闭合就当作普通正文（首行那个 `---` 是分割线），不吞掉整篇。
 */
export function frontmatterEndLine(lines: readonly string[]): number {
  if (!FRONTMATTER_DELIMITER.test(lines[0] ?? '')) return 0
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONTMATTER_CLOSE.test(lines[index])) return index + 1
  }
  return 0
}

/**
 * 去掉行首的容器标记（引用 `>` / 列表 `-`、`1.`，可嵌套），只用于识别**容器内**的围栏。
 * 不去缩进：围栏的合法缩进（≤3 空格）由 `FENCE_PATTERN` 自己判，4 空格是缩进代码块不是围栏。
 */
export function stripContainerPrefix(line: string): string {
  let rest = line
  for (;;) {
    const next = rest
      .replace(/^ {0,3}>[ \t]?/, '')
      .replace(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/, '')
    if (next === rest) return rest
    rest = next
  }
}

/** 扫描源码，产出全部可折叠范围（已按起始行排序） */
export function markdownFoldRanges(text: string): MarkdownFoldRange[] {
  const lines = text.split(/\r?\n/)
  const ranges: MarkdownFoldRange[] = []
  const headings: { line: number; level: number }[] = []
  let fence: OpenFence | null = null
  // `:::` 容器（提示块 / 代码组…）的嵌套深度：容器里的 `#` 不算章节
  let containerDepth = 0
  const frontmatterEnd = frontmatterEndLine(lines)

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    // frontmatter 整段当不透明：里面的 `#` 是元数据注释，不是章节
    if (lineNumber <= frontmatterEnd) continue
    const line = lines[index]
    // 容器前缀（`> ` / `- ` / `1. `）对围栏有意义，对标题没有（标题只认顶格）
    const content = stripContainerPrefix(line)
    const fenceMatch = FENCE_PATTERN.exec(content)

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

    const containerMatch = CONTAINER_PATTERN.exec(content)
    if (containerMatch) {
      // 有 info string 是开容器（`::: tip 标题`），只有冒号是合（`:::`）
      if (containerMatch[2].trim() === '') containerDepth = Math.max(0, containerDepth - 1)
      else containerDepth += 1
      continue
    }

    // 只认顶格标题：容器/列表里缩进的 `#` 不参与章节（否则章节范围会伸到容器外）
    if (containerDepth === 0) {
      const headingMatch = ATX_HEADING_PATTERN.exec(line)
      if (headingMatch) headings.push({ line: lineNumber, level: headingMatch[1].length })
    }
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
