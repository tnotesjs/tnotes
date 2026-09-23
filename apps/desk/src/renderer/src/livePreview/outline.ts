import { syntaxTree } from '@codemirror/language'

import type { EditorState } from '@codemirror/state'
import type { NoteOutlineHeading } from '../markdown/noteOutline'

export interface OutlineHeading extends NoteOutlineHeading {
  from: number
}

/** 从语法树取标题（容器、代码块里的 `#` 不算）。`id` 用标题起点，随编辑变化。 */
export function collectHeadings(state: EditorState): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  const doc = state.doc
  syntaxTree(state).iterate({
    enter(node) {
      const match = /^(ATX|Setext)Heading([1-6])$/.exec(node.name)
      if (!match) {
        return node.name === 'Document' || node.name === 'Blockquote' || node.name.endsWith('List') || node.name === 'ListItem'
      }
      const level = Number(match[2]) as NoteOutlineHeading['level']
      let text = doc.sliceString(node.from, node.to)
      if (match[1] === 'ATX') {
        text = text.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '')
      } else {
        text = text.split('\n')[0]
      }
      text = text
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_~`]/g, '')
        .trim()
      if (text) headings.push({ id: `h-${node.from}`, level, text, from: node.from })
      return false
    }
  })
  return headings
}
