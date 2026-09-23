import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'

import type { Extension } from '@codemirror/state'
import type { Input } from '@lezer/common'
import type { BlockContext, InlineContext, Line, MarkdownConfig } from '@lezer/markdown'

const CONTAINER_OPEN = /^(:{3,})[ \t]*(.*)$/
const CONTAINER_CLOSE = /^(:{3,})[ \t]*$/
const FENCE = /^(`{3,}|~{3,})/

function lineContent(line: Line): string {
  return line.text.slice(line.pos)
}

/**
 * VitePress 风格的 `:::` 容器（`::: tip 标题` … `:::`），整块作为一个叶子节点。
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
        if (!open || !open[2].trim()) return false
        const start = cx.lineStart + line.pos
        const openEnd = cx.lineStart + line.text.length
        const markEnd = start + open[1].length
        const stack = [open[1].length]
        let fence: string | null = null
        let bodyStart = -1
        let bodyEnd = -1
        let closeFrom = -1
        let closeTo = -1
        while (cx.nextLine()) {
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
          cx.nextLine()
          cx.addElement(
            cx.elt('BlockMath', start, end, [
              cx.elt('MathMark', start, start + 2),
              cx.elt('MathMark', end - 2, end)
            ])
          )
          return true
        }
        if (rest.trim()) return false
        let end = cx.lineStart + line.text.length
        let closeFrom = -1
        const contentStart = end + 1
        while (cx.nextLine()) {
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

/** TNotes 笔记用的 Markdown 语言：GFM + 容器 + frontmatter + 公式，代码块按语言嵌套高亮。 */
export function tnotesMarkdown(): Extension {
  return markdown({
    base: markdownLanguage,
    codeLanguages: languages,
    extensions: [frontmatter, containers, math, { remove: ['Superscript', 'Subscript'] }],
    addKeymap: false
  })
}
