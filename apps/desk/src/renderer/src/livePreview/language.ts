import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'

import { deskCodeMirrorLanguages } from '../editor/markdown/codeMirrorLanguages'

import type { Extension } from '@codemirror/state'
import type { Input } from '@lezer/common'
import type { BlockContext, InlineContext, Line, MarkdownConfig } from '@lezer/markdown'

const CONTAINER_OPEN = /^(:{3,})[ \t]*(.*)$/
const CONTAINER_CLOSE = /^(:{3,})[ \t]*$/
const FENCE = /^(`{3,}|~{3,})/

/** 原地编辑的提示块：开启行和结束行各自成节点，中间是普通正文。 */
export const CALLOUT_NAMES = new Set(['tip', 'info', 'warning', 'danger', 'details'])

function lineContent(line: Line): string {
  return line.text.slice(line.pos)
}

// `Line.depth` is public at runtime but missing from @lezer/markdown's typings; without
// this check a multi-line leaf would swallow the close line of the enclosing Callout.
function insideParent(cx: BlockContext, line: Line): boolean {
  return (line as Line & { depth: number }).depth >= cx.depth
}

function calloutOpenMatch(text: string): RegExpExecArray | null {
  const open = CONTAINER_OPEN.exec(text)
  if (!open) return null
  const name = open[2].trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return CALLOUT_NAMES.has(name) ? open : null
}

function isCalloutFenceLine(line: Line): boolean {
  if (line.indent - line.baseIndent >= 4) return false
  const text = lineContent(line)
  return Boolean(CONTAINER_CLOSE.exec(text) || calloutOpenMatch(text))
}

/**
 * 顶层的 `::: tip 标题` … `:::` 是一个复合块（和引用块一样），正文按普通 Markdown 解析，
 * 可以像正文一样直接编辑。闭合与 markdown-it-container 一致：第一行冒号数不少于开启行的
 * `:::` 关闭容器，哪怕它落在没闭合的围栏里。容器里再写的开启行不嵌套，单独成 CalloutOpen；
 * 不在容器里的 `:::` 单独成 CalloutClose。
 */
const callouts: MarkdownConfig = {
  defineNodes: [
    {
      name: 'Callout',
      block: true,
      composite(cx, line, colons) {
        if (line.indent - line.baseIndent >= 4) return true
        const close = CONTAINER_CLOSE.exec(lineContent(line))
        if (!close || close[1].length < colons) return true
        const start = cx.lineStart + line.pos
        line.addMarker(cx.elt('CalloutMark', start, start + close[1].length))
        line.moveBase(line.text.length)
        return false
      }
    },
    { name: 'CalloutOpen', block: true },
    { name: 'CalloutClose', block: true },
    { name: 'CalloutMark', style: tags.processingInstruction },
    { name: 'CalloutInfo', style: tags.labelName }
  ],
  parseBlock: [
    {
      name: 'Callout',
      before: 'FencedCode',
      parse(cx: BlockContext, line: Line): boolean | null {
        if (line.indent - line.baseIndent >= 4) return false
        const text = lineContent(line)
        const start = cx.lineStart + line.pos
        const end = cx.lineStart + line.text.length
        const open = calloutOpenMatch(text)
        if (open) {
          const mark = cx.elt('CalloutMark', start, start + open[1].length)
          const info = cx.elt('CalloutInfo', end - open[2].length, end)
          if (cx.depth === 1) {
            cx.startComposite('Callout', line.pos, open[1].length)
            cx.addElement(mark)
            cx.addElement(info)
            line.moveBase(line.text.length)
            return null
          }
          cx.addElement(cx.elt('CalloutOpen', start, end, [mark, info]))
          cx.nextLine()
          return true
        }
        const close = CONTAINER_CLOSE.exec(text)
        if (!close) return false
        cx.addElement(
          cx.elt('CalloutClose', start, end, [
            cx.elt('CalloutMark', start, start + close[1].length)
          ])
        )
        cx.nextLine()
        return true
      },
      endLeaf: (_cx, line) => isCalloutFenceLine(line)
    }
  ]
}

/**
 * 提示块以外的 `:::` 容器（`::: code-group` … `:::`），整块作为一个叶子节点。
 *
 * 闭合规则与 markdown-it-container 一致：只由冒号组成、且冒号数不少于开启行的那一行
 * 关闭当前层；更短的开启行是内层容器。容器内部的围栏代码里出现的 `:::` 不算。
 */
const containers: MarkdownConfig = {
  defineNodes: [
    { name: 'Container', block: true },
    { name: 'ContainerMark', style: tags.processingInstruction },
    { name: 'ContainerInfo', style: tags.labelName },
    { name: 'ContainerBody' }
  ],
  parseBlock: [
    {
      name: 'Container',
      before: 'FencedCode',
      parse(cx: BlockContext, line: Line): boolean {
        if (line.indent >= 4) return false
        const open = CONTAINER_OPEN.exec(lineContent(line))
        if (!open || !open[2].trim() || calloutOpenMatch(open[0])) return false
        const start = cx.lineStart + line.pos
        const openEnd = cx.lineStart + line.text.length
        const markEnd = start + open[1].length
        const stack = [open[1].length]
        let fence: string | null = null
        let bodyStart = -1
        let bodyEnd = -1
        let closeFrom = -1
        let closeTo = -1
        while (cx.nextLine() && insideParent(cx, line)) {
          const text = lineContent(line)
          if (bodyStart < 0) bodyStart = cx.lineStart
          if (fence) {
            if (text.trimEnd().startsWith(fence) && text.trim().replace(/[`~]/g, '') === '') {
              fence = null
            }
            bodyEnd = cx.lineStart + line.text.length
            continue
          }
          const fenceOpen = FENCE.exec(text)
          if (fenceOpen) {
            fence = fenceOpen[1]
            bodyEnd = cx.lineStart + line.text.length
            continue
          }
          const close = CONTAINER_CLOSE.exec(text)
          if (close && close[1].length >= stack[stack.length - 1]) {
            stack.pop()
            if (stack.length === 0) {
              closeFrom = cx.lineStart + line.pos
              closeTo = cx.lineStart + line.text.length
              cx.nextLine()
              break
            }
          } else {
            const nested = CONTAINER_OPEN.exec(text)
            if (nested && nested[2].trim()) stack.push(nested[1].length)
          }
          bodyEnd = cx.lineStart + line.text.length
        }
        const children = [cx.elt('ContainerMark', start, markEnd)]
        const infoStart = openEnd - open[2].length
        if (open[2].trim()) children.push(cx.elt('ContainerInfo', infoStart, openEnd))
        if (bodyStart >= 0 && bodyEnd > bodyStart) {
          children.push(cx.elt('ContainerBody', bodyStart, bodyEnd))
        }
        let end = bodyEnd > 0 ? bodyEnd : openEnd
        if (closeFrom >= 0) {
          children.push(cx.elt('ContainerMark', closeFrom, closeTo))
          end = closeTo
        }
        cx.addElement(cx.elt('Container', start, end, children))
        return true
      }
    }
  ]
}

