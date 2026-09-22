// @vitest-environment happy-dom
//
// 固定上下文锚点的校验判据。
//
// 两条重点：
// 1. **位置判据**（跨视图 / 磁盘）：只认"同一偏移范围上还是不是同一段文字"，
//    所以"A 前插入内容 → 坐标变化"会失效、别处的相同文字不能顶替原位置；
// 2. **可视化判据**：比**选区文本**而不是整块 Markdown —— 同一段落里选区后方的修改
//    不该误伤固定；选区内部修改或前方插入才失效。
import { editorViewCtx, serializerCtx, type Editor } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, describe, expect, it } from 'vitest'

import {
  projectRawBlocksForMilkdown,
  rawBlockProjectionPlugins
} from '../editor/markdown/rawBlockProjection'
import { createDeskEditor } from '../markdown/deskEditor'
import { validateTextAnchor, validateVisualAnchor } from './pinnedAnchorCheck'
import { captureVisualSelection } from './visualSelection'

import type { EditorView } from '@milkdown/kit/prose/view'
import type { PinnedSelectionAnchor } from '../../../shared/contracts'

const editors: Editor[] = []

afterEach(async () => {
  await Promise.all(editors.splice(0).map((editor) => editor.destroy()))
  document.body.replaceChildren()
})

async function setup(
  source: string
): Promise<{ view: EditorView; deps: Parameters<typeof validateVisualAnchor>[3] }> {
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
  return { view, deps: { serializeDocument: (document) => serialize(document) } }
}

function selectText(view: EditorView, needle: string): { from: number; to: number } {
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
  return found
}

/** 捕获当前选区并返回它的锚点 */
function pinAnchor(view: EditorView, deps: Parameters<typeof validateVisualAnchor>[3]) {
  const payload = captureVisualSelection(view, deps)
  if (!payload.anchor) throw new Error('没有锚点')
  return { anchor: payload.anchor as PinnedSelectionAnchor, text: payload.selectedText }
}

describe('位置判据（跨视图 / 磁盘复核）', () => {
  const anchor: PinnedSelectionAnchor = {
    view: 'visual',
    kind: 'block',
    textRange: { startOffset: 3, endOffset: 10, expected: 'AAA BBB' }
  }

  it('同一范围仍是同一段文字 → 有效', () => {
    expect(validateTextAnchor('头部：AAA BBB 尾巴', anchor)).toEqual({ valid: true })
  })

  it('前方插入内容让坐标变化 → 失效（不是全文搜到就算）', () => {
    const shifted = '插入了一段。头部：AAA BBB 尾巴'
    const result = validateTextAnchor(shifted, anchor)
    expect(result?.valid).toBe(false)
  })

  it('原位置被删除、别处仍有相同文字 → 失效', () => {
    const replaced = '头部：XXXXXX 尾巴，后面还有 AAA BBB'
    const result = validateTextAnchor(replaced, anchor)
    expect(result?.valid).toBe(false)
  })

  it('只改原位置后方 → 保留', () => {
    expect(validateTextAnchor('头部：AAA BBB 尾巴（后面加了字）', anchor)).toEqual({ valid: true })
  })

  it('没有位置锚 → 返回 null（上层应当保守失效，而不是全文搜索）', () => {
    expect(validateTextAnchor('随便什么', { view: 'visual', kind: 'block' })).toBeNull()
  })
})

