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
  // 默认把"笔记源码文本"当作位置锚的坐标系（与真实编辑器一致）
  const sourceText = source
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
    deps: { serializeDocument: (document) => serialize(document), sourceText }
  }
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

describe('真实采集 → 跨视图 / 磁盘复核（位置范围来自编辑器）', () => {
  it('跨段落固定：第二段变化也失效（每个块都有范围）', async () => {
    const body = 'AAA\n\nBBB\n'
    const { view, deps } = await setup(body)
    const from = selectText(view, 'AAA').from
    const to = selectText(view, 'BBB').to
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
    const payload = captureVisualSelection(view, deps)
    const anchor = payload.anchor as PinnedSelectionAnchor
    expect(anchor.ranges?.length).toBe(2)

    // 原样：两个范围都对得上
    expect(validateTextAnchor(body, anchor)).toEqual({ valid: true })
    // 第一段变 → 失效
    expect(validateTextAnchor('XXX\n\nBBB\n', anchor)?.valid).toBe(false)
    // 第二段变 → **也要失效**（这正是之前漏掉的）
    expect(validateTextAnchor('AAA\n\nCCC\n', anchor)?.valid).toBe(false)
    // 在选区结束之后追加（第二段末尾）：选中的内容与坐标都没变 → 保留
    expect(validateTextAnchor('AAA\n\nBBB 尾部\n', anchor)).toEqual({ valid: true })
  })

  it('同段落只固定 AAA：未选中后缀变化仍保留（跨视图 / 磁盘同一条判据）', async () => {
    const body = 'AAA BBB\n'
    const { view, deps } = await setup(body)
    selectText(view, 'AAA')
    const payload = captureVisualSelection(view, deps)
    const anchor = payload.anchor as PinnedSelectionAnchor
    expect(anchor.ranges?.length).toBe(1)
    expect(validateTextAnchor(body, anchor)).toEqual({ valid: true })
    // 后缀 BBB → CCC：A 的内容与坐标都没变 → 保留
    expect(validateTextAnchor('AAA CCC\n', anchor)).toEqual({ valid: true })
    // A 自己变了 → 失效
    expect(validateTextAnchor('AAX BBB\n', anchor)?.valid).toBe(false)
    // 前面插入内容 → 坐标变化 → 失效
    expect(validateTextAnchor('前缀 AAA BBB\n', anchor)?.valid).toBe(false)
    // 原位置被删、别处有同样文字 → 失效
    expect(validateTextAnchor('XXX BBB\n\nAAA\n', anchor)?.valid).toBe(false)
  })

  it('同一代码块只固定 const：未选中后缀变化仍保留', async () => {
    const body = '```js\nconst a = 1\n```\n'
    const { view, deps } = await setup(body)
    const payload = captureVisualSelection(view, {
      ...deps,
      codeMirror: () => ({ text: 'const', ranges: 1, blockPosition: 0, from: 0, to: 5 })
    })
    const anchor = payload.anchor as PinnedSelectionAnchor
    expect(anchor.ranges?.length).toBe(1)
    expect(validateTextAnchor(body, anchor)).toEqual({ valid: true })
    // 选区后面的 ` a = 1` 改成别的：保留
    expect(validateTextAnchor('```js\nconst b = 2\n```\n', anchor)).toEqual({ valid: true })
    // 选区内部变了：失效
    expect(validateTextAnchor('```js\nXonst a = 1\n```\n', anchor)?.valid).toBe(false)
  })

  it('跨段落固定：同视图内第二段变化也失效（可视化判据）', async () => {
    const body = 'AAA\n\nBBB\n'
    const { view, deps } = await setup(body)
    const from = selectText(view, 'AAA').from
    const to = selectText(view, 'BBB').to
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
    const payload = captureVisualSelection(view, deps)
    const anchor = payload.anchor as PinnedSelectionAnchor
    expect(validateVisualAnchor(view, anchor, payload.selectedText, deps)).toEqual({ valid: true })
    const second = view.state.doc.textContent.indexOf('BBB')
    view.dispatch(view.state.tr.insertText('X', second + 1))
    expect(validateVisualAnchor(view, anchor, payload.selectedText, deps)?.valid).toBe(false)
  })
})

