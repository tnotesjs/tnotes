// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceStore } from '../stores/workspace'
import { commandHistory } from './commandHistory'
import CommandPalette from './CommandPalette.vue'

beforeEach(() => {
  commandHistory.clear()
  setActivePinia(createPinia())
  Object.defineProperty(window, 'desk', {
    configurable: true,
    value: {
      search: vi.fn(async () => ({
        ok: true,
        value: [
          {
            knowledgeBaseId: 'kb-a',
            knowledgeBaseName: 'docs',
            noteUuid: 'note-a',
            noteIndex: '0001',
            fileName: '0001. 欢迎',
            title: '欢迎',
            snippet: '正文',
            score: 1
          }
        ]
      }))
    }
  })
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('CommandPalette', () => {
  it('opens search mode and command mode from the title-bar input', async () => {
    const workspace = useWorkspaceStore()
    workspace.selectedKnowledgeBaseId = 'kb-a'
    const wrapper = mount(CommandPalette, { attachTo: document.body })
    const palette = wrapper.vm as unknown as {
      openSearch: () => Promise<void>
      openCommands: () => Promise<void>
    }

    await palette.openSearch()
    expect(wrapper.get('input').element.value).toBe('')
    expect(wrapper.get('input').attributes('placeholder')).toContain('知识库')

    await palette.openCommands()
    const field = wrapper.get('input').element
    expect(field.value).toBe('>')
    expect(field.selectionStart).toBe(1)
    expect(field.selectionEnd).toBe(1)
    expect(wrapper.get('input').attributes('placeholder')).toBe('输入命令')
    expect(wrapper.text()).toContain('全部折叠标题')
    expect(wrapper.text()).toContain('Fold All')
    expect(wrapper.text()).toContain('折叠 2 级标题')
    expect(wrapper.text()).toContain('Unfold Level 2')
    expect(wrapper.text()).toContain('展开 2 级标题')

    await wrapper.get('input').setValue('>设置')
    expect(wrapper.text()).toContain('打开设置')
    expect(wrapper.text()).not.toContain('全部折叠标题')

    await wrapper.get('input').trigger('blur')
    expect(wrapper.find('#desk-command-palette-list').exists()).toBe(false)

    await palette.openCommands()
    expect(wrapper.find('#desk-command-palette-list').exists()).toBe(true)
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('#desk-command-palette-list').exists()).toBe(false)
    wrapper.unmount()
  })

  it('pressing enter runs the most recently used command', async () => {
    const wrapper = mount(CommandPalette, { attachTo: document.body })
    const palette = wrapper.vm as unknown as { openCommands: () => Promise<void> }
    await palette.openCommands()
    await wrapper.get('input').setValue('>设置')
    const settings = wrapper.findAll('button').find((button) => button.text().includes('打开设置'))
    expect(settings).toBeTruthy()
    await settings!.trigger('mousedown')
    await settings!.trigger('click')
    expect(wrapper.emitted('openSettings')).toHaveLength(1)

    await palette.openCommands()
    expect(wrapper.find('.command-palette__heading').text()).toBe('最近使用')
    expect(wrapper.find('.command-palette__item.is-active').text()).toContain('打开设置')
    await wrapper.get('input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('openSettings')).toHaveLength(2)
    wrapper.unmount()
  })
})
