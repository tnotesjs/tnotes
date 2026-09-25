import { markdownLanguage } from '@codemirror/lang-markdown'
import type { ChangeSpec, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { parseMarkdownSource } from '../editor/markdown/sourcePreservation'

const styleNodes = new Set(['Emphasis', 'StrongEmphasis', 'Strikethrough'])
const opaqueKinds = new Set([
  'raw-frontmatter',
  'raw-component',
  'raw-reference-definition',
  'raw-fence',
  'indented-code',
  'html',
  'math'
])

/** 与编辑器无关的改动描述（Monaco / CodeMirror 都能吃同一份） */
export interface SourceLineStyleChange {
  from: number
  to: number
  insert: string
}

/**
 * 与编辑器无关的实现：输入原文与选区偏移，输出要应用的改动。
 *
 * 抽出来是因为源码视图已经从 CodeMirror 换成 Monaco，而这段逻辑必须逐字节保持
 * （Lezer 解析与保护块判定都不依赖编辑器）。
 */
export function sourceLineStyleChangesFor(
  source: string,
  selectionFrom: number,
  selectionTo: number
): SourceLineStyleChange[] {
  const lineStartAt = (offset: number): number => {
    const index = source.lastIndexOf('\n', Math.max(0, offset - 1))
    return index + 1
  }
  const lineEndAt = (offset: number): number => {
    const index = source.indexOf('\n', offset)
    return index === -1 ? source.length : index
  }
  const from = lineStartAt(selectionFrom)
  // A selection ending at column zero does not include that next line.
  const last =
    selectionTo !== selectionFrom && lineStartAt(selectionTo) === selectionTo
      ? selectionTo - 1
      : selectionTo
  const to = lineEndAt(last)
  const protectedBlocks = parseMarkdownSource(source).blocks.filter((block) =>
    opaqueKinds.has(block.kind)
  )
  const changes: SourceLineStyleChange[] = []
  const insertions = new Map<number, { marker: string; order: number }[]>()
  const insert = (pos: number, marker: string, order: number): void => {
    const items = insertions.get(pos) ?? []
    items.push({ marker, order })
    insertions.set(pos, items)
  }
  // Parse as GFM even though the source editor's highlighting uses CommonMark:
  // strikethrough is a Desk style too. Code, escaped punctuation and URLs remain
  // opaque, so regex stripping cannot corrupt their literal asterisks/tildes.
  markdownLanguage.parser.parse(source).iterate({
    enter: (ref): boolean | void => {
      if (!styleNodes.has(ref.name) || ref.to <= from || ref.from >= to) return
      if (protectedBlocks.some((block) => ref.from < block.to && ref.to > block.from)) return false
      const open = ref.node.firstChild!
      const close = ref.node.lastChild!
      const marker = source.slice(open.from, open.to)
      // When formatting spans multiple lines, close/reopen it around the target
      // lines. This keeps styles on unselected lines instead of stripping the
      // entire multi-line emphasis node.
      const left = source.slice(open.to, Math.min(from, close.from)).trimEnd()
      if (open.from < from && left.length > 0) {
        insert(open.to + left.length, marker, -ref.from)
      } else {
        changes.push({ from: open.from, to: open.to, insert: '' })
      }
      const rightFrom = Math.max(to, open.to)
      const right = source.slice(rightFrom, close.from)
      const trimmedRight = right.trimStart()
      if (close.to > to && trimmedRight.length > 0) {
        // Quote prefixes belong to the block, not the continued inline span.
        const quotePrefix = trimmedRight.match(/^(?:>\s*)+/)?.[0].length ?? 0
        insert(rightFrom + right.length - trimmedRight.length + quotePrefix, marker, ref.from)
      } else {
        changes.push({ from: close.from, to: close.to, insert: '' })
      }
    }
  })
  for (const [pos, parts] of insertions) {
    changes.push({
      from: pos,
      to: pos,
      insert: parts
        .sort((a, b) => a.order - b.order)
        .map((part) => part.marker)
        .join('')
    })
  }
  return changes.sort((a, b) => a.from - b.from || a.to - b.to)
}

/** Remove Markdown style delimiters, not literal punctuation or other syntax. */
export function sourceLineStyleChanges(state: EditorState): ChangeSpec[] {
  const range = state.selection.main
  return sourceLineStyleChangesFor(state.doc.toString(), range.from, range.to)
}

// Clears line-level markdown markers in the source view.
export function clearSourceLineStyles(view: EditorView): boolean {
  if (view.state.readOnly) return false
  const changes = sourceLineStyleChanges(view.state)
  if (changes.length)
    view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.clearLineStyles' })
  return true
}
