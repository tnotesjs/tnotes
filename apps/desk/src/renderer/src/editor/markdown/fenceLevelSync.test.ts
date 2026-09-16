import { describe, expect, it } from 'vitest'

import { reconcileMarkdownSource } from './sourcePreservation'

/**
 * Desk's mindmap 「层」 control writes the expand level into the fence info line
 * (```` ```mindmap [title] 5 ````). `reconcileChangedFence` rebuilds that line
 * from the *original* bytes and only re-applies the channels it knows about
 * (language, `[title]`), so the level needs a channel of its own — without one
 * the level is silently reverted during reconciliation and never reaches disk.
 *
 * The baseline is the canonical dump captured at load time; it equals the file
 * bytes for these fences, which is exactly what the editor passes at runtime.
 */
const note = (fenceLine: string): string =>
  `---\nid: 00000000-0000-4000-8000-0000000000aa\n---\n\n# 脑图层级\n\n${fenceLine}\n- 一级\n  - 二级\n\n之后\n`

/** The opening fence line, whatever the language. */
const fenceOf = (markdown: string): string =>
  markdown.split('\n').find((line) => line.startsWith('```')) ?? '<no-fence>'

describe('mindmap fence level sync', () => {
  it('keeps a level the editor just added', () => {
    const original = note('```mindmap [demo]')
    const current = note('```mindmap [demo] 5')

    expect(fenceOf(reconcileMarkdownSource(original, original, current))).toBe(
      '```mindmap [demo] 5'
    )
  })

  it('follows a changed level', () => {
    const original = note('```mindmap [demo] 3')
    const current = note('```mindmap [demo] 7')

    expect(fenceOf(reconcileMarkdownSource(original, original, current))).toBe(
      '```mindmap [demo] 7'
    )
  })

  it('keeps an untitled fence working', () => {
    const original = note('```mindmap')
    const current = note('```mindmap 4')

    expect(fenceOf(reconcileMarkdownSource(original, original, current))).toBe('```mindmap 4')
  })

  it('does not invent a level the editor dropped', () => {
    const original = note('```mindmap [demo] 3')
    const current = note('```mindmap [demo]')

    expect(fenceOf(reconcileMarkdownSource(original, original, current))).toBe('```mindmap [demo]')
  })

  it('is byte-stable when nothing changed', () => {
    const original = note('```mindmap [demo] 3')

    expect(reconcileMarkdownSource(original, original, original)).toBe(original)
  })

  it('keeps the level while the title changes', () => {
    const original = note('```mindmap [旧名] 3')
    const current = note('```mindmap [新名] 3')

    expect(fenceOf(reconcileMarkdownSource(original, original, current))).toBe(
      '```mindmap [新名] 3'
    )
  })

  it('keeps the level when the title is added', () => {
    const original = note('```mindmap 3')
    const current = note('```mindmap [新名] 3')

    expect(fenceOf(reconcileMarkdownSource(original, original, current))).toBe(
      '```mindmap [新名] 3'
    )
  })

  it('leaves other code fences alone', () => {
    const original = note('```js:line-numbers=4 {2} [one.js]')
    const current = note('```js:line-numbers=4 {2} [one.js]')

    expect(fenceOf(reconcileMarkdownSource(original, original, current))).toBe(
      '```js:line-numbers=4 {2} [one.js]'
    )
  })
})
