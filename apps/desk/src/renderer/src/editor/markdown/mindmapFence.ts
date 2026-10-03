import {
  clampMindmapHeight,
  normalizeMindmapMarkdown,
  parseMindmapFence,
  type MindmapFenceOptions
} from '@tnotesjs/ui'

export interface MindmapFenceParts {
  openLine: string
  body: string
  trailingNewline: boolean
  options: MindmapFenceOptions
  /** True when the original fence info included `[title]`. */
  hasFenceTitle: boolean
  /** True when the body already had an H1 before normalize. */
  hasBodyH1: boolean
}

/** Split a full mindmap fence source into open-line meta + body. */
export function parseMindmapFenceSource(source: string): MindmapFenceParts {
  const trailingNewline = /\r?\n$/.test(source)
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const openLine = lines[0] ?? '```mindmap'
  const options = parseMindmapFence(openLine) ?? {}
  const hasFenceTitle = /\[[^\]]+\]/.test(openLine.replace(/^`+/, ''))
  let end = lines.length - 1
  while (end > 0 && !/^ {0,3}`{3,}[ \t]*$/.test(lines[end])) end -= 1
  const body = lines.slice(1, end).join('\n')
  const hasBodyH1 = /^\s{0,3}#(?!#)\s+/m.test(body)
  return { openLine, body, trailingNewline, options, hasFenceTitle, hasBodyH1 }
}

/** Build the markdown passed to mindmap-core (always one H1 root). */
export function mindmapPreviewMarkdown(source: string): {
  markdown: string
  initialExpandLevel: number
  height: number | undefined
  parts: MindmapFenceParts
} {
  const parts = parseMindmapFenceSource(source)
  const markdown = normalizeMindmapMarkdown(parts.body, {
    title: parts.options.title
  })
  return {
    markdown,
    initialExpandLevel: parts.options.initialExpandLevel ?? 3,
    height: parts.options.height,
    parts
  }
}

/**
 * Rebuild a mindmap fence after canvas / expand-level / height edits.
 * Preserves fence-title vs body-H1 style from the original source.
 */
export function rebuildMindmapFence(
  source: string,
  next: {
    markdown?: string
    initialExpandLevel?: number
    height?: number
    title?: string
  } = {}
): string {
  const parts = parseMindmapFenceSource(source)
  const full = next.markdown ?? normalizeMindmapMarkdown(parts.body, { title: parts.options.title })
  const normalized = normalizeMindmapMarkdown(full)
  const lines = normalized.replace(/\r\n?/g, '\n').split('\n')
  let rootTitle = 'root'
  let rootIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s{0,3}#(?!#)\s+(.+?)\s*$/)
    if (!match) continue
    rootTitle =
      match[1]
        .trim()
        .replace(/\s+#+\s*$/, '')
        .trim() || 'root'
    rootIndex = i
    break
  }
  const bodyLines = lines.filter((_, i) => i !== rootIndex)
  while (bodyLines[0]?.trim() === '') bodyLines.shift()
  while (bodyLines[bodyLines.length - 1]?.trim() === '') bodyLines.pop()

  const title = next.title ?? (parts.hasFenceTitle ? rootTitle : parts.options.title)
  const level = next.initialExpandLevel ?? parts.options.initialExpandLevel
  const height = next.height ?? parts.options.height
  const useFenceTitle = parts.hasFenceTitle || Boolean(next.title)

  let info = 'mindmap'
  if (useFenceTitle && title) info += ` [${title}]`
  if (level !== undefined) info += ` ${Math.max(1, Math.trunc(level))}`
  if (height !== undefined) info += ` h=${clampMindmapHeight(height)}`

  let body: string
  if (useFenceTitle) {
    body = bodyLines.join('\n')
  } else if (parts.hasBodyH1 || rootTitle !== 'root') {
    body = bodyLines.length > 0 ? `# ${rootTitle}\n\n${bodyLines.join('\n')}` : `# ${rootTitle}`
  } else {
    body = bodyLines.join('\n')
  }

  const fence = body.length > 0 ? `\`\`\`${info}\n${body}\n\`\`\`` : `\`\`\`${info}\n\`\`\``
  return parts.trailingNewline ? `${fence}\n` : fence
}
