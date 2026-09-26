import { describe, expect, it } from 'vitest'

import { withImages } from './messages'

describe('withImages', () => {
  it('sends images only on the latest user message', () => {
    const result = withImages(
      [
        { role: 'user', content: '第一张', images: ['a'] },
        { role: 'assistant', content: '收到' },
        { role: 'user', content: '第二张', images: ['b', 'missing'] }
      ],
      (id) => (id === 'missing' ? null : `data:${id}`)
    )
    expect(result).toEqual([
      { role: 'user', content: '第一张\n[图片]' },
      { role: 'assistant', content: '收到' },
      { role: 'user', content: '第二张', imageUrls: ['data:b'] }
    ])
  })
})
