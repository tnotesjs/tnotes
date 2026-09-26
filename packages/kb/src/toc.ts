/**
 * src/toc.ts
 *
 * TOC.md line-based parser, tree builder and serializer.
 *
 * Grammar (existing hand-written format, unchanged):
 *   - 分组标题                  group (any depth, 2-space indent)
 *   - [x] 0001. 标题            done note
 *   - [ ] 0001. 标题            pending note
 *
 * Unknown lines (blank lines, headings, comments) are preserved in place:
 * mutations edit the raw line array by index and rewrite the file.
 */

import { TOC_GROUP_LINE_REGEX, TOC_INDENT_SPACES, TOC_NOTE_LINE_REGEX } from './constants'
import { KbError } from './errors'

import type { TocNode } from './types'

export type TocLineKind = 'group' | 'note' | 'unknown'

export interface ParsedTocLine {
  kind: TocLineKind
  indentLevel: number
  /** 4-digit note index (note lines only). */
  noteIndex: string | null
  /** Title text on the line (notes: may be absent; groups: always). */
  title: string | null
  done: boolean
  rawLine: string
}

function parseIndent(spaces: string | undefined): number {
  return Math.floor((spaces?.length ?? 0) / TOC_INDENT_SPACES)
}

export function parseTocLine(line: string | undefined | null): ParsedTocLine {
  const rawLine = line ?? ''
  const unknown: ParsedTocLine = {
    kind: 'unknown',
    indentLevel: 0,
    noteIndex: null,
    title: null,
    done: false,
    rawLine
  }
  if (line == null) return unknown

  const note = line.match(TOC_NOTE_LINE_REGEX)
  if (note) {
    return {
      kind: 'note',
      indentLevel: parseIndent(note[1]),
      noteIndex: note[4],
      title: note[5]?.trim() || null,
      done: note[3].toLowerCase() === 'x',
      rawLine
    }
  }

  const group = line.match(TOC_GROUP_LINE_REGEX)
  if (group) {
    const title = group[2].replace(/^-\s+/, '').trim()
    if (!title) return unknown
    return {
      kind: 'group',
      indentLevel: parseIndent(group[1]),
      noteIndex: null,
      title,
      done: false,
      rawLine
    }
  }

  return unknown
}

export function buildGroupLine(title: string, indentLevel: number): string {
  return `${' '.repeat(indentLevel * TOC_INDENT_SPACES)}- ${title}`
}

export function buildNoteLine(
  index: string,
  title: string,
  done: boolean,
  indentLevel: number
): string {
  const indent = ' '.repeat(indentLevel * TOC_INDENT_SPACES)
  const name = title ? `${index}. ${title}` : index
  return `${indent}- [${done ? 'x' : ' '}] ${name}`
}

/* ---------------------------------- tree --------------------------------- */

interface FlatEntry {
  kind: 'group' | 'note'
  indent: number
  lineIndex: number
  title?: string
  noteIndex?: string
  done?: boolean
  groupPath: string[]
}

/** Flatten content lines, tracking the group path of each entry. */
export function flattenTocLines(lines: string[]): FlatEntry[] {
  const flat: FlatEntry[] = []
  const stack: Array<{ title: string; indent: number }> = []

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseTocLine(lines[i])
    if (parsed.kind === 'unknown') continue

    while (stack.length > 0 && stack[stack.length - 1].indent >= parsed.indentLevel) {
      stack.pop()
    }
    const groupPath = stack.map((s) => s.title)

    if (parsed.kind === 'group') {
      flat.push({
        kind: 'group',
        indent: parsed.indentLevel,
        lineIndex: i,
        title: parsed.title!,
        groupPath
      })
      stack.push({ title: parsed.title!, indent: parsed.indentLevel })
    } else {
      flat.push({
        kind: 'note',
        indent: parsed.indentLevel,
        lineIndex: i,
        noteIndex: parsed.noteIndex!,
        done: parsed.done,
        groupPath
      })
    }
  }
  return flat
}

