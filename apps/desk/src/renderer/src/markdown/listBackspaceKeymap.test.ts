// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { editorViewCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

import type { DeskEditorHandle } from './deskEditor'
import { createTestDeskEditor } from './deskEditorTestKit'
import { listItemEmptyBackspace } from './listBackspaceKeymap'

vi.mock('katex', () => ({
  default: {
    render: (v: string, dom: HTMLElement) => void (dom.textContent = v),
    renderToString: (v: string) => v
  }
}))

const SOURCE = ['- 111', '  - 222', '    - 333', '- 444', '  - 555', '- 666', ''].join('\n')
let editor: DeskEditorHandle | null = null
afterEach(async () => {
  await editor?.destroy()
  editor = null
})

async function openView(defaultValue = SOURCE): Promise<EditorView> {
  const created = await createTestDeskEditor({ defaultValue })
  editor = created.handle
  return created.handle.editor.ctx.get(editorViewCtx)
}

/** 把光标放到某个段落文本的末尾 */
function caretToParagraphEnd(view: EditorView, text: string): void {
  let target = -1
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && node.textContent === text)
      target = pos + 1 + node.content.size
    return true
  })
  expect(target).toBeGreaterThan(0)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)))
}

/** 等价默认 Backspace 的"删掉光标前 n 个字符" */
function deleteChars(view: EditorView, n: number): void {
  for (let i = 0; i < n; i += 1) {
    const { $from } = view.state.selection
    view.dispatch(view.state.tr.delete($from.pos - 1, $from.pos))
  }
}

/** 每个 list_item 的 文本 + 列表层级（含嵌套的 bullet/ordered），用于逐项核对结构 */
function items(view: EditorView): { text: string; depth: number; checked: unknown }[] {
  const out: { text: string; depth: number; checked: unknown }[] = []
  const walkList = (list: never, depth: number): void => {
    ;(list as unknown as { forEach: (f: (item: never) => void) => void }).forEach((item) => {
      const it = item as unknown as {
        firstChild: { textContent: string } | null
        attrs: { checked?: unknown }
        forEach: (f: (child: never) => void) => void
      }
      out.push({
        text: it.firstChild?.textContent ?? '',
        depth,
        checked: it.attrs?.checked ?? null
      })
      it.forEach((child) => {
        const name = (child as unknown as { type: { name: string } }).type.name
        if (name === 'bullet_list' || name === 'ordered_list') walkList(child, depth + 1)
      })
    })
  }
  view.state.doc.forEach((block) => {
    const name = (block as unknown as { type: { name: string } }).type.name
    if (name === 'bullet_list' || name === 'ordered_list') walkList(block as never, 1)
  })
  return out
}

/** 列表外的空段落（文档末尾那个尾随段落是正常的，不算） */
function strayEmptyParagraphs(view: EditorView): number[] {
  const doc = view.state.doc
  const found: number[] = []
  for (let i = 0; i < doc.childCount; i += 1) {
    const child = doc.child(i)
    const isTrailing = i === doc.childCount - 1
    if (child.type.name === 'paragraph' && child.content.size === 0 && !isTrailing) found.push(i)
  }
  return found
}

/** 文档里所有空的 list_item（按列表项层级） */
const emptyItems = (view: EditorView) => items(view).filter((item) => item.text === '')

const caretInfo = (view: EditorView) => {
  const { $from } = view.state.selection
  return {
    parent: $from.parent.type.name,
    text: $from.parent.textContent,
    offset: $from.parentOffset
  }
}

describe('空列表项 Backspace（用户主场景）', () => {
  it('第四次删除空项后：结构不变、光标回到 555 末尾、不残留空列表项与空段落', async () => {
    const view = await openView()
    caretToParagraphEnd(view, '666')

    // 前三次 Backspace：把 "666" 文本删空（等价于真实按键的前三次）
    deleteChars(view, 3)
    expect(view.state.selection.$from.parent.textContent).toBe('')

    // 第四次：命令应命中空列表项
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(true)

    // 1) 没有空列表项
    expect(emptyItems(view)).toEqual([])
    // 2) 层级结构逐项不变
    expect(items(view).map(({ text, depth }) => ({ text, depth }))).toEqual([
      { text: '111', depth: 1 },
      { text: '222', depth: 2 },
      { text: '333', depth: 3 },
      { text: '444', depth: 1 },
      { text: '555', depth: 2 }
    ])
    // 3) 光标回到 555 末尾且在列表内
    expect(caretInfo(view)).toEqual({ parent: 'paragraph', text: '555', offset: 3 })
    const { $from } = view.state.selection
    expect($from.node(-1)?.type.name).toBe('list_item')
    // 4) 不残留列表外的空段落
    expect(strayEmptyParagraphs(view)).toEqual([])
  })

  it('再按一次只在 555 上退格，不会冒出嵌套空项', async () => {
    const view = await openView()
    caretToParagraphEnd(view, '666')
    deleteChars(view, 3)
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(true)

    // 光标在 555 末尾：这次应放行给默认键位（删一个字符），不命中空项分支
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(false)
    deleteChars(view, 1)
    expect(emptyItems(view)).toEqual([])
    expect(caretInfo(view)).toEqual({ parent: 'paragraph', text: '55', offset: 2 })
  })
})

