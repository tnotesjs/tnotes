// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { looksLikeMarkdown, textToDom } from './clipboardNewline'

const toHtml = (text: string): string => {
  const host = document.createElement('div')
  host.appendChild(textToDom(text))
  return host.innerHTML
}

describe('纯文本粘贴的行结构转换', () => {
  it('单个换行变成硬换行，不塌成空格', () => {
    expect(toHtml('a\nb')).toBe('<p>a<br>b</p>')
  })

  it('两个空行必须产出两个空段落（不合并）', () => {
    expect(toHtml('a\n\nb')).toBe('<p>a</p><p></p><p>b</p>')
  })

  it('三个空行产出三个空段落（旧实现会把 2/3 个空行压成同一种结果）', () => {
    expect(toHtml('a\n\n\nb')).toBe('<p>a</p><p></p><p></p><p>b</p>')
  })

  it('四个空行产出四个空段落', () => {
    expect(toHtml('a\n\n\n\nb')).toBe('<p>a</p><p></p><p></p><p></p><p>b</p>')
  })

  it('尾部空行同样保留（`a` 后 3 个换行 = 3 个空行）', () => {
    expect(toHtml('a\n\n\n')).toBe('<p>a</p><p></p><p></p><p></p>')
  })

  it('行首缩进保留', () => {
    expect(toHtml('a\n    indented')).toBe('<p>a<br>    indented</p>')
  })

  it('CRLF / CR 归一成 LF', () => {
    expect(toHtml('a\r\nb\rc')).toBe('<p>a<br>b<br>c</p>')
  })

  it('HTML 特殊字符按文本处理，不当作标签', () => {
    expect(toHtml('<b>x</b> & y')).toBe('<p>&lt;b&gt;x&lt;/b&gt; &amp; y</p>')
  })
})

describe('Markdown 判定（命中就交回原有 Markdown 解析）', () => {
  it('标题 / 列表 / 围栏 / 引用 / 表格 / 分隔线 / 容器语法都算 Markdown', () => {
    for (const text of [
      '# 标题',
      '## 标题\n正文',
      '- 列表项',
      '* 列表项',
      '1. 有序项',
      '1) 有序项',
      '> 引用',
      '```js\nconst a = 1\n```',
      '~~~\ncode\n~~~',
      '---\n',
      '| a | b |\n| - | - |',
      '::: note\n内容\n:::'
    ]) {
      expect(looksLikeMarkdown(text), JSON.stringify(text)).toBe(true)
    }
  })

  it('代码与普通多行文本不算 Markdown（走保留行边界的路径）', () => {
    for (const text of [
      'const a = 1\n\nconst b = 2\n    indented',
      '普通一句话\n第二行\n\n第四行',
      '}\n  return value\n}',
      'SELECT *\nFROM t\nWHERE x = 1'
    ]) {
      expect(looksLikeMarkdown(text), JSON.stringify(text)).toBe(false)
    }
  })

  it('行中间出现的 `#` / `-` 不算 Markdown 标记', () => {
    expect(looksLikeMarkdown('a # b')).toBe(false)
    expect(looksLikeMarkdown('a - b')).toBe(false)
    expect(looksLikeMarkdown('x = a | b')).toBe(false)
  })
})
