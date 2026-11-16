import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags, type Tag } from '@lezer/highlight'
import { githubDarkStyle, githubLightStyle } from '@uiw/codemirror-theme-github'

import type { Extension } from '@codemirror/state'

/** 跟 `@uiw/codemirror-theme-github` 的样式项同一形状。 */
export interface SourceHighlightStyle {
  tag: Tag | readonly Tag[]
  color?: string
  backgroundColor?: string
  fontWeight?: string
  fontStyle?: string
  textDecoration?: string
}

/**
 * 源码视图的 GitHub 语法色。
 *
 * 主题包已经覆盖标题、强调、链接和代码词法。行内代码（`monospace`）和
 * Markdown 标记（`#`、`*`、反引号）它没写，这里补上同一套配色。
 * 只着色，不改编辑器底色，避免和 Desk 自己的编辑区背景打架。
 */
export function sourceHighlightStyles(theme: 'light' | 'dark'): SourceHighlightStyle[] {
  const base = (theme === 'dark' ? githubDarkStyle : githubLightStyle) as SourceHighlightStyle[]
  const muted = theme === 'dark' ? '#8b949e' : '#6a737d'
  const code = theme === 'dark' ? '#a5d6ff' : '#032f62'
  const link = theme === 'dark' ? '#58a6ff' : '#032f62'
  return [
    ...base,
    { tag: tags.monospace, color: code },
    { tag: tags.processingInstruction, color: muted },
    { tag: [tags.link, tags.url], color: link, textDecoration: 'underline' }
  ]
}

export function sourceHighlightExtension(theme: 'light' | 'dark'): Extension {
  return syntaxHighlighting(HighlightStyle.define(sourceHighlightStyles(theme)))
}

export function deskColorScheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}
