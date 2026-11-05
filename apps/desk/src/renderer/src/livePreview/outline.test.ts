import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { headingSections } from './headingFold'
import { tnotesMarkdown } from './language'
import { collectHeadings } from './outline'

function editor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [tnotesMarkdown()] })
}

const note = [
  '## 外',
  '',
  '::: tip',
  '## 容器',
  '',
  '::: warning',
  '## 内层',
  ':::',
  ':::',
  '',
  '## 后'
].join('\n')

describe('容器内标题不算大纲', () => {
  it('本页目录不含容器内标题', () => {
    expect(collectHeadings(editor(note)).map((heading) => heading.text)).toEqual(['外', '后'])
  })

  it('折叠边界只落在容器外的标题上', () => {
    expect(headingSections(editor(note)).map((section) => section.level)).toEqual([2, 2])
  })
})
