/**
 * 源码视图（Monaco）的 Markdown 折叠范围：**纯函数**，不依赖 Monaco，便于单测。
 *
 * 两类范围（与验收要求一致）：
 * - **标题章节**：从标题行到「下一个同级或更高级标题的上一行」；最后一个章节到文末。
 * - **围栏代码块**：起始围栏行到闭合围栏行（未闭合则到文末），` ``` ` 与 `~~~` 都支持，
 *   让"折叠代码块"折的是**整块**，而不是缩进片段。
 *
 * 「哪些 `#` 才算章节标题」这条靠**容器上下文**判断，逐行解析出「引用深度 / 是否在列表项里 /
 * 是否在 `:::` 容器里」，而不是靠"有缩进就排除"：
 * 1. **frontmatter 整段跳过** —— 否则 `---\n# metadata comment\nid: x\n---` 里的注释会被当成
 *    章节，命令面板的「全部折叠标题」会去折元数据；
 * 2. **合法的文档级 ATX 标题**：允许 0–3 个前导空格（CommonMark），但**引用里、列表项里、
 *    `:::` 容器里**的 `#` 不是文档级标题 —— 与可视化编辑器只收集顶层 heading 的实际解析
 *    结果一致，也避免章节范围伸到容器外；
 * 3. **围栏代码块内的行一律不参与章节**。围栏本身允许带容器前缀（引用 `> ``` `、列表
 *    `- ``` `）；但**闭合判定必须回到开栏时的容器上下文** —— 代码内容里的 `> ``` ` / `- ``` `
 *    不能被剥成"闭合围栏"（否则围栏提前结束，代码里的 `#` 又变回章节）。
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
  /** 开栏时的引用深度：闭合行必须处在同一个引用里 */
  quoteDepth: number
  /** 开栏时的"容器内容列"（列表项内容起始列；不在列表里就是围栏自身的缩进） */
  contentColumn: number
}

/** 一行的容器上下文（引用深度 + 剥掉引用标记后的剩余内容 + 缩进） */
interface LineContext {
  quoteDepth: number
  /** 剥掉引用标记后的内容 */
  rest: string
  /** `rest` 的前导空格数 */
  indent: number
}

function lineContext(line: string): LineContext {
  let rest = line
  let quoteDepth = 0
  for (;;) {
    const next = rest.replace(QUOTE_MARKER_PATTERN, '')
    if (next === rest) break
    rest = next
    quoteDepth += 1
  }
  const indent = /^ */.exec(rest)?.[0].length ?? 0
  return { quoteDepth, rest, indent }
}

/** 围栏：最多 3 个前导空格 + 至少 3 个反引号或波浪线 + info string */
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** ATX 标题：0–3 个前导空格 + `#`..`######` + 空白或行尾（CommonMark） */
const ATX_HEADING_PATTERN = /^ {0,3}(#{1,6})(?:[ \t]|$)/
/** 行首的列表项标记（含标记后的空白），用于取"容器内容列" */
const LIST_MARKER_PATTERN = /^ {0,3}(?:[-+*]|\d{1,9}[.)])([ \t]+)/
/** 引用标记（`>`，最多 3 个前导空格） */
const QUOTE_MARKER_PATTERN = /^ {0,3}>[ \t]?/
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
  // 当前打开的列表项"内容列"栈：缩进小于栈顶的行说明该项已结束（空行不结束列表项）
  const listColumns: number[] = []
  const frontmatterEnd = frontmatterEndLine(lines)

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    // frontmatter 整段当不透明：里面的 `#` 是元数据注释，不是章节
    if (lineNumber <= frontmatterEnd) continue
    const line = lines[index]
    const ctx = lineContext(line)

    if (fence) {
      // 闭合判定**必须回到开栏时的容器上下文**：只有同引用深度、且本身不是列表项标记的行
      // 才可能是闭合围栏。代码内容里的 `> ``` ` / `- ``` ` 属于"代码"，不能剥成闭合围栏
      // （否则围栏提前结束，后面的代码行会被当成正文、里面的 `#` 又变成章节）。
      if (ctx.quoteDepth === fence.quoteDepth && !LIST_MARKER_PATTERN.test(ctx.rest)) {
        const candidate = FENCE_PATTERN.exec(ctx.rest)
        const closes =
          candidate !== null &&
          candidate[1][0] === fence.char &&
          candidate[1].length >= fence.length &&
          candidate[2].trim() === '' &&
          // 闭合围栏的缩进不能比"容器内容列"浅太多，也不能深到出容器
          (/^ */.exec(ctx.rest)?.[0].length ?? 0) <= fence.contentColumn + 3
        if (closes) {
          if (lineNumber > fence.startLine) {
            ranges.push({ start: fence.startLine, end: lineNumber, kind: 'code', level: null })
          }
          fence = null
        }
      }
      // 围栏内的行不参与标题 / 容器栈
      continue
    }

    // 维护列表项内容列栈（空行不结束列表项）
    if (ctx.rest.trim() !== '') {
      while (listColumns.length > 0 && ctx.indent < listColumns[listColumns.length - 1]) {
        listColumns.pop()
      }
      const marker = LIST_MARKER_PATTERN.exec(ctx.rest)
      if (marker) listColumns.push(ctx.indent + marker[0].length)
    }

    // 开栏识别用"剥掉全部容器标记"后的内容（`> ``` ` / `- ``` ` 都算围栏起始）
    const openContent = stripContainerPrefix(line)
    const fenceMatch = FENCE_PATTERN.exec(openContent)
    if (fenceMatch) {
      // 反引号围栏的 info string 里不能再出现反引号（CommonMark）——那种行不是围栏起始
      if (fenceMatch[1][0] === '`' && fenceMatch[2].includes('`')) continue
      fence = {
        char: fenceMatch[1][0] as '`' | '~',
        length: fenceMatch[1].length,
        startLine: lineNumber,
        quoteDepth: ctx.quoteDepth,
        contentColumn: listColumns.length > 0 ? listColumns[listColumns.length - 1] : ctx.indent
      }
      continue
    }

    const containerMatch = CONTAINER_PATTERN.exec(openContent)
    if (containerMatch) {
      // 有 info string 是开容器（`::: tip 标题`），只有冒号是合（`:::`）
      if (containerMatch[2].trim() === '') containerDepth = Math.max(0, containerDepth - 1)
      else containerDepth += 1
      continue
    }

    // 文档级标题：不在引用里、不在列表项里、不在 `:::` 容器里（0–3 个前导空格是合法的）
    if (ctx.quoteDepth === 0 && listColumns.length === 0 && containerDepth === 0) {
      const headingMatch = ATX_HEADING_PATTERN.exec(ctx.rest)
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
