/**
 * Whether a note renders differently under `commonmark` and `visual` line
 * breaks: it has a soft line break inside a paragraph, list item or quote, a
 * run of 2+ blank lines between top-level blocks, or any blank line in a
 * callout body. A line scan,
 * not a parse, so the kb settings page can count affected notes cheaply; it
 * mirrors the rules of `@tnotesjs/ui/line-breaks`.
 */

const FENCE_OPEN = /^\s*(`{3,}|~{3,})/
const MATH_FENCE = /^\s*\$\$\s*$/
const CONTAINER_OPEN = /^\s*:{3,}\s*([\w-]+)/
const CONTAINER_CLOSE = /^\s*:{3,}\s*$/
const CALLOUT = /^(?:info|tip|warning|danger|details)$/
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/
const QUOTE = /^\s*>\s?/
/** Lines that are blocks of their own, never paragraph text. */
const NOT_TEXT =
  /^\s*(?:#{1,6}(?:\s|$)|[-*_](?:\s*[-*_]){2,}\s*$|=+\s*$|\||<|\[[^\]]+\]:\s|!?\[\[|\$\$|`{3,}|~{3,}|:{3,})/
const HARD_BREAK = /(?: {2,}|\\)$/

function stripFrontmatter(lines: string[]): string[] {
  if (lines[0]?.trim() !== '---') return lines
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  return end > 0 ? lines.slice(end + 1) : lines
}

function unquoted(line: string): string {
  let rest = line
  while (QUOTE.test(rest)) rest = rest.replace(QUOTE, '')
  return rest
}

function textOf(line: string): string | null {
  const rest = unquoted(line).replace(LIST_ITEM, '')
  if (!rest.trim() || NOT_TEXT.test(rest)) return null
  return rest
}

export function isLineBreakSensitive(source: string): boolean {
  const lines = stripFrontmatter(source.replace(/\r\n?/g, '\n').split('\n'))
  /** Container names, innermost last; blank runs only count at top level or in callouts. */
  const containers: string[] = []
  let fence: string | null = null
  let math = false
  /** Inside an HTML / component block, which runs to the next blank line. */
  let html = false
  let blankRun = 0
  /** Last non-blank line, or null right after a block boundary that has no gap rule. */
  let previous: string | null = null
  let previousInList = false

  for (const line of lines) {
    if (fence) {
      if (line.trim().startsWith(fence) && !line.trim().slice(fence.length).trim()) fence = null
      continue
    }
    if (math) {
      if (MATH_FENCE.test(line)) math = false
      continue
    }
    if (!line.trim()) {
      blankRun += 1
      html = false
      continue
    }
    if (html) continue

    const spaced = containers.every((name) => CALLOUT.test(name))
    const inCallout = spaced && containers.length > 0
    const indented = /^\s/.test(line)
    const listLine = LIST_ITEM.test(unquoted(line)) || (previousInList && indented)
    if (
      blankRun >= (inCallout ? 1 : 2) &&
      previous !== null &&
      spaced &&
      !(previousInList && listLine)
    ) {
      return true
    }

    if (
      blankRun === 0 &&
      previous !== null &&
      spaced &&
      !HARD_BREAK.test(previous) &&
      textOf(previous) !== null &&
      textOf(line) !== null &&
      !LIST_ITEM.test(unquoted(line)) &&
      QUOTE.test(previous) === QUOTE.test(line)
    ) {
      return true
    }

    blankRun = 0
    if (unquoted(line).trimStart().startsWith('<')) {
      html = true
      previous = line
      previousInList = false
      continue
    }
    const open = line.match(FENCE_OPEN)
    if (open) {
      fence = open[1]!
      previous = line
      previousInList = listLine
      continue
    }
    if (MATH_FENCE.test(line)) {
      math = true
      previous = line
      continue
    }
    if (CONTAINER_CLOSE.test(line)) {
      containers.pop()
      previous = line
      previousInList = false
      continue
    }
    const container = line.match(CONTAINER_OPEN)
    if (container) {
      containers.push(container[1]!.toLowerCase())
      previous = line
      previousInList = false
      continue
    }
    previous = line
    previousInList = listLine
  }
  return false
}