/** 文档开头的 YAML frontmatter（`---` … `---`），必须闭合才算。 */
const frontmatter: MarkdownConfig = {
  defineNodes: [
    { name: 'Frontmatter', block: true },
    { name: 'FrontmatterMark', style: tags.processingInstruction },
    { name: 'FrontmatterBody', style: tags.meta }
  ],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx: BlockContext, line: Line): boolean {
        if (cx.lineStart !== 0 || line.text.trimEnd() !== '---') return false
        // 闭合行要先向前看（解析器不能回退）；input 是 lezer 的内部字段，拿不到就不认 frontmatter
        const input = (cx as unknown as { input?: Input }).input
        if (!input) return false
        const source = input.read(0, Math.min(input.length, 64 * 1024))
        const close = /\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(source.slice(3))
        if (!close) return false
        const closeStart = 3 + close.index + 1
        const closeEnd = closeStart + close[0].trim().length
        while (cx.lineStart < closeStart && cx.nextLine()) {
          /* 逐行跨过 frontmatter 正文 */
        }
        cx.nextLine()
        const children = [cx.elt('FrontmatterMark', 0, 3)]
        if (closeStart - 1 > 4) children.push(cx.elt('FrontmatterBody', 4, closeStart - 1))
        children.push(cx.elt('FrontmatterMark', closeStart, closeEnd))
        cx.addElement(cx.elt('Frontmatter', 0, closeEnd, children))
        return true
      }
    }
  ]
}

const COMPONENT_OPEN = /^(<(?:NotesTable|BilibiliVideo|WordList)\b)/

/**
 * 独占一段的 Vue 组件（`<NotesTable />`、`<BilibiliVideo />`、`<WordList>`）。
 * 标准 Markdown 会把它们当成段落里的 HTML，显示层就无法换成卡片。
 */
