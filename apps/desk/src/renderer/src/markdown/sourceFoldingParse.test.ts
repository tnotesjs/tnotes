// @vitest-environment happy-dom

/**
 * 「哪些 `#` 是**文档级**标题」—— 用**可视化编辑器自己的解析结果**验证，
 * 而不是从 `collectDocHeadings` 的实现推导（复核要求：一致性要有解析依据）。
 *
 * 源码视图的折叠扫描器（`sourceFolding.ts`）就是按这份结论对齐的：
 * - `  ## 标题`（0–3 个前导空格）→ 文档级标题；
 * - `> # x` / `- # x`（引用、列表项里）→ 不是文档级标题；
 * - frontmatter 里的 `# 注释` → 不是标题（它是 frontmatter 的一部分）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'

import {
  projectRawBlocksForMilkdown,
  rawBlockProjectionPlugins
} from '../editor/markdown/rawBlockProjection'

const editors: Editor[] = []

afterEach(async () => {
  await Promise.all(editors.splice(0).map((editor) => editor.destroy()))
  document.body.replaceChildren()
})

/** 顶层代码块的内容（用来对齐"围栏在哪里结束"） */
async function docCodeBlocks(source: string): Promise<string[]> {
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
  editors.push(editor)
  await editor.create()
  const view = editor.action((ctx) => ctx.get(editorViewCtx))
  const blocks: string[] = []
  view.state.doc.descendants((node) => {
    if (node.type.name === 'code_block') blocks.push(node.textContent)
  })
  return blocks
}

/** 文档级（顶层）标题：`{ level, text }` 列表 */
async function docHeadings(source: string): Promise<{ level: number; text: string }[]> {
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
  editors.push(editor)
  await editor.create()
  const view = editor.action((ctx) => ctx.get(editorViewCtx))
  const headings: { level: number; text: string }[] = []
  view.state.doc.forEach((node) => {
    if (node.type.name === 'heading') {
      headings.push({ level: Number(node.attrs.level), text: node.textContent })
    }
  })
  return headings
}

describe('可视化解析：文档级标题的判定', () => {
  it('0–3 个前导空格是合法的文档级 ATX 标题', async () => {
    expect(await docHeadings('  ## 缩进两格的标题\n\n正文\n')).toEqual([
      { level: 2, text: '缩进两格的标题' }
    ])
  })

  it('引用里、列表项里的 # 不是文档级标题', async () => {
    expect(await docHeadings('> # 引用里的标题\n>\n> 正文\n')).toEqual([])
    expect(await docHeadings('- # 列表项里的标题\n\n  正文\n')).toEqual([])
  })

  it('frontmatter 里的 # 注释不是标题', async () => {
    expect(await docHeadings('---\n# metadata comment\nid: x\n---\n\n# Real\nbody\n')).toEqual([
      { level: 1, text: 'Real' }
    ])
  })

  it('列表项里 4 空格缩进的闭合围栏：代码块到闭合行结束，后面的标题恢复识别', async () => {
    const source = '10. ```js\n    const x = 1\n    ```\n\n# Real\nbody\n'
    // 解析器认为代码块内容只有 `const x = 1`（闭合行是第 3 行），`# Real` 是文档级标题
    expect(await docCodeBlocks(source)).toEqual(['const x = 1'])
    expect(await docHeadings(source)).toEqual([{ level: 1, text: 'Real' }])
  })

  it('引用容器结束后（空行）围栏随之结束：外部标题恢复识别', async () => {
    const source = '> ```js\n> const x = 1\n\n# Real\nbody\n'
    expect(await docCodeBlocks(source)).toEqual(['const x = 1'])
    expect(await docHeadings(source)).toEqual([{ level: 1, text: 'Real' }])
  })

  it('代码围栏里的 # 不是标题', async () => {
    expect(await docHeadings('```md\n# 代码里的伪标题\n```\n\n# Real\nbody\n')).toEqual([
      { level: 1, text: 'Real' }
    ])
  })
})
