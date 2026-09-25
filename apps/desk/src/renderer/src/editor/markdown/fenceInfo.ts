/** Extract the last `[title]` segment from a fence info/meta string. */
export function parseFenceTitleFromMeta(meta?: string | null): string {
  if (!meta) return ''
  const matches = [...meta.matchAll(/\[([^\]]*)\]/g)]
  const last = matches[matches.length - 1]
  return (last?.[1] ?? '').trim()
}

/**
 * Rewrite the opening fence line's trailing `[title]`, preserving highlight
 * meta such as `{30-51}`. Empty title removes the bracket segment.
 */
export function applyFenceTitle(opening: string, title: string): string {
  const match = opening.match(/^( {0,3}(?:`{3,}|~{3,}))([ \t]*)(\S+)?([\s\S]*)$/)
  if (!match) return opening
  const [, fence, whitespace, language = '', remaining = ''] = match
  let rest = remaining
    .replace(/\s*\[[^\]]*\]\s*(?=$)/, '')
    .replace(/[ \t]+$/g, '')
    // A trailing mindmap level (` ```mindmap [demo] 3 `) is a separate channel —
    // re-appending the title must not swallow it (`... 3` → `... [demo]`).
    .replace(/(?<=^|[ \t])\d+[ \t]*$/, '')
    .replace(/[ \t]+$/g, '')
  const trimmedTitle = title.trim()
  if (trimmedTitle) {
    rest = `${rest} [${trimmedTitle}]`.replace(/^\s+/, language ? ' ' : '')
  }
  return `${fence}${whitespace}${language}${rest}`
}

/**
 * Extract the mindmap expand level from a fence info/meta string.
 *
 * The level is the trailing integer of a `mindmap` fence —
 * `` ```mindmap [title] 3 `` — so `[title]` and highlight braces are not numbers
 * and can never be mistaken for it. Returns `null` for other languages (a `js`
 * fence may legitimately end in, say, `line-numbers=4`).
 */
export function parseFenceLevelFromMeta(meta?: string | null): number | null {
  if (!meta) return null
  const match = meta.match(/^\s*(\S+)([\s\S]*)$/)
  const language = match?.[1] ?? ''
  if (!/^mindmap$/i.test(language)) return null
  const level = (match?.[2] ?? '').match(/(?:^|[ \t])(\d+)[ \t]*$/)
  if (!level) return null
  const value = Number(level[1])
  return Number.isFinite(value) ? value : null
}

/** True when the fence is a mindmap — the only fence with an expand level. */
export function isMindmapFenceOpening(opening: string): boolean {
  return /^ {0,3}(?:`{3,}|~{3,})\s*mindmap(?=[\s`]|$)/i.test(opening)
}

/**
 * Rewrite the opening fence line's mindmap expand level: a number sets/appends
 * it, `null` removes it. The title and highlight meta stay in place.
 */
export function applyFenceLevel(opening: string, level: number | null): string {
  const match = opening.match(/^( {0,3}(?:`{3,}|~{3,}))([ \t]*)(\S+)?([\s\S]*)$/)
  if (!match) return opening
  const [, fence, whitespace, language = '', remaining = ''] = match
  const rest = remaining.replace(/(?<=^|[ \t])\d+[ \t]*$/, '').replace(/[ \t]+$/, '')
  const suffix = level === null ? '' : ` ${Math.max(1, Math.trunc(level))}`
  return `${fence}${whitespace}${language}${rest}${suffix}`
}

/** 改围栏语言标记。空字符串表示不写语言（源码里不填 text）。 */
export function applyFenceLanguage(opening: string, language: string): string {
  const match = opening.match(/^( {0,3}(?:`{3,}|~{3,}))[ \t]*([\s\S]*)$/)
  if (!match) return opening
  const [, fence, restRaw = ''] = match
  let rest = restRaw
  const token = /^(\S+)/.exec(rest)
  if (token && !token[1].startsWith('[') && !token[1].startsWith('{')) {
    rest = rest.slice(token[1].length)
  }
  rest = rest.replace(/^[ \t]+/, '')
  const lang = language.trim()
  if (!lang) return rest ? `${fence} ${rest}` : fence
  return rest ? `${fence}${lang} ${rest}` : `${fence}${lang}`
}
