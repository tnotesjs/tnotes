/**
 * src/pages.ts
 *
 * kb-driven page discovery: notes/*.md become routes, TOC.md becomes the
 * sidebar, and the home page is the configured (or first) TOC note.
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

/** First note in TOC order (used as the default home page). */
function firstTocNoteIndex(nodes: TocNode[]): string | undefined {
  for (const node of nodes) {
    if (node.kind === 'note') return node.index
    const nested = firstTocNoteIndex(node.children)
    if (nested) return nested
  }
  return undefined
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

  // Home page: configured note, else the first TOC note, else a placeholder.
  const homeIndex =
    (config.home && noteByIndex.has(config.home) ? config.home : undefined) ??
    firstTocNoteIndex(snapshot.toc)
  const homePage = pages.find((page) => page.noteIndex === homeIndex)
  if (homePage) {
    pages.unshift({ ...homePage, route: '/' })
  } else {
    pages.unshift({
      file: path.join(config.cacheDir, 'index.md'),
      route: '/',
      source: `# ${config.title}\n`,
      titleHint: config.title,
      noteIndex: ''
    })
  }

  return {
    pages,
    sidebar: toSidebarItems(snapshot.toc, noteByIndex),
    snapshot
  }
}
