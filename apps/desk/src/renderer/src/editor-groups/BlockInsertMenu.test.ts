// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import BlockInsertMenu from './BlockInsertMenu.vue'

const wrappers: ReturnType<typeof mount>[] = []

function labels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(
    (button) => button.textContent?.trim() ?? ''
  )
}

async function open(parent: string | null): Promise<string[]> {
  const wrapper = mount(BlockInsertMenu, {
    attachTo: document.body,
    props: { disabled: false, active: true, resolveParent: () => parent }
  })
  wrappers.push(wrapper)
  await wrapper.get('button').trigger('click')
  return labels()
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.replaceChildren()
})

describe('block insert menu nesting', () => {
  it('offers every block at the document root', async () => {
    const items = await open(null)
    expect(items).toContain('提示块')
    expect(items).toContain('Mermaid')
    expect(items).toContain('表格')
  })

  it('inside a ::: container only offers ordinary content', async () => {
    expect(await open('tip')).toEqual(['表格'])
  })

  it('inside a code group still offers a code block', async () => {
    const items = await open('code-group')
    expect(items).toContain('代码块')
    expect(items).not.toContain('提示块')
  })
})
