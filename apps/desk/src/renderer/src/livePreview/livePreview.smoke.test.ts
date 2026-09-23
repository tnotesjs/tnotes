// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../editor/markdown/componentPreview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../editor/markdown/componentPreview')>()
  const stub = () => ({ unmount: () => undefined, update: () => undefined })
  // mermaid / 思维导图要真实的 canvas 与布局，happy-dom 没有
  return { ...actual, mountMermaidPreview: stub, mountMindmapPreview: stub }
})

import { codeGroupTabs, livePreviewField, setFocused } from './decorations'
import { tnotesMarkdown } from './language'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const state = EditorState.create({
    doc,
    extensions: [tnotesMarkdown(), codeGroupTabs, livePreviewField]
  })
  ensureSyntaxTree(state, doc.length, 5000)
  const view = new EditorView({ state, parent })
  view.dispatch({ effects: setFocused.of(true) })
  views.push(view)
  return view
}

/** 光标逐行走一遍：每一步都会重算装饰（露出 / 隐藏标记、卡片进出） */
function walk(view: EditorView): void {
  const lines = view.state.doc.lines
  for (let number = 1; number <= lines; number += 1) {
    const line = view.state.doc.line(number)
    view.dispatch({ selection: EditorSelection.cursor(line.from + Math.floor(line.length / 2)) })
  }
  view.dispatch({ selection: EditorSelection.single(0, view.state.doc.length) })
}

const SAMPLE = [
  '---',
  'title: 示例',
  '---',
  '',
  '# 标题 **加粗**',
  '',
  '段落里有 *斜体*、`代码`、~~删除~~、[链接](https://example.com) 和 $x^2$。',
  '',
  '![图](../assets/0001-1.png) {w=300 align=center}',
  '',
  '- 一',
  '    - 二',
  '- [ ] 待办',
  '- [x] 完成',
  '',
  '1. 甲',
  '2. 乙',
  '',
  '> 引用',
  '',
  '---',
  '',
  '```js [a.js]',
  'const a = 1',
  '```',
  '',
  '::: code-group',
  '```js [a.js]',
  'a',
  '```',
  '```ts [b.ts]',
  'b',
  '```',
  ':::',
  '',
  '::: tip 提示',
  '内容',
  ':::',
  '',
  '```mermaid',
  'graph LR',
  '  A --> B',
  '```',
  '',
  '$$',
  'a^2+b^2=c^2',
  '$$',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '<BilibiliVideo id="BV1xx" />',
  '',
  '<!-- 注释 -->',
  ''
].join('\n')

describe('live preview decorations', () => {
  it('survives walking the cursor through every construct', () => {
    const view = mount(SAMPLE)
    expect(() => walk(view)).not.toThrow()
  })

  it('hides markers away from the cursor and reveals them on the cursor line', () => {
    const view = mount('# 标题\n\n正文 **粗体**\n')
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) })
    const text = view.contentDOM.textContent ?? ''
    expect(text).not.toContain('# ')
    expect(text).not.toContain('**')
    view.dispatch({ selection: EditorSelection.cursor(2) })
    expect(view.contentDOM.textContent).toContain('# 标题')
  })

  it('shows the clean rendering when the editor loses focus', () => {
    const view = mount('# 标题\n')
    view.dispatch({ selection: EditorSelection.cursor(2) })
    expect(view.contentDOM.textContent).toContain('# 标题')
    view.dispatch({ effects: setFocused.of(false) })
    expect(view.contentDOM.textContent).not.toContain('# ')
  })

  const docsKb = '/Users/huyouda/tnotesjs/kbs/TNotes.docs/notes'
  it.runIf(existsSync(docsKb))('handles every TNotes.docs note', () => {
    for (const name of readdirSync(docsKb).filter((file) => file.endsWith('.md'))) {
      const view = mount(readFileSync(join(docsKb, name), 'utf8'))
      expect(() => walk(view), name).not.toThrow()
      view.destroy()
    }
  }, 120_000)
})