/** Build the TOC tree from raw lines. */
export function parseTocToTree(lines: string[]): TocNode[] {
  const flat = flattenTocLines(lines)
  const roots: TocNode[] = []
  const stack: Array<{ indent: number; children: TocNode[] }> = [{ indent: -1, children: roots }]

  for (const entry of flat) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= entry.indent) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    const node: TocNode =
      entry.kind === 'group'
        ? { kind: 'group', title: entry.title!, lineIndex: entry.lineIndex, children: [] }
        : {
            kind: 'note',
            index: entry.noteIndex!,
            done: entry.done ?? false,
            lineIndex: entry.lineIndex,
            children: []
          }
    parent.children.push(node)
    stack.push({ indent: entry.indent, children: node.children })
  }
  return roots
}

/** Serialize the tree back to canonical lines (titles from noteTitles map). */
export function serializeTocTree(
  tree: TocNode[],
  noteTitles: ReadonlyMap<string, string>
): string[] {
  const lines: string[] = []
  const walk = (nodes: TocNode[], indent: number): void => {
    for (const node of nodes) {
      if (node.kind === 'group') {
        lines.push(buildGroupLine(node.title, indent))
      } else {
        lines.push(buildNoteLine(node.index, noteTitles.get(node.index) ?? '', node.done, indent))
      }
      walk(node.children, indent + 1)
    }
  }
  walk(tree, 0)
  return lines
}

/* ----------------------------- line-level ops ----------------------------- */

/** Subtree range [start, end) of the entry at lineIndex. */
export function getSubtreeRange(
  lines: string[],
  lineIndex: number
): { start: number; end: number } {
  const parsed = parseTocLine(lines[lineIndex])
  if (parsed.kind === 'unknown') return { start: lineIndex, end: lineIndex + 1 }
  let end = lineIndex + 1
  for (let i = lineIndex + 1; i < lines.length; i++) {
    const next = parseTocLine(lines[i])
    if (next.kind !== 'unknown' && next.indentLevel <= parsed.indentLevel) break
    end = i + 1
  }
  return { start: lineIndex, end }
}

export function findNoteLineIndex(lines: string[], noteIndex: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (parseTocLine(lines[i]).noteIndex === noteIndex) return i
  }
  throw new KbError('NOTE_NOT_FOUND', `TOC.md 中未找到笔记: ${noteIndex}`, { noteIndex })
}

/** Find a group line by its title path, e.g. ["AI 生成", "环境准备"]. */
export function findGroupLineIndex(lines: string[], groupPath: string[]): number {
  const target = groupPath.join('/')
  for (const entry of flattenTocLines(lines)) {
    if (entry.kind !== 'group') continue
    if ([...entry.groupPath, entry.title!].join('/') === target) {
      return entry.lineIndex
    }
  }
  throw new KbError('GROUP_NOT_FOUND', `TOC.md 中未找到分组: ${target}`, { groupPath })
}

/** Note indexes inside the subtree rooted at lineIndex (root included). */
export function collectSubtreeNoteIndexes(lines: string[], lineIndex: number): string[] {
  const { start, end } = getSubtreeRange(lines, lineIndex)
  const indexes: string[] = []
  for (let i = start; i < end; i++) {
    const index = parseTocLine(lines[i]).noteIndex
    if (index) indexes.push(index)
  }
  return indexes
}

/**
 * Insert `newLines` (already at the desired indent) relative to a target entry.
 * `after`/`inside` both insert at the end of the target subtree — the caller
 * controls indentation.
 */
export function insertLinesRelative(
  lines: string[],
  targetLineIndex: number,
  newLines: string[],
  placement: 'before' | 'after' | 'inside'
): string[] {
  const result = [...lines]
  if (placement === 'before') {
    result.splice(targetLineIndex, 0, ...newLines)
    return result
  }
  const { end } = getSubtreeRange(lines, targetLineIndex)
  result.splice(end, 0, ...newLines)
  return result
}

/** Remove the subtree rooted at lineIndex. Returns removed lines + result. */
export function removeSubtree(
  lines: string[],
  lineIndex: number
): { removed: string[]; lines: string[] } {
  const { start, end } = getSubtreeRange(lines, lineIndex)
  const result = [...lines]
  const removed = result.splice(start, end - start)
  return { removed, lines: result }
}

function liftIndent(line: string, levels: number): string {
  if (levels <= 0) return line
  const width = line.length - line.trimStart().length
  return line.slice(Math.min(levels * TOC_INDENT_SPACES, width))
}

/**
 * Drop the selected note lines. Notes and groups that were nested under a
 * removed note move up one level per removed ancestor. Group lines themselves
 * are never removed. Blank lines do not end a subtree.
 */
