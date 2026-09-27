// @vitest-environment happy-dom
import { EditorState, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import {
  codeLineDecorations,
  pruneStaleCodeHighlights,
  staleHighlightChanges,
  toggleFenceHighlight
} from './codeLines'
import { tnotesMarkdown } from './language'

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

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

function pruned(doc: string): string {
  const state = EditorState.create({ doc, extensions: [tnotesMarkdown()] })
  const changes = staleHighlightChanges(state)
  if (changes.length === 0) return doc
  return state.update({ changes }).state.doc.toString()
}

describe('stale code highlights', () => {
  it('drops highlight numbers past the last body line and keeps the ones that remain', () => {
    expect(pruned('```ts {9}\n111\n\n222\n```\n')).toBe('```ts\n111\n\n222\n```\n')
    expect(pruned('```ts {1,9}\n111\n\n222\n```\n')).toBe('```ts {1}\n111\n\n222\n```\n')
    expect(pruned('```ts {1-9}\n111\n\n222\n```\n')).toBe('```ts {1-3}\n111\n\n222\n```\n')
    expect(pruned('```ts {3}\n111\n\n222\n```\n')).toBe('```ts {3}\n111\n\n222\n```\n')
  })

  it('prunes each code-group panel on its own', () => {
    const doc = [
      '::: code-group',
      '```js {5} [a.js]',
      'a',
      '```',
      '```ts {1} [b.ts]',
      'b',
      '```',
      ':::',
      ''
    ].join('\n')
    expect(pruned(doc)).toBe(
      [
        '::: code-group',
        '```js [a.js]',
        'a',
        '```',
        '```ts {1} [b.ts]',
        'b',
        '```',
        ':::',
        ''
      ].join('\n')
    )
  })

  it('writes the cleanup into the document after the line is gone', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '```ts {9}\n111\n\n222\n```\n',
        extensions: [tnotesMarkdown(), pruneStaleCodeHighlights]
      })
    })
    views.push(view)
    await new Promise((resolve) => queueMicrotask(resolve))
    expect(view.state.doc.toString()).toBe('```ts\n111\n\n222\n```\n')
  })
})

describe('code line highlight', () => {
  it('adds and removes a highlight on a plain code block', () => {
    const source = '```js\na\nb\n```'
    const once = apply(source, 1, 2)
    expect(once).toBe('```js {2}\na\nb\n```')
    expect(apply(once, 1, 2)).toBe(source)
  })

  it('keeps the title and merges with existing ranges', () => {
    expect(apply('```js {1,3} [a.js]\na\nb\nc\n```', 1, 2)).toBe('```js {1-3} [a.js]\na\nb\nc\n```')
    expect(apply('```ts:line-numbers [b.ts]\nx\n```', 1, 1)).toBe(
      '```ts:line-numbers {1} [b.ts]\nx\n```'
    )
  })

  it('only rewrites the fence of the chosen code-group panel', () => {
    const source = [
      '::: code-group',
      '```js [a.js]',
      'a',
      '```',
      '```ts [b.ts]',
      'b1',
      'b2',
      '```',
      ':::'
    ].join('\n')
    expect(apply(source, 5, 2)).toBe(
      [
        '::: code-group',
        '```js [a.js]',
        'a',
        '```',
        '```ts {2} [b.ts]',
        'b1',
        'b2',
        '```',
        ':::'
      ].join('\n')
    )
  })

  it('numbers body lines, honours :line-numbers=N and skips numbers for :no-line-numbers', () => {
    expect(lineAttrs('```js {2}\na\nb\n```', 1, 3)).toEqual([
      {
        line: 2,
        class: 'cm-lp-code-line',
        attrs: { 'data-line': '1', 'data-code-line': '1', 'data-digits': '1' }
      },
      {
        line: 3,
        class: 'cm-lp-code-line cm-lp-code-highlighted',
        attrs: { 'data-line': '2', 'data-code-line': '2', 'data-digits': '1' }
      }
    ])
    expect(lineAttrs('```js:line-numbers=10\na\n```', 1, 2)[0]?.attrs).toMatchObject({
      'data-line': '10',
      'data-digits': '2'
    })
    expect(lineAttrs('```js:line-numbers=100\na\n```', 1, 2)[0]?.attrs['data-digits']).toBe('3')
    const nine = ['```js', ...Array.from({ length: 9 }, () => 'a'), '```'].join('\n')
    const ten = ['```js', ...Array.from({ length: 10 }, () => 'a'), '```'].join('\n')
    expect(lineAttrs(nine, 1, 10).at(-1)?.attrs['data-digits']).toBe('1')
    expect(lineAttrs(ten, 1, 11).at(-1)?.attrs['data-digits']).toBe('2')
    expect(lineAttrs('```js:no-line-numbers {2}\na\nb\n```', 1, 3)).toEqual([
      { line: 3, class: 'cm-lp-code-line cm-lp-code-highlighted', attrs: {} }
    ])
  })
})
