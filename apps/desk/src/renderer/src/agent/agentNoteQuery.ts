import type { DeskTocNode } from '../../../shared/contracts'
import { frontmatterGuardRanges } from '../livePreview/frontmatterIdGuard'
import { EditorState } from '@codemirror/state'

export interface NoteRef {
  uuid: string
  title: string
  index: string
  path: string
}

function walk(nodes: DeskTocNode[], group: string[] = []): Array<NoteRef & { node: Extract<DeskTocNode, { type: 'note' }> }> {
  const rows: Array<NoteRef & { node: Extract<DeskTocNode, { type: 'note' }> }> = []
  for (const node of nodes) {
    if (node.type === 'note') {
      rows.push({
        uuid: node.uuid,
        title: node.title,
        index: node.noteIndex,
        path: node.dirName,
        node
      })
      rows.push(...walk(node.children, group))
    } else {
      rows.push(...walk(node.children, [...group, node.title]))
    }
  }
  return rows
}

export function listNoteRefs(nodes: DeskTocNode[]): NoteRef[] {
  return walk(nodes).map(({ uuid, title, index, path }) => ({ uuid, title, index, path }))
}

function subsequence(haystack: string, needle: string): boolean {
  let at = 0
  for (const char of haystack) {
    if (char === needle[at]) at += 1
    if (at === needle.length) return true
  }
  return needle.length === 0
}

function tokenScore(note: { index: string; title: string }, token: string): number {
  const title = note.title.toLowerCase()
  if (note.index.startsWith(token)) return 3
  if (title.includes(token)) return 2
  if (/^\d+$/.test(token)) return 0
  if (subsequence(`${note.index} ${title}`, token)) return 1
  return 0
}

/**
 * @ 点名用的模糊搜索：编号前缀 > 标题包含 > 按顺序出现的字符。
 * 多个关键字用空格分开，必须都命中；分数相同保持目录顺序。
 */
export function rankNotes<T extends { index: string; title: string }>(notes: readonly T[], query: string, limit = 8): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return notes.slice(0, limit)
  const scored: Array<{ note: T; score: number; order: number }> = []
  notes.forEach((note, order) => {
    let score = 0
    for (const token of tokens) {
      const value = tokenScore(note, token)
      if (value === 0) return
      score += value
    }
    scored.push({ note, score, order })
  })
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((item) => item.note)
}

export interface KnowledgeBaseRef {
  id: string
  name: string
  displayName: string
  configName?: string
}

/** 工具里的 kb 参数：按 id、显示名、目录名解析；省略时用本轮的默认知识库。 */
export function resolveKnowledgeBase<T extends KnowledgeBaseRef>(
  list: readonly T[],
  query: unknown,
  fallbackId: string
): { kb: T } | { error: string } {
  const needle = typeof query === 'string' ? query.trim() : ''
  const target = needle || fallbackId
  const lower = target.toLowerCase()
  const kb =
    list.find((item) => item.id === target) ??
    list.find((item) =>
      [item.displayName, item.name, item.configName ?? ''].some((value) => value && value.toLowerCase() === lower)
    )
  if (kb) return { kb }
  return { error: `找不到知识库「${target}」。可用的有：${list.map((item) => item.displayName).join('、')}` }
}

/** uuid、编号、相对路径、文件夹名或完整标题都能对上。 */
export function findNote(nodes: DeskTocNode[], query: string): Extract<DeskTocNode, { type: 'note' }> | null {
  const needle = query.trim()
  if (!needle) return null
  const notes = walk(nodes)
  const exact = notes.find(
    (note) =>
      note.uuid === needle ||
      note.index === needle ||
      note.title === needle ||
      note.path === needle ||
      `notes/${note.path}.md` === needle ||
      `notes/${note.path}` === needle
  )
  return exact?.node ?? null
}

/** 主进程把单条工具结果限制在 16000 字以内，这里留出行号头的余量。 */
export const READ_CHAR_LIMIT = 15_000

export function readLineSlice(
  content: string,
  offset: number,
  limit: number,
  maxChars = READ_CHAR_LIMIT
): { text: string; fromLine: number; toLine: number; total: number } {
  const lines = content.split('\n')
  const total = lines.length
  const start = Math.min(total, Math.max(1, Math.floor(offset) || 1))
  const count = Math.min(800, Math.max(1, Math.floor(limit) || 400))
  const slice: string[] = []
  let size = 0
  for (const line of lines.slice(start - 1, start - 1 + count)) {
    if (slice.length > 0 && size + line.length + 1 > maxChars) break
    slice.push(line)
    size += line.length + 1
  }
  return { text: slice.join('\n'), fromLine: start, toLine: start - 1 + slice.length, total }
}

export function lineChangeCounts(oldText: string, newText: string): { removed: number; added: number } {
  const count = (text: string): number => text.split('\n').filter((line) => line.length > 0).length
  return { removed: count(oldText), added: count(newText) }
}

export interface SelectionTarget {
  from?: number
  to?: number
  startLine?: number
  endLine?: number
  /** 选区原文（可能只存了开头一段） */
  text?: string
}

