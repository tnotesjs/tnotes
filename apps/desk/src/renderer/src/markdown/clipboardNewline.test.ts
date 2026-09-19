// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { textToDom } from './clipboardNewline'

const toHtml = (text: string): string => {
  const host = document.createElement('div')
  host.appendChild(textToDom(text))
  return host.innerHTML
}

describe('纯文本粘贴的行结构转换', () => {
  it('单个换行变成硬换行，不塌成空格', () => {
    expect(toHtml('a\nb')).toBe('<p>a<br>b</p>')
  })

  it('连续换行（含空行）拆成段落', () => {
    expect(toHtml('a\n\nb')).toBe('<p>a</p><p>b</p>')
    expect(toHtml('a\n\n\nb')).toBe('<p>a</p><p>b</p>')
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

  it('空串得到空段落（不会注入额外节点类型）', () => {
    expect(toHtml('')).toBe('<p></p>')
  })
})
