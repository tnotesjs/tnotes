import { describe, expect, it } from 'vitest'

import { resolveMarkdownImageUrl } from './markdownAssetUrl'

describe('resolveMarkdownImageUrl', () => {
  it('maps relative note images without changing their Markdown source', () => {
    const url = new URL(
      resolveMarkdownImageUrl('./assets/%E5%9B%BE%20%E7%89%87.png', 'kb/一', 'note 1')
    )

    expect(url.protocol).toBe('tnotes-asset:')
    expect(url.hostname).toBe('asset')
    expect(url.searchParams.get('knowledgeBaseId')).toBe('kb/一')
    expect(url.searchParams.get('noteUuid')).toBe('note 1')
    expect(url.searchParams.get('path')).toBe('./assets/%E5%9B%BE%20%E7%89%87.png')
  })

  it.each(['https://example.com/image.png', 'http://example.com/image.png'])(
    'leaves remote http(s) resources unchanged: %s',
    (source) => {
      expect(resolveMarkdownImageUrl(source, 'kb', 'note')).toBe(source)
    }
  )

  it.each([
    'data:image/png;base64,AA==',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'tnotes-asset://asset?path=1.png',
    'javascript:alert(1)',
    'file:///tmp/image.png',
    'blob:https://example.com/id',
    '//cdn.example.com/image.png',
    '#generated-image'
  ])('blocks non-allowlisted resources: %s', (source) => {
    expect(resolveMarkdownImageUrl(source, 'kb', 'note')).toBe('')
  })

  it('does not decode a percent path before the guarded filesystem lookup', () => {
    const source = './assets/100%20literal.png'
    const url = new URL(resolveMarkdownImageUrl(source, 'kb', 'note'))
    expect(url.searchParams.get('path')).toBe(source)
  })
})
