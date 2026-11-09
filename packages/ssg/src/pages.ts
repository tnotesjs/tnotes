/**
 * src/pages.ts
 *
 * kb-driven page discovery: notes/*.md become routes, TOC.md becomes the
 * sidebar, and `/` is always the kb home: the heatmap plus README.md when
 * that file has text. `tnotes.json` `home` does not choose this page.
 */

import fs from 'node:fs'
import path from 'node:path'
import { scanKnowledgeBase } from '@tnotesjs/kb'

import type { KbSnapshot, TocNode } from '@tnotesjs/kb'
import { canonicalNoteRoute } from './noteRoute'
import type { ResolvedSsgConfig, SidebarItem } from './types'

export interface SourcePage {
  file: string
  route: string
  source: string
  /** Note title from the file name — wins over frontmatter/H1. */
  titleHint: string
  /** Note index ("0001") for notes; empty for synthesized pages. */
  noteIndex: string
}

export interface CollectedSite {
  pages: SourcePage[]
  sidebar: SidebarItem[]
  snapshot: KbSnapshot
}

/** Sidebar row for `/`. Always first, above the TOC. */
export const HOME_SIDEBAR_TEXT = '首页'

/** Note counts and source length. Computed while the notes are already in memory. */
export interface NoteCorpusStats {
  noteCount: number
  charCount: number
}

export function noteCorpusStats(
  notes: ReadonlyArray<unknown>,
  pages: ReadonlyArray<{ noteIndex: string; source: string }>
): NoteCorpusStats {
  let charCount = 0
  for (const page of pages) if (page.noteIndex) charCount += page.source.length
  return { noteCount: notes.length, charCount }
}

export function noteRoute(index: string): string {
  return canonicalNoteRoute(index)
}

export function routeToOutput(route: string) {
  if (route === '/') return 'index.html'
  return `${route.slice(1)}.html`
}

function toSidebarItems(
  nodes: TocNode[],
  noteByIndex: ReadonlyMap<string, { title: string; fileName: string }>
): SidebarItem[] {
  const items: SidebarItem[] = []
  for (const node of nodes) {
    if (node.kind === 'group') {
      items.push({
        text: node.title,
        items: toSidebarItems(node.children, noteByIndex)
      })
      continue
    }
    const note = noteByIndex.get(node.index)
    if (!note) continue
    items.push({
      text: note.title,
      index: node.index,
      done: node.done,
      link: noteRoute(node.index),
      items: toSidebarItems(node.children, noteByIndex)
    })
  }
  return items
}

export async function collectSite(config: ResolvedSsgConfig): Promise<CollectedSite> {
  const snapshot = await scanKnowledgeBase(config.root)
  const noteByIndex = new Map(
    snapshot.notes.map((note) => [note.index, { title: note.title, fileName: note.fileName }])
  )

  const pages: SourcePage[] = []
  for (const note of snapshot.notes) {
    pages.push({
      file: path.join(config.root, note.relPath),
      route: noteRoute(note.index),
      source: fs.readFileSync(path.join(config.root, note.relPath), 'utf8'),
      titleHint: note.title,
      noteIndex: note.index
    })
  }

  // `/` is the kb home. README body follows the heatmap when the file has text.
  // A configured `home` note stays at its own `/notes/{n}` route.
  const sidebar = toSidebarItems(snapshot.toc, noteByIndex)
  const readmeFile = path.join(config.root, 'README.md')
  const readme = readNonEmpty(readmeFile)
  pages.unshift({
    file: readme ? readmeFile : path.join(config.cacheDir, 'index.md'),
    route: '/',
    source: readme,
    titleHint: config.title,
    noteIndex: ''
  })
  sidebar.unshift({ text: HOME_SIDEBAR_TEXT, link: '/' })

  return {
    pages,
    sidebar,
    snapshot
  }
}

function readNonEmpty(file: string): string {
  try {
    const source = fs.readFileSync(file, 'utf8')
    return source.trim() ? source : ''
  } catch {
    return ''
  }
}
