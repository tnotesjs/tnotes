import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { codeLineDecorations, toggleFenceHighlight } from './codeLines'

function apply(source: string, openLine: number, index: number): string {
  const doc = Text.of(source.split('\n'))
  const change = toggleFenceHighlight(doc, openLine, index)
  if (!change) return source
  return source.slice(0, change.from) + change.insert + source.slice(change.to)
}

function lineAttrs(source: string, openLine: number, lastBody: number) {
  const doc = Text.of(source.split('\n'))
  return codeLineDecorations(doc, openLine, lastBody).map((range) => {
    const spec = range.value.spec as { class: string; attributes: Record<string, string> }
    return { line: doc.lineAt(range.from).number, class: spec.class, attrs: spec.attributes }
  })
}

describe('code line highlight', () => {
  it('adds and removes a highlight on a plain code block', () => {
    const source = '```js\na\nb\n```'
    const once = apply(source, 1, 2)
    expect(once).toBe('```js {2}\na\nb\n```')
    expect(apply(once, 1, 2)).toBe(source)
  })

  it('keeps the title and merges with existing ranges', () => {
    expect(apply('```js {1,3} [a.js]\na\nb\nc\n```', 1, 2)).toBe('```js {1-3} [a.js]\na\nb\nc\n```')
    expect(apply('```ts:line-numbers [b.ts]\nx\n```', 1, 1)).toBe('```ts:line-numbers {1} [b.ts]\nx\n```')
  })

  it('only rewrites the fence of the chosen code-group panel', () => {
    const source = ['::: code-group', '```js [a.js]', 'a', '```', '```ts [b.ts]', 'b1', 'b2', '```', ':::'].join('\n')
    expect(apply(source, 5, 2)).toBe(
      ['::: code-group', '```js [a.js]', 'a', '```', '```ts {2} [b.ts]', 'b1', 'b2', '```', ':::'].join('\n')
    )
  })

  it('numbers body lines, honours :line-numbers=N and skips numbers for :no-line-numbers', () => {
    expect(lineAttrs('```js {2}\na\nb\n```', 1, 3)).toEqual([
      { line: 2, class: 'cm-lp-code-line', attrs: { 'data-line': '1', 'data-code-line': '1' } },
      { line: 3, class: 'cm-lp-code-line cm-lp-code-highlighted', attrs: { 'data-line': '2', 'data-code-line': '2' } }
    ])
    expect(lineAttrs('```js:line-numbers=10\na\n```', 1, 2)[0]?.attrs['data-line']).toBe('10')
    expect(lineAttrs('```js:no-line-numbers {2}\na\nb\n```', 1, 3)).toEqual([
      { line: 3, class: 'cm-lp-code-line cm-lp-code-highlighted', attrs: {} }
    ])
  })
})
