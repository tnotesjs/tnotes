/**
 * src/frontmatter.ts
 *
 * Whitelisted frontmatter parse/serialize for single-file notes.
 * Parsing tolerates any YAML; serialization writes whitelist keys only.
 */

import matter from 'gray-matter'

import { FRONTMATTER_KEYS } from './constants'

import type { NoteFrontmatter } from './types'

export interface ParsedNoteContent {
  frontmatter: NoteFrontmatter
  /** Markdown body without the frontmatter block. */
  body: string
}

function cleanString(value: unknown): string | undefined {
  // YAML 会把未加引号的 111 读成数字。描述框逐字打出的纯数字必须仍是字符串，
  // 否则保存时字段被丢掉，并退回磁盘上的旧描述。
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Parse note content, returning only whitelisted frontmatter fields. */
export function parseNoteContent(content: string): ParsedNoteContent {
  const { data, content: body } = matter(content)
  const frontmatter: NoteFrontmatter = {}
  const id = cleanString(data.id)
  if (id) frontmatter.id = id
  const description = cleanString(data.description)
  if (description) frontmatter.description = description
  return { frontmatter, body }
}

/**
 * Serialize frontmatter + body. Only whitelisted, non-empty keys are written,
 * in a stable order. No frontmatter block is emitted when empty.
 */
export function serializeNoteContent(frontmatter: NoteFrontmatter, body: string): string {
  const ordered: Record<string, unknown> = {}
  for (const key of FRONTMATTER_KEYS) {
    const value = frontmatter[key]
    if (typeof value === 'string' && value.trim()) ordered[key] = value.trim()
  }
  const normalizedBody = body.startsWith('\n') ? body.slice(1) : body
  if (Object.keys(ordered).length === 0) {
    return normalizedBody.endsWith('\n') ? normalizedBody : `${normalizedBody}\n`
  }
  return keepPlainScalars(matter.stringify(`\n${normalizedBody.replace(/\n$/, '')}\n`, ordered))
}

/**
 * js-yaml 会给纯数字、布尔值加引号，避免它们被读成非字符串。
 * 解析时这些值已经按文本保留，引号只会让源码和描述框不一致。
 */
function keepPlainScalars(content: string): string {
  return content.replace(
    /^(id|description):\s*(['"])((?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)|true|false)\2\s*$/gm,
    '$1: $3'
  )
}

/** Merge updates into existing file content, preserving the body. */
export function updateNoteFrontmatter(content: string, updates: Partial<NoteFrontmatter>): string {
  const { frontmatter, body } = parseNoteContent(content)
  const next: NoteFrontmatter = { ...frontmatter }
  for (const key of FRONTMATTER_KEYS) {
    if (!(key in updates)) continue
    const value = updates[key]
    if (value === undefined || value === '') {
      delete next[key]
    } else {
      ;(next as Record<string, unknown>)[key] = value
    }
  }
  return serializeNoteContent(next, body)
}
