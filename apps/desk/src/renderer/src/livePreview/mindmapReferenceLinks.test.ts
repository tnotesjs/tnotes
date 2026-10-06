// @vitest-environment happy-dom
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MindmapPreviewProps } from '../editor/markdown/componentPreview'

const mindmapProps: MindmapPreviewProps[] = []

vi.mock('../editor/markdown/componentPreview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../editor/markdown/componentPreview')>()
  return {
    ...actual,
    mountMermaidPreview: () => ({ unmount: () => undefined, update: () => undefined }),
    // 思维导图要真实布局，happy-dom 没有：只记下交给导图的 props
    mountMindmapPreview: (_host: HTMLElement, props: MindmapPreviewProps) => {
      mindmapProps.push(props)
      return {
        unmount: () => undefined,
        update: (next: MindmapPreviewProps) => {
          mindmapProps.push(next)
        }
      }
    }
  }
})

import { livePreviewField, setFocused } from './decorations'
import { tnotesMarkdown } from './language'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  mindmapProps.splice(0)
  document.body.replaceChildren()
})

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const state = EditorState.create({ doc, extensions: [tnotesMarkdown(), livePreviewField] })
  ensureSyntaxTree(state, doc.length, 5000)
  const view = new EditorView({ state, parent })
  view.dispatch({ effects: setFocused.of(false) })
  views.push(view)
  return view
}

// todo 2026.10.05/05 的复现笔记
const NOTE = [
  '# 测试',
  '',
  '```mindmap [导图]',
  '- 参考 [百度][1]',
  '- 二维数组 `grid[0][1]`',
  '- dp[i][1] 转移',
  '```',
  '',
  '[1]: https://www.baidu.com',
  ''
].join('\n')

describe('mindmap card reference links', () => {
  it('passes the original fence body plus the note definitions to the mindmap', () => {
    mount(NOTE)
    const props = mindmapProps.at(-1)
    expect(props).toBeDefined()
    // 原文直接给导图，不再展开成圆括号链接
    expect(props!.source).toContain('- 参考 [百度][1]')
    expect(props!.source).toContain('- 二维数组 `grid[0][1]`')
    expect(props!.source).toContain('- dp[i][1] 转移')
    expect(props!.source).not.toContain('https://www.baidu.com')
    expect([...props!.linkDefinitions!.entries()]).toEqual([['1', 'https://www.baidu.com']])
  })

  it('writes the mindmap markdown back verbatim, keeping reference syntax', () => {
    const view = mount(NOTE)
    const props = mindmapProps.at(-1)!
    // 导图序列化未编辑节点用原 raw，被编辑节点仍写回 `[文字][id]`
    props.onMarkdownChange!(props.source.replace('转移', '转移X'))
    expect(view.state.doc.toString()).toBe(NOTE.replace('转移', '转移X'))
  })

  it('end to end: a real mindmap session edit keeps [百度][1] and code spans intact', async () => {
    const { MindmapSession } = await import('@tnotesjs/mindmap-core')
    const view = mount(NOTE)
    const props = mindmapProps.at(-1)!
    const session = new MindmapSession({
      markdown: props.source,
      definitions: props.linkDefinitions
    })
    const [ref, code, dp] = session.document.root.children
    expect(ref.content.text).toBe('参考 百度')
    expect(code.content.text).toBe('二维数组 grid[0][1]')
    session.updateNodeDisplayText(dp.id, `${dp.content.text}X`)
    session.updateNodeDisplayText(ref.id, '参考 百度一下')
    props.onMarkdownChange!(session.getMarkdown())
    const doc = view.state.doc.toString()
    expect(doc).toContain('- 参考 [百度一下][1]')
    expect(doc).toContain('- 二维数组 `grid[0][1]`')
    expect(doc).toContain('- dp[i][1] 转移X')
    expect(doc).toContain('[1]: https://www.baidu.com')
    expect(doc).not.toContain('](https://www.baidu.com)')
  })
})
