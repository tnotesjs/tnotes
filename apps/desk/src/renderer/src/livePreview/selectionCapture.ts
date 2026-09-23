import { syntaxTree } from '@codemirror/language'

import type { EditorState } from '@codemirror/state'
import type { EditorSelectionAnchor, EditorSelectionPayload } from '../selection/selectionReporter'

const BLOCK_KINDS: Record<string, string> = {
  Paragraph: 'paragraph',
  BulletList: 'list',
  OrderedList: 'list',
  Blockquote: 'blockquote',
  FencedCode: 'code',
  CodeBlock: 'code',
  Container: 'container',
  Table: 'table',
  HTMLBlock: 'html',
  CommentBlock: 'html',
  BlockMath: 'math',
  Frontmatter: 'frontmatter',
  HorizontalRule: 'thematic-break',
  LinkReference: 'reference-definition'
}

function blockKind(name: string): string {
  if (name.startsWith('ATXHeading') || name.startsWith('SetextHeading')) return 'heading'
  return BLOCK_KINDS[name] ?? name.toLowerCase()
}

/**
 * 选区采集。编辑器里只有一份源码，所以选区的偏移**就是**源码偏移：
 * 可视化与源码两种视图给出的是同一种精确范围（UTF-16 码元，左闭右开）。
 */
export function captureSelection(state: EditorState): EditorSelectionPayload {
  const ranges = state.selection.ranges.filter((range) => !range.empty)
  if (ranges.length === 0) return { empty: true, selectedText: '', blocks: [] }
  if (ranges.length > 1) {
    return {
      empty: false,
      selectedText: '',
      blocks: [],
      unsupportedReason: `暂不支持多个不连续选区（当前 ${ranges.length} 处）`
    }
  }
  const { from, to } = ranges[0]
  const doc = state.doc
  const startLine = doc.lineAt(from)
  const endLine = doc.lineAt(to)
  const blocks: EditorSelectionPayload['blocks'] = []
  const cursor = syntaxTree(state).cursor()
  if (cursor.firstChild()) {
    do {
      if (cursor.to < from || cursor.from > to) continue
      const first = doc.lineAt(cursor.from)
      const last = doc.lineAt(cursor.to)
      blocks.push({
        kind: blockKind(cursor.name),
        markdown: doc.sliceString(first.from, last.to),
        source: 'raw',
        sourceRange: { startLine: first.number, endLine: last.number }
      })
    } while (cursor.nextSibling())
  }
  const range = {
    startLine: startLine.number,
    startColumn: from - startLine.from + 1,
    endLine: endLine.number,
    endColumn: to - endLine.from + 1,
    startOffset: from,
    endOffset: to,
    lineBase: 1 as const,
    columnBase: 1 as const,
    endExclusive: true as const
  }
  const anchor: EditorSelectionAnchor = { view: 'source', kind: 'source-range', sourceRange: range }
  return {
    empty: false,
    selectedText: doc.sliceString(from, to),
    range,
    blocks,
    anchor
  }
}
