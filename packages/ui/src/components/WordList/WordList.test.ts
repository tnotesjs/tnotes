/** @vitest-environment happy-dom */

import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'

import WordList from './WordList.vue'
import { WORD_LIST_FEATURES_STATIC } from './wordListFeatures'

function mount(words: string[]): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  createApp({
    render: () => h(WordList, { words, features: { ...WORD_LIST_FEATURES_STATIC } })
  }).mount(host)
  return host
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('WordList', () => {
  it('每个词只显示一份序号', () => {
    const host = mount(['cancel', 'sake'])
    expect([...host.querySelectorAll('.index')].map((node) => node.textContent)).toEqual([
      '1.',
      '2.'
    ])
  })

  it('右键单词打开自定义菜单', async () => {
    const host = mount(['cancel'])
    const link = host.querySelector('a')!
    link.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 12 })
    )
    await nextTick()
    expect(document.querySelector('.rightClickMenu')?.textContent ?? '').toContain('Pronounce')
  })
})
