// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import MilkdownMarkdownEditor from './MilkdownMarkdownEditor.vue'
import { DESK_SELECT_ALL_EVENT } from './documentSelection'

interface EditorHandle {
  insertTextAt(text: string, position?: number): void
}

async function mountEditor(
  content = 'alpha\n',
  props: Partial<InstanceType<typeof MilkdownMarkdownEditor>['$props']> = {}
): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(MilkdownMarkdownEditor, {
    attachTo: document.body,
    props: {
      content,
      mode: 'visual',
      readOnly: false,
      knowledgeBaseId: 'kb-a',
      noteUuid: 'note-a',
      active: true,
      uploadImage: vi.fn(async () => ({ src: './assets/image.png', alt: 'image' })),
      ...props
    }
  })
  await vi.waitFor(() => expect(wrapper.find('.ProseMirror').exists()).toBe(true), {
    timeout: 4_000
  })
  return wrapper
}

describe('MilkdownMarkdownEditor synchronization', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('does not emit a change while creating or replacing external content', async () => {
    const wrapper = await mountEditor()
    expect(wrapper.emitted('change')).toBeUndefined()

    await wrapper.setProps({ content: 'external\n' })
    await Promise.resolve()

    expect(wrapper.emitted('change')).toBeUndefined()
    wrapper.unmount()
  })

  it('syncs props that changed while the editor was still being created', async () => {
    // 不 await 就绪：onMounted 里 create() 仍挂着，此刻改 props 就是「初始化期间变化」。
    const wrapper = mount(MilkdownMarkdownEditor, {
      attachTo: document.body,
      props: {
        content: 'first\n',
        mode: 'visual',
        readOnly: false,
        knowledgeBaseId: 'kb-a',
        noteUuid: 'note-a',
        active: true,
        uploadImage: vi.fn(async () => ({ src: './assets/image.png', alt: 'image' }))
      }
    })
    await wrapper.setProps({ content: 'second\n' })

    await vi.waitFor(() => expect(wrapper.find('.ProseMirror').exists()).toBe(true), {
      timeout: 4_000
    })
    // 编辑器按创建时的那份原文建，ready 之后必须补同步到最新 props
    await vi.waitFor(() =>
      expect(wrapper.find('.ProseMirror').element.textContent).toContain('second')
    )
    expect(wrapper.find('.ProseMirror').element.textContent).not.toContain('first')
    expect(wrapper.emitted('change')).toBeUndefined()
    wrapper.unmount()
  })

  it('does not list slash-menu group titles in the page outline', async () => {
    const wrapper = await mountEditor('# 代码分组\n\n正文\n')
    await vi.waitFor(() => expect(wrapper.find('.note-outline__link').exists()).toBe(true))
    expect(wrapper.findAll('.note-outline__link').map((item) => item.text())).toEqual(['代码分组'])
    wrapper.unmount()
  })

  it('lists document headings in the page outline and scrolls on click', async () => {
    const wrapper = await mountEditor(
      ['# 欢迎', '', '## 建议按这个顺序点', '', '正文', '', '### 小节', ''].join('\n')
    )
    await vi.waitFor(() => expect(wrapper.findAll('.note-outline__link')).toHaveLength(3))
    expect(wrapper.findAll('.note-outline__link').map((item) => item.text())).toEqual([
      '欢迎',
      '建议按这个顺序点',
      '小节'
    ])
    const heading = wrapper.get('.ProseMirror h2')
    const scrollIntoView = vi.fn()
    Object.defineProperty(heading.element, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    await wrapper.findAll('.note-outline__link')[1]!.trigger('click')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    wrapper.unmount()
  })

  it('keeps the editor alive when a heading id starts with digits', async () => {
    const wrapper = await mountEditor('# 0001. 标题\n\n正文\n')
    await vi.waitFor(() => expect(wrapper.find('.note-outline__link').text()).toBe('0001. 标题'))
    expect(wrapper.emitted('fatal')).toBeUndefined()
    wrapper.unmount()
  })

  it('switches the visual page between standard and wide layouts', async () => {
    const wrapper = await mountEditor('alpha\n', { pageWidth: 'wide' })

    expect(wrapper.get('.milkdown-markdown-editor').classes()).toContain('is-wide')
    await wrapper.setProps({ pageWidth: 'standard' })
    expect(wrapper.get('.milkdown-markdown-editor').classes()).not.toContain('is-wide')
    wrapper.unmount()
  })

  it('collapses a heading section from the gutter toggle', async () => {
    const wrapper = await mountEditor('# 欢迎\n\n正文段落\n\n## 小节\n\n更多\n')
    await vi.waitFor(() => expect(wrapper.find('.desk-heading-toggle').exists()).toBe(true))
    const heading = wrapper.get('.ProseMirror h1')
    expect(heading.classes()).not.toContain('is-heading-collapsed')
    await wrapper.get('.desk-heading-toggle').trigger('click')
    expect(wrapper.get('.ProseMirror h1').classes()).toContain('is-heading-collapsed')
    expect(wrapper.get('.ProseMirror p').classes()).toContain('desk-heading-section--collapsed')
    await wrapper.get('.desk-heading-toggle').trigger('click')
    expect(wrapper.get('.ProseMirror h1').classes()).not.toContain('is-heading-collapsed')
    wrapper.unmount()
  })

  it('keeps the page outline in wide layout and hides it when toggled off', async () => {
    const wrapper = await mountEditor('# 欢迎\n\n正文\n', { pageWidth: 'wide' })
    await vi.waitFor(() => expect(wrapper.find('.note-outline').exists()).toBe(true))
    expect(wrapper.get('.milkdown-markdown-editor').classes()).toContain('is-wide')
    expect(wrapper.get('.milkdown-markdown-editor').classes()).not.toContain('is-outline-hidden')
    await wrapper.setProps({ outlineVisible: false })
    expect(wrapper.get('.milkdown-markdown-editor').classes()).toContain('is-outline-hidden')
    expect(wrapper.find('.note-outline').isVisible()).toBe(false)
    await wrapper.setProps({ outlineVisible: true })
    expect(wrapper.find('.note-outline').isVisible()).toBe(true)
    wrapper.unmount()
  })

  it('flushes a transaction synchronously when the view is immediately unmounted', async () => {
    const wrapper = await mountEditor()
    const editor = wrapper.vm as unknown as EditorHandle

    editor.insertTextAt('typed')
    wrapper.unmount()

    const changes = wrapper.emitted<string[]>('change') ?? []
    expect(changes).toHaveLength(1)
    expect(changes[0][0]).toContain('typed')
  })

  it('emits user transactions without Milkdown listener debounce', async () => {
    const wrapper = await mountEditor()
    const editor = wrapper.vm as unknown as EditorHandle

    editor.insertTextAt('now')
    await Promise.resolve()

    const changes = wrapper.emitted<string[]>('change') ?? []
    expect(changes).toHaveLength(1)
    expect(changes[0][0]).toContain('now')
    wrapper.unmount()
  })

  it('keeps opaque reference definitions when editing another block', async () => {
    const source = 'See [guide].\n\nparagraph\n\n[guide]: https://example.com/docs\n'
    const wrapper = await mountEditor(source)
    const editor = wrapper.vm as unknown as EditorHandle

    editor.insertTextAt('new block')
    await Promise.resolve()

    const changes = wrapper.emitted<string[]>('change') ?? []
    expect(changes.at(-1)?.[0]).toContain('[guide]: https://example.com/docs')
    wrapper.unmount()
  })

  it('serializes unordered lists with hyphen bullets', async () => {
    const wrapper = await mountEditor('* alpha\n* beta\n')
    const editor = wrapper.vm as unknown as EditorHandle

    editor.insertTextAt('x')
    await Promise.resolve()

    const latest = wrapper.emitted<string[]>('change')?.at(-1)?.[0] ?? ''
    expect(latest).toMatch(/^- /m)
    expect(latest).not.toMatch(/^\* /m)
    wrapper.unmount()
  })

  it('loads consecutive standalone breaks as empty paragraphs', async () => {
    const source = 'before\n\n<br />\n\n<br />\n\n<br />\n\nafter\n'
    const wrapper = await mountEditor(source)
    expect(wrapper.findAll('[data-type="desk-raw-block"]')).toHaveLength(0)

    const emptyParagraphs = [...wrapper.get('.ProseMirror').element.querySelectorAll('p')].filter(
      (element) => (element.textContent ?? '').trim() === ''
    )
    expect(emptyParagraphs.length).toBeGreaterThanOrEqual(3)

    await wrapper.setProps({
      content: 'before\n\n<br />\n\n<br />\n\nafter\n'
    })
    await Promise.resolve()
    expect(wrapper.emitted('change')).toBeUndefined()
    wrapper.unmount()
  })

  it('is effectively read-only while the file is not writable', async () => {
    const wrapper = await mountEditor('alpha\n', { readOnly: true })
    const editor = wrapper.vm as unknown as EditorHandle

    expect(wrapper.get('.ProseMirror').attributes('contenteditable')).toBe('false')
    editor.insertTextAt('blocked')
    await wrapper.setProps({ content: 'external\n' })
    await Promise.resolve()

    expect(wrapper.emitted('change')).toBeUndefined()
    expect(wrapper.get('.ProseMirror').text()).toContain('external')
    await wrapper.setProps({ readOnly: false })
    await vi.waitFor(() =>
      expect(wrapper.get('.ProseMirror').attributes('contenteditable')).toBe('true')
    )
    wrapper.unmount()
  })

  it('blocks edits to empty paragraphs while readonly', async () => {
    const source = 'before\n\n<br />\n\nafter\n'
    const wrapper = await mountEditor(source, { readOnly: true })

    expect(wrapper.get('.milkdown-markdown-editor').classes()).toContain('is-readonly')
    expect(wrapper.findAll('[data-type="desk-raw-block"]')).toHaveLength(0)
    await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Backspace' })
    await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Delete' })
    await wrapper.get('.ProseMirror').trigger('keydown', { key: 'x' })
    await Promise.resolve()

    expect(wrapper.emitted('change')).toBeUndefined()
    wrapper.unmount()
  })

  it('renders local images through the asset protocol without emitting a source rewrite', async () => {
    const source = '![图片](./assets/%E5%9B%BE%20%E7%89%87.png)\n'
    const wrapper = await mountEditor(source, {
      knowledgeBaseId: 'kb/一',
      noteUuid: 'note 1'
    })
    const image = wrapper.get('.ProseMirror img')
    const renderedSource = image.attributes('src') ?? ''

    expect(renderedSource).toContain('tnotes-asset://asset?')
    const url = new URL(renderedSource)
    expect(url.searchParams.get('knowledgeBaseId')).toBe('kb/一')
    expect(url.searchParams.get('noteUuid')).toBe('note 1')
    expect(url.searchParams.get('path')).toBe('./assets/%E5%9B%BE%20%E7%89%87.png')
    expect(wrapper.emitted('change')).toBeUndefined()
    expect(wrapper.get('.desk-image__caption').element).toHaveProperty('value', '图片')
    wrapper.unmount()
  })

  it('marks consecutive image paragraphs without inserting an empty paragraph between them', async () => {
    const wrapper = await mountEditor(
      '![](https://example.com/a.png) {w=100px}\n\n![](https://example.com/b.png) {w=80px}\n'
    )
    const paragraphs = [...wrapper.get('.ProseMirror').element.querySelectorAll(':scope > p')]
    const imageParagraphs = paragraphs.filter((element) =>
      element.querySelector('figure.desk-image')
    )
    expect(imageParagraphs).toHaveLength(2)
    expect(imageParagraphs[0]?.classList.contains('desk-standalone-image')).toBe(true)
    expect(imageParagraphs[1]?.classList.contains('desk-standalone-image')).toBe(true)
    expect(imageParagraphs[0]?.nextElementSibling).toBe(imageParagraphs[1] ?? null)
    expect(wrapper.findAll('figure.desk-image')).toHaveLength(2)
    wrapper.unmount()
  })

  it('renders alt as a caption and applies {w} as image width', async () => {
    const wrapper = await mountEditor('![说明](https://example.com/a.png) {w=50%}\n')
    const image = wrapper.get('.desk-image img')
    expect(image.attributes('alt')).toBe('说明')
    expect(wrapper.get('.desk-image__stack').attributes('style') ?? '').toContain('width: 50%')
    expect(image.attributes('data-tn-src')).toBe('https://example.com/a.png')
    expect(image.attributes('data-tn-width')).toBe('50%')
    expect((wrapper.get('.desk-image__caption').element as HTMLInputElement).value).toBe('说明')
    expect(wrapper.findAll('.desk-image__handle')).toHaveLength(4)
    expect(wrapper.find('.desk-image__quick').exists()).toBe(true)
    expect((wrapper.get('.desk-image__size-panel').element as HTMLElement).hidden).toBe(true)
    expect((wrapper.get('.desk-image__align-panel').element as HTMLElement).hidden).toBe(true)
    expect((wrapper.get('.desk-image__more-panel').element as HTMLElement).hidden).toBe(true)
    wrapper.unmount()
  })

  it('keeps an unsized captioned image shrink-wrapped to the image', async () => {
    const wrapper = await mountEditor('![标题](https://example.com/pixel.svg)\n')
    const caption = wrapper.get('.desk-image__caption').element as HTMLInputElement
    expect(wrapper.get('.desk-image__stack').attributes('style') ?? '').not.toMatch(/width\s*:/)
    expect(wrapper.get('.desk-image__caption-row').exists()).toBe(true)
    expect(caption.value).toBe('标题')
    expect(caption.size).toBe(1)
    expect(caption.hidden).toBe(false)
    wrapper.unmount()
  })

  it('applies image alignment from {align} and keeps caption closed until requested', async () => {
    const wrapper = await mountEditor('![](https://example.com/a.png) {align=right}\n')
    const figure = wrapper.get('.desk-image')
    expect(figure.classes()).toContain('tn-image--right')
    expect(wrapper.get('.desk-image img').attributes('data-tn-align')).toBe('right')
    expect((wrapper.get('.desk-image__caption').element as HTMLInputElement).hidden).toBe(true)
    await wrapper.get('.desk-image__tool[aria-label="描述"]').trigger('click')
    expect((wrapper.get('.desk-image__caption').element as HTMLInputElement).hidden).toBe(false)
    wrapper.unmount()
  })

  it('opens a fullscreen preview on image click in readonly mode without a selected state', async () => {
    const wrapper = await mountEditor('![](https://example.com/a.png)\n', { readOnly: true })
    const requests: Event[] = []
    const onPreview = (event: Event): void => {
      requests.push(event)
    }
    document.addEventListener('tn:preview-image', onPreview)
    const figure = wrapper.get('.desk-image')
    expect(figure.classes()).toContain('is-readonly')
    expect(figure.classes()).not.toContain('is-selected')
    expect(figure.classes()).not.toContain('tn-preview-ignore')
    await figure.get('img').trigger('click')
    expect(requests).toHaveLength(1)
    expect(figure.classes()).not.toContain('is-selected')
    document.removeEventListener('tn:preview-image', onPreview)
    wrapper.unmount()
  })

  it('opens links directly in readonly mode and requires a modifier while editing', async () => {
    const readonly = await mountEditor('[Open](https://example.com)\n', { readOnly: true })
    await readonly.get('.ProseMirror a').trigger('click')
    expect(readonly.emitted<string[]>('openLink')).toEqual([['https://example.com']])
    readonly.unmount()

    const visual = await mountEditor('[Open](https://example.com)\n')
    await visual.get('.ProseMirror a').trigger('click')
    expect(visual.emitted('openLink')).toBeUndefined()
    await visual.get('.ProseMirror a').trigger('click', { ctrlKey: true })
    expect(visual.emitted<string[]>('openLink')).toEqual([['https://example.com']])
    visual.unmount()
  })

  it('scrolls hash links inside the current document instead of opening a web tab', async () => {
    const wrapper = await mountEditor('[Jump](#heading)\n\n## Heading\n')
    const heading = wrapper.get('.ProseMirror h2')
    const scrollIntoView = vi.fn()
    Object.defineProperty(heading.element, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })

    await wrapper.get('.ProseMirror a').trigger('click')

    expect(heading.attributes('id')).toBe('heading')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    expect(wrapper.emitted('openLink')).toBeUndefined()
    wrapper.unmount()
  })

  it('resolves TOC anchors even when Milkdown heading ids diverge from canonical slugs', async () => {
    // Milkdown slugs `1. 本节内容` as `1.-本节内容`, while the TOC region (generated
    // by github-slugger) links to `#1-本节内容`. The click handler must locate the
    // heading by its canonical slug as a fallback.
    const source = [
      '# [0001. hello-algo](https://example.com)',
      '',
      '<!-- region:toc -->',
      '- [1. 本节内容](#1-本节内容)',
      '- [3. `hello-algo` 是什么？](#3-hello-algo-是什么)',
      '<!-- endregion:toc -->',
      '',
      '## 1. 本节内容',
      '',
      '正文',
      '',
      '## 3. `hello-algo` 是什么？',
      '',
      '内容',
      ''
    ].join('\n')
    const wrapper = await mountEditor(source)
    const headings = wrapper.findAll('.ProseMirror h2')
    const scrollIntoView = vi.fn()
    headings.forEach((heading) =>
      Object.defineProperty(heading.element, 'scrollIntoView', {
        configurable: true,
        value: scrollIntoView
      })
    )

    const anchors = wrapper.findAll('.ProseMirror a[href^="#"]')
    expect(anchors.length).toBeGreaterThan(0)

    // Guard the regression: Milkdown's own heading id must differ from the TOC
    // anchor for this exercise to prove the canonical-slug fallback is in use.
    const tocFirstHref = anchors[0].attributes('href')
    const headingIds = headings.map((heading) => heading.attributes('id'))
    expect(tocFirstHref).toBe('#1-本节内容')
    expect(headingIds).toContain('1.-本节内容')
    expect(headingIds).not.toContain('1-本节内容')

    const firstAnchor = anchors[0]
    await firstAnchor.trigger('click')

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    expect(wrapper.emitted('openLink')).toBeUndefined()
    wrapper.unmount()
  })

  it('applies hidden, collapsed, and expanded in-note TOC modes', async () => {
    const source = [
      '# 0001. 标题',
      '',
      '<!-- region:toc -->',
      '- [1. 第一节](#1-第一节)',
      '<!-- endregion:toc -->',
      '',
      '## 1. 第一节',
      '',
      '正文',
      ''
    ].join('\n')
    const wrapper = await mountEditor(source, { tocDisplay: 'collapsed' })
    const editor = wrapper.get('.milkdown-markdown-editor')
    const toc = wrapper.get('.desk-generated-toc')
    const toggle = toc.get('.desk-generated-toc__toggle')

    expect(toc.classes()).toContain('is-collapsed')
    expect(toggle.attributes('aria-expanded')).toBe('false')

    await wrapper.setProps({ tocDisplay: 'hidden' })
    expect(editor.classes()).toContain('is-toc-hidden')

    await wrapper.setProps({ tocDisplay: 'expanded' })
    expect(editor.classes()).not.toContain('is-toc-hidden')
    expect(toc.classes()).not.toContain('is-collapsed')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  it('renders reference-style links as links and hides the definition atom', async () => {
    const source = [
      '## 5. 引用',
      '',
      '- [hello 算法 github 仓库][1]',
      '- [hello 算法在线阅读][2]',
      '',
      '[1]: https://github.com/krahets/hello-algo',
      '[2]: https://www.hello-algo.com/',
      ''
    ].join('\n')
    const wrapper = await mountEditor(source)
    const pm = wrapper.get('.ProseMirror').element as HTMLElement

    const renderedLinks = [...pm.querySelectorAll('a')].map((anchor) => ({
      href: anchor.getAttribute('href'),
      text: (anchor.textContent ?? '').trim()
    }))
    expect(renderedLinks).toEqual([
      { href: 'https://github.com/krahets/hello-algo', text: 'hello 算法 github 仓库' },
      { href: 'https://www.hello-algo.com/', text: 'hello 算法在线阅读' }
    ])

    // The reference definitions must not surface as visible source cards.
    expect(pm.querySelectorAll('.desk-raw-block:not(.desk-raw-block--hidden)')).toHaveLength(0)
    expect(pm.querySelectorAll('.desk-raw-block--hidden')).toHaveLength(1)
    wrapper.unmount()
  })

  it('clears a mixed heading note after select-all then Backspace', async () => {
    const wrapper = await mountEditor(
      [
        '---',
        'id: c9b10d0b-e8f9-4b98-8199-8a2156f439ea',
        '---',
        '',
        '# 认识 webpack',
        '',
        'Webpack 是一个打包工具。',
        '',
        '- 依赖管理',
        '',
        '结尾',
        ''
      ].join('\n')
    )
    const pm = wrapper.get('.ProseMirror').element as HTMLElement
    expect(pm.textContent).toContain('认识 webpack')
    window.dispatchEvent(new Event(DESK_SELECT_ALL_EVENT))
    pm.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    )
    await vi.waitFor(() => {
      const last = wrapper.emitted<string[]>('change')?.at(-1)?.[0] ?? ''
      expect(last).toContain('id: c9b10d0b-e8f9-4b98-8199-8a2156f439ea')
      expect(last).not.toContain('认识 webpack')
      expect(last).not.toContain('打包工具')
    })
    await vi.waitFor(() => {
      expect(wrapper.find('.crepe-placeholder').exists()).toBe(true)
      expect(wrapper.find('.ProseMirror-gapcursor').exists()).toBe(false)
    })
    const emptyLine = wrapper.get('.ProseMirror p')
    expect(emptyLine.classes()).toContain('crepe-placeholder')
    expect((emptyLine.element.textContent ?? '').replace(/\u200b/g, '').trim()).toBe('')
    wrapper.unmount()
  })
})
