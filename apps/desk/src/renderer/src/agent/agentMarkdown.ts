import DOMPurify from 'dompurify'
import katex from 'katex'
import MarkdownIt from 'markdown-it'

const DOLLAR = 36

type AgentMarkdown = InstanceType<typeof MarkdownIt>

interface BlockToken {
  content: string
  markup: string
  block: boolean
  map: [number, number] | null
}

interface BlockState {
  src: string
  sCount: number[]
  blkIndent: number
  bMarks: number[]
  tShift: number[]
  eMarks: number[]
  line: number
  push(type: string, tag: string, nesting: number): BlockToken
}

interface InlineToken {
  content: string
  markup: string
}

interface InlineState {
  src: string
  pos: number
  posMax: number
  push(type: string, tag: string, nesting: number): InlineToken
}

/**
 * 给 markdown-it 接上 `$…$` / `$$…$$`。定界跟笔记的 `math` 对齐，但没有闭合美元符号时保持原文，
 * 避免流式输出写到一半时把后面的正文吞进公式。
 */
export function installMarkdownMath(markdown: AgentMarkdown): void {
  markdown.block.ruler.before('fence', 'math_block', mathBlock)
  markdown.inline.ruler.before('emphasis', 'math_inline', mathInline)
  markdown.renderer.rules.math_inline = (tokens, idx) => renderKatex(tokens[idx].content, false)
  markdown.renderer.rules.math_block = (tokens, idx) => renderKatex(tokens[idx].content, true)
}

export function createAgentMarkdown(): AgentMarkdown {
  const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
  installMarkdownMath(markdown)
  return markdown
}

export function renderAgentMarkdown(markdown: AgentMarkdown, text: string): string {
  return DOMPurify.sanitize(markdown.render(text || ''))
}

function renderKatex(source: string, displayMode: boolean): string {
  try {
    const html = katex.renderToString(source, { throwOnError: false, displayMode, output: 'html' })
    if (html) return displayMode ? `${html}\n` : html
  } catch {
    // 解析失败时退回源码，避免把公式吞掉。
  }
  const raw = displayMode ? `$$${source}$$` : `$${source}$`
  return `${escapeHtml(raw)}${displayMode ? '\n' : ''}`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 行首 `$$ … $$`。空内容、以及还没写到闭合 `$$` 的块，都不认。 */
function mathBlock(state: BlockState, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  if (start + 1 >= max) return false
  if (state.src.charCodeAt(start) !== DOLLAR || state.src.charCodeAt(start + 1) !== DOLLAR) return false

  const rest = state.src.slice(start + 2, max).trimEnd()
  let content = ''
  let nextLine = startLine
  if (rest.endsWith('$$') && rest.length >= 2) {
    content = rest.slice(0, -2)
    nextLine = startLine + 1
  } else if (!rest.trim()) {
    const lines: string[] = []
    let close = -1
    for (let line = startLine + 1; line < endLine; line += 1) {
      const lineStart = state.bMarks[line] + state.tShift[line]
      const current = state.src.slice(lineStart, state.eMarks[line]).trimEnd()
      if (current.endsWith('$$')) {
        close = line
        const before = current.slice(0, -2)
        if (before) lines.push(before)
        break
      }
      lines.push(state.src.slice(state.bMarks[line], state.eMarks[line]))
    }
    if (close < 0) return false
    content = lines.join('\n')
    nextLine = close + 1
  } else {
    return false
  }
  if (!content.trim()) return false
  if (silent) return true
  const token = state.push('math_block', 'div', 0)
  token.content = content
  token.markup = '$$'
  token.block = true
  token.map = [startLine, nextLine]
  state.line = nextLine
  return true
}

/**
 * `$…$`。不把 `$$` 当成行内；开口 `$` 后不能是空格；闭合 `$` 前不能是空格；
 * 闭合 `$` 后紧跟数字则不认；没有闭合时保持原文。
 */
const mathInline = (state: InlineState, silent: boolean): boolean => {
  const start = state.pos
  if (state.src.charCodeAt(start) !== DOLLAR) return false
  const after = state.src.charCodeAt(start + 1)
  if (after === DOLLAR || after === 32 || after === 9 || Number.isNaN(after)) return false
  for (let index = start + 1; index < state.posMax; index += 1) {
    const char = state.src.charCodeAt(index)
    if (char === 10 || char === 13) return false
    if (char === 92) {
      index += 1
      continue
    }
    if (char !== DOLLAR) continue
    const before = state.src.charCodeAt(index - 1)
    const following = state.src.charCodeAt(index + 1)
    if (before === 32 || before === 9) return false
    if (following >= 48 && following <= 57) return false
    if (index === start + 1) return false
    if (!silent) {
      const token = state.push('math_inline', 'span', 0)
      token.content = state.src.slice(start + 1, index)
      token.markup = '$'
    }
    state.pos = index + 1
    return true
  }
  return false
}