/**
 * 胶囊记下的选区在当前全文里的位置：
 * 偏移处的原文没变就用偏移；变了就找离原位置最近的同一段原文；都不行就选中原来那几行。
 */
export function locateSelection(content: string, target: SelectionTarget): { from: number; to: number } | null {
  const text = target.text ?? ''
  const length = Math.max(text.length, (target.to ?? 0) - (target.from ?? 0))
  const origin = target.from ?? 0
  const clampEnd = (from: number): number => Math.min(content.length, from + length)
  if (text && target.from !== undefined && content.startsWith(text, target.from)) {
    return { from: target.from, to: clampEnd(target.from) }
  }
  if (text) {
    let best = -1
    for (let at = content.indexOf(text); at >= 0; at = content.indexOf(text, at + 1)) {
      if (best < 0 || Math.abs(at - origin) < Math.abs(best - origin)) best = at
    }
    if (best >= 0) return { from: best, to: clampEnd(best) }
  }
  if (!target.startLine) return null
  const lines = content.split('\n')
  if (target.startLine > lines.length) return null
  const endLine = Math.min(lines.length, Math.max(target.startLine, target.endLine ?? target.startLine))
  let from = 0
  for (let index = 0; index < target.startLine - 1; index += 1) from += lines[index].length + 1
  let to = from
  for (let index = target.startLine - 1; index < endLine; index += 1) to += lines[index].length + 1
  return { from, to: Math.min(content.length, to - 1) }
}

function bareLine(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+)?(?:[-*+]\s+|\d+[.)]\s+)?(?:\d+(?:\.\d+)*\.?\s+)?/, '')
    .replace(/[*_`]/g, '')
    .trim()
}

/**
 * Agent 写进去的文字现在在哪：整段还在就选中整段；
 * 保存时被整理过（标题加了编号、列表符号变了）就按行找，选中第一处到最后一处对得上的行。
 */
export function locateWritten(content: string, written: string): { from: number; to: number } | null {
  const text = written.trim()
  if (!text) return null
  const exact = content.indexOf(text)
  if (exact >= 0) return { from: exact, to: exact + text.length }
  const wanted = text
    .split('\n')
    .map(bareLine)
    .filter((line) => line.length >= 4)
  if (wanted.length === 0) return null
  const lines = content.split('\n')
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  let first = -1
  let last = -1
  let cursor = 0
  for (const target of wanted) {
    for (let index = cursor; index < lines.length; index += 1) {
      if (bareLine(lines[index]) === target || (target.length >= 8 && lines[index].includes(target))) {
        if (first < 0) first = index
        last = index
        cursor = index + 1
        break
      }
    }
  }
  if (first < 0) return null
  return { from: starts[first], to: starts[last] + lines[last].length }
}

export interface NotePage {
  lines: string[]
  offset: number
  total: number
}

const PAGE_CHAR_LIMIT = 15_000

/** 按编号或标题过滤后翻页。返回的行数不会超过字数上限，头信息按实际行数算。 */
export function pageNoteRefs(
  notes: readonly NoteRef[],
  options: { offset?: number; limit?: number; query?: string } = {}
): NotePage {
  const query = (options.query ?? '').trim().toLowerCase()
  const filtered = query
    ? notes.filter((note) => note.index.toLowerCase().includes(query) || note.title.toLowerCase().includes(query))
    : notes
  const total = filtered.length
  const offset = Math.min(total, Math.max(0, Math.floor(options.offset ?? 0) || 0))
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 200) || 200))
  const lines: string[] = []
  let size = 0
  for (const note of filtered.slice(offset, offset + limit)) {
    const line = `${note.index}\t${note.title}\t${note.uuid}\t${note.path}`
    if (lines.length > 0 && size + line.length + 1 > PAGE_CHAR_LIMIT) break
    lines.push(line)
    size += line.length + 1
  }
  return { lines, offset, total }
}

export function notePageHeader(page: NotePage): string {
  const from = page.lines.length ? page.offset + 1 : page.offset
  const to = page.offset + page.lines.length
  return `第 ${from}–${to} 篇 / 共 ${page.total} 篇`
}

/**
 * 追加到正文末尾。有 frontmatter 时也不会插进保护区：
 * 插入点就是全文末尾，只有 frontmatter 时那正好在结束的 --- 之后。
 * 前面不是换行就补一个，追加内容自己也以换行结束。
 */
export function appendRange(content: string, text: string): { from: number; insert: string } {
  const from = content.length
  let insert = text
  const previous = from > 0 ? content[from - 1] : '\n'
  if (previous !== '\n' && !insert.startsWith('\n')) insert = `\n${insert}`
  if (insert.length > 0 && !insert.endsWith('\n')) insert = `${insert}\n`
  return { from, insert }
}

export function overlapsProtectedFrontmatter(content: string, from: number, to: number): boolean {
  const state = EditorState.create({ doc: content })
  const ranges = frontmatterGuardRanges(state.doc)
  if (!ranges) return false
  for (let index = 0; index < ranges.length; index += 2) {
    const start = ranges[index]
    const end = ranges[index + 1]
    if (from < end && to > start) return true
  }
  return false
}
