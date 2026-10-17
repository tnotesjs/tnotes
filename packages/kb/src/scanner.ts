/**
 * src/scanner.ts
 *
 * Read-only scan of a knowledge base: notes/ files, TOC.md, tnotes.json,
 * joined into a snapshot with diagnostics.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { CONFIG_FILE, isRemoteIconSrc, NOTE_FILE_REGEX, NOTES_DIR, TOC_FILE } from './constants'
import { parseNoteContent } from './frontmatter'
import { flattenTocLines, parseTocToTree } from './toc'

import type { KbConfig, KbDiagnostic, KbSnapshot, NoteMeta, TocNode } from './types'

export function contentRevision(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

export interface ScannedNoteFile {
  index: string
  title: string
  fileName: string
  relPath: string
  frontmatter: NoteMeta['frontmatter']
}

/** List and parse note files under notes/ (non-recursive by design). */
export async function scanNoteFiles(rootPath: string): Promise<ScannedNoteFile[]> {
  const notesDir = path.join(rootPath, NOTES_DIR)
  let entries: string[]
  try {
    entries = await fs.readdir(notesDir)
  } catch {
    return []
  }

  const notes: ScannedNoteFile[] = []
  for (const entry of entries.sort()) {
    const match = entry.match(NOTE_FILE_REGEX)
    if (!match) continue
    const relPath = `${NOTES_DIR}/${entry}`
    let frontmatter: NoteMeta['frontmatter'] = {}
    try {
      const content = await fs.readFile(path.join(rootPath, relPath), 'utf8')
      frontmatter = parseNoteContent(content).frontmatter
    } catch {
      // Unreadable file — surfaced as missing-note-id diagnostics downstream.
    }
    notes.push({
      index: match[1],
      title: match[2]?.trim() ?? '',
      fileName: entry,
      relPath,
      frontmatter
    })
  }
  return notes
}

export async function readTocLines(rootPath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(path.join(rootPath, TOC_FILE), 'utf8')
    return content.split('\n')
  } catch {
    return []
  }
}

export async function readKbConfig(
  rootPath: string
): Promise<{ config: KbConfig; diagnostic: KbDiagnostic | null }> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(rootPath, CONFIG_FILE), 'utf8')
  } catch {
    return { config: {}, diagnostic: null }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const config = parsed as KbConfig
      const src = config.icon?.src
      if (typeof src === 'string' && isRemoteIconSrc(src)) {
        const icon = { ...config.icon }
        delete icon.src
        config.icon = icon
      }
      return { config, diagnostic: null }
    }
    throw new Error('not an object')
  } catch {
    return {
      config: {},
      diagnostic: {
        code: 'invalid-config',
        message: `${CONFIG_FILE} 不是合法的 JSON 对象`,
        severity: 'error',
        path: CONFIG_FILE
      }
    }
  }
}

/** Join note files with TOC entries into a snapshot. */
export function buildSnapshot(input: {
  rootPath: string
  config: KbConfig
  configDiagnostic: KbDiagnostic | null
  noteFiles: ScannedNoteFile[]
  tocLines: string[]
}): KbSnapshot {
  const { rootPath, config, configDiagnostic, noteFiles, tocLines } = input
  const diagnostics: KbDiagnostic[] = configDiagnostic ? [configDiagnostic] : []

  const flat = flattenTocLines(tocLines)
  const tocByIndex = new Map<string, { done: boolean; groupPath: string[]; lineIndex: number }>()
  for (const entry of flat) {
    if (entry.kind !== 'note') continue
    if (tocByIndex.has(entry.noteIndex!)) {
      diagnostics.push({
        code: 'duplicate-index',
        message: `TOC.md 中笔记编号重复: ${entry.noteIndex}`,
        severity: 'error',
        path: TOC_FILE
      })
      continue
    }
    tocByIndex.set(entry.noteIndex!, {
      done: entry.done ?? false,
      groupPath: entry.groupPath,
      lineIndex: entry.lineIndex
    })
  }

  const seenIndexes = new Map<string, string>()
  const notes: NoteMeta[] = []
  for (const file of noteFiles) {
    const existing = seenIndexes.get(file.index)
    if (existing) {
      diagnostics.push({
        code: 'duplicate-index',
        message: `笔记编号重复: ${file.index}（${existing}、${file.fileName}）`,
        severity: 'error',
        path: file.relPath
      })
      continue
    }
    seenIndexes.set(file.index, file.fileName)

    if (!file.title) {
      diagnostics.push({
        code: 'missing-title',
        message: `笔记文件缺少标题: ${file.fileName}（应为「${file.index}. 标题.md」）`,
        severity: 'warning',
        path: file.relPath
      })
    }
    if (!file.frontmatter.id) {
      diagnostics.push({
        code: 'missing-note-id',
        message: `笔记缺少 frontmatter id（评论映射键）: ${file.fileName}`,
        severity: 'info',
        path: file.relPath
      })
    }

    const tocEntry = tocByIndex.get(file.index)
    if (!tocEntry) {
      diagnostics.push({
        code: 'file-missing-from-toc',
        message: `笔记未收录进 TOC.md: ${file.fileName}`,
        severity: 'warning',
        path: file.relPath
      })
    }
    notes.push({
      index: file.index,
      title: file.title,
      fileName: file.fileName,
      relPath: file.relPath,
      frontmatter: file.frontmatter,
      done: tocEntry?.done ?? false,
      inToc: tocEntry !== undefined,
      groupPath: tocEntry?.groupPath ?? []
    })
  }

  for (const [index] of tocByIndex) {
    if (!seenIndexes.has(index)) {
      diagnostics.push({
        code: 'toc-entry-missing-file',
        message: `TOC.md 引用了不存在的笔记文件: ${index}`,
        severity: 'error',
        path: TOC_FILE
      })
    }
  }

  const toc: TocNode[] = parseTocToTree(tocLines)
  const revision = createHash('sha256')
    .update(JSON.stringify(config))
    .update('\n')
    .update(tocLines.join('\n'))
    .update('\n')
    .update(noteFiles.map((n) => n.fileName).join('\n'))
    .digest('hex')

  return { rootPath, config, toc, notes, diagnostics, revision }
}

/** Full scan of a knowledge base root. */
export async function scanKnowledgeBase(rootPath: string): Promise<KbSnapshot> {
  const [noteFiles, tocLines, { config, diagnostic }] = await Promise.all([
    scanNoteFiles(rootPath),
    readTocLines(rootPath),
    readKbConfig(rootPath)
  ])
  return buildSnapshot({
    rootPath,
    config,
    configDiagnostic: diagnostic,
    noteFiles,
    tocLines
  })
}