export function removeSelectedNoteLines(lines: string[], indexes: ReadonlySet<string>): string[] {
  const removedIndents: number[] = []
  const result: string[] = []
  for (const line of lines) {
    const parsed = parseTocLine(line)
    if (parsed.kind === 'unknown') {
      result.push(line.trim() === '' ? line : liftIndent(line, removedIndents.length))
      continue
    }
    while (
      removedIndents.length > 0 &&
      parsed.indentLevel <= removedIndents[removedIndents.length - 1]!
    ) {
      removedIndents.pop()
    }
    if (parsed.kind === 'note' && parsed.noteIndex && indexes.has(parsed.noteIndex)) {
      removedIndents.push(parsed.indentLevel)
      continue
    }
    result.push(liftIndent(line, removedIndents.length))
  }
  return result
}

/** Move a subtree before/after/inside another entry. */
export function moveSubtree(
  lines: string[],
  sourceLineIndex: number,
  targetLineIndex: number,
  placement: 'before' | 'after' | 'inside'
): string[] {
  const source = parseTocLine(lines[sourceLineIndex])
  if (source.kind === 'unknown') {
    throw new KbError('INVALID_OPERATION', `无法移动非 TOC 行: ${sourceLineIndex}`)
  }
  // Guard: cannot move into/descendant-of itself.
  const { start, end } = getSubtreeRange(lines, sourceLineIndex)
  if (targetLineIndex >= start && targetLineIndex < end) {
    throw new KbError('INVALID_OPERATION', '不能将条目移动到它自身内部')
  }

  const target = parseTocLine(lines[targetLineIndex])
  const targetIndent = placement === 'inside' ? target.indentLevel + 1 : target.indentLevel
  const delta = targetIndent - source.indentLevel

  const { removed, lines: withoutSource } = removeSubtree(lines, sourceLineIndex)
  const shifted = removed.map((line) => {
    if (delta === 0 || line.trim() === '') return line
    if (delta > 0) return ' '.repeat(delta * TOC_INDENT_SPACES) + line
    const cut = Math.min(-delta * TOC_INDENT_SPACES, line.length - line.trimStart().length)
    return line.slice(cut)
  })

  // Target line may have shifted after removal.
  const adjustedTarget = targetLineIndex >= end ? targetLineIndex - (end - start) : targetLineIndex
  return insertLinesRelative(withoutSource, adjustedTarget, shifted, placement)
}

/** Set the checkbox state of a note line. */
export function setNoteDoneLine(lines: string[], noteIndex: string, done: boolean): string[] {
  const lineIndex = findNoteLineIndex(lines, noteIndex)
  const parsed = parseTocLine(lines[lineIndex])
  const result = [...lines]
  result[lineIndex] = buildNoteLine(parsed.noteIndex!, parsed.title ?? '', done, parsed.indentLevel)
  return result
}

/** Rewrite a note line's title (after rename). */
export function setNoteTitleLine(lines: string[], noteIndex: string, title: string): string[] {
  const lineIndex = findNoteLineIndex(lines, noteIndex)
  const parsed = parseTocLine(lines[lineIndex])
  const result = [...lines]
  result[lineIndex] = buildNoteLine(parsed.noteIndex!, title, parsed.done, parsed.indentLevel)
  return result
}

/** Rewrite a note line's index, keeping its title, checkbox and indent. */
export function setNoteIndexLine(lines: string[], noteIndex: string, nextIndex: string): string[] {
  const lineIndex = findNoteLineIndex(lines, noteIndex)
  const parsed = parseTocLine(lines[lineIndex])
  const result = [...lines]
  result[lineIndex] = buildNoteLine(nextIndex, parsed.title ?? '', parsed.done, parsed.indentLevel)
  return result
}

/** Collapse blank lines sitting between two TOC content lines. */
export function normalizeTocBlankLines(lines: string[]): string[] {
  const result: string[] = []
  let previousBlank = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() !== '') {
      result.push(line)
      previousBlank = false
      continue
    }
    const prev = lines[i - 1]
    const next = lines[i + 1]
    if (
      prev !== undefined &&
      next !== undefined &&
      parseTocLine(prev).kind !== 'unknown' &&
      parseTocLine(next).kind !== 'unknown'
    ) {
      continue
    }
    if (!previousBlank) {
      result.push(line)
      previousBlank = true
    }
  }
  return result
}
