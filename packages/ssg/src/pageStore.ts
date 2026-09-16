import path from 'node:path'
import matter from 'gray-matter'

import type { SourcePage } from './pages'
import type { PageData, ResolvedSsgConfig, SidebarItem } from './types'
import type { NoteRef } from './noteRoute'

/** Page modules are virtual ids ending in `.vue` so plugin-vue compiles them. */
export const PAGE_ID_PREFIX = 'virtual:tnotes-page:'

export function pageModuleId(route: string): string {
  return `${PAGE_ID_PREFIX}${encodeURIComponent(route)}.vue`
}

export function parsePageModuleId(id: string): string | undefined {
  if (!id.startsWith(PAGE_ID_PREFIX) || !id.endsWith('.vue')) return undefined
  return decodeURIComponent(id.slice(PAGE_ID_PREFIX.length, -'.vue'.length))
}

/** Mutable session shared by the Vite plugin, SSR loop, and on-demand dev. */
export class PageSourceStore {
  catalog: Record<string, PageData> = {}
  sidebar: SidebarItem[] = []
  notes: NoteRef[] = []
  private vue = new Map<string, string>()
  private compiled = new Map<string, PageData>()
  private html = new Map<string, string>()
  private userSfc = new Set<string>()

  setCompiled(route: string, vueSource: string, data: PageData, html: string, hasUserSfc: boolean) {
    this.compiled.set(route, data)
    this.html.set(route, html)
    if (hasUserSfc) {
      this.vue.set(route, vueSource)
      this.userSfc.add(route)
    } else {
      this.vue.delete(route)
      this.userSfc.delete(route)
    }
  }

  getVue(route: string) {
    return this.vue.get(route)
  }

  getCompiledData(route: string) {
    return this.compiled.get(route)
  }

  getHtml(route: string) {
    return this.html.get(route)
  }

  hasUserSfc(route: string) {
    return this.userSfc.has(route)
  }

  dropVue(route: string) {
    this.vue.delete(route)
    this.compiled.delete(route)
    this.html.delete(route)
    this.userSfc.delete(route)
  }

  dropAllVue() {
    this.vue.clear()
    this.compiled.clear()
    this.html.clear()
    this.userSfc.clear()
  }
}

/**
 * NotesTable and chrome only need titles / descriptions / routes — not body
 * text. Built from raw markdown so we never keep every vueSource at once.
 */
export function catalogFromPages(
  config: ResolvedSsgConfig,
  pages: SourcePage[]
): Record<string, PageData> {
  const catalog: Record<string, PageData> = {}
  for (const page of pages) {
    const parsed = matter(page.source)
    const relativePath = path.relative(config.root, page.file).replaceAll('\\', '/')
    catalog[page.route] = {
      route: page.route,
      relativePath,
      title: page.titleHint,
      description: String(parsed.data.description ?? ''),
      headings: [],
      text: '',
      frontmatter: parsed.data
    }
  }
  return catalog
}

export function slimPageData(data: PageData): PageData {
  return {
    route: data.route,
    relativePath: data.relativePath,
    title: data.title,
    description: data.description,
    // Kept, unlike the rest of the frontmatter: the comments component keys its
    // discussion off this, and it is the only frontmatter field the browser needs.
    noteId: data.noteId,
    // The copy button needs the note itself; the rendered HTML cannot stand in
    // for it.
    source: data.source,
    headings: data.headings,
    text: '',
    frontmatter: {}
  }
}
