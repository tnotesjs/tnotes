// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import {
  DESK_CODE_CLIPBOARD_TYPE,
  looksLikeMarkdown,
  stripDeskCodeSentinel,
  textToDom,
  withDeskCodeSentinel
} from './clipboardNewline'

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

describe('Markdown 判定（P2：不能靠行首正则区分代码与 Markdown）', () => {
  it('多级标题 / 列表(≥2行) / 成对围栏 / 引用 / 表格 / 分隔线 / 容器语法算 Markdown', () => {
    for (const text of [
      '## 标题',
      '## 标题\n正文',
      '- 甲\n- 乙',
      '* 甲\n* 乙',
      '1. 甲\n2. 乙',
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

  it('行内语法（`**粗体**` / 链接）也要认（旧实现只查行首，会漏）', () => {
    expect(looksLikeMarkdown('这是**粗体**文字')).toBe(true)
    expect(looksLikeMarkdown('见 [文档](https://example.com/a)')).toBe(true)
    expect(looksLikeMarkdown('这是 *斜体* 文字')).toBe(true)
  })

  it('Python 注释开头的代码不得被当成 Markdown', () => {
    const code = [
      '# 计算总和',
      'def total(xs):',
      '    return sum(xs)',
      '',
      '# 打印结果',
      'print(total([1, 2]))'
    ].join('\n')
    expect(looksLikeMarkdown(code)).toBe(false)
  })

  it('Shell 注释开头的代码不得被当成 Markdown', () => {
    const code = ['#!/bin/bash', '# 部署脚本', 'set -e', '# 构建', 'pnpm build'].join('\n')
    expect(looksLikeMarkdown(code)).toBe(false)
  })

  it('C 风格注释块（` * 内容`）不得被当成 Markdown 列表', () => {
    const code = [
      '/*',
      ' * 计算总和',
      ' * 参数：xs',
      ' */',
      'function total(xs) {',
      '  return xs.length',
      '}'
    ].join('\n')
    expect(looksLikeMarkdown(code)).toBe(false)
  })

  it('单个 `# 注释` 不算（与标题字符层面无法区分，宁可不解析）', () => {
    expect(looksLikeMarkdown('# 标题')).toBe(false)
    expect(looksLikeMarkdown('# 单行注释')).toBe(false)
  })

  it('单个 `- item` 不算 Markdown（代码里的短横线太常见）', () => {
    expect(looksLikeMarkdown('- 单个列表项')).toBe(false)
    expect(looksLikeMarkdown('const a = 1\n- 1')).toBe(false)
  })

  it('代码与普通多行文本都不算 Markdown', () => {
    for (const text of [
      'const a = 1\n\nconst b = 2\n    indented',
      '普通一句话\n第二行\n\n第四行',
      '}',
      'SELECT *\nFROM t\nWHERE x = 1'
    ]) {
      expect(looksLikeMarkdown(text), JSON.stringify(text)).toBe(false)
    }
  })

  it('行中间出现的 `#` / `-` / `|` 不算标记', () => {
    expect(looksLikeMarkdown('a # b')).toBe(false)
    expect(looksLikeMarkdown('a - b')).toBe(false)
    expect(looksLikeMarkdown('x = a | b')).toBe(false)
  })

  it('自定义 MIME 用 Electron 实际认可的形式（`web application/...`）', () => {
    // 实测 Electron：`ClipboardItem.supports('application/x-desk-code') === false`，
    // 只有带 `web ` 前缀的形式被认
    expect(DESK_CODE_CLIPBOARD_TYPE.startsWith('web application/')).toBe(true)
  })
})

describe('代码来源哨兵（不依赖剪贴板权限的载体）', () => {
  it('加哨兵后能识别出来，并剥回原文', () => {
    const code = '# 计算总和\ndef total(xs):\n    return sum(xs)'
    const payload = withDeskCodeSentinel(code)
    expect(payload).not.toBe(code)
    const stripped = stripDeskCodeSentinel(payload)
    expect(stripped.isCode).toBe(true)
    expect(stripped.text).toBe(code)
  })

  it('普通文本不带哨兵，原样返回', () => {
    const stripped = stripDeskCodeSentinel('# 计算总和\ndef total():')
    expect(stripped.isCode).toBe(false)
    expect(stripped.text).toBe('# 计算总和\ndef total():')
  })

  it('哨兵本身不贡献可见字符宽度（不可见、不参与排版）', () => {
    // Unicode Tag 区字符：不可见，粘贴到外部应用也不会显现
    expect(withDeskCodeSentinel('x').startsWith('\u{E0000}')).toBe(true)
    expect(withDeskCodeSentinel('x').replace(/[\u{E0000}-\u{E007F}]/gu, '')).toBe('desk-codex')
  })

  it('带哨兵的代码（含 `##` 与 `**` 冲突内容）必须走保留行边界的路径', () => {
    const tricky = ['## 这不是标题', '**这不是粗体**', '# 也不是', '- 也不是列表'].join('\n')
    // 不打哨兵时会被判成 Markdown（`##` / 两行短横线）
    expect(looksLikeMarkdown(tricky)).toBe(true)
    // 打上哨兵后粘贴端会跳过 Markdown 判定，直接保留行边界
    const stripped = stripDeskCodeSentinel(withDeskCodeSentinel(tricky))
    expect(stripped.isCode).toBe(true)
    expect(stripped.text).toBe(tricky)
  })
})
