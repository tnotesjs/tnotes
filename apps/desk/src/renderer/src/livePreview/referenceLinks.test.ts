// @vitest-environment happy-dom
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { livePreviewField, setFocused } from './decorations'
import { tnotesMarkdown } from './language'
import { expandReferenceLinks } from './referenceLinks'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [tnotesMarkdown(), livePreviewField]
    })
  })
  view.dispatch({ effects: setFocused.of(false) })
  views.push(view)
  return view
}

function hrefs(view: EditorView): Array<{ text: string; href: string }> {
  return [...view.dom.querySelectorAll<HTMLElement>('.cm-lp-link')].map((element) => ({
    text: element.textContent ?? '',
    href: element.dataset.href ?? ''
  }))
}

describe('reference links', () => {
  it('opens an inline link from its own url', () => {
    const view = mount('[描述](https://inline.example/a)\n')
    expect(hrefs(view)).toEqual([{ text: '描述', href: 'https://inline.example/a' }])
  })

  it('resolves a full reference link to the definition url', () => {
    const view = mount('[描述][1]\n\n[1]: https://ref.example/b\n')
    expect(hrefs(view)).toEqual([{ text: '描述', href: 'https://ref.example/b' }])
  })

  it('resolves a collapsed reference and a shortcut reference', () => {
    const collapsed = mount('[描述][]\n\n[描述]: https://col.example/c\n')
    expect(hrefs(collapsed)).toEqual([{ text: '描述', href: 'https://col.example/c' }])

    const shortcut = mount('[描述]\n\n[描述]: https://short.example/d\n')
    expect(hrefs(shortcut)).toEqual([{ text: '描述', href: 'https://short.example/d' }])
  })

  it('matches labels case-insensitively and keeps the first definition', () => {
    const view = mount(
      '[文字][Ab]\n\n[AB]: https://first.example/e\n[ab]: https://second.example/f\n'
    )
    expect(hrefs(view)).toEqual([{ text: '文字', href: 'https://first.example/e' }])
  })

  it('strips angle brackets around a definition url', () => {
    const view = mount('[描述][1]\n\n[1]: <https://angle.example/g>\n')
    expect(hrefs(view)).toEqual([{ text: '描述', href: 'https://angle.example/g' }])
  })

  it('shows a reference without a definition as plain text and does not steal an inline link', () => {
    const missing = mount('[没有][missing]\n')
    expect(hrefs(missing)).toEqual([])
    expect(missing.contentDOM.textContent).toContain('[没有][missing]')

    const bracket = mount('渲染异常：[1]\n')
    expect(hrefs(bracket)).toEqual([])
    expect(bracket.contentDOM.textContent).toContain('渲染异常：[1]')

    const inline = mount('[描述](https://inline.example/a)\n\n[描述]: https://nope.example\n')
    expect(hrefs(inline)).toEqual([{ text: '描述', href: 'https://inline.example/a' }])
  })
})

describe('expandReferenceLinks', () => {
  const definitions = new Map([['1', 'https://www.baidu.com']])

  it('rewrites a full reference and leaves unresolved or parenthesized links alone', () => {
    expect(expandReferenceLinks('- [百度][1]\n', definitions)).toBe(
      '- [百度](https://www.baidu.com)\n'
    )
    expect(expandReferenceLinks('- [没有][missing]\n', definitions)).toBe('- [没有][missing]\n')
    expect(expandReferenceLinks('- [已有](https://example.com)\n', definitions)).toBe(
      '- [已有](https://example.com)\n'
    )
  })
})
