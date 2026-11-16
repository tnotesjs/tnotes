/**
 * Parse / rebuild Vue-tag components used as deskRawBlock atoms.
 */

export interface ParsedBilibiliVideo {
  /** Canonical tag written on rebuild. */
  name: 'BilibiliVideo'
  id: string
  autoplay: boolean
  muted: boolean
  trailingNewline: boolean
}

const BILIBILI_TAG = /^ {0,3}<(?<tag>BilibiliVideo)\b([^>]*)\/?\s*>\s*$/m

/** True when source is a Bilibili video tag. */
export function isBilibiliVideoSource(source: string): boolean {
  return BILIBILI_TAG.test(source.trim())
}

function readIdAttr(attrs: string): string {
  const match =
    attrs.match(/\bid\s*=\s*"([^"]*)"/) ??
    attrs.match(/\bid\s*=\s*'([^']*)'/) ??
    attrs.match(/\bid\s*=\s*\{\s*["']([^"']*)["']\s*\}/)
  return match?.[1] ?? ''
}

function readBooleanAttr(attrs: string, name: string, defaultValue = false): boolean {
  const bound = attrs.match(new RegExp(`:${name}\\s*=\\s*["']?(true|false)["']?`))
  if (bound) return bound[1] === 'true'
  const plain = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']?(true|false|1|0)["']?`))
  if (plain) return plain[1] === 'true' || plain[1] === '1'
  // Presence-only boolean attribute: <X autoplay />
  if (
    new RegExp(`\\b${name}(?:\\s|/|>|$)`).test(attrs) &&
    !new RegExp(`\\b${name}\\s*=`).test(attrs)
  ) {
    return true
  }
  return defaultValue
}

export function parseBilibiliVideoSource(source: string): ParsedBilibiliVideo | null {
  const trailingNewline = /\r?\n$/.test(source)
  const trimmed = source.replace(/\r\n?/g, '\n').trim()
  const match = trimmed.match(BILIBILI_TAG)
  if (!match?.groups?.tag) return null
  const attrs = match[2] ?? ''
  return {
    name: 'BilibiliVideo',
    id: readIdAttr(attrs),
    autoplay: readBooleanAttr(attrs, 'autoplay', false),
    muted: readBooleanAttr(attrs, 'muted', false),
    trailingNewline
  }
}

export interface RebuildBilibiliVideoOptions {
  id: string
  autoplay?: boolean
  muted?: boolean
  trailingNewline?: boolean
}

/** Canonical tag; omits autoplay/muted when false so notes stay short. */
export function rebuildBilibiliVideoSource(options: RebuildBilibiliVideoOptions | string): string {
  const opts =
    typeof options === 'string'
      ? { id: options, autoplay: false, muted: false, trailingNewline: true }
      : options
  const id = opts.id.replace(/"/g, '')
  const parts = [`id="${id}"`]
  if (opts.autoplay) parts.push(':autoplay="true"')
  if (opts.muted) parts.push(':muted="true"')
  const line = `<BilibiliVideo ${parts.join(' ')} />`
  return (opts.trailingNewline ?? true) ? `${line}\n` : line
}

export interface ParsedWordList {
  name: 'WordList'
  words: string[]
  needSort: boolean
  trailingNewline: boolean
}

const WORD_LIST_OPEN = /^ {0,3}<(?<tag>WordList)\b/m

/** True when source is a WordList tag. */
export function isWordListSource(source: string): boolean {
  return WORD_LIST_OPEN.test(source.trim())
}

function extractWordsArrayLiteral(source: string): string | null {
  const match = source.match(/:words\s*=\s*(["'])(\[[\s\S]*?\])\1/)
  if (match) return match[2]
  const bare = source.match(/:words\s*=\s*(\[[\s\S]*?\])/)
  return bare?.[1] ?? null
}

function parseWordsLiteral(literal: string): string[] {
  const words: string[] = []
  for (const match of literal.matchAll(/['"]([^'"]*)['"]/g)) {
    const word = match[1].trim()
    if (word) words.push(word)
  }
  return words
}

export function parseWordListSource(source: string): ParsedWordList | null {
  const trailingNewline = /\r?\n$/.test(source)
  const trimmed = source.replace(/\r\n?/g, '\n').trim()
  if (!WORD_LIST_OPEN.test(trimmed)) return null
  const literal = extractWordsArrayLiteral(trimmed) ?? '[]'
  const attrsChunk = trimmed.slice(0, Math.min(trimmed.length, 400))
  return {
    name: 'WordList',
    words: parseWordsLiteral(literal),
    needSort: readBooleanAttr(attrsChunk, 'needSort', false),
    trailingNewline
  }
}

export interface RebuildWordListOptions {
  words: string[]
  needSort?: boolean
  trailingNewline?: boolean
}

/** Canonical WordList tag; one word per line when non-empty. */
export function rebuildWordListSource(options: RebuildWordListOptions): string {
  const words = options.words.map((w) => w.trim()).filter(Boolean)
  const needSortAttr = options.needSort ? ' :needSort="true"' : ''
  let line: string
  if (words.length === 0) {
    line = `<WordList :words="[]"${needSortAttr} />`
  } else {
    const body = words.map((w) => `'${w.replace(/'/g, "\\'")}'`).join(',\n')
    line = `<WordList :words="[\n${body},\n]"${needSortAttr} />`
  }
  return (options.trailingNewline ?? true) ? `${line}\n` : line
}

export interface ParsedNotesTable {
  name: 'NotesTable'
  ids: string[]
  trailingNewline: boolean
}

const NOTES_TABLE_OPEN = /^ {0,3}<(?<tag>NotesTable)\b/m

export function isNotesTableSource(source: string): boolean {
  return NOTES_TABLE_OPEN.test(source.trim())
}

function extractIdsArrayLiteral(source: string): string | null {
  const match = source.match(/:ids\s*=\s*(["'])(\[[\s\S]*?\])\1/)
  if (match) return match[2]
  const bare = source.match(/:ids\s*=\s*(\[[\s\S]*?\])/)
  return bare?.[1] ?? null
}

export function parseNotesTableSource(source: string): ParsedNotesTable | null {
  const trailingNewline = /\r?\n$/.test(source)
  const trimmed = source.replace(/\r\n?/g, '\n').trim()
  if (!NOTES_TABLE_OPEN.test(trimmed)) return null
  const literal = extractIdsArrayLiteral(trimmed) ?? '[]'
  const ids: string[] = []
  for (const match of literal.matchAll(/['"]([^'"]*)['"]/g)) {
    const id = match[1].trim()
    if (id) ids.push(id)
  }
  return { name: 'NotesTable', ids, trailingNewline }
}

export function rebuildNotesTableSource(options: {
  ids: string[]
  trailingNewline?: boolean
}): string {
  const ids = options.ids.map((id) => id.trim()).filter(Boolean)
  let line: string
  if (ids.length === 0) {
    line = `<NotesTable :ids="[\n  '',\n]" />`
  } else {
    const body = ids.map((id) => `  '${id.replace(/'/g, "\\'")}'`).join(',\n')
    line = `<NotesTable :ids="[\n${body},\n]" />`
  }
  return (options.trailingNewline ?? true) ? `${line}\n` : line
}
