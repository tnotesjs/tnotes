// @vitest-environment happy-dom

/**
 * 可视化视图选区采集：以**编辑器状态**为准（PM selection / NodeSelection / 代码编辑器选区），
 * 不用 DOM 文本推算位置。
 *
 * 覆盖验收里点名的几类：段落内选字、跨段落、普通代码块内部、代码组面板内部、
 * 整个特殊组件的节点选中态，以及"没有选区"。
 */
import { editorViewCtx, serializerCtx, type Editor } from '@milkdown/kit/core'
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, describe, expect, it } from 'vitest'

import {
  projectRawBlocksForMilkdown,
  rawBlockProjectionPlugins
} from '../editor/markdown/rawBlockProjection'
import { createDeskEditor } from '../markdown/deskEditor'
import { captureVisualSelection, rawBlockSubtype } from './visualSelection'

import type { EditorView } from '@milkdown/kit/prose/view'
import type { CodeMirrorCapture, VisualSelectionDeps } from './visualSelection'

const editors: Editor[] = []

afterEach(async () => {
  await Promise.all(editors.splice(0).map((editor) => editor.destroy()))
  document.body.replaceChildren()
})

async function setup(
  source: string,
  codeMirror?: () => CodeMirrorCapture | null
): Promise<{ view: EditorView; deps: VisualSelectionDeps }> {
  const root = document.createElement('div')
  root.className = 'milkdown'
  document.body.append(root)
  const handle = createDeskEditor({
    root,
    defaultValue: projectRawBlocksForMilkdown(source),
    codeBlock: {},
    isReadOnly: () => false,
    uploadImage: async () => ({ src: 'https://example.com/uploaded.png' })
  })
  handle.editor.use(rawBlockProjectionPlugins)
  editors.push(handle.editor)
  await handle.editor.create()
  const view = handle.editor.action((ctx) => ctx.get(editorViewCtx))
  const serialize = handle.editor.action((ctx) => ctx.get(serializerCtx))
  return {
    view,
    deps: {
      serializeDocument: (document) => serialize(document),
      ...(codeMirror ? { codeMirror } : {})
    }
  }
}

/** 选中文档里第一处 `needle`（按文本查找，构造 TextSelection） */
function selectText(view: EditorView, needle: string): void {
  let found: { from: number; to: number } | null = null
  view.state.doc.descendants((node, pos) => {
    if (found) return false
    if (!node.isTextblock) return true
    const index = node.textContent.indexOf(needle)
    if (index < 0) return true
    found = { from: pos + 1 + index, to: pos + 1 + index + needle.length }
    return false
  })
  if (!found) throw new Error(`没找到文本：${needle}`)
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, found.from, found.to))
  )
}

/** 找到第一个 `deskRawBlock`（特殊组件）的位置 */
function firstRawBlock(view: EditorView): number {
  let position = -1
  view.state.doc.forEach((node, offset) => {
    if (position < 0 && node.type.name === 'deskRawBlock') position = offset
  })
  if (position < 0) throw new Error('文档里没有 deskRawBlock')
  return position
}

