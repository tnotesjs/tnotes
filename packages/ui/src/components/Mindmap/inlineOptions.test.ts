// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createLinkDefinitions, setRichSelection } from '@tnotesjs/mindmap-core'
import type { LinkDefinitions, RichInlineEditorElement } from '@tnotesjs/mindmap-core'

import InlineRuns from './InlineRuns'
import RichInlineEditor from './editor/RichInlineEditor.vue'
import { provideMindmapInlineOptions } from './inlineOptions'

const definitions = createLinkDefinitions([['1', 'https://www.baidu.com']])

function mount(child: () => ReturnType<typeof h>, defs: LinkDefinitions | null = definitions) {
  const host = document.createElement('div')
  document.body.append(host)
  createApp({
    setup() {
      // 不提供时走 inject 默认值，相当于宿主没传定义
      if (defs) provideMindmapInlineOptions(() => ({ definitions: defs }))
      return child
    }
  }).mount(host)
  return host
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('Mindmap 行内选项（链接引用定义）', () => {
  it('大纲行把 [文字][id] 渲染成链接，行内代码里的方括号保持文本', () => {
    const host = mount(() => h(InlineRuns, { raw: '参考 [百度][1] `grid[0][1]`' }))
    const link = host.querySelector('a.is-link') as HTMLAnchorElement
    expect(link.textContent).toBe('百度')
    expect(link.getAttribute('href')).toBe('https://www.baidu.com')
    expect(host.querySelector('.is-code')?.textContent).toBe('grid[0][1]')
    expect(host.textContent).toBe('参考 百度 grid[0][1]')
  })

  it('没有提供定义时引用写法按字面量显示', () => {
    const host = mount(() => h(InlineRuns, { raw: '参考 [百度][1]' }), null)
    expect(host.querySelector('a')).toBeNull()
    expect(host.textContent).toBe('参考 [百度][1]')
  })

  it('行内编辑器在引用链接内输入，raw 仍是引用写法', async () => {
    const host = mount(() =>
      h(RichInlineEditor, { editorId: 'n1', raw: '参考 [百度][1]', active: true })
    )
    const editor = host.querySelector('.rich-inline-editor') as RichInlineEditorElement
    expect(editor.value).toBe('参考 百度')
    editor.focus()
    setRichSelection(editor, 5)
    editor.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: '一下'
      })
    )
    await nextTick()
    await nextTick()
    expect(editor.rawValue).toBe('参考 [百度一下][1]')
  })
})
