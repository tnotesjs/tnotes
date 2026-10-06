// @vitest-environment happy-dom
/**
 * 大纲视图编辑交互的组件级测试（对齐幕布行为）。
 * 覆盖 Enter 的四种光标场景 / Backspace 合并 / Tab 升降级 / 多行粘贴。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import { MindmapSession, resetNodeIdCounter } from '@tnotesjs/mindmap-core'
import type { RichInlineEditorElement } from '@tnotesjs/mindmap-core'
import OutlineView from './OutlineView.vue'

const MD = '# T\n\n- a\n  - a1\n  - a2\n- b\n'

function mountOutline(markdown = MD) {
  resetNodeIdCounter()
  const session = new MindmapSession({ markdown, fileName: 't.tn-mindmap.md' })
  const version = ref(0)
  session.on('change', () => version.value++)
  session.on('selectionChange', () => version.value++)
  session.on('collapseChange', () => version.value++)
  session.on('focusChange', () => version.value++)

  const host = document.createElement('div')
  document.body.appendChild(host)
  const pastedImages: Array<{ anchorId: string; blob: Blob }> = []
  const app = createApp({
    setup: () => () =>
      h(OutlineView, {
        session,
        version: version.value,
        onPasteImage: (anchorId: string, blob: Blob) => pastedImages.push({ anchorId, blob })
      })
  })
  app.mount(host)
  return { session, host, app, pastedImages }
}

function inputOf(host: HTMLElement, id: string): RichInlineEditorElement | null {
  return host.querySelector(`.rich-inline-editor[data-id="${id}"]`)
}

function keydown(input: RichInlineEditorElement, key: string, opts: KeyboardEventInit = {}) {
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
  )
}

async function settle() {
  await nextTick()
  await nextTick()
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('大纲输入（受控值）', () => {
  it('连续输入不会被行高重算冲掉', async () => {
    const { session, host } = mountOutline()
    const a1 = session.document.root.children[0].children[0]
    const input = inputOf(host, a1.id)!
    input.focus()
    await settle()

    input.value = 'hello'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(inputOf(host, a1.id)?.value).toBe('hello')

    input.value = 'hello世界'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(inputOf(host, a1.id)?.value).toBe('hello世界')
    expect(a1.content.raw).toBe('a1')
  })
})

describe('大纲图片粘贴', () => {
  it('优先识别剪贴板图片并上抛 Blob，不改变现有文档', async () => {
    const { session, host, pastedImages } = mountOutline()
    const a = session.document.root.children[0]
    const input = inputOf(host, a.id)!
    const image = new File(['image-data'], 'shot.png', { type: 'image/png' })
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
        getData: () => 'should-not-be-inserted'
      }
    })

    input.dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(pastedImages).toEqual([{ anchorId: a.id, blob: image }])
    expect(session.getMarkdown()).toBe(MD)
  })
})

describe('大纲 Enter 行为（幕布对齐）', () => {
  it('光标在行尾：下方插入同级空行，光标移入新行', async () => {
    const { session, host } = mountOutline()
    const a = session.document.root.children[0]
    const input = inputOf(host, a.id)!
    input.focus()
    input.setSelectionRange(1, 1) // 'a' 行尾
    keydown(input, 'Enter')
    await settle()

    const md = session.getMarkdown()
    expect(md).toContain('- a\n  - a1\n  - a2\n- \n- b\n')

    // 光标移到新行（空行，位于 a 与 b 之间）
    const active = document.activeElement as HTMLTextAreaElement
    expect(active?.classList.contains('row-input')).toBe(true)
    expect(active?.value).toBe('')
    expect(active?.dataset.id).not.toBe(a.id)
  })

  it('光标在行中：分裂节点，前半留当前行，后半进新行，光标在新行行首', async () => {
    const { session, host } = mountOutline()
    const a1 = session.document.root.children[0].children[0]
    // 先把 a1 改成 hello 并提交
    session.updateNodeRaw(a1.id, 'hello')
    await settle()

    const input = inputOf(host, a1.id)!
    input.focus()
    expect(input.value).toBe('hello')
    input.setSelectionRange(2, 2) // he|llo
    keydown(input, 'Enter')
    await settle()

    const md = session.getMarkdown()
    expect(md).toContain('  - he\n  - llo\n')

    const active = document.activeElement as HTMLTextAreaElement
    expect(active?.value).toBe('llo')
    expect(active?.selectionStart).toBe(0)
    expect(active?.dataset.id).not.toBe(a1.id)
  })

  it('光标在行首：上方插入空行，光标在上面的空行', async () => {
    const { session, host } = mountOutline()
    const a1 = session.document.root.children[0].children[0]
    const input = inputOf(host, a1.id)!
    input.focus()
    input.setSelectionRange(0, 0)
    keydown(input, 'Enter')
    await settle()

    expect(session.getMarkdown()).toContain('  - \n  - a1\n')

    const active = document.activeElement as HTMLTextAreaElement
    expect(active?.value).toBe('')
    expect(active?.dataset.id).not.toBe(a1.id)
  })

  it('有展开子节点的父行行尾 Enter：下方插入同级空行', async () => {
    const { session, host } = mountOutline()
    const a = session.document.root.children[0]
    const input = inputOf(host, a.id)!
    input.focus()
    input.setSelectionRange(1, 1)
    keydown(input, 'Enter')
    await settle()

    // a 的子节点保持 a1/a2，新空行是 a 的同级
    const md = session.getMarkdown()
    expect(md).toContain('- a\n  - a1\n  - a2\n- \n- b\n')
  })

  it('新建空行失焦后仍保留（幕布允许空节点）', async () => {
    const { session, host } = mountOutline()
    const a = session.document.root.children[0]
    const input = inputOf(host, a.id)!
    input.focus()
    input.setSelectionRange(1, 1)
    keydown(input, 'Enter')
    await settle()

    const empty = document.activeElement as HTMLTextAreaElement
    expect(empty?.value).toBe('')
    empty.blur()
    await settle()

    expect(session.getMarkdown()).toContain('- a\n  - a1\n  - a2\n- \n- b\n')
  })

  it('清空已有内容后失焦：节点变为空节点并保留', async () => {
    const { session, host } = mountOutline()
    const b = session.document.root.children[1]
    const input = inputOf(host, b.id)!
    input.focus()
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.blur()
    await settle()

    // blur 走 commitRow，需手动触发 blur 处理器：happy-dom 的 blur 会触发
    expect(session.document.root.children[1].content.raw).toBe('')
    expect(session.getMarkdown()).toContain('- a\n  - a1\n  - a2\n- \n')
  })
})

describe('大纲 Backspace / Tab 行为', () => {
  it('行首 Backspace：合并到视觉上一行，光标在拼接点', async () => {
    const { session, host } = mountOutline()
    const a2 = session.document.root.children[0].children[1]
    const input = inputOf(host, a2.id)!
    input.focus()
    input.setSelectionRange(0, 0)
    keydown(input, 'Backspace')
    await settle()

    expect(session.getMarkdown()).toContain('  - a1a2\n')
    const active = document.activeElement as HTMLTextAreaElement
    expect(active?.value).toBe('a1a2')
    expect(active?.selectionStart).toBe(2)
  })

  it('空行行首 Backspace：删除本行并聚焦上一行末尾', async () => {
    const { session, host } = mountOutline('# T\n\n- a\n- \n- b\n')
    const empty = session.document.root.children[1]
    const input = inputOf(host, empty.id)!
    input.focus()
    input.setSelectionRange(0, 0)
    keydown(input, 'Backspace')
    await settle()

    expect(session.getMarkdown()).toBe('# T\n\n- a\n- b\n')
    const active = document.activeElement as HTMLTextAreaElement
    expect(active?.value).toBe('a')
    expect(active?.selectionStart).toBe(1)
  })

  it('编辑态 Tab 降级并保持编辑焦点', async () => {
    const { session, host } = mountOutline()
    const b = session.document.root.children[1]
    const input = inputOf(host, b.id)!
    input.focus()
    input.setSelectionRange(1, 1)
    keydown(input, 'Tab')
    await settle()

    expect(session.getMarkdown()).toContain('- a\n  - a1\n  - a2\n  - b\n')
    const active = document.activeElement as HTMLTextAreaElement
    expect(active?.dataset.id).toBe(b.id)
  })
})

describe('大纲标题（聚焦根）行为', () => {
  it('标题不在列表 bullet 行中；列表从根的子节点开始', async () => {
    const { session, host } = mountOutline()
    const root = session.document.root
    const title = inputOf(host, root.id)
    expect(title?.classList.contains('title-input')).toBe(true)
    expect(host.querySelectorAll('.rich-inline-editor.row-input').length).toBe(4) // a,a1,a2,b
  })

  it('标题行尾 Enter：聚焦首个子节点', async () => {
    const { session, host } = mountOutline()
    const root = session.document.root
    const title = inputOf(host, root.id)!
    title.focus()
    title.setSelectionRange(title.value.length, title.value.length)
    keydown(title, 'Enter')
    await settle()

    const active = document.activeElement as HTMLTextAreaElement
    expect(active?.dataset.id).toBe(session.document.root.children[0].id)
    expect(session.getMarkdown()).toBe(MD)
  })

  it('无子节点时标题 Enter：新建首个子节点', async () => {
    const { session, host } = mountOutline('# Alone\n')
    const root = session.document.root
    const title = inputOf(host, root.id)!
    title.focus()
    keydown(title, 'Enter')
    await settle()

    expect(session.document.root.children).toHaveLength(1)
    expect(session.document.root.children[0].content.raw).toBe('')
    const active = document.activeElement as HTMLTextAreaElement
    expect(active?.dataset.id).toBe(session.document.root.children[0].id)
  })

  it('Cmd+Enter 在列表行新建子节点', async () => {
    const { session, host } = mountOutline()
    const b = session.document.root.children[1]
    const input = inputOf(host, b.id)!
    input.focus()
    input.setSelectionRange(1, 1)
    keydown(input, 'Enter', { metaKey: true })
    await settle()

    expect(b.children).toHaveLength(1)
    expect(b.children[0].content.raw).toBe('')
  })
})

describe('大纲图片节点', () => {
  it('图片节点在大纲中渲染预览，描述可编辑且写回 markdown', async () => {
    const md = '# T\n\n- ![头像|120](https://avatars.githubusercontent.com/u/83686346?v=4)\n'
    const { session, host } = mountOutline(md)
    const imgNode = session.document.root.children[0]
    expect(imgNode.content.image?.src).toContain('avatars.githubusercontent.com')

    const preview = host.querySelector('img.row-image-img') as HTMLImageElement | null
    expect(preview).toBeTruthy()
    expect(preview?.getAttribute('src')).toBe(imgNode.content.image!.src)

    const input = inputOf(host, imgNode.id)!
    expect(input.value).toBe('头像')
    input.focus()
    input.value = '新描述'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.blur()
    await settle()

    expect(session.getMarkdown()).toContain(
      '![新描述|120](https://avatars.githubusercontent.com/u/83686346?v=4)'
    )
  })

  it('进入图片节点后标题显示描述并保留图片预览', async () => {
    const md = '# T\n\n- ![头像|120](https://avatars.githubusercontent.com/u/83686346?v=4)\n'
    const { session, host } = mountOutline(md)
    const imgNode = session.document.root.children[0]
    session.focusNode(imgNode.id)
    await settle()

    const title = inputOf(host, imgNode.id)!
    expect(title.classList.contains('title-input')).toBe(true)
    expect(title.value).toBe('头像')
    expect(title.value).not.toContain('![')
    const preview = host.querySelector('.title-image img.row-image-img') as HTMLImageElement | null
    expect(preview?.getAttribute('src')).toBe(imgNode.content.image!.src)
  })
})

describe('大纲粘贴 / 复制', () => {
  it('多行粘贴按缩进解析为子树插入当前行之后', async () => {
    const { session, host } = mountOutline()
    const a = session.document.root.children[0]
    const input = inputOf(host, a.id)!
    input.focus()

    const clipboardData = {
      getData: () => '- x\n  - x1\n- y'
    } as unknown as ClipboardEvent['clipboardData']
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: clipboardData })
    input.dispatchEvent(event)
    await settle()

    expect(session.getMarkdown()).toContain('- a\n  - a1\n  - a2\n- x\n  - x1\n- y\n- b\n')
  })

  it('无选中文本时 Cmd+C 复制整棵子树为 markdown 列表', async () => {
    const { session, host } = mountOutline()
    const a = session.document.root.children[0]
    const input = inputOf(host, a.id)!
    input.focus()
    input.setSelectionRange(0, 0) // 无选区

    let copied = ''
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (_t: string, data: string) => (copied = data) }
    })
    input.dispatchEvent(event)
    await settle()

    expect(copied).toBe('- a\n  - a1\n  - a2')
  })
})

describe('大纲连续节点选择（幕布对齐）', () => {
  it('当前行文本已全选时再次 Cmd+A，扩大为当前主题下全部节点', async () => {
    const { session, host } = mountOutline()
    const a1 = session.document.root.children[0].children[0]
    const input = inputOf(host, a1.id)!
    input.focus()
    input.setSelectionRange(0, input.value.length)
    keydown(input, 'a', { metaKey: true })
    await settle()

    expect(session.selectedNodes.map((n) => n.content.text)).toEqual(['a', 'a1', 'a2', 'b'])
    expect(document.activeElement?.classList.contains('outline-view')).toBe(true)
  })

  it('跨行纵向拖动选择连续可见节点', async () => {
    const { session, host } = mountOutline()
    const a1 = session.document.root.children[0].children[0]
    const input = inputOf(host, a1.id)!

    input.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientY: 40 })
    )
    document.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 110 })
    )
    document.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientY: 110 })
    )
    await settle()

    expect(session.selectedNodes.map((n) => n.content.text)).toEqual(['a1', 'a2', 'b'])
    expect(host.querySelectorAll('.outline-row.is-selected')).toHaveLength(3)
    expect(document.activeElement).toBe(host.querySelector('.outline-view'))
  })

  it.each(['Delete', 'Backspace'])('拖动选中连续节点后按 %s 删除所选节点', async (key) => {
    const { session, host } = mountOutline()
    const a1 = session.document.root.children[0].children[0]
    const input = inputOf(host, a1.id)!
    input.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientY: 40 })
    )
    document.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 110 })
    )
    document.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientY: 110 })
    )
    await settle()

    const container = host.querySelector('.outline-view') as HTMLElement
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    container.dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(session.document.root.children.map((node) => node.content.text)).toEqual(['a'])
    expect(session.document.root.children[0].children).toHaveLength(0)
    session.undo()
    expect(session.getMarkdown()).toBe(MD)
  })

  it('节点选择态 Cmd+X 写入 Markdown 后删除所选节点', async () => {
    const { session, host } = mountOutline()
    const [a, b] = session.document.root.children
    session.selectMany([a.id, b.id], b.id, a.id)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const container = host.querySelector('.outline-view') as HTMLElement
    container.focus()
    const event = new KeyboardEvent('keydown', {
      key: 'x',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })

    container.dispatchEvent(event)
    await Promise.resolve()
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(writeText).toHaveBeenCalledWith('- a\n  - a1\n  - a2\n- b')
    expect(session.document.root.children).toHaveLength(0)
    session.undo()
    expect(session.getMarkdown()).toBe(MD)
  })

  it('剪贴板写入失败时 Cmd+X 不删除节点', async () => {
    const { session, host } = mountOutline()
    const a = session.document.root.children[0]
    session.select(a.id)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    })
    const container = host.querySelector('.outline-view') as HTMLElement
    container.focus()

    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'x', metaKey: true, bubbles: true, cancelable: true })
    )
    await Promise.resolve()
    await settle()

    expect(session.document.root.children.map((node) => node.content.text)).toEqual(['a', 'b'])
  })

  it('Shift+方向键以首次选择为锚点扩展和收缩连续选择', async () => {
    const { session, host } = mountOutline()
    const a1 = session.document.root.children[0].children[0]
    const a2 = session.document.root.children[0].children[1]
    const input = inputOf(host, a1.id)!
    input.focus()

    keydown(input, 'ArrowDown', { shiftKey: true })
    await settle()
    expect(session.selectedNodes.map((node) => node.content.text)).toEqual(['a1', 'a2'])
    expect(session.selectionAnchor).toBe(a1)
    expect(session.selectedNode).toBe(a2)

    const container = host.querySelector('.outline-view') as HTMLElement
    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    await settle()
    expect(session.selectedNodes.map((node) => node.content.text)).toEqual(['a1'])
    expect(session.selectionAnchor).toBe(a1)
  })

  it('Shift+点击按锚点选中连续节点', async () => {
    const { session, host } = mountOutline()
    const a1 = session.document.root.children[0].children[0]
    const b = session.document.root.children[1]
    session.select(a1.id)
    await settle()

    inputOf(host, b.id)!.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 2,
        shiftKey: true
      })
    )
    await settle()

    expect(session.selectedNodes.map((node) => node.content.text)).toEqual(['a1', 'a2', 'b'])
    expect(session.selectionAnchor).toBe(a1)
    expect(session.selectedNode).toBe(b)
  })

  it('Cmd+] 进入当前主题，Cmd+[ 返回父主题', async () => {
    const { session, host } = mountOutline()
    const a = session.document.root.children[0]
    const input = inputOf(host, a.id)!
    input.focus()
    keydown(input, ']', { metaKey: true })
    await settle()

    expect(session.focusRootNode).toBe(a)
    const title = inputOf(host, a.id)!
    expect(title.classList.contains('title-input')).toBe(true)
    keydown(title, '[', { metaKey: true })
    await settle()

    expect(session.focusRootNode).toBe(session.document.root)
    expect(inputOf(host, a.id)?.classList.contains('row-input')).toBe(true)
  })

  it('同深度切换聚焦主题时清理旧编辑态、文字选区和滚动位置', async () => {
    const { session, host } = mountOutline(
      '# T\n\n- A\n  - A1 alpha\n    - A11\n  - A2 beta\n    - A21\n'
    )
    const a = session.document.root.children[0]
    const [a1, a2] = a.children
    session.focusNode(a1.id)
    await settle()

    const container = host.querySelector('.outline-view') as HTMLElement
    container.scrollTop = 96
    container.dispatchEvent(new Event('scroll'))

    const oldEditor = inputOf(host, a1.id)!
    oldEditor.focus()
    oldEditor.value = 'A1 draft'
    oldEditor.dispatchEvent(new Event('input', { bubbles: true }))
    oldEditor.setSelectionRange(0, 2)
    oldEditor.dispatchEvent(new Event('select', { bubbles: true }))
    await settle()
    expect(document.activeElement).toBe(oldEditor)
    expect(document.body.querySelector('[aria-label="文字格式工具栏"]')).not.toBeNull()
    expect(container.scrollTop).toBe(96)

    session.switchFocusNode(a2.id)
    await settle()

    expect(session.focusPath.map((node) => node.id)).toEqual([a.id, a2.id])
    expect(session.selectedNode).toBe(a2)
    expect(a1.content.text).toBe('A1 draft')
    expect(a2.content.text).toBe('A2 beta')
    expect(inputOf(host, a1.id)).toBeNull()
    expect(inputOf(host, a2.id)?.classList.contains('is-view-mode')).toBe(true)
    expect(document.activeElement).toBe(container)
    expect(document.body.querySelector('[aria-label="文字格式工具栏"]')).toBeNull()
    expect(container.scrollTop).toBe(0)
  })

  it('进入主题聚焦后退出纯文本编辑态并完整保留行内样式', async () => {
    const raw = '**粗体** *斜体* <u>下划线</u> ~~删除线~~ ==高亮== [链接](https://example.com)'
    const { session, host } = mountOutline(`# T\n\n- ${raw}\n  - child\n`)
    const formatted = session.document.root.children[0]
    const input = inputOf(host, formatted.id)!

    input.focus()
    keydown(input, ']', { metaKey: true })
    await settle()

    expect(session.focusRootNode).toBe(formatted)
    expect(formatted.content.raw).toBe(raw)
    const title = host.querySelector('.outline-title')!
    expect(inputOf(host, formatted.id)?.classList.contains('is-view-mode')).toBe(true)
    expect(title.querySelector('.inline-run.bold')?.textContent).toBe('粗体')
    expect(title.querySelector('.inline-run.italic')?.textContent).toBe('斜体')
    expect(title.querySelector('.inline-run.underline')?.textContent).toBe('下划线')
    expect(title.querySelector('.inline-run.strike')?.textContent).toBe('删除线')
    expect(title.querySelector('.inline-run.highlight')?.textContent).toBe('高亮')
    expect(title.querySelector('.inline-run.link')?.textContent).toBe('链接')

    session.exitFocusTo(0)
    await settle()
    expect(formatted.content.raw).toBe(raw)
  })

  it('Cmd+Shift+方向键移动主题，Cmd+D 复制主题', async () => {
    const { session, host } = mountOutline('# T\n\n- a\n- b\n- c\n')
    const b = session.document.root.children[1]
    const input = inputOf(host, b.id)!
    input.focus()
    keydown(input, 'ArrowUp', { metaKey: true, shiftKey: true })
    await settle()
    expect(session.document.root.children.map((node) => node.content.text)).toEqual(['b', 'a', 'c'])

    const moved = inputOf(host, b.id)!
    keydown(moved, 'd', { metaKey: true })
    await settle()
    expect(session.document.root.children.map((node) => node.content.text)).toEqual([
      'b',
      'b',
      'a',
      'c'
    ])
    expect(session.selectedNode?.content.text).toBe('b')
  })

  it('多选后 Cmd+C 复制顶层子树，Delete 作为一条历史删除', async () => {
    const { session, host } = mountOutline()
    const a = session.document.root.children[0]
    const a1 = a.children[0]
    const a2 = a.children[1]
    const b = session.document.root.children[1]
    session.selectMany([a.id, a1.id, a2.id, b.id], b.id)
    await settle()

    const container = host.querySelector('.outline-view') as HTMLElement
    container.focus()
    let copied = ''
    const copy = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(copy, 'clipboardData', {
      value: { setData: (_t: string, data: string) => (copied = data) }
    })
    container.dispatchEvent(copy)
    expect(copied).toBe('- a\n  - a1\n  - a2\n- b')

    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
    )
    await settle()
    expect(session.document.root.children).toHaveLength(0)
    session.undo()
    expect(session.getMarkdown()).toBe(MD)
  })
})

describe('大纲富文本、链接与浮动工具栏', () => {
  it('节点进入文字编辑态后仍原位显示全部行内样式', async () => {
    const raw = '**粗体** *斜体* <u>下划线</u> ~~删除线~~ ==高亮== `代码`'
    const { session, host } = mountOutline(`# T\n\n- ${raw}\n`)
    const node = session.document.root.children[0]
    const editor = inputOf(host, node.id)!

    editor.focus()
    await settle()

    expect(editor.isContentEditable).toBe(true)
    expect(editor.querySelector('.bold')?.textContent).toBe('粗体')
    expect(editor.querySelector('.italic')?.textContent).toBe('斜体')
    expect(editor.querySelector('.underline')?.textContent).toBe('下划线')
    expect(editor.querySelector('.strike')?.textContent).toBe('删除线')
    expect(editor.querySelector('.highlight')?.textContent).toBe('高亮')
    expect(editor.querySelector('.code')?.textContent).toBe('代码')
    expect(node.content.raw).toBe(raw)
  })

  it('链接以 label 渲染，hover 可更新地址，单击安全地新开标签页', async () => {
    const { session, host } = mountOutline('# T\n\n- [桥水官网](https://old.example)\n')
    const node = session.document.root.children[0]
    const link = host.querySelector('.inline-run.link') as HTMLElement
    expect(link.textContent).toBe('桥水官网')
    expect(host.textContent).not.toContain('[桥水官网]')

    link.dispatchEvent(new Event('mouseenter'))
    await settle()
    const popover = document.body.querySelector('.link-popover') as HTMLElement
    const urlInput = popover.querySelector('.link-input') as HTMLInputElement
    expect(urlInput.value).toBe('https://old.example')
    expect(urlInput.readOnly).toBe(true)
    ;(popover.querySelector('[aria-label="编辑链接地址"]') as HTMLButtonElement).click()
    await settle()
    expect(urlInput.readOnly).toBe(false)
    urlInput.value = 'https://new.example'
    urlInput.dispatchEvent(new Event('input', { bubbles: true }))
    ;(popover.querySelector('.link-action.primary') as HTMLButtonElement).click()
    await settle()
    expect(node.content.raw).toBe('[桥水官网](https://new.example)')

    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    ;(host.querySelector('.inline-run.link') as HTMLElement).click()
    expect(open).toHaveBeenCalledWith('https://new.example', '_blank', 'noopener,noreferrer')
    expect(host.querySelector('[contenteditable="true"]')).toBeNull()
    open.mockRestore()
  })

  it('链接地址输入框内的 ←/→/Backspace 保持原生行为，不被大纲导航拦截', async () => {
    const { session, host } = mountOutline('# T\n\n- [桥水官网](https://old.example)\n  - child\n')
    const node = session.document.root.children[0]
    session.select(node.id)
    ;(host.querySelector('.inline-run.link') as HTMLElement).dispatchEvent(new Event('mouseenter'))
    await settle()
    const popover = document.body.querySelector('.link-popover') as HTMLElement
    ;(popover.querySelector('[aria-label="编辑链接地址"]') as HTMLButtonElement).click()
    await settle()
    const urlInput = popover.querySelector('.link-input') as HTMLInputElement
    for (const key of ['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      urlInput.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    await settle()
    expect(node.collapsed).toBe(false)
    expect(session.document.root.children[0]).toBe(node)
    expect(session.selectedNode?.id).toBe(node.id)
  })

  it('直接编辑链接 label 保留 href，清空最后一个字时移除链接', async () => {
    const { session, host } = mountOutline('# T\n\n- [label](https://old.example)\n')
    const node = session.document.root.children[0]
    let input = inputOf(host, node.id)!
    input.focus()
    await settle()
    input = inputOf(host, node.id)!
    input.value = 'renamed'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.blur()
    await settle()
    expect(node.content.raw).toBe('[renamed](https://old.example)')

    input = inputOf(host, node.id)!
    input.focus()
    await settle()
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.blur()
    await settle()
    expect(node.content.raw).toBe('')
    expect(node.content.link).toBeNull()
  })

  it('选中文字显示一级工具栏，按钮与快捷键复用同一行内命令', async () => {
    const { session, host } = mountOutline('# T\n\n- alpha\n')
    const node = session.document.root.children[0]
    const input = inputOf(host, node.id)!
    input.focus()
    await settle()
    input.setSelectionRange(0, input.value.length)
    input.dispatchEvent(new Event('select', { bubbles: true }))
    await settle()

    const toolbar = document.body.querySelector('[aria-label="文字格式工具栏"]') as HTMLElement
    expect(toolbar).not.toBeNull()
    expect(toolbar.querySelectorAll('button')).toHaveLength(11)
    ;(toolbar.querySelector('.format-button.is-bold') as HTMLButtonElement).click()
    await settle()
    expect(node.content.raw).toBe('**alpha**')

    const activeInput = inputOf(host, node.id)!
    activeInput.setSelectionRange(0, activeInput.value.length)
    keydown(activeInput, 'u', { metaKey: true })
    await settle()
    expect(node.content.raw).toBe('**<u>alpha</u>**')
  })

  it.each([
    ['b', '**alpha**'],
    ['e', '`alpha`']
  ])('光标停在节点内且无选区时 Cmd+%s 格式化整个节点', async (key, expectedRaw) => {
    const { session, host } = mountOutline('# T\n\n- alpha\n')
    const node = session.document.root.children[0]
    const input = inputOf(host, node.id)!
    input.focus()
    await settle()
    input.setSelectionRange(2, 2)

    keydown(input, key, { metaKey: true })
    await settle()

    expect(node.content.raw).toBe(expectedRaw)
    const active = inputOf(host, node.id)!
    expect(document.activeElement).toBe(active)
    expect([active.selectionStart, active.selectionEnd]).toEqual([2, 2])
  })

  it('Option+L 不再被编辑器拦截为行内代码', async () => {
    const { session, host } = mountOutline('# T\n\n- alpha\n')
    const node = session.document.root.children[0]
    const input = inputOf(host, node.id)!
    input.focus()
    await settle()
    input.setSelectionRange(0, input.value.length)
    const event = new KeyboardEvent('keydown', {
      key: 'l',
      altKey: true,
      bubbles: true,
      cancelable: true
    })

    input.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(node.content.raw).toBe('alpha')
  })

  it('文档 H1 标题选区也使用同一富文本工具栏', async () => {
    const { session, host } = mountOutline('# Root title\n\n- child\n')
    const root = session.document.root
    const title = inputOf(host, root.id)!
    title.focus()
    await settle()
    title.setSelectionRange(0, 4)
    title.dispatchEvent(new Event('select', { bubbles: true }))
    await settle()
    ;(document.body.querySelector('.format-button.is-italic') as HTMLButtonElement).click()
    await settle()
    expect(root.content.raw).toBe('*Root* title')
    expect(session.getMarkdown()).toContain('# *Root* title')
  })

  it('多节点选择展示约定操作和清除样式，并批量格式化为一条历史', async () => {
    const { session } = mountOutline('# T\n\n- a\n- b\n- c\n')
    const [a, b] = session.document.root.children
    session.selectMany([a.id, b.id], b.id, a.id)
    await settle()

    const toolbar = document.body.querySelector('[aria-label="多主题工具栏"]') as HTMLElement
    expect(toolbar).not.toBeNull()
    expect(toolbar.querySelectorAll('button')).toHaveLength(9)
    expect(toolbar.querySelector('[aria-label="添加图片"]')).toBeNull()
    expect(toolbar.querySelector('[aria-label="添加链接"]')).toBeNull()
    ;(toolbar.querySelector('.format-button.is-bold') as HTMLButtonElement).click()
    await settle()
    expect(a.content.raw).toBe('**a**')
    expect(b.content.raw).toBe('**b**')
    session.undo()
    expect(session.document.root.children[0].content.raw).toBe('a')
    expect(session.document.root.children[1].content.raw).toBe('b')
  })

  it('折叠计数包含全部后代，而不只是直接子节点', async () => {
    const { session, host } = mountOutline(
      '# T\n\n- 工作原则\n  - 创意择优\n    - 可信度加权\n    - 极度求真\n  - 桥水官网\n  - 原则豆瓣\n'
    )
    const node = session.document.root.children[0]
    session.toggleCollapse(node.id)
    await settle()
    const row = host.querySelector(`.outline-row[data-node-id="${node.id}"]`)
    expect(row?.querySelector('.bullet-count')?.textContent?.trim()).toBe('5')
  })
})
