// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'

import {
  projectRawBlocksForMilkdown,
  rawBlockProjectionPlugins
} from '../editor/markdown/rawBlockProjection'
import {
  BlockBoundaryCaret,
  activeBlockBoundaryTarget,
  blockBoundaryCaretAt,
  blockBoundaryTargetAt,
  createBlockBoundaryCaretPlugin,
  isBoundaryStopBlock
} from './blockBoundaryCaret'
import {
  adjacentBoundaryCaretPosition,
  createBlockBoundaryNavigationPlugin,
  edgeBoundaryTargetForDelete,
  handleBoundaryNavigationKeyDown,
  materializeLineAt,
  placeBoundaryCaret
} from './blockBoundaryNavigation'

const editors: Editor[] = []

afterEach(async () => {
  await Promise.all(editors.splice(0).map((editor) => editor.destroy()))
  document.body.replaceChildren()
})

async function setup(source: string): Promise<EditorView> {
  const root = document.createElement('div')
  root.className = 'milkdown'
  document.body.append(root)
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, projectRawBlocksForMilkdown(source))
    })
    .use(commonmark)
    .use(gfm)
    .use(rawBlockProjectionPlugins)
    .use(createBlockBoundaryCaretPlugin())
    .use(createBlockBoundaryNavigationPlugin())
  editors.push(editor)
  await editor.create()
  return editor.action((ctx) => ctx.get(editorViewCtx))
}

function childPositions(doc: ProseMirrorNode): { pos: number; node: ProseMirrorNode }[] {
  const children: { pos: number; node: ProseMirrorNode }[] = []
  doc.forEach((node, pos) => children.push({ pos, node }))
  return children
}

function caretSides(view: EditorView): string[] {
  const host = view.dom.parentElement ?? view.dom.ownerDocument
  return [...host.querySelectorAll('.desk-block-boundary-caret')].map(
    (element) => element.getAttribute('data-side') ?? ''
  )
}