const componentBlock: MarkdownConfig = {
  defineNodes: [{ name: 'ComponentBlock', block: true, style: tags.content }],
  parseBlock: [
    {
      name: 'ComponentBlock',
      before: 'HTMLBlock',
      parse(cx: BlockContext, line: Line): boolean {
        if (line.indent >= 4) return false
        if (!COMPONENT_OPEN.test(lineContent(line))) return false
        const start = cx.lineStart + line.pos
        let end = cx.lineStart + line.text.length
        if (!lineContent(line).includes('>')) {
          while (cx.nextLine()) {
            const current = lineContent(line)
            if (current.trim() === '') break
            end = cx.lineStart + line.text.length
            if (current.includes('>')) {
              cx.nextLine()
              break
            }
          }
        } else {
          cx.nextLine()
        }
        cx.addElement(cx.elt('ComponentBlock', start, end))
        return true
      }
    }
  ]
}

const DOLLAR = 36

/** `$$ … $$` 块级公式与 `$…$` 行内公式（规则与 remark-math 的常见用法一致）。 */
const math: MarkdownConfig = {
  defineNodes: [
    { name: 'BlockMath', block: true },
    { name: 'InlineMath' },
    { name: 'MathMark', style: tags.processingInstruction },
    { name: 'MathContent', style: tags.special(tags.content) }
  ],
  parseBlock: [
    {
      name: 'BlockMath',
      before: 'FencedCode',
      parse(cx: BlockContext, line: Line): boolean {
        if (line.indent >= 4) return false
        const text = lineContent(line)
        if (!text.startsWith('$$')) return false
        const start = cx.lineStart + line.pos
        const rest = text.slice(2).trimEnd()
        if (rest.endsWith('$$') && rest.length >= 2) {
          const end = cx.lineStart + line.pos + 2 + rest.length
          const children = [cx.elt('MathMark', start, start + 2)]
          if (end - 2 > start + 2) children.push(cx.elt('MathContent', start + 2, end - 2))
          children.push(cx.elt('MathMark', end - 2, end))
          cx.nextLine()
          cx.addElement(cx.elt('BlockMath', start, end, children))
          return true
        }
        if (rest.trim()) return false
        let end = cx.lineStart + line.text.length
        let closeFrom = -1
        const contentStart = end + 1
        while (cx.nextLine() && insideParent(cx, line)) {
          const current = lineContent(line).trimEnd()
          if (current.endsWith('$$')) {
            closeFrom = cx.lineStart + line.pos + current.length - 2
            end = closeFrom + 2
            cx.nextLine()
            break
          }
          end = cx.lineStart + line.text.length
        }
        const children = [cx.elt('MathMark', start, start + 2)]
        const contentEnd = closeFrom >= 0 ? closeFrom : end
        if (contentEnd > contentStart) {
          children.push(cx.elt('MathContent', contentStart, contentEnd))
        }
        if (closeFrom >= 0) children.push(cx.elt('MathMark', closeFrom, end))
        cx.addElement(cx.elt('BlockMath', start, end, children))
        return true
      }
    }
  ],
  parseInline: [
    {
      name: 'InlineMath',
      before: 'Escape',
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== DOLLAR || cx.char(pos + 1) === DOLLAR) return -1
        const after = cx.char(pos + 1)
        if (after === 32 || after === 9 || after === -1) return -1
        for (let index = pos + 1; index < cx.end; index += 1) {
          const char = cx.char(index)
          if (char === 92) {
            index += 1
            continue
          }
          if (char !== DOLLAR) continue
          const before = cx.char(index - 1)
          const following = cx.char(index + 1)
          if (before === 32 || before === 9) return -1
          if (following >= 48 && following <= 57) return -1
          if (index === pos + 1) return -1
          return cx.addElement(
            cx.elt('InlineMath', pos, index + 1, [
              cx.elt('MathMark', pos, pos + 1),
              cx.elt('MathContent', pos + 1, index),
              cx.elt('MathMark', index, index + 1)
            ])
          )
        }
        return -1
      }
    }
  ]
}

/**
 * `classHighlighter` 没有 `tags.strikethrough`。不补上的话，可视化藏掉 `~~` 之后正文没有中线。
 */
export const strikethroughHighlight: Extension = syntaxHighlighting(
  HighlightStyle.define([{ tag: tags.strikethrough, class: 'tok-strikethrough' }])
)

/** TNotes 笔记用的 Markdown 语言：GFM + 容器 + frontmatter + 公式，代码块按语言嵌套高亮。 */
export function tnotesMarkdown(): Extension {
  return [
    strikethroughHighlight,
    indentUnit.of('    '),
    markdown({
      base: markdownLanguage,
      codeLanguages: deskCodeMirrorLanguages,
      extensions: [
        frontmatter,
        callouts,
        containers,
        componentBlock,
        math,
        { remove: ['Superscript', 'Subscript'] }
      ],
      addKeymap: false
    })
  ]
}
