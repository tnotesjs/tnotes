// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { setupHeadingFolds } from '../src/client/headingFolds'
let controls: ReturnType<typeof setupHeadingFolds> | undefined
afterEach(() => {
  controls?.destroy()
  document.body.innerHTML = ''
})
function setup(html: string) {
  document.body.innerHTML = `<article>${html}</article>`
  const root = document.querySelector('article')!
  const changed = vi.fn()
  controls = setupHeadingFolds(root, changed)
  return { root, changed }
}
function button(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === name
  )!
}
it('independently folds all six levels and preserves child state across a parent toggle', () => {
  setup(
    Array.from(
      { length: 6 },
      (_, i) => `<h${i + 1}>L${i + 1}</h${i + 1}><p>Body ${i + 1}</p>`
    ).join('')
  )
  expect(document.querySelectorAll('button')).toHaveLength(6)
  button('折叠 L3').click()
  button('折叠 L1').click()
  button('展开 L1').click()
  expect(button('展开 L3').getAttribute('aria-expanded')).toBe('false')
  expect(button('折叠 L2').getAttribute('aria-expanded')).toBe('true')
})
it('keeps sibling sections independent and bulk control expands mixed state', () => {
  const { changed } = setup(
    '<h2>A</h2><div class="tn-heading-body"><p>a</p></div><h2>B</h2><div class="tn-heading-body"><p>b</p></div>'
  )
  button('折叠 A').click()
  expect(button('折叠 B').getAttribute('aria-expanded')).toBe('true')
  expect(changed).toHaveBeenLastCalledWith(true)
  controls!.toggleAll()
  expect(document.querySelectorAll('[hidden]')).toHaveLength(0)
  controls!.toggleAll()
  expect(document.querySelectorAll('[hidden]')).toHaveLength(2)
  button('展开 A').click()
  expect(button('展开 B').getAttribute('aria-expanded')).toBe('false')
})
it('reveals only the target path and keeps unrelated sections folded', () => {
  setup('<h1>Title</h1><h2 id="a">A</h2><p>a</p><h2>B</h2><p>b</p>')
  controls!.toggleAll()
  controls!.reveal(document.getElementById('a')!)
  expect(button('折叠 Title').getAttribute('aria-expanded')).toBe('true')
  expect(button('折叠 A').getAttribute('aria-expanded')).toBe('true')
  expect(button('展开 B').getAttribute('aria-expanded')).toBe('false')
})
it('supports headings inside containers without taking following outside content', () => {
  setup('<blockquote><h3>Quote</h3><p>inside</p></blockquote><p id="outside">outside</p>')
  button('折叠 Quote').click()
  expect(document.getElementById('outside')!.closest('[hidden]')).toBeNull()
  expect(document.querySelector('blockquote p')!.closest('[hidden]')).not.toBeNull()
})
it('does not offer empty sections and restores content on teardown', () => {
  setup('<h2>Empty</h2><h2>Full</h2><p>text</p>')
  expect(document.querySelectorAll('button')).toHaveLength(1)
  controls!.toggleAll()
  controls!.destroy()
  expect(document.querySelectorAll('button,[hidden]')).toHaveLength(0)
})
