// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { setRichSelection } from '@tnotesjs/mindmap-core'
import type { RichInlineEditorElement } from '@tnotesjs/mindmap-core'
import RichInlineEditor from './RichInlineEditor.vue'

function mountEditor(raw: string) {
  const host = document.createElement('div')
  document.body.append(host)
  const commits: string[] = []
  const app = createApp({
    setup: () => () =>
      h(RichInlineEditor, {
        editorId: 'node-1',
        raw,
        active: true,
        onCommit: (payload: { raw: string }) => commits.push(payload.raw)
      })
  })
  app.mount(host)
  return {
    app,
    host,
    commits,
    editor: host.querySelector('.rich-inline-editor') as RichInlineEditorElement
  }
}

async function settle() {
  await nextTick()
  await nextTick()
}

function beforeInput(editor: HTMLElement, inputType: string, data: string | null = null) {
  editor.dispatchEvent(
    new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType,
      data
    })
  )
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('RichInlineEditor', () => {
  it('编辑态直接渲染全部行内样式', () => {
    const { host, editor } = mountEditor(
      '**粗体** *斜体* <u>下划线</u> ~~删除~~ `代码` [链接](https://example.com)'
    )
    expect(editor.isContentEditable).toBe(true)
    expect(host.querySelector('.bold')?.textContent).toBe('粗体')
    expect(host.querySelector('.italic')?.textContent).toBe('斜体')
    expect(host.querySelector('.underline')?.textContent).toBe('下划线')
    expect(host.querySelector('.strike')?.textContent).toBe('删除')
    expect(host.querySelector('.code')?.textContent).toBe('代码')
    expect(host.querySelector('.link')?.textContent).toBe('链接')
  })

  it('在删除线与链接内输入时继承原样式', async () => {
    const strike = mountEditor('~~目标~~')
    strike.editor.focus()
    setRichSelection(strike.editor, 1)
    beforeInput(strike.editor, 'insertText', '新')
    await settle()
    expect(strike.editor.rawValue).toBe('~~目新标~~')
    expect(strike.host.querySelector('.strike')?.textContent).toBe('目新标')

    strike.app.unmount()
    const link = mountEditor('[目标](https://example.com)')
    link.editor.focus()
    setRichSelection(link.editor, 1)
    beforeInput(link.editor, 'insertText', '新')
    await settle()
    expect(link.editor.rawValue).toBe('[目新标](https://example.com)')
  })

  it('跨样式范围替换与删空链接不会产生残缺标记', async () => {
    const mixed = mountEditor('**ab**cd')
    mixed.editor.focus()
    setRichSelection(mixed.editor, 1, 3)
    beforeInput(mixed.editor, 'insertText', 'X')
    await settle()
    expect(mixed.editor.rawValue).toBe('**aX**d')

    mixed.app.unmount()
    const link = mountEditor('[目标](https://example.com)')
    link.editor.focus()
    setRichSelection(link.editor, 0, 2)
    beforeInput(link.editor, 'deleteContentBackward')
    await settle()
    expect(link.editor.rawValue).toBe('')
    expect(link.host.querySelector('.link')).toBeNull()
  })

  it('Backspace 按 grapheme 删除，不会留下半个 emoji', async () => {
    const family = '👨‍👩‍👧‍👦'
    const { editor, host } = mountEditor(`~~A${family}B~~`)
    editor.focus()
    setRichSelection(editor, 1 + family.length)
    beforeInput(editor, 'deleteContentBackward')
    await settle()
    expect(editor.rawValue).toBe('~~AB~~')
    expect(host.querySelector('.strike')?.textContent).toBe('AB')
  })

  it('粘贴只读取 text/plain，不接收外部 HTML', async () => {
    const { editor, host } = mountEditor('~~目标~~')
    editor.focus()
    setRichSelection(editor, 1, 1)
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [],
        getData: (type: string) => (type === 'text/plain' ? '<安全>' : '<img onerror=alert(1)>')
      }
    })
    editor.dispatchEvent(event)
    await settle()
    expect(editor.rawValue).toBe('~~目\\<安全\\>标~~')
    expect(host.querySelector('img, script')).toBeNull()
  })

  it('中文组合输入结束后规范化 DOM 并保留所在格式', async () => {
    const { editor, host } = mountEditor('~~目标~~')
    editor.focus()
    setRichSelection(editor, 1)
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    editor.textContent = '目中文标'
    setRichSelection(editor, 3)
    editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    await settle()
    expect(editor.rawValue).toBe('~~目中文标~~')
    expect(host.querySelector('.strike')?.textContent).toBe('目中文标')
  })
})
