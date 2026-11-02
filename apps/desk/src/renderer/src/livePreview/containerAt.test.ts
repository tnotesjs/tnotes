import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { containerAtCursor } from './containerAt'
import { tnotesMarkdown } from './language'

function at(doc: string, marker = '|'): string | null {
  const pos = doc.indexOf(marker)
  const state = EditorState.create({
    doc: doc.replace(marker, ''),
    selection: { anchor: pos },
    extensions: [tnotesMarkdown()]
  })
  ensureSyntaxTree(state, state.doc.length, 5000)
  return containerAtCursor(state)
}

describe('containerAtCursor', () => {
  it('reads the container type from the info line', () => {
    expect(at('::: tip 💡 TIP\n\n正文|\n\n:::\n')).toBe('tip')
    expect(at('::: details 标题\n|\n:::\n')).toBe('details')
    expect(at('::: code-group\n\n```js [a]\n|x\n```\n\n:::\n')).toBe('code-group')
  })

  it('is null outside any container and on the fence lines', () => {
    expect(at('# 标题\n\n正文|\n')).toBeNull()
    expect(at('::: tip|\n正文\n:::\n')).toBeNull()
    expect(at('::: tip\n正文\n:::|\n')).toBeNull()
    expect(at('::: tip\n正文\n:::\n\n后文|\n')).toBeNull()
  })

  it('treats an unclosed container body as inside', () => {
    expect(at('::: warning\n正文|')).toBe('warning')
  })
})