describe('嵌套列表里的空项（Milkdown 默认 lift 会留空 item 的场景）', () => {
  it('嵌套无序项：只删该项、层级不变、光标回上一项末尾', async () => {
    const view = await openView(
      ['- 111', '  - 222', '    - 333', '- 444', '  - 555', '    - 666', ''].join('\n')
    )
    caretToParagraphEnd(view, '666')
    deleteChars(view, 3)
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(true)

    expect(emptyItems(view)).toEqual([])
    expect(items(view).map(({ text, depth }) => ({ text, depth }))).toEqual([
      { text: '111', depth: 1 },
      { text: '222', depth: 2 },
      { text: '333', depth: 3 },
      { text: '444', depth: 1 },
      { text: '555', depth: 2 }
    ])
    expect(caretInfo(view)).toEqual({ parent: 'paragraph', text: '555', offset: 3 })
    expect(strayEmptyParagraphs(view)).toEqual([])
  })

  it('嵌套有序项：只删该项、层级不变、光标回上一项末尾', async () => {
    const view = await openView(['1. 甲', '   1. 乙', '   2. 丙丙丙', '2. 丁', ''].join('\n'))
    caretToParagraphEnd(view, '丙丙丙')
    deleteChars(view, 3)
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(true)

    expect(emptyItems(view)).toEqual([])
    expect(items(view).map(({ text, depth }) => ({ text, depth }))).toEqual([
      { text: '甲', depth: 1 },
      { text: '乙', depth: 2 },
      { text: '丁', depth: 1 }
    ])
    expect(caretInfo(view)).toEqual({ parent: 'paragraph', text: '乙', offset: 1 })
    expect(strayEmptyParagraphs(view)).toEqual([])
  })

  it('父列表唯一的子项被删空：连空的子列表一起删，不留空列表', async () => {
    const view = await openView(['- 444', '  - 555', ''].join('\n'))
    caretToParagraphEnd(view, '555')
    deleteChars(view, 3)
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(true)

    expect(items(view).map(({ text, depth }) => ({ text, depth }))).toEqual([
      { text: '444', depth: 1 }
    ])
    expect(caretInfo(view)).toEqual({ parent: 'paragraph', text: '444', offset: 3 })
    expect(strayEmptyParagraphs(view)).toEqual([])
  })

  it('文档里唯一的列表（前有标题）：删项后不留空列表、光标回标题末尾', async () => {
    const view = await openView(['# 标题', '', '- 666', ''].join('\n'))
    caretToParagraphEnd(view, '666')
    deleteChars(view, 3)
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(true)

    expect(items(view)).toEqual([])
    expect(caretInfo(view)).toEqual({ parent: 'heading', text: '标题', offset: 2 })
    expect(strayEmptyParagraphs(view)).toEqual([])
  })
})

describe('有序/任务列表：空项删除后不应继续吞掉上一项', () => {
  it('有序列表：删除空项后光标停在上一项末尾，再按一次只退格一个字符', async () => {
    const view = await openView(['1. 甲', '2. 乙', '3. 丙', ''].join('\n'))
    caretToParagraphEnd(view, '丙')
    deleteChars(view, 1)
    expect(view.state.selection.$from.parent.textContent).toBe('')

    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(true)
    expect(caretInfo(view)).toEqual({ parent: 'paragraph', text: '乙', offset: 1 })
    // 再按一次：不应命中"空项"分支
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(false)
    expect(items(view).map(({ text }) => text)).toEqual(['甲', '乙'])
  })

  it('任务列表：空项被删除，其它项的勾选态原样保留', async () => {
    const view = await openView(['- [ ] 甲', '- [x] 乙', '- [ ] 丙丙丙', ''].join('\n'))
    caretToParagraphEnd(view, '丙丙丙')
    deleteChars(view, 3)
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(true)

    expect(items(view)).toEqual([
      { text: '甲', depth: 1, checked: false },
      { text: '乙', depth: 1, checked: true }
    ])
    expect(caretInfo(view)).toEqual({ parent: 'paragraph', text: '乙', offset: 1 })
    expect(strayEmptyParagraphs(view)).toEqual([])
  })
})

