import { KbError } from './errors'

/** 四位编号，范围 0001–9999。允许输入 `42`，存成 `0042`。 */
export function normalizeNoteIndex(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!/^\d{1,4}$/.test(text)) {
    throw new KbError('INVALID_INDEX', '索引必须是 0001 到 9999', { index: raw })
  }
  const value = Number(text)
  if (value < 1 || value > 9999) {
    throw new KbError('INVALID_INDEX', '索引必须是 0001 到 9999', { index: raw })
  }
  return String(value).padStart(4, '0')
}

/**
 * 把正文里第一处标题前缀和本篇资源路径从旧编号换成新编号。
 * 标题只改「还没出现过别的标题、且不在代码围栏里」的那一行，例如 `# 0013. new`。
 */
export function rewriteNoteIndexContent(content: string, from: string, to: string): string {
  if (from === to) return content
  const heading = new RegExp(`^(#{1,6}[ \\t]+)${from}(\\.)`, 'm')
  const match = heading.exec(content)
  let next = content
  if (match) {
    const before = content.slice(0, match.index)
    const inFence = (before.match(/```/g) ?? []).length % 2 === 1
    const earlierHeading = /^#{1,6}[ \t]/m.test(before)
    if (!inFence && !earlierHeading) {
      next =
        content.slice(0, match.index) +
        match[1] +
        to +
        match[2] +
        content.slice(match.index + match[0].length)
    }
  }
  return next.replaceAll(`assets/${from}-`, `assets/${to}-`)
}
