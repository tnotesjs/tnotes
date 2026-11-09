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

  it('首次解析窗口之后的标题也进目录', () => {
    const doc = [
      '普通段落，用来把后面的标题推过首次解析范围。',
      '',
      '## 前面',
      ''
    ].join('\n').repeat(120) + ['::: tip 里面', '## 容器里的标题', ':::', '', '## 后面的标题', ''].join('\n')
    expect(doc.length).toBeGreaterThan(3000)
    expect(collectHeadings(editor(doc)).at(-1)?.text).toBe('后面的标题')
    expect(collectHeadings(editor(doc)).some((heading) => heading.text === '容器里的标题')).toBe(
      false
    )
  })

  it('折叠边界只落在容器外的标题上', () => {
    expect(headingSections(editor(note)).map((section) => section.level)).toEqual([2, 2])
  })
})
