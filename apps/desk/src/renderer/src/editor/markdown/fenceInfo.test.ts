import { describe, expect, it } from 'vitest'

import { applyFenceLanguage, applyFenceTitle, parseFenceTitleFromMeta } from './fenceInfo'
import { reconcileMarkdownSource } from './sourcePreservation'

describe('fenceInfo', () => {
  it('parses the last bracket title from fence meta', () => {
    expect(parseFenceTitleFromMeta('[App]')).toBe('App')
    expect(parseFenceTitleFromMeta('{30-51} [TypeScript]')).toBe('TypeScript')
    expect(parseFenceTitleFromMeta('')).toBe('')
  })

  it('rewrites only the trailing title on an opening fence line', () => {
    expect(applyFenceTitle('```ts {30-51} [TypeScript]', 'App')).toBe('```ts {30-51} [App]')
    expect(applyFenceTitle('```js', 'demo')).toBe('```js [demo]')
    expect(applyFenceTitle('```js [old]', '')).toBe('```js')
  })

  it('rewrites the language token and leaves the title', () => {
    expect(applyFenceLanguage('```js [demo]', 'ts')).toBe('```ts [demo]')
    expect(applyFenceLanguage('```js', '')).toBe('```')
    expect(applyFenceLanguage('``` [demo]', 'js')).toBe('```js [demo]')
    expect(applyFenceLanguage('```', 'py')).toBe('```py')
  })
})

describe('reconcileMarkdownSource title updates', () => {
  it('updates the fence title while retaining highlight metadata', () => {
    const original = '```ts {30-51} [TypeScript]\nconst value = 1\n```\n'
    const baseline = '```ts [TypeScript]\nconst value = 1\n```\n'
    const current = '```ts [App]\nconst value = 1\n```\n'

    expect(reconcileMarkdownSource(original, baseline, current)).toBe(
      '```ts {30-51} [App]\nconst value = 1\n```\n'
    )
  })
})
