/**
 * kb-level line-break mode (`tnotes.json` → `markdown.lineBreaks`), shared by
 * the SSG and Desk's card renderers so both draw the same note the same way.
 *
 * `visual` keeps what the editor shows: a single newline renders as `<br>`, and
 * every blank line beyond the first between two top-level blocks becomes a
 * one-line spacer; inside callout bodies (title and closing fence included)
 * every blank line does. Lists and quotes keep CommonMark spacing; their inner blank lines
 * decide loose/tight and have no stable visual meaning. Fences, tables and
 * HTML are single tokens, so their contents are never touched.
 */

export type LineBreakMode = 'commonmark' | 'visual'

export const BLANK_LINE_CLASS = 'tn-blank-line'

export const BLANK_LINE_HTML = `<div class="${BLANK_LINE_CLASS}" aria-hidden="true"></div>\n`

export function resolveLineBreakMode(value: unknown): LineBreakMode {
  return value === 'visual' ? 'visual' : 'commonmark'
}

/** Structural subset of markdown-it's Token, so this module stays dependency-free. */
interface BlockToken {
  type: string
  block: boolean
  nesting: number
  level: number
  map: [number, number] | null
  content: string
}

interface CoreState {
  src: string
  tokens: BlockToken[]
  Token: new (type: string, tag: string, nesting: -1 | 0 | 1) => BlockToken
}

interface MarkdownLike {
  set(options: { breaks: boolean }): unknown
  core: { ruler: { push(name: string, rule: (state: CoreState) => void): void } }
}

const CALLOUT_OPEN = /^container_(?:info|tip|warning|danger|details)_open$/
const CONTAINER_FENCE = /^\s*:{3,}\s*$/

/** Callout bodies get spacers too; other containers render their own way. */
export function isSpacedContainer(type: string): boolean {
  return CALLOUT_OPEN.test(type)
}

interface Scope {
  level: number
  /** Line after the previous block in this scope; null before the first block. */
  lastEnd: number | null
  close?: string
  /** Callout bodies: the closing `:::` line, which spaces like a block. */
  closeLine?: number
  /**
   * Callout paragraphs have no margins standing in for the first blank line,
   * so every blank line there is a spacer; top-level runs drop one.
   */
  free: number
}

function blockEnd(token: BlockToken, lines: readonly string[]): number {
  const [start, mapEnd] = token.map!
  let end = mapEnd
  // markdown-it-container ends its map on the closing `:::` line itself.
  if (token.type.startsWith('container_') && CONTAINER_FENCE.test(lines[end] ?? '')) end += 1
  // Lists and quotes swallow one trailing blank line.
  while (end > start + 1 && !(lines[end - 1] ?? '').trim()) end -= 1
  return end
}

/** Inserts `tn-blank-line` spacers for the blank lines `visual` keeps. */
export function insertBlankLineSpacers(
  state: CoreState,
  spaced: (type: string) => boolean = isSpacedContainer
): void {
  const lines = state.src.split('\n')
  const out: BlockToken[] = []
  const stack: Scope[] = [{ level: 0, lastEnd: null, free: 1 }]
  const pushSpacers = (count: number, level: number): void => {
    for (; count > 0; count -= 1) {
      const spacer = new state.Token('html_block', '', 0)
      spacer.block = true
      spacer.level = level
      spacer.content = BLANK_LINE_HTML
      out.push(spacer)
    }
  }
  for (const token of state.tokens) {
    const scope = stack[stack.length - 1]!
    if (scope.close && token.type === scope.close && token.level === scope.level - 1) {
      if (scope.closeLine !== undefined && scope.lastEnd !== null) {
        pushSpacers(scope.closeLine - scope.lastEnd - scope.free, scope.level)
      }
      stack.pop()
      out.push(token)
      continue
    }
    if (token.block && token.map && token.nesting !== -1 && token.level === scope.level) {
      if (scope.lastEnd !== null) {
        pushSpacers(token.map[0] - scope.lastEnd - scope.free, scope.level)
      }
      const end = blockEnd(token, lines)
      scope.lastEnd = end
      out.push(token)
      if (token.nesting === 1 && spaced(token.type)) {
        // The title line spaces like a block, so does a closing fence.
        const closed = CONTAINER_FENCE.test(lines[end - 1] ?? '') && end - 1 > token.map[0]
        stack.push({
          level: token.level + 1,
          lastEnd: token.map[0] + 1,
          close: token.type.replace(/_open$/, '_close'),
          closeLine: closed ? end - 1 : undefined,
          free: 0
        })
      }
      continue
    }
    out.push(token)
  }
  state.tokens = out
}

/** Applies the mode to a markdown-it instance; `commonmark` leaves it untouched. */
export function useLineBreaks(md: MarkdownLike, mode: LineBreakMode): void {
  if (mode !== 'visual') return
  md.set({ breaks: true })
  md.core.ruler.push('tn_blank_lines', (state) => insertBlankLineSpacers(state))
}