describe('可视化视图选区采集', () => {
  it('没有选区时返回 empty（不抛异常、不编造内容）', async () => {
    const { view, deps } = await setup('第一段\n\n第二段\n')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    expect(captureVisualSelection(view, deps)).toEqual({
      empty: true,
      selectedText: '',
      blocks: []
    })
  })

  it('段落内选字：文字取自文档，相关块标 reserialized', async () => {
    const { view, deps } = await setup('第一段文字\n\n第二段\n')
    selectText(view, '段文字')
    const payload = captureVisualSelection(view, deps)
    expect(payload.empty).toBe(false)
    expect(payload.selectedText).toBe('段文字')
    expect(payload.blocks).toHaveLength(1)
    expect(payload.blocks[0].kind).toBe('paragraph')
    expect(payload.blocks[0].source).toBe('reserialized')
    expect(payload.blocks[0].markdown).toContain('第一段文字')
    // 可视化视图没有逐字源码坐标 → 不给 sourceRange
    expect(payload.range).toBeUndefined()
  })

  it('跨段落选择：相关块覆盖被选中的每一段', async () => {
    const { view, deps } = await setup('第一段\n\n第二段\n\n第三段\n')
    let from = -1
    let to = -1
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'paragraph') return true
      if (node.textContent.startsWith('第一段')) from = pos + 1
      if (node.textContent.startsWith('第三段')) to = pos + 1 + node.textContent.length
      return true
    })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
    const payload = captureVisualSelection(view, deps)
    expect(payload.blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph'
    ])
    expect(payload.selectedText).toContain('第一段')
    expect(payload.selectedText).toContain('第三段')
  })

  it('普通代码块内部（PM 选区）：给代码块上下文', async () => {
    const { view, deps } = await setup('```js\nconst a = 1\n```\n')
    selectText(view, 'const a = 1')
    const payload = captureVisualSelection(view, deps)
    expect(payload.selectedText).toBe('const a = 1')
    expect(payload.blocks).toHaveLength(1)
    expect(payload.blocks[0].kind).toBe('code')
    expect(payload.blocks[0].markdown).toContain('const a = 1')
  })

  it('代码编辑器（代码块 / 代码组面板）里的选区：只给块级上下文', async () => {
    const source = '::: code-group\n```js\nconst b = 2\n```\n:::\n'
    const capture: CodeMirrorCapture = { text: 'const b = 2', ranges: 1, blockPosition: -1 }
    const { view, deps } = await setup(source, () => capture)
    const rawPosition = firstRawBlock(view)
    ;(deps.codeMirror as () => CodeMirrorCapture) = () => ({
      text: 'const b = 2',
      ranges: 1,
      blockPosition: rawPosition
    })
    const payload = captureVisualSelection(view, deps)
    expect(payload.selectedText).toBe('const b = 2')
    // 细分类型要能看出"这是代码组"，而不是笼统的 raw-container
    expect(payload.blocks[0].kind).toBe('raw-block:code-group')
    // raw block 的源码是逐字原文
    expect(payload.blocks[0].source).toBe('raw')
    expect(payload.blocks[0].markdown).toContain('::: code-group')
  })

  it('代码编辑器多光标：明确不支持，不悄悄取其中一个', async () => {
    const { view, deps } = await setup('```js\nconst a = 1\n```\n', () => ({
      text: 'const a',
      ranges: 2,
      blockPosition: 0
    }))
    const payload = captureVisualSelection(view, deps)
    expect(payload.selectedText).toBe('')
    expect(payload.unsupportedReason).toContain('多个不连续选区')
  })

  it('raw block 细分类型：容器名 / 围栏语言 / 都识别不出时的兜底', () => {
    expect(rawBlockSubtype('::: code-group\n```js\n```\n:::')).toBe('code-group')
    expect(rawBlockSubtype('```mindmap\n- 前端\n```')).toBe('mindmap')
    expect(rawBlockSubtype(':::: tip 💡 提示\n正文\n::::')).toBe('tip')
    expect(rawBlockSubtype('<div>html</div>')).toBeNull()
  })

  it('整块节点选中态（特殊组件）：给类型 + 完整组件源码', async () => {
    const source = '::: code-group\n```js\nconst c = 3\n```\n:::\n'
    const { view, deps } = await setup(source)
    const position = firstRawBlock(view)
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)))
    const payload = captureVisualSelection(view, deps)
    expect(payload.empty).toBe(false)
    expect(payload.blocks).toHaveLength(1)
    expect(payload.blocks[0].kind).toBe('raw-block:code-group')
    // 逐字原文（不是重新序列化的）
    expect(payload.blocks[0].source).toBe('raw')
    expect(payload.blocks[0].markdown).toBe(source.trimEnd())
  })
})