describe('block boundary caret', () => {
  it('recognises which blocks get a boundary caret', async () => {
    const view = await setup('前段\n\n```js\nconst a = 1\n```\n\n<B id="x" />\n\n后段\n')
    const children = childPositions(view.state.doc)
    const code = children.find((child) => child.node.type.name === 'code_block')
    const raw = children.find((child) => child.node.type.name === 'deskRawBlock')
    const paragraph = children.find((child) => child.node.type.name === 'paragraph')
    expect(code && isBoundaryStopBlock(code.node)).toBe(true)
    expect(raw && isBoundaryStopBlock(raw.node)).toBe(true)
    expect(paragraph && isBoundaryStopBlock(paragraph.node)).toBe(false)
  })

  it('keeps the side explicit when two stops share one position', async () => {
    const view = await setup('前段\n\n<B id="x" />\n')
    const raw = childPositions(view.state.doc).find(
      (child) => child.node.type.name === 'deskRawBlock'
    )!
    const before = raw.pos
    const after = raw.pos + raw.node.nodeSize

    const beforeCaret = blockBoundaryCaretAt(view.state.doc, before, 'before')
    const afterCaret = blockBoundaryCaretAt(view.state.doc, after, 'after')
    expect(beforeCaret?.side).toBe('before')
    expect(afterCaret?.side).toBe('after')
    expect(beforeCaret?.eq(afterCaret!)).toBe(false)
    // 相邻两个块共用位置时，可以按 side 精确取到各自的目标块
    const twoBlocks = await setup('前段\n\n<B id="x" />\n\n```js\nconst a = 1\n```\n')
    const nodes = childPositions(twoBlocks.state.doc)
    const rawNode = nodes.find((child) => child.node.type.name === 'deskRawBlock')!
    const codeNode = nodes.find((child) => child.node.type.name === 'code_block')!
    const shared = rawNode.pos + rawNode.node.nodeSize
    expect(shared).toBe(codeNode.pos)
    expect(blockBoundaryTargetAt(twoBlocks.state.doc, shared, 'after')?.node).toBe(rawNode.node)
    expect(blockBoundaryTargetAt(twoBlocks.state.doc, shared, 'before')?.node).toBe(codeNode.node)
  })

  it('falls back to a text selection when the mapped position is gone', async () => {
    const view = await setup('前段\n\n<B id="x" />\n')
    const raw = childPositions(view.state.doc).find(
      (child) => child.node.type.name === 'deskRawBlock'
    )!
    placeBoundaryCaret(view, raw.pos, 'before')
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    // 删掉块：状态里的位置不再贴着可停靠块，map 回退成文本光标
    view.dispatch(view.state.tr.delete(raw.pos, raw.pos + raw.node.nodeSize))
    expect(view.state.selection).not.toBeInstanceOf(BlockBoundaryCaret)
  })

  it('独立图片段落：光标画在可编辑 DOM 之外，不会被 PM 的 DOMObserver 重置', async () => {
    // 回归：之前把光标 <span> append 进目标块 DOM。独立图片段落只是普通 paragraph，
    // 它的 contentDOM 就是 <p>，PM 会把多出来的子节点当成 DOM 变更，readDOMChange
    // 立刻把选区重置回文本光标并抹掉光标元素——真实浏览器里表现成「按 ↓ 没反应」。
    const view = await setup('## 标题\n\n![图](../assets/a.png)\n\n尾段\n')
    const children = childPositions(view.state.doc)
    const heading = children[0]!
    const imageParagraph = children[1]!
    expect(heading.node.type.name).toBe('heading')
    expect(imageParagraph.node.firstChild?.type.name).toBe('image')

    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, heading.pos + 1 + heading.node.content.size)
      )
    )
    const pos = adjacentBoundaryCaretPosition(view.state, 'down')
    expect(pos).toBe(imageParagraph.pos)
    expect(placeBoundaryCaret(view, pos!)).toBe(true)
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)

    const host = view.dom.parentElement!
    const caret = host.querySelector('.desk-block-boundary-caret')
    expect(caret).toBeTruthy()
    expect(caret?.getAttribute('data-side')).toBe('before')
    expect(activeBlockBoundaryTarget(view.state)?.node.firstChild?.type.name).toBe('image')
    // 关键契约：可编辑 DOM 里不能有光标元素。
    expect(view.dom.contains(caret)).toBe(false)
    expect(host.contains(caret)).toBe(true)

    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    expect(host.querySelector('.desk-block-boundary-caret')).toBe(caret)
  })

  it('相邻代码块（中间没有空行）：块前 ↑ / 块后 ↓ 在两个块之间来回', async () => {
    const view = await setup(
      '```js\nconst first = 1\n```\n```css\n.demo {\n  color: red;\n}\n```\n'
    )
    const children = childPositions(view.state.doc)
    expect(children.map((child) => child.node.type.name)).toEqual(['code_block', 'code_block'])
    const [first, second] = children

    // 第二块块前 ↑ → 第一块块后
    placeBoundaryCaret(view, second!.pos, 'before')
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    expect(activeBlockBoundaryTarget(view.state)?.side).toBe('after')
    expect(view.state.selection.from).toBe(first!.pos + first!.node.nodeSize)

    // 第一块块后 ↓ → 第二块块前
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    expect(activeBlockBoundaryTarget(view.state)?.side).toBe('before')
    expect(view.state.selection.from).toBe(second!.pos)
  })

  it('renders exactly one visible caret element', async () => {
    const view = await setup('前段\n\n<B id="x" />\n\n后段\n')
    const raw = childPositions(view.state.doc).find(
      (child) => child.node.type.name === 'deskRawBlock'
    )!
    placeBoundaryCaret(view, raw.pos, 'before')
    const before = caretSides(view)
    expect(before).toHaveLength(1)
    placeBoundaryCaret(view, raw.pos + raw.node.nodeSize, 'after')
    const after = caretSides(view)
    expect(after).toHaveLength(1)
    expect(after[0]).toBe('after')
    expect(activeBlockBoundaryTarget(view.state)?.side).toBe('after')
  })
})