describe('可视化判据（同视图内）', () => {
  it('同一段落里选区**后方**的修改：固定保留（不按整块比较）', async () => {
    const { view, deps } = await setup('AAA BBB\n')
    selectText(view, 'AAA')
    const { anchor, text } = pinAnchor(view, deps)
    expect(anchor.blocks?.[0]?.markdown).toContain('AAA BBB')
    expect(validateVisualAnchor(view, anchor, text, deps)).toEqual({ valid: true })

    // 只改后面的 BBB
    view.dispatch(view.state.tr.insertText('CCC', view.state.doc.content.size - 1))
    expect(validateVisualAnchor(view, anchor, text, deps)).toEqual({ valid: true })
  })

  it('选区内部被修改 → 失效', async () => {
    const { view, deps } = await setup('AAA BBB\n')
    const range = selectText(view, 'AAA')
    const { anchor, text } = pinAnchor(view, deps)
    view.dispatch(view.state.tr.insertText('X', range.from + 1))
    const result = validateVisualAnchor(view, anchor, text, deps)
    expect(result?.valid).toBe(false)
  })

  it('选区前方插入内容导致坐标变化 → 失效', async () => {
    const { view, deps } = await setup('AAA BBB\n')
    selectText(view, 'AAA')
    const { anchor, text } = pinAnchor(view, deps)
    view.dispatch(view.state.tr.insertText('前缀 ', 1))
    const result = validateVisualAnchor(view, anchor, text, deps)
    expect(result?.valid).toBe(false)
  })

  it('跨段落选区：另一段被改 → 失效；只改选区后方 → 保留', async () => {
    const { view, deps } = await setup('第一段。\n\n第二段。\n\n第三段。\n')
    const from = selectText(view, '第一段。').from
    const to = view.state.doc.textContent.indexOf('第二段。') + 3
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
    const { anchor, text } = pinAnchor(view, deps)
    expect(validateVisualAnchor(view, anchor, text, deps)).toEqual({ valid: true })

    // 改第三段（选区外、后方）：保留
    view.dispatch(view.state.tr.insertText('（改）', view.state.doc.content.size - 1))
    expect(validateVisualAnchor(view, anchor, text, deps)).toEqual({ valid: true })

    // 改第二段（选区内部）：失效
    const second = view.state.doc.textContent.indexOf('第二段。')
    view.dispatch(view.state.tr.insertText('X', second + 1))
    expect(validateVisualAnchor(view, anchor, text, deps)?.valid).toBe(false)
  })

  it('代码编辑器锚点：只认 CM 自己的坐标（内部改动失效、后方改动保留）', async () => {
    const { view, deps } = await setup('```js\nconst a = 1\n```\n')
    // 用真实的可视化采集 + 注入的 CM 选区，得到**真实**锚点（块类型由投影决定）
    const payload = captureVisualSelection(view, {
      ...deps,
      codeMirror: () => ({ text: 'const', ranges: 1, blockPosition: 0, from: 0, to: 5 })
    })
    const anchor = payload.anchor!
    expect(anchor.code).toEqual({ from: 0, to: 5, expected: 'const' })

    const withCode = (text: string | null) => ({ ...deps, codeText: () => text })
    expect(validateVisualAnchor(view, anchor, 'const', withCode('const a = 1'))?.valid).toBe(true)
    // 选区后方追加：CM 自己的坐标没变 → 保留
    expect(validateVisualAnchor(view, anchor, 'const', withCode('const a = 1 + 1'))?.valid).toBe(
      true
    )
    // 选区内部被改：CM 同一段坐标上已经不是原来那段文字 → 失效
    expect(validateVisualAnchor(view, anchor, 'const', withCode('Xst a = 1'))?.valid).toBe(false)
    // 拿不到 CM（面板没渲染等）→ null，交给位置锚，不假装有效
    expect(validateVisualAnchor(view, anchor, 'const', withCode(null))).toBeNull()
  })

  it('位置锚（序列化偏移）随文档前部插入而失效', async () => {
    const { view, deps } = await setup('AAA\n\nBBB\n')
    selectText(view, 'AAA')
    const { anchor } = pinAnchor(view, deps)
    const range = anchor.textRange!
    const text = deps.serializeDocument(view.state.doc)
    expect(text.slice(range.startOffset, range.endOffset)).toBe(range.expected)

    view.dispatch(view.state.tr.insertText('新段落。\n\n', 1))
    const shifted = deps.serializeDocument(view.state.doc)
    expect(validateTextAnchor(shifted, anchor)?.valid).toBe(false)
  })
})
