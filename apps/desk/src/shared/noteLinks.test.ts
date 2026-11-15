import { describe, expect, it } from 'vitest'

import { noteGithubFileUrl, notePageUrl } from './noteLinks'

describe('note links', () => {
  it('opens the note page under the configured site, not the site root', () => {
    expect(notePageUrl('https://tnotes.example/vue/', '0007')).toBe(
      'https://tnotes.example/vue/notes/7'
    )
    expect(notePageUrl('', '0001')).toBeNull()
    expect(notePageUrl('not a url', '0001')).toBeNull()
  })

  it('opens the note file on GitHub, not the repository root', () => {
    expect(noteGithubFileUrl('https://github.com/tnotesjs/TNotes.vue.git', '0007. 标题')).toBe(
      'https://github.com/tnotesjs/TNotes.vue/blob/main/notes/0007.%20%E6%A0%87%E9%A2%98.md'
    )
    expect(noteGithubFileUrl(undefined, '0001. 标题')).toBeNull()
  })
})