describe('block boundary navigation', () => {
  it('finds the boundary below/above a neighbouring block', async () => {
    const view = await setup('前段\n\n```js\nconst a = 1\n```\n\n后段\n')
    const children = childPositions(view.state.doc)
    const paragraph = children.find((child) => child.node.type.name === 'paragraph')!
    const code = children.find((child) => child.node.type.name === 'code_block')!
    const caret = paragraph.pos + 1 + paragraph.node.content.size
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)))
    expect(adjacentBoundaryCaretPosition(view.state, 'down')).toBe(code.pos)
    expect(adjacentBoundaryCaretPosition(view.state, 'right')).toBe(code.pos)
    const after = code.pos + code.node.nodeSize
    // ↑ 只要在第一条视觉行上；← 必须严格在文本块开头
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, after + 1 + '后段'.length))
    )
    expect(adjacentBoundaryCaretPosition(view.state, 'up')).toBe(after)
    expect(adjacentBoundaryCaretPosition(view.state, 'left')).toBeNull()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, after + 1)))
    expect(adjacentBoundaryCaretPosition(view.state, 'left')).toBe(after)
  })

  it('treats a hidden block as transparent', async () => {
    const view = await setup('前段\n\n<B id="x" />\n')
    const children = childPositions(view.state.doc)
    const raw = children.find((child) => child.node.type.name === 'deskRawBlock')!
    // 隐藏块（frontmatter 投影）不算停靠块
    expect(
      isBoundaryStopBlock({ type: { name: 'deskRawBlock' }, attrs: { hidden: true } } as never)
    ).toBe(false)
    expect(blockBoundaryCaretAt(view.state.doc, raw.pos, 'before')).not.toBeNull()
  })

  it('materialises an empty paragraph above or below the block', async () => {
    const view = await setup('前段\n\n<B id="x" />\n\n后段\n')
    const raw = childPositions(view.state.doc).find(
      (child) => child.node.type.name === 'deskRawBlock'
    )!
    expect(materializeLineAt(view, raw.pos)).toBe(true)
    const afterBefore = childPositions(view.state.doc)
    expect(afterBefore[1].node.type.name).toBe('paragraph')
    expect(afterBefore[1].node.content.size).toBe(0)
    expect(afterBefore[2].node.type.name).toBe('deskRawBlock')

    const rawAfter = childPositions(view.state.doc).find(
      (child) => child.node.type.name === 'deskRawBlock'
    )!
    expect(materializeLineAt(view, rawAfter.pos + rawAfter.node.nodeSize)).toBe(true)
    const children = childPositions(view.state.doc)
    const index = children.findIndex((child) => child.node.type.name === 'deskRawBlock')
    expect(children[index + 1].node.type.name).toBe('paragraph')
    expect(children[index + 1].node.content.size).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* 段落边缘的 Backspace / Delete → 特殊块边界光标（验收第 5 项）        */
/* ------------------------------------------------------------------ */

/** 模拟真实按键（repeat 表示长按重复事件，键位处理不许依赖"松开再按"）。 */
function press(view: EditorView, key: string, repeat = false): boolean {
  const event = new KeyboardEvent('keydown', { key, repeat })
  return handleBoundaryNavigationKeyDown(view, event as unknown as KeyboardEvent)
}

function kinds(view: EditorView): string[] {
  return childPositions(view.state.doc).map((child) => child.node.type.name)
}

/** 把光标放到某个块内文本的指定偏移（offset 从该块内容的第 0 个位置算起）。 */
function caretInBlock(view: EditorView, blockIndex: number, offset: number): void {
  const child = childPositions(view.state.doc)[blockIndex]
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, child.pos + 1 + offset))
  )
}

