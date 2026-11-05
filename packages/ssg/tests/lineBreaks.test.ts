import { describe, expect, it } from 'vitest'

import { createMarkdownCompiler } from '../src/markdown'
import type { LineBreakMode } from '@tnotesjs/ui/line-breaks'

const configFor = (lineBreaks: LineBreakMode) => ({
  root: '/',
  outDir: '/',
  cacheDir: '/',
  publicDir: '/',
  base: '/',
  title: 't',
  description: '',
  lang: 'zh',
  port: 0,
  discussions: false,
  ignoreDeadLinks: true,
  head: [] as Array<[string, Record<string, string>, string?]>,
  markdown: { lineNumbers: false, math: false, imageLazyLoading: false, lineBreaks }
})

const SPACER = '<div class="tn-blank-line" aria-hidden="true"></div>'

async function render(source: string, mode: LineBreakMode = 'visual'): Promise<string> {
  const compiler = await createMarkdownCompiler(configFor(mode))
  await compiler.prepare([source])
  return compiler.compile(source, '/kb/notes/0001.md', '/notes/1').html
}

const spacers = (html: string) => html.split(SPACER).length - 1

describe('visual line breaks', () => {
  it('keeps CommonMark when the mode is commonmark', async () => {
    const html = await render('a\nb\n\n\n\nc\n', 'commonmark')
    expect(html).not.toContain('<br>')
    expect(spacers(html)).toBe(0)
  })

  it('renders a single newline as <br>', async () => {
    expect(await render('第一行\n第二行\n')).toContain('第一行<br>\n第二行')
  })

  it('keeps one spacer per blank line beyond the first', async () => {
    expect(spacers(await render('a\n\nb\n'))).toBe(0)
    expect(spacers(await render('a\n\n\nb\n'))).toBe(1)
    expect(spacers(await render('a\n\n\n\n\nb\n'))).toBe(3)
  })

  it('ignores blank lines at the start and end of the note', async () => {
    expect(spacers(await render('\n\n\n\na\n\n\n\n'))).toBe(0)
  })

  it('measures gaps from the body when the note has frontmatter', async () => {
    const html = await render('---\nid: x\n---\n\n\n\na\n\n\nb\n')
    expect(spacers(html)).toBe(1)
  })

  it('leaves fence, table and HTML contents alone but spaces around them', async () => {
    const fence = await render('```js\nconst a = 1\n\n\n\nconst b = 2\n```\n\n\nafter\n')
    expect(fence).toContain(encodeURIComponent('const a = 1\n\n\n\nconst b = 2'))
    expect(spacers(fence)).toBe(1)

    const table = await render('| a |\n| - |\n| 1 |\n\n\n\nafter\n')
    expect(spacers(table)).toBe(2)

    const html = await render('<div>\nx\n</div>\n\n\nafter\n')
    expect(spacers(html)).toBe(1)
  })

  it('keeps CommonMark spacing inside lists and quotes', async () => {
    expect(spacers(await render('- a\n\n\n- b\n'))).toBe(0)
    expect(spacers(await render('> a\n>\n>\n> b\n'))).toBe(0)
  })

  it('spaces blocks before and after a list by its last non-blank line', async () => {
    expect(spacers(await render('- a\n- b\n\n\nafter\n'))).toBe(1)
    expect(spacers(await render('- a\n- b\n\nafter\n'))).toBe(0)
  })

  it('keeps every blank line in callout bodies, title and closing fence included', async () => {
    const html = await render('::: tip\n\n\na\n\n\n\nb\n\n\n:::\n')
    expect(spacers(html)).toBe(7)
    expect(html.indexOf(SPACER)).toBeLessThan(html.indexOf('<p>a</p>'))
    expect(html.lastIndexOf(SPACER)).toBeGreaterThan(html.indexOf('<p>b</p>'))
  })

  it('spaces a single blank line inside callouts, as the editor shows it', async () => {
    expect(spacers(await render('::: tip 标题\n\n正文\n\n:::\n'))).toBe(2)
    expect(spacers(await render('::: tip\n甲\n\n乙\n:::\n'))).toBe(1)
    expect(spacers(await render('::: details\n正文\n:::\n'))).toBe(0)
  })

  it('spaces the blocks around a callout from its closing fence', async () => {
    expect(spacers(await render('before\n\n::: tip\nx\n:::\n\nafter\n'))).toBe(0)
    expect(spacers(await render('before\n\n\n::: tip\nx\n:::\n\n\nafter\n'))).toBe(2)
  })

  it('does not space inside non-callout containers', async () => {
    const html = await render('::: code-group\n```js [a]\n1\n```\n\n\n\n```js [b]\n2\n```\n:::\n')
    expect(spacers(html)).toBe(0)
  })

  it('keeps headings attached to their section bodies', async () => {
    const html = await render('## A\n\n\ntext\n\n\n## B\n')
    expect(spacers(html)).toBe(2)
    expect(html).toMatch(/<h2[^>]*>[\s\S]*<\/h2>[\s\S]*tn-blank-line/)
  })
})
