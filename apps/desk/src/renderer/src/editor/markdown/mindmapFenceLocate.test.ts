import { describe, expect, it } from 'vitest'

import { locateUniqueFence, mindmapFenceOrdinal } from './mindmapFenceLocate'

describe('locateUniqueFence', () => {
  it('finds a single fence', () => {
    const fence = '```mindmap\n# A\n```'
    const content = `# Note\n\n${fence}\n\nend\n`
    expect(locateUniqueFence(content, fence)).toEqual({
      status: 'ok',
      from: 8,
      to: 8 + fence.length
    })
  })

  it('reports missing', () => {
    expect(locateUniqueFence('hello', '```mindmap\n# A\n```')).toEqual({ status: 'missing' })
  })

  it('reports ambiguous duplicates', () => {
    const fence = '```mindmap\n# A\n```'
    const content = `${fence}\n\n${fence}`
    expect(locateUniqueFence(content, fence)).toEqual({ status: 'ambiguous' })
  })
})

describe('mindmapFenceOrdinal', () => {
  it('numbers fences in document order', () => {
    const first = '```mindmap\n# A\n```'
    const second = '```mindmap\n# B\n```'
    const content = `# Note\n\n${first}\n\n${second}\n`
    expect(mindmapFenceOrdinal(content, first)).toBe(0)
    expect(mindmapFenceOrdinal(content, `${second}\n`)).toBe(1)
  })

  it('returns null when the slice is not a mindmap fence', () => {
    expect(mindmapFenceOrdinal('# hi\n', '```ts\nconst a = 1\n```')).toBeNull()
  })
})
