/** @vitest-environment happy-dom */

import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'

import WordList from './WordList.vue'
import { WORD_LIST_FEATURES_STATIC } from './wordListFeatures'
import { deskWordListStorageScope, wordListStorageKey } from './wordListStorage'

function mount(words: string[], storageScope?: string): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  createApp({
    render: () =>
      h(WordList, {
        words,
        features: { ...WORD_LIST_FEATURES_STATIC },
        ...(storageScope === undefined ? {} : { storageScope })
      })
  }).mount(host)
  return host
}

function checkbox(host: HTMLElement, index: number): HTMLInputElement {
  return host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index]!
}

async function toggle(host: HTMLElement, index: number): Promise<void> {
  checkbox(host, index).click()
  await nextTick()
}

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
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

  it('未注入作用域时沿用 pathname + 单词作为键（SSG 行为不变）', async () => {
    const host = mount(['apple'])
    await nextTick()
    await toggle(host, 0)
    expect(localStorage.getItem(`${window.location.pathname}-apple`)).toBe('true')
  })

  it('不同笔记作用域的勾选态互不影响', async () => {
    const scopeA = deskWordListStorageScope('kb', 'note-a')
    const scopeB = deskWordListStorageScope('kb', 'note-b')
    const a = mount(['apple', 'cherry'], scopeA)
    await nextTick()
    await toggle(a, 0)
    expect(checkbox(a, 0).checked).toBe(true)
    expect(localStorage.getItem(wordListStorageKey(scopeA, '', 'apple'))).toBe('true')
    expect(localStorage.getItem(`${window.location.pathname}-apple`)).toBe(null)

    const b = mount(['apple', 'cherry'], scopeB)
    await nextTick()
    expect(checkbox(b, 0).checked).toBe(false)
    expect(checkbox(b, 1).checked).toBe(false)

    // 同一作用域重新挂载能读回勾选态
    const again = mount(['apple', 'cherry'], scopeA)
    await nextTick()
    expect(checkbox(again, 0).checked).toBe(true)
  })
})

describe('wordListStorage', () => {
  it('有作用域用作用域，否则退回 pathname', () => {
    expect(wordListStorageKey('', '/notes/a', 'apple')).toBe('/notes/a-apple')
    expect(wordListStorageKey(undefined, '/notes/a', 'apple')).toBe('/notes/a-apple')
    expect(wordListStorageKey('scope', '/index.html', 'apple')).toBe('scope-apple')
  })

  it('Desk 作用域带知识库和笔记维度，缺一项时为空', () => {
    expect(deskWordListStorageScope('kb1', 'n1')).toBe('tnotes-desk:word-list:kb1:n1')
    expect(deskWordListStorageScope('kb1', 'n1')).not.toBe(deskWordListStorageScope('kb1', 'n2'))
    expect(deskWordListStorageScope('kb1', 'n1')).not.toBe(deskWordListStorageScope('kb2', 'n1'))
    expect(deskWordListStorageScope('', 'n1')).toBe('')
    expect(deskWordListStorageScope('kb1', '')).toBe('')
  })
})
