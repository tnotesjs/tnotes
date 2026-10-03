export interface MindmapFenceOptions {
  title?: string
  initialExpandLevel?: number
  /** Pane height in px (`h=480` in the fence info). */
  height?: number
}

export const MINDMAP_MIN_HEIGHT = 200
export const MINDMAP_MAX_HEIGHT = 1600

export function clampMindmapHeight(value: number): number {
  return Math.round(Math.min(MINDMAP_MAX_HEIGHT, Math.max(MINDMAP_MIN_HEIGHT, value)))
}

function cleanHeadingText(value: string): string {
  return value
    .trim()
    .replace(/\s+#+\s*$/, '')
    .trim()
}

/** Parse the canonical `mindmap [title] 2 h=480` fence metadata. */
export function parseMindmapFence(openLine: string): MindmapFenceOptions | null {
  const fenceBody = openLine.trim().replace(/^`+\s*/, '')
  const nameMatch = fenceBody.match(/^mindmap(?=\s|\[|$)/)
  if (!nameMatch) return null

  let rest = fenceBody.slice(nameMatch[0].length).trim()
  const options: MindmapFenceOptions = {}
  const titleMatch = rest.match(/\[([^\]]+)\]/)
  if (titleMatch) {
    options.title = cleanHeadingText(titleMatch[1]) || undefined
    rest =
      `${rest.slice(0, titleMatch.index)} ${rest.slice((titleMatch.index ?? 0) + titleMatch[0].length)}`.trim()
  }

  for (const token of rest.split(/\s+/).filter(Boolean)) {
    const height = token.match(/^h=(\d+)$/)
    if (height) {
      options.height = clampMindmapHeight(Number(height[1]))
    } else if (/^\d+$/.test(token) && options.initialExpandLevel === undefined) {
      options.initialExpandLevel = Math.max(1, Number(token))
    } else {
      return null
    }
  }
  return options
}

export interface NormalizeMindmapOptions {
  title?: string
  defaultTitle?: string
}

/** Ensure canonical mindmap Markdown has exactly one H1 root title. */
export function normalizeMindmapMarkdown(
  source: string,
  options: NormalizeMindmapOptions = {}
): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let existingTitle = ''
  let rootIndex = -1

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s{0,3}#(?!#)\s+(.+?)\s*$/)
    if (!match) continue
    existingTitle = cleanHeadingText(match[1])
    rootIndex = index
    break
  }

  const rootTitle =
    cleanHeadingText(options.title || existingTitle || options.defaultTitle || 'root') || 'root'
  const body = lines.filter((_, index) => index !== rootIndex)
  while (body[0]?.trim() === '') body.shift()
  while (body[body.length - 1]?.trim() === '') body.pop()

  return body.length > 0 ? `# ${rootTitle}\n\n${body.join('\n')}\n` : `# ${rootTitle}\n`
}