describe('块身份：重复内容不会指错位置（真实采集）', () => {
  it('两个一模一样的段落：选中第二个 → 锚点落在第二个的偏移上', async () => {
    const body = 'AAA\n\nAAA\n'
    const { view, deps } = await setup(body)
    // 选中**第二个**段落（按文档位置，不按文字）
    let secondPos = -1
    view.state.doc.forEach((node, pos) => {
      if (node.textContent === 'AAA' && pos > 0) secondPos = pos
    })
    expect(secondPos).toBeGreaterThan(0)
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, secondPos + 1, secondPos + 4))
    )
    const payload = captureVisualSelection(view, deps)
    const anchor = payload.anchor as PinnedSelectionAnchor
    const range = anchor.ranges![0]!
    // 先断言偏移确实对应**所选位置**（第二个段落在源码里的偏移是 5）
    expect(range.startOffset).toBe(5)
    expect(body.slice(range.startOffset, range.endOffset)).toBe('AAA')

    // 改第二段 → 失效
    expect(validateTextAnchor('AAA\n\nCCC\n', anchor)?.valid).toBe(false)
    // 改第一段（未选中）→ 保留
    expect(validateTextAnchor('CCC\n\nAAA\n', anchor)).toEqual({ valid: true })
  })

  it('同一代码块里第二个相同的词：按 CM 坐标落点，不按首次匹配', async () => {
    const body = '```js\nfoo foo\n```\n'
    const { view, deps } = await setup(body)
    // 第二个 foo：CM 偏移 4–7
    const payload = captureVisualSelection(view, {
      ...deps,
      codeMirror: () => ({ text: 'foo', ranges: 1, blockPosition: 0, from: 4, to: 7 })
    })
    const anchor = payload.anchor as PinnedSelectionAnchor
    const range = anchor.ranges![0]!
    // 第一个 foo 的偏移是 7（围栏 + 换行之后），第二个应当是 11
    expect(body.slice(range.startOffset, range.endOffset)).toBe('foo')
    // 围栏正文从 '```js\n' 之后开始（偏移 6），第二个 foo 是正文里的 4 → 10
    expect(range.startOffset).toBe(10)

    // 改第二个（选中那个）→ 失效；只改第一个 → 保留
    expect(validateTextAnchor('```js\nfoo XXX\n```\n', anchor)?.valid).toBe(false)
    expect(validateTextAnchor('```js\nXXX foo\n```\n', anchor)).toEqual({ valid: true })
  })

  it('不同代码组面板里的相同文字：按面板序号（结构）定位', async () => {
    const body = [
      '::: code-group',
      '',
      '```js [a.js]',
      'same',
      '```',
      '',
      '```ts [b.ts]',
      'same',
      '```',
      '',
      ':::',
      ''
    ].join('\n')
    const { view, deps } = await setup(body)
    const rawPos = 0
    // 第二个面板（panelIndex: 1）
    const payload = captureVisualSelection(view, {
      ...deps,
      codeMirror: () => ({
        text: 'same',
        ranges: 1,
        blockPosition: rawPos,
        from: 0,
        to: 4,
        panelIndex: 1
      })
    })
    const anchor = payload.anchor as PinnedSelectionAnchor
    const range = anchor.ranges![0]!
    const secondOccurrence = body.indexOf('same', body.indexOf('same') + 1)
    expect(range.startOffset).toBe(secondOccurrence)

    // 只改第二个面板 → 失效；只改第一个面板 → 保留
    const editedSecond = body.replace('```ts [b.ts]\nsame', '```ts [b.ts]\nXXXX')
    const editedFirst = body.replace('```js [a.js]\nsame', '```js [a.js]\nXXXX')
    expect(validateTextAnchor(editedSecond, anchor)?.valid).toBe(false)
    expect(validateTextAnchor(editedFirst, anchor)).toEqual({ valid: true })
  })

  it('结构对不上（顶层块数不一致）→ 拿不到锚点（拒绝固定，而不是猜位置）', async () => {
    const body = 'AAA\n\nBBB\n'
    const { view, deps } = await setup(body)
    selectText(view, 'BBB')
    const payload = captureVisualSelection(view, {
      ...deps,
      // 源码文本与文档结构不一致（少了一段）
      sourceText: '只有一段\n'
    })
    // 拿不到位置范围：服务端会据此**拒绝固定**，而不是猜一个位置出来
    expect((payload.anchor as PinnedSelectionAnchor | undefined)?.ranges).toBeUndefined()
  })
})

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
    expect(anchor.code).toMatchObject({ from: 0, to: 5 })

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

  it('位置锚落在笔记源码文本的坐标系里（不是序列化结果）', async () => {
    const body = '# 标题\n\nAAA\n\nBBB\n'
    const { view, deps } = await setup(body)
    selectText(view, 'AAA')
    const { anchor } = pinAnchor(view, deps)
    const range = anchor.ranges![0]!
    // 锚点直接能在**源码文本**上取到那段文字
    expect(body.slice(range.startOffset, range.endOffset)).toBe(range.expected)
    expect(range.expected).toBe('AAA')

    // 在文档最前面插入一整段：每个范围都后移 → 失效
    const shifted = `新段落。\n\n${body}`
    expect(validateTextAnchor(shifted, anchor)?.valid).toBe(false)
  })
})
