/** @vitest-environment happy-dom */

import { h } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { hydrateIslands } from '../src/client/hydrateIslands'

vi.mock('@tnotesjs/ui/word-list', () => ({
  default: {
    name: 'WordList',
    props: ['words', 'needSort'],
    setup(props: { words: string[] }) {
      return () =>
        h(
          'div',
          { class: 'tn-word-list', 'data-tn-island': 'word-list' },
          props.words.map((word, index) =>
            h('span', { class: 'index', key: word }, `${index + 1}.${word}`)
          )
        )
    }
  }
}))

/** 一份贴近真实 SSR 输出的代码块（每个代码块标题左侧都有折叠 Icon）。 */
function codeBlockMarkup(code: string): string {
  const collapse =
    '<button type="button" class="tn-code-block__icon-btn tn-code-block__collapse-btn" aria-expanded="true" aria-label="收起代码"></button>'
  return `
    <section class="tn-code-block">
      <header class="tn-code-block__header">
        ${collapse}
        <span class="tn-code-block__title">demo</span>
        <button type="button" class="tn-code-block__icon-btn tn-code-block__copy-btn" aria-label="复制代码"></button>
        <button type="button" class="tn-code-block__icon-btn tn-code-block__fullscreen-btn" aria-label="全屏代码"></button>
      </header>
      <div class="tn-code-block__content"><pre class="tn-code-highlight">${code}</pre></div>
    </section>`
}

describe('hydrateIslands', () => {
  it('switches code-group tabs without Vue', async () => {
    document.body.innerHTML = `
      <section class="tn-code-group has-tabs">
        <div class="tn-code-group__tabs">
          <button type="button" role="tab" class="active" aria-selected="true">one.js</button>
          <button type="button" role="tab" aria-selected="false">two.ts</button>
        </div>
        <div class="tn-code-group__panels">
          <div class="tn-code-group__panel active">first</div>
          <div class="tn-code-group__panel" style="display:none">second</div>
        </div>
      </section>
    `
    await hydrateIslands(document.body)
    const tabs = document.querySelectorAll('button[role="tab"]')
    const panels = document.querySelectorAll<HTMLElement>('.tn-code-group__panel')
    tabs[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(tabs[1]?.classList.contains('active')).toBe(true)
    expect(panels[0]?.hidden).toBe(true)
    expect(panels[1]?.hidden).toBe(false)
  })

  it('代码块折叠按钮就地切换 is-collapsed（不落库、不写 storage）', async () => {
    document.body.innerHTML = `<div data-tn-code="YQ==">${codeBlockMarkup('a')}</div>`
    await hydrateIslands(document.body)
    const block = document.querySelector('.tn-code-block')!
    const button = document.querySelector<HTMLButtonElement>('.tn-code-block__collapse-btn')!
    expect(block.classList.contains('is-collapsed')).toBe(false)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(block.classList.contains('is-collapsed')).toBe(true)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('aria-label')).toBe('展开代码')
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(block.classList.contains('is-collapsed')).toBe(false)
  })

  it('用笔记里的词汇挂上 WordList，再跑一次不会套两层', async () => {
    const words = encodeURIComponent(JSON.stringify(['cancel', 'sake']))
    document.body.innerHTML = `<div class="tn-word-list" data-tn-island="word-list" data-words="${words}" data-need-sort="false"></div>`
    await hydrateIslands(document.body)
    await hydrateIslands(document.body)
    expect([...document.querySelectorAll('.index')].map((node) => node.textContent)).toEqual([
      '1.cancel',
      '2.sake'
    ])
  })

  it('代码分组切换 tab 时自动展开新面板里被收起的代码块', async () => {
    const long = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')
    document.body.innerHTML = `
      <section class="tn-code-group has-tabs">
        <div class="tn-code-group__tabs">
          <button type="button" class="tn-code-group__collapse-btn tn-code-block__icon-btn" aria-expanded="true"></button>
          <button type="button" role="tab" class="active" aria-selected="true">one.js</button>
          <button type="button" role="tab" aria-selected="false">two.ts</button>
        </div>
        <div class="tn-code-group__panels">
          <div class="tn-code-group__panel active">
            <div data-tn-code="YQ==">${codeBlockMarkup('a')}</div>
          </div>
          <div class="tn-code-group__panel" style="display:none">
            <div data-tn-code="Yg==">${codeBlockMarkup(long)}</div>
          </div>
        </div>
      </section>
    `
    await hydrateIslands(document.body)
    const blocks = document.querySelectorAll<HTMLElement>('.tn-code-block')
    const tabs = document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
    const groupButton = document.querySelector<HTMLButtonElement>('.tn-code-group__collapse-btn')!

    // 收起第二个面板的代码，再切过去：应当自动展开
    blocks[1]!.classList.add('is-collapsed')
    tabs[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(blocks[1]?.classList.contains('is-collapsed')).toBe(false)
    expect(groupButton.hidden).toBe(false)
    expect(groupButton.getAttribute('aria-expanded')).toBe('true')

    // tab 行那颗按钮作用于当前面板
    groupButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(blocks[1]?.classList.contains('is-collapsed')).toBe(true)
    expect(groupButton.getAttribute('aria-expanded')).toBe('false')
    // 切回第一个面板：收起状态只属于面板 B，A 不受影响
    tabs[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(blocks[0]?.classList.contains('is-collapsed')).toBe(false)
  })
})
