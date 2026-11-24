/**
 * 站内换笔记：从整页 HTML 里取出正文和页面数据，不卸载侧栏。
 *
 * 侧栏链接仍是普通 `<a>`，没按住修饰键时由站点应用拦截。取不到正文就交给浏览器整页打开。
 */

import type { PageData } from '../types'
import { resolveNotePath, stripBase, type NoteRef } from './noteRoute'

export interface NotePagePayload {
  route: string
  data: PageData
  articleHtml: string
  title: string
}

export interface NoteClick {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}

/** 普通左键，没有「新标签 / 新窗口」修饰键。 */
export function isPlainNoteClick(event: NoteClick): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  )
}

/**
 * 这个地址能不能在当前页里换掉。
 * 笔记别名收成规范路径；首页是 `/`。站外、资源文件、锚点以外的未知路径返回 null。
 */
export function noteTarget(
  href: string,
  current: { origin: string },
  base: string,
  notes: readonly NoteRef[]
): { route: string; url: string } | null {
  let url: URL
  try {
    url = new URL(href, current.origin)
  } catch {
    return null
  }
  if (url.origin !== current.origin) return null
  const path = stripBase(url.pathname, base)
  const route = path === '/' ? '/' : resolveNotePath(url.pathname, notes, base)
  if (!route) return null
  const prefix = base.endsWith('/') ? base : `${base}/`
  const pathname = route === '/' ? prefix : `${prefix}${route.replace(/^\//, '')}`
  return { route, url: `${pathname}${url.search}${url.hash}` }
}

function extractDivInner(html: string, className: string): string | null {
  const open = new RegExp(`<div\\b[^>]*\\bclass="[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'i')
  const match = open.exec(html)
  if (!match || match.index === undefined) return null
  const start = match.index + match[0].length
  const token = /<div\b|<\/div>/gi
  token.lastIndex = start
  let depth = 1
  let found: RegExpExecArray | null
  while ((found = token.exec(html))) {
    depth += found[0].startsWith('</') ? -1 : 1
    if (depth === 0) return html.slice(start, found.index)
  }
  return null
}

function decodeTitle(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

/** 从一篇已生成的 HTML 里取出正文、页面数据和标题。结构对不上就返回 null。 */
export function extractNotePage(html: string): NotePagePayload | null {
  const articleHtml = extractDivInner(html, 'tn-site-article')
  const dataMatch = /<script\b[^>]*\bid="tn-page-data"[^>]*>([\s\S]*?)<\/script>/i.exec(html)
  if (articleHtml == null || !dataMatch) return null
  try {
    const data = JSON.parse(dataMatch[1]) as PageData
    if (!data || typeof data.route !== 'string' || !Array.isArray(data.headings)) return null
    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html)
    return {
      route: data.route,
      data,
      articleHtml,
      title: titleMatch ? decodeTitle(titleMatch[1]) : data.title
    }
  } catch {
    return null
  }
}

export async function fetchNotePage(url: string): Promise<NotePagePayload | null> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) return null
  return extractNotePage(await response.text())
}
