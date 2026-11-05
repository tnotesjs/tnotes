/**
 * 标题编号：给整篇笔记的 ATX 标题加/剥层级编号。
 *
 * 规则：
 * - 编号前缀的规范形态：`N.` / `N.N.` / `N.N.N.` …（数字段 + 尾点 + 空白）。
 *   `# 1.5 倍速` 这类无尾点的小数不会被识别为编号。
 * - 编号按层级深度分配段数，与标题级别无关：栈式父级追踪，跳级（H1 直下 H6）
 *   也只占一段深度，即直接子标题恒为两段。
 * - renumberHeadings 是重排语义：先剥掉所有规范前缀，再重新编号；层级深度超过
 *   maxDepth 的标题不加前缀。
 * - stripHeadingNumbers 剥掉所有规范前缀。
 * - frontmatter、围栏代码块（``` / ~~~）与 `:::` 容器内的内容永远不碰。
 *   容器里的 `#` 只是排版，不占编号层级。
 */

import {
  clampHeadingNumberMaxDepth,
  HEADING_NUMBER_DEFAULT_MAX_DEPTH
} from '../../../../shared/headingNumbering'

const HEADING_RE = /^( {0,3})(#{1,6})(\s+)(.*)$/
const NUMBER_PREFIX_RE = /^\d+(?:\.\d+)*\.\s+/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
/** `::: tip` 开启；单独一行的 `:::` 且冒号不少于开启行时关闭。与实时预览的容器语法一致。 */
const CONTAINER_MARK_RE = /^( {0,3})(:{3,})[ \t]*(.*)$/

export interface HeadingNumberingResult {
  text: string
  changed: boolean
}

interface HeadingParts {
  indent: string
  hashes: string
  space: string
  text: string
}

interface TrackedLine {
  raw: string
  /** 非标题行（含 frontmatter / 围栏内行）为 null */
  heading: HeadingParts | null
}

/** 逐行拆解，跳过 frontmatter、围栏代码块和 `:::` 容器，标出可编号/可剥编号的标题行。 */
function scanLines(markdown: string): TrackedLine[] {
  const lines = markdown.split('\n')
  const tracked: TrackedLine[] = []
  let fence: { char: string; length: number } | null = null
  const containers: number[] = []
  let containerFence: string | null = null
  let inFrontmatter = false
  let frontmatterChecked = false

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]

    // frontmatter：仅当文件第一行是 --- 时进入，到下一个 --- 或 ... 结束
    if (!frontmatterChecked) {
      frontmatterChecked = true
      if (index === 0 && raw.trim() === '---') {
        inFrontmatter = true
        tracked.push({ raw, heading: null })
        continue
      }
    }
    if (inFrontmatter) {
      const trimmed = raw.trim()
      if (trimmed === '---' || trimmed === '...') inFrontmatter = false
      tracked.push({ raw, heading: null })
      continue
    }

    const fenceMatch = raw.match(FENCE_RE)
    if (fence) {
      // 关闭判定：同字符且长度不短于开围栏
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) {
        fence = null
      }
      tracked.push({ raw, heading: null })
      continue
    }
    if (containers.length > 0) {
      tracked.push({ raw, heading: null })
      if (containerFence) {
        if (raw.trimEnd().startsWith(containerFence) && raw.trim().replace(/[`~]/g, '') === '') {
          containerFence = null
        }
        continue
      }
      if (fenceMatch) {
        containerFence = fenceMatch[1]
        continue
      }
      const mark = CONTAINER_MARK_RE.exec(raw)
      if (mark && !mark[3].trim() && mark[2].length >= containers[containers.length - 1]) {
        containers.pop()
      } else if (mark?.[3].trim()) {
        containers.push(mark[2].length)
      }
      continue
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }
      tracked.push({ raw, heading: null })
      continue
    }
    const containerOpen = CONTAINER_MARK_RE.exec(raw)
    if (containerOpen?.[3].trim()) {
      containers.push(containerOpen[2].length)
      tracked.push({ raw, heading: null })
      continue
    }

    const headingMatch = raw.match(HEADING_RE)
    tracked.push({
      raw,
      heading: headingMatch
        ? {
            indent: headingMatch[1],
            hashes: headingMatch[2],
            space: headingMatch[3],
            text: headingMatch[4]
          }
        : null
    })
  }
  return tracked
}

function renderHeading(heading: HeadingParts, text: string): string {
  return `${heading.indent}${heading.hashes}${heading.space}${text}`
}

function stripAllPrefixes(lines: TrackedLine[]): TrackedLine[] {
  return lines.map(({ raw, heading }) => {
    if (!heading) return { raw, heading }
    const stripped = heading.text.replace(NUMBER_PREFIX_RE, '')
    if (stripped === heading.text) return { raw, heading }
    return { raw: renderHeading(heading, stripped), heading: { ...heading, text: stripped } }
  })
}

/**
 * 重排编号：剥掉所有规范前缀后按层级深度重新编号（兼作残留修复）。
 * 深度超过 maxDepth 的标题保持无前缀。
 */
export function renumberHeadings(
  markdown: string,
  maxDepth: number = HEADING_NUMBER_DEFAULT_MAX_DEPTH
): HeadingNumberingResult {
  const limit = clampHeadingNumberMaxDepth(maxDepth)
  const lines = stripAllPrefixes(scanLines(markdown))
  const levelStack: number[] = []
  const counters: number[] = []
  const text = lines
    .map(({ raw, heading }) => {
      if (!heading) return raw
      const level = heading.hashes.length
      while (levelStack.length > 0 && levelStack[levelStack.length - 1] >= level) {
        levelStack.pop()
      }
      const depth = levelStack.length
      levelStack.push(level)
      counters.length = depth + 1
      counters[depth] = (counters[depth] ?? 0) + 1
      if (depth + 1 > limit) return raw
      const prefix = `${counters.slice(0, depth + 1).join('.')}. `
      return renderHeading(heading, `${prefix}${heading.text}`)
    })
    .join('\n')
  return { text, changed: text !== markdown }
}

/** 剥掉所有标题的规范编号前缀。 */
export function stripHeadingNumbers(markdown: string): HeadingNumberingResult {
  const text = stripAllPrefixes(scanLines(markdown))
    .map((line) => line.raw)
    .join('\n')
  return { text, changed: text !== markdown }
}
