// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import BlockInsertMenu from './BlockInsertMenu.vue'

const wrappers: ReturnType<typeof mount>[] = []

function labels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.tn-block-picker-label')].map(
    (label) => label.textContent?.trim() ?? ''
  )
}

async function open(parent: string | null, exclude?: string[]): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(BlockInsertMenu, {
    attachTo: document.body,
    props: { disabled: false, active: true, resolveParent: () => parent, exclude }
  })
  wrappers.push(wrapper)
  await wrapper.get('button').trigger('click')
  await new Promise((resolve) => setTimeout(resolve))
  return wrapper
}

function search(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('.block-insert-search input')!
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.replaceChildren()
})

describe('block insert menu', () => {
  it('offers every block at the document root, grouped', async () => {
    await open(null)
    expect(labels()).toContain('提示块')
    expect(labels()).toContain('Mermaid 图表')
    expect(labels()).toContain('表格')
    expect(labels()).toContain('图片')
    // 行内格式（标题、列表）工具栏上已有按钮，不在插入菜单里重复
    expect(labels()).not.toContain('一级标题')
    const groups = [...document.querySelectorAll('.tn-block-picker-group')].map(
      (el) => el.textContent
    )
    expect(groups).toEqual(['基础', '提示块', '代码与图表', '媒体与组件'])
  })

  it('inside a ::: container only offers ordinary content and code', async () => {
    await open('tip')
    expect(labels()).toEqual(['表格', '图片', '公式', '代码块', '代码组'])
  })

  it('inside a code group still offers a code block', async () => {
    await open('code-group')
    expect(labels()).toContain('代码块')
    expect(labels()).not.toContain('提示块')
  })

  it('hides blocks the host does not support', async () => {
    await open(null, ['canvas'])
    expect(labels()).not.toContain('画布')
  })

  it('filters by pinyin initials and picks with Enter', async () => {
    const wrapper = await open(null)
    const input = search()
    input.value = 'swdt'
    input.dispatchEvent(new Event('input'))
    await new Promise((resolve) => setTimeout(resolve))
    expect(labels()[0]).toBe('思维导图')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(wrapper.emitted('select')).toEqual([['mindmap']])
    await new Promise((resolve) => setTimeout(resolve))
    expect(document.querySelector('.block-insert-menu')).toBeNull()
  })

  it('moves the selection with the arrow keys', async () => {
    const wrapper = await open(null)
    const input = search()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(wrapper.emitted('select')).toEqual([['image']])
  })
})