describe('段落边缘的方向删除：先落到特殊块边界，再删整块', () => {
  it('代码块后段落开头 Backspace：先落块右下角（块内容不变），再按才删块', async () => {
    const view = await setup('前段\n\n```js\nconst a = 1\n```\n\n后段\n')
    const code = childPositions(view.state.doc).find(
      (child) => child.node.type.name === 'code_block'
    )!
    caretInBlock(view, 2, 0) // 「后段」段首
    expect(edgeBoundaryTargetForDelete(view.state, 'Backspace')).toMatchObject({
      blockPos: code.pos,
      side: 'after'
    })

    expect(press(view, 'Backspace')).toBe(true)
    // 只移动光标：不是 NodeSelection（没有"整块选中"的中间态），文档没变
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    expect((view.state.selection as BlockBoundaryCaret).side).toBe('after')
    expect(view.state.selection.head).toBe(code.pos + code.node.nodeSize)
    expect(kinds(view)).toEqual(['paragraph', 'code_block', 'paragraph'])
    expect(view.state.doc.textContent).toContain('const a = 1')

    expect(press(view, 'Backspace')).toBe(true)
    expect(kinds(view)).toEqual(['paragraph', 'paragraph'])
    expect(view.state.doc.textContent).not.toContain('const a = 1')
    expect(view.state.selection.from).toBeGreaterThanOrEqual(0)
  })

  it('长按重复事件（repeat）同样：第一下移动、第二下删块', async () => {
    const view = await setup('前段\n\n```js\nconst a = 1\n```\n\n后段\n')
    caretInBlock(view, 2, 0)
    expect(press(view, 'Backspace', true)).toBe(true)
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    expect(press(view, 'Backspace', true)).toBe(true)
    expect(kinds(view)).toEqual(['paragraph', 'paragraph'])
  })

  it('代码块前段落末尾 Delete：先落块左上角，再按才删块', async () => {
    const view = await setup('前段\n\n```js\nconst a = 1\n```\n\n后段\n')
    const code = childPositions(view.state.doc).find(
      (child) => child.node.type.name === 'code_block'
    )!
    caretInBlock(view, 0, '前段'.length) // 「前段」段尾
    expect(edgeBoundaryTargetForDelete(view.state, 'Delete')).toMatchObject({
      blockPos: code.pos,
      side: 'before'
    })

    expect(press(view, 'Delete')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    expect((view.state.selection as BlockBoundaryCaret).side).toBe('before')
    expect(kinds(view)).toEqual(['paragraph', 'code_block', 'paragraph'])

    expect(press(view, 'Delete')).toBe(true)
    expect(kinds(view)).toEqual(['paragraph', 'paragraph'])
  })

  it('独立成段的图片同样适用', async () => {
    const view = await setup('前段\n\n![图](../assets/a.png)\n\n后段\n')
    const image = childPositions(view.state.doc).find(
      (child) => child.node.type.name === 'paragraph' && child.node.child(0)?.type.name === 'image'
    )!
    caretInBlock(view, 2, 0) // 「后段」段首
    expect(edgeBoundaryTargetForDelete(view.state, 'Backspace')).toMatchObject({
      blockPos: image.pos,
      side: 'after'
    })
    expect(press(view, 'Backspace')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    expect(press(view, 'Backspace')).toBe(true)
    expect(kinds(view)).toEqual(['paragraph', 'paragraph'])
  })

  it('提示块（callout）同样适用：不停在"整块选中"的中间态', async () => {
    const view = await setup('前段\n\n::: tip 标题\n正文\n:::\n\n后段\n')
    const callout = childPositions(view.state.doc).find(
      (child) => child.node.type.name === 'deskCallout'
    )!
    caretInBlock(view, 2, 0) // 「后段」段首
    expect(edgeBoundaryTargetForDelete(view.state, 'Backspace')).toMatchObject({
      blockPos: callout.pos,
      side: 'after'
    })
    expect(press(view, 'Backspace')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    expect(kinds(view)).toEqual(['paragraph', 'deskCallout', 'paragraph'])

    expect(press(view, 'Backspace')).toBe(true)
    expect(kinds(view)).toEqual(['paragraph', 'paragraph'])
  })

  it('代码组（raw block）前段落末尾 Delete 也适用', async () => {
    const view = await setup('前段\n\n::: code-group\n```js\nconst a = 1\n```\n:::\n\n后段\n')
    caretInBlock(view, 0, '前段'.length)
    expect(press(view, 'Delete')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    expect(press(view, 'Delete')).toBe(true)
    expect(kinds(view).some((kind) => kind === 'deskRawBlock')).toBe(false)
  })

  it('不接管的情况：段落中间、以及相邻是普通段落', async () => {
    const view = await setup('前段A\n\n前段B\n\n```js\nx\n```\n')
    // 段落中间：正常删字（不接管）
    caretInBlock(view, 0, 1)
    expect(edgeBoundaryTargetForDelete(view.state, 'Backspace')).toBeNull()
    expect(press(view, 'Backspace')).toBe(false)
    // 相邻是普通段落：交给 PM 默认的合并（不接管）
    caretInBlock(view, 1, 0) // 「前段B」段首
    expect(edgeBoundaryTargetForDelete(view.state, 'Backspace')).toBeNull()
    expect(press(view, 'Backspace')).toBe(false)
    // 段尾 Delete（后面是普通段落）：不接管
    caretInBlock(view, 0, '前段A'.length)
    expect(edgeBoundaryTargetForDelete(view.state, 'Delete')).toBeNull()
    expect(press(view, 'Delete')).toBe(false)
  })

  it('表格：块后段首 Backspace 也是先落边界、再删整块', async () => {
    const view = await setup('| a | b |\n| - | - |\n| 1 | 2 |\n\n表后段\n')
    const table = childPositions(view.state.doc).find((child) => child.node.type.name === 'table')!
    caretInBlock(view, 1, 0) // 「表后段」段首
    expect(edgeBoundaryTargetForDelete(view.state, 'Backspace')).toMatchObject({
      blockPos: table.pos,
      side: 'after'
    })
    expect(press(view, 'Backspace')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    expect(kinds(view)).toEqual(['table', 'paragraph'])
    expect(press(view, 'Backspace')).toBe(true)
    expect(kinds(view)).toEqual(['paragraph'])
  })

  it('callout 边界上的方向键：回到正文末尾 / 进标题，不会卡住', async () => {
    const view = await setup('前段\n\n::: tip 标题\n正文\n:::\n\n后段\n')
    const callout = childPositions(view.state.doc).find(
      (child) => child.node.type.name === 'deskCallout'
    )!
    caretInBlock(view, 2, 0)
    expect(press(view, 'Backspace')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    // ↑/← 从块右下角回到 callout 正文末尾（不进 PM 默认的 gapcursor 分支）
    expect(press(view, 'ArrowUp')).toBe(true)
    expect(view.state.selection).not.toBeInstanceOf(BlockBoundaryCaret)
    expect(view.state.selection.from).toBeGreaterThan(callout.pos)
    expect(view.state.selection.from).toBeLessThan(callout.pos + callout.node.nodeSize)
  })
})

/* ------------------------------------------------------------------ */
/* 嵌套容器：相邻节点必须取「当前段落所在那一层」                        */
/* ------------------------------------------------------------------ */

describe('嵌套容器里的段落边缘删除（按当前层级取相邻块）', () => {
  it('引用里的段落紧跟内部代码块：Backspace 落到内部块，不跳到容器外', async () => {
    const view = await setup(
      '```text\nconst a = 1\n```\n\n> ```js\n> const b = 1\n> ```\n>\n> 引用正文\n'
    )
    const [outerCode, quote] = childPositions(view.state.doc)
    const innerCodePos = quote.pos + 1
    // 光标放到引用内段落「引用正文」的开头
    const innerParagraphPos = innerCodePos + view.state.doc.nodeAt(innerCodePos)!.nodeSize
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, innerParagraphPos + 1))
    )
    const target = edgeBoundaryTargetForDelete(view.state, 'Backspace')
    expect(target).toMatchObject({ blockPos: innerCodePos, side: 'after' })
    // 明确不是容器外的那个代码块
    expect(target?.blockPos).not.toBe(outerCode.pos)

    expect(press(view, 'Backspace')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    expect(press(view, 'Backspace')).toBe(true)
    // 只删掉引用内部那个代码块：外层块与引用容器都还在
    expect(kinds(view)).toEqual(['code_block', 'blockquote'])
    expect(view.state.doc.textContent).toContain('const a = 1')
    expect(view.state.doc.textContent).not.toContain('const b = 1')
  })

  it('列表项里的空段落紧跟内部代码块：Delete（前向）落到内部块', async () => {
    const view = await setup('```text\nconst a = 1\n```\n\n- ```js\n  const b = 1\n  ```\n\n  \n')
    const [outerCode, list] = childPositions(view.state.doc)
    const item = list.pos + 1
    const emptyParagraphPos = item + 1
    // 光标放到列表项里那个空段落（在内部代码块之前）的内容末尾
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, emptyParagraphPos + 1))
    )
    const target = edgeBoundaryTargetForDelete(view.state, 'Delete')
    expect(target?.side).toBe('before')
    expect(target?.node.type.name).toBe('code_block')
    expect(target?.blockPos).not.toBe(outerCode.pos)

    expect(press(view, 'Delete')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(BlockBoundaryCaret)
    expect(press(view, 'Delete')).toBe(true)
    // 只删掉列表项内部那个代码块
    expect(view.state.doc.textContent).toContain('const a = 1')
    expect(view.state.doc.textContent).not.toContain('const b = 1')
    expect(kinds(view)).toEqual(['code_block', 'bullet_list'])
  })

  it('提示块里的段落紧跟内部代码块：Backspace 落到内部块', async () => {
    const view = await setup(
      '```text\nconst a = 1\n```\n\n::: tip 标题\n```js\nconst b = 1\n```\n\ncallout 后段\n:::\n'
    )
    const callout = childPositions(view.state.doc).find(
      (child) => child.node.type.name === 'deskCallout'
    )!
    const innerCodePos = callout.pos + 1
    const innerCode = view.state.doc.nodeAt(innerCodePos)!
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, innerCodePos + innerCode.nodeSize + 1)
      )
    )
    expect(edgeBoundaryTargetForDelete(view.state, 'Backspace')).toMatchObject({
      blockPos: innerCodePos,
      side: 'after'
    })
    expect(press(view, 'Backspace')).toBe(true)
    expect(press(view, 'Backspace')).toBe(true)
    expect(view.state.doc.textContent).toContain('const a = 1')
    expect(view.state.doc.textContent).not.toContain('const b = 1')
    expect(view.state.doc.textContent).toContain('callout 后段')
  })

  it('容器内没有相邻特殊块时不接管（不跳到容器外）', async () => {
    const view = await setup('> 引用正文\n>\n> 后段\n\n```text\nconst a = 1\n```\n')
    const quote = childPositions(view.state.doc)[0]
    // 引用里的第二个段落，前一个兄弟是普通段落 → 不接管
    const secondParagraph = quote.pos + 1 + view.state.doc.nodeAt(quote.pos + 1)!.nodeSize
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, secondParagraph + 1))
    )
    expect(edgeBoundaryTargetForDelete(view.state, 'Backspace')).toBeNull()
    expect(press(view, 'Backspace')).toBe(false)
    // 第二个段落末尾 Delete：容器内后面没有块 → 同样不跳到容器外
    const paragraph = view.state.doc.nodeAt(secondParagraph)!
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, secondParagraph + 1 + paragraph.content.size)
      )
    )
    expect(edgeBoundaryTargetForDelete(view.state, 'Delete')).toBeNull()
    expect(press(view, 'Delete')).toBe(false)
  })
})