describe('命令守卫', () => {
  it('列表项里还有文本时不得命中（否则一次 Backspace 会删掉整项）', async () => {
    const view = await openView(['1. 甲', '2. 乙', '3. 丙', ''].join('\n'))
    caretToParagraphEnd(view, '丙')
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(false)
    expect(view.state.doc.textContent).toContain('丙')
  })

  it('项内第二个段落被删空时不得命中（不能连本项前面的段落一起删）', async () => {
    const view = await openView(['- abc', '', '  def', '', '- x', ''].join('\n'))
    caretToParagraphEnd(view, 'def')
    deleteChars(view, 3)
    // 空段落不是本项的第一块 → 放行给默认键位（join 前后块）
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(false)
    expect(view.state.doc.textContent).toContain('abc')
  })

  it('空段落后面还挂着有内容的嵌套列表时不得命中', async () => {
    const view = await openView(['-', '  - x', ''].join('\n'))
    // 解析结果：父项（空段落）+ 子项 x —— 整项 textContent 不为空
    expect(items(view).map(({ text, depth }) => ({ text, depth }))).toEqual([
      { text: '', depth: 1 },
      { text: 'x', depth: 2 }
    ])
    // 光标放进"父项自己的空段落"（不要落到文档末尾的尾随空段落上）
    let target = -1
    view.state.doc.descendants((node, pos) => {
      if (target >= 0) return false
      if (node.type.name !== 'paragraph' || node.content.size !== 0) return true
      const $pos = view.state.doc.resolve(pos + 1)
      if ($pos.node(-1)?.type.name === 'list_item') target = pos + 1
      return false
    })
    expect(target).toBeGreaterThan(0)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)))
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(false)
    expect(view.state.doc.textContent).toContain('x')
  })
})

describe('连按四次（等价真实按键序列）', () => {
  it('有序列表：3 次删字符 + 第 4 次删空项，光标回到乙末尾', async () => {
    const view = await openView(['1. 甲', '2. 乙', '3. 丙丙丙', ''].join('\n'))
    caretToParagraphEnd(view, '丙丙丙')
    deleteChars(view, 3)
    expect(view.state.selection.$from.parent.textContent).toBe('')

    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(true)
    expect(emptyItems(view)).toEqual([])
    expect(items(view).map(({ text }) => text)).toEqual(['甲', '乙'])
    expect(caretInfo(view)).toEqual({ parent: 'paragraph', text: '乙', offset: 1 })
  })
})

describe('空列表项判定：不能误删非文本内容（P1）', () => {
  it('最小 schema：项里是「空段落 + 图片」时不得被当成空项', async () => {
    const { Schema } = await import('@milkdown/kit/prose/model')
    const { EditorState } = await import('@milkdown/kit/prose/state')
    const schema = new Schema({
      nodes: {
        text: { group: 'inline' },
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
        image: { group: 'inline', inline: true, attrs: { src: {} }, toDOM: () => ['img'] },
        bullet_list: {
          group: 'block',
          content: 'list_item+',
          toDOM: () => ['ul', 0]
        },
        list_item: { content: 'paragraph block*', defining: true, toDOM: () => ['li', 0] }
      },
      marks: {}
    })
    // 结构：- （空段落）\n  ![](x.png) —— 项里只有一个空段落 + 一个图片
    const item = schema.nodes.list_item.create(null, [
      schema.nodes.paragraph.create(),
      schema.nodes.paragraph.create(null, schema.nodes.image.create({ src: 'x.png' }))
    ])
    const doc = schema.nodes.doc.create(null, [schema.nodes.bullet_list.create(null, [item])])
    const state = EditorState.create({ doc, schema })
    // 光标放在那个空段落里（项的第一块）。命令**不得**接管（否则整个项连同图片被删）
    const withSelection = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)))
    expect(listItemEmptyBackspace(withSelection, undefined)).toBe(false)
  })

  it('真实 Desk schema：列表项里的图片在文字删空后仍在，命令不得接管', async () => {
    // markdown → 真实 Desk 文档：列表项里先文字、后图片
    const view = await openView(['- 图文', '  ![图](../assets/pic.svg)', ''].join('\n'))
    const countImages = () => {
      let n = 0
      view.state.doc.descendants((node) => {
        if (node.type.name === 'image') n += 1
        return true
      })
      return n
    }
    const countItems = () => {
      let n = 0
      view.state.doc.descendants((node) => {
        if (node.type.name === 'list_item') n += 1
        return true
      })
      return n
    }
    expect(countImages()).toBe(1)
    expect(countItems()).toBe(1)

    // 把项里的**文字**删掉（等价用户按 Backspace 删完文字），保留行内图片。
    // 段落里此时是 `text("图文") + hardbreak + image`，所以按节点位置删文本，
    // 不能用 `textContent === '图文'` 去找（会被图片的 alt 影响）。
    let textPos = -1
    let textLen = 0
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === '图文') {
        textPos = pos
        textLen = node.nodeSize
      }
      return true
    })
    expect(textPos).toBeGreaterThan(0)
    view.dispatch(view.state.tr.delete(textPos, textPos + textLen))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textPos)))

    // **区分力**：此刻 `item.textContent` 确实是空串（图片不贡献文本），
    // 所以旧实现（按 textContent 判空）会接管并删掉整项、图片一起没了。
    // 新实现按节点结构判空，必须拒绝接管。
    let itemText = 'MISSING'
    view.state.doc.descendants((node) => {
      if (node.type.name === 'list_item') itemText = node.textContent
      return true
    })
    // 只剩下硬换行（图片不贡献文本），按文本判空必然误判
    expect(itemText.trim()).toBe('')
    expect(listItemEmptyBackspace(view.state, view.dispatch)).toBe(false)
    expect(countImages()).toBe(1)
    expect(countItems()).toBe(1)
  })
})
