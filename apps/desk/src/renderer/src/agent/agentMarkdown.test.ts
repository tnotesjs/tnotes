// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { createAgentMarkdown, renderAgentMarkdown } from './agentMarkdown'

const markdown = createAgentMarkdown()

function render(text: string): string {
  return renderAgentMarkdown(markdown, text)
}

describe('agent markdown math', () => {
  it('renders inline math and leaves currency dollars alone', () => {
    const html = render('把 $O(n)$ 的那步挪到另一个操作上。价格 $5 和 $x^2$ 公式')
    expect(html).toContain('class="katex"')
    expect(html).toContain('style="')
    expect(html).not.toContain('$O(n)$')
    expect(html).not.toContain('$x^2$')
    expect(html).toContain('$5')
  })

  it('renders a single-line and a multiline block formula', () => {
    const single = markdown.render('$$\\sum_{i=1}^{n} i$$')
    expect(single).toContain('katex-display')
    expect(single).not.toContain('$$')
    const block = markdown.render('$$\na^2+b^2\n$$')
    expect(block).toContain('katex-display')
    expect(block).not.toContain('<p>$$')
    const sanitized = render('把 $O(n)$ 和 $$a^2$$ 放在一起')
    expect(sanitized).toContain('class="katex"')
    expect(sanitized).toContain('style="')
  })

  it('keeps dollars inside code, and keeps unclosed or empty dollars as source', () => {
    expect(render('行内 `$O(n)$` 保持源码')).toContain('$O(n)$')
    expect(render('```\n$O(n)$\n```')).toContain('$O(n)$')
    expect(render('```\n$O(n)$\n```')).not.toContain('class="katex"')
    const open = render('流式 $O(n 还没写完')
    expect(open).not.toContain('class="katex"')
    expect(open).toContain('$O(n')
    expect(render('$$\n$$')).not.toContain('class="katex"')
    expect(render('$$$$')).not.toContain('class="katex"')
    expect(markdown.render('半截 $$\n\\sum\n后面的正文')).not.toContain('katex-display')
    expect(render('半截 $$\n\\sum\n后面的正文')).toContain('后面的正文')
  })

  it('does not treat a closing dollar before a space or a digit as math', () => {
    expect(render('不是 $x $ 公式')).not.toContain('class="katex"')
    expect(render('不是 $x$2 公式')).not.toContain('class="katex"')
  })

  it('renders underscores inside math instead of emphasis', () => {
    const html = render('公式 $a_b$ 结束')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('<em>')
  })

  it('renders the comparison table with formulas in the cells', () => {
    const source = [
      '| | s.1 递归 | s.2 迭代（栈） |',
      '|---|---|---|',
      '| 时间 | $O(n)$ | $O(n)$ |',
      '| 空间 | $O(h)$，调用栈 | $O(h)$，显式栈 |'
    ].join('\n')
    const raw = markdown.render(source)
    expect(raw).toContain('<table>')
    expect(raw).toContain('<thead>')
    expect(raw).toContain('<tbody>')
    expect(raw).not.toContain('|---|')
    const html = render(source)
    expect(html).toContain('class="katex"')
    expect(html).toContain('style="')
    expect(html).not.toContain('$O(n)$')
    expect(html).toContain('s.1 递归')
  })
})
