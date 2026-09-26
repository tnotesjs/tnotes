/** 对话框里的编号：`42` 与 `0042` 都是 0042，超出 0001–9999 则无效。 */
export function canonicalNoteIndex(raw: string): string | null {
  const text = String(raw ?? '').trim()
  if (!/^\d{1,4}$/.test(text)) return null
  const value = Number(text)
  if (value < 1 || value > 9999) return null
  return String(value).padStart(4, '0')
}

export function noteIndexChangeError(
  raw: string,
  currentIndex: string,
  taken: ReadonlySet<string>
): string | null {
  const next = canonicalNoteIndex(raw)
  if (!next) return '索引必须是 0001 到 9999'
  if (next !== currentIndex && taken.has(next)) return `索引 ${next} 已被占用`
  return null
}

/** 与知识库层同一规则：只改第一处标题前缀，以及 `assets/旧编号-` 资源路径。 */
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
