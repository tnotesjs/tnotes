import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { tnotesMarkdown } from './language'

function topLevel(doc: string): Array<{ name: string; text: string }> {
  const state = EditorState.create({ doc, extensions: [tnotesMarkdown()] })
  const tree = ensureSyntaxTree(state, doc.length, 5000)
  if (!tree) throw new Error('parse timeout')
  const nodes: Array<{ name: string; text: string }> = []
  const cursor = tree.cursor()
  if (!cursor.firstChild()) return nodes
  do {
    nodes.push({ name: cursor.name, text: doc.slice(cursor.from, cursor.to) })
  } while (cursor.nextSibling())
  return nodes
}

function names(doc: string, nodeName: string): string[] {
  const state = EditorState.create({ doc, extensions: [tnotesMarkdown()] })
  const tree = ensureSyntaxTree(state, doc.length, 5000)!
  const found: string[] = []
  tree.iterate({
    enter(node) {
      if (node.name === nodeName) found.push(doc.slice(node.from, node.to))
    }
  })
  return found
}

describe('tnotesMarkdown', () => {
  it('parses frontmatter only at document start', () => {
    const doc = '---\ntitle: 闭包\n---\n\n# 闭包\n\n正文\n'
    expect(topLevel(doc).map((node) => node.name)).toEqual(['Frontmatter', 'ATXHeading1', 'Paragraph'])
    expect(topLevel(doc)[0].text).toBe('---\ntitle: 闭包\n---')
  })

  it('treats an unclosed leading --- as a thematic break', () => {
    expect(topLevel('---\n\n正文\n')[0].name).toBe('HorizontalRule')
  })

  it('parses containers with nested containers and fenced ::: lines', () => {
    const doc = [
      ':::: tip 外层',
      '外层正文',
      '::: warning 内层',
      '内层',
      ':::',
      '```md',
      ':::',
      '```',
      '::::',
      '',
      '后续段落'
    ].join('\n')
    const nodes = topLevel(doc)
    expect(nodes.map((node) => node.name)).toEqual(['Container', 'Paragraph'])
    expect(nodes[0].text.endsWith('::::')).toBe(true)
  })

  it('parses code-group containers as one block', () => {
    const doc = '::: code-group\n```js [a.js]\na\n```\n```js [b.js]\nb\n```\n:::\n'
    expect(topLevel(doc).map((node) => node.name)).toEqual(['Container'])
    expect(names(doc, 'ContainerInfo')).toEqual(['code-group'])
  })

  it('parses block and inline math', () => {
    const doc = '$$\na^2+b^2\n$$\n\n价格 $5 和 $x^2$ 公式\n'
    expect(topLevel(doc)[0].name).toBe('BlockMath')
    expect(names(doc, 'InlineMath')).toEqual(['$x^2$'])
  })

  it('keeps GFM tables, task lists and strikethrough', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] 待办\n\n~~删~~\n'
    expect(topLevel(doc).map((node) => node.name)).toEqual(['Table', 'BulletList', 'Paragraph'])
    expect(names(doc, 'TaskMarker')).toEqual(['[ ]'])
    expect(names(doc, 'Strikethrough')).toEqual(['~~删~~'])
  })
})
