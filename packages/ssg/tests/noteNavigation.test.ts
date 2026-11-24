import { describe, expect, it } from 'vitest'

import { extractNotePage, isPlainNoteClick, noteTarget } from '../src/client/noteNavigation'

const notes = [{ index: '0007', id: '10000000-0000-4000-8000-000000000007' }]

describe('noteTarget', () => {
  const current = { origin: 'https://tnotesjs.github.io' }

  it('keeps note aliases and the home page inside the current document', () => {
    expect(
      noteTarget(
        'https://tnotesjs.github.io/TNotes.algorithms/notes/0007.%20标题',
        current,
        '/TNotes.algorithms/',
        notes
      )
    ).toEqual({
      route: '/notes/7',
      url: '/TNotes.algorithms/notes/7'
    })
    expect(
      noteTarget(
        'https://tnotesjs.github.io/TNotes.algorithms/',
        current,
        '/TNotes.algorithms/',
        notes
      )
    ).toEqual({ route: '/', url: '/TNotes.algorithms/' })
  })

  it('leaves external links and files to the browser', () => {
    expect(
      noteTarget(
        'https://example.com/TNotes.algorithms/notes/7',
        current,
        '/TNotes.algorithms/',
        notes
      )
    ).toBeNull()
    expect(
      noteTarget(
        'https://tnotesjs.github.io/TNotes.algorithms/assets/pic.png',
        current,
        '/TNotes.algorithms/',
        notes
      )
    ).toBeNull()
  })

  it('only treats an unmodified primary click as in-page navigation', () => {
    const plain = {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false
    }
    expect(isPlainNoteClick(plain)).toBe(true)
    expect(isPlainNoteClick({ ...plain, metaKey: true })).toBe(false)
    expect(isPlainNoteClick({ ...plain, button: 1 })).toBe(false)
  })
})

describe('extractNotePage', () => {
  it('reads the article, page data, and title out of a generated page', () => {
    const html = `<!doctype html><html><head><title>认识 path &amp; 元素 · Algorithms</title></head><body>
      <div id="app"><main><div class="tn-site-article"><p>正文</p><div><iframe class="tn-bilibili-video"></iframe></div></div></main></div>
      <script type="application/json" id="tn-page-data">{"route":"/notes/7","relativePath":"notes/0007. 标题.md","title":"标题","description":"","headings":[],"text":"正文","frontmatter":{}}</script>
    </body></html>`
    expect(extractNotePage(html)).toMatchObject({
      route: '/notes/7',
      title: '认识 path & 元素 · Algorithms',
      articleHtml: '<p>正文</p><div><iframe class="tn-bilibili-video"></iframe></div>'
    })
  })

  it('returns null when the page is not a note document', () => {
    expect(extractNotePage('<html><body>nope</body></html>')).toBeNull()
  })
})
