import type { LineBreakMode } from '@tnotesjs/ui/line-breaks'

/**
 * One row of the TOC sidebar. Notes carry `index`/`done` as separate fields
 * rather than being baked into `text`: the row renders them as a status dot
 * and a muted index, so the title stays the primary visual element.
 */
export interface SidebarItem {
  text: string
  link?: string
  items?: SidebarItem[]
  /** 4-digit note index ("0001"); absent on TOC group headings. */
  index?: string
  /** TOC checkbox state; absent on TOC group headings. */
  done?: boolean
}

export interface PageHeading {
  text: string
  level: number
  id: string
}

export interface PageData {
  route: string
  relativePath: string
  title: string
  description: string
  /**
   * Frontmatter `id` (a UUID): the note's stable identity, and the key its
   * comments hang off. Present on every note; absent on generated pages such as
   * the 404, which have no discussion to map to.
   */
  noteId?: string
  headings: PageHeading[]
  text: string
  frontmatter: Record<string, unknown>
  /**
   * The note file verbatim, frontmatter included — what the copy button puts on
   * the clipboard. Present on every page (the 404 is a page too); it is the
   * toolbar that decides whether a page is a note.
   */
  source?: string
}

export interface MarkdownConfig {
  lineNumbers: boolean
  math: boolean
  imageLazyLoading: boolean
  /** `visual`: single newline → `<br>`, extra blank lines kept as spacers. */
  lineBreaks: LineBreakMode
}

/**
 * Site configuration — sourced from tnotes.json (kb-level config).
 * Unknown tnotes.json keys are preserved by @tnotesjs/kb but ignored here.
 */
export interface SsgConfig {
  /** Stable kb UUID. Sites use it to open this kb in Desk. */
  id?: string
  /** Deploy base path, e.g. "/TNotes.vite/". Defaults to "/". */
  base?: string
  title?: string
  description?: string
  lang?: string
  port?: number
  /**
   * Kept so older `tnotes.json` files still parse. The site home is always `/`
   * (heatmap, then README.md when that file has text) and does not follow this.
   */
  home?: string
  /** Git repository this kb lives in; the site's title links to it. */
  repositoryUrl?: string
  /** Site icon the kb declares; rendered as the page's favicon. */
  icon?: { src: string }
  /** kb-level comments switch (giscus) — reserved, comments ship later. */
  discussions?: boolean
  ignoreDeadLinks?: boolean | string[]
  head?: Array<[string, Record<string, string>, string?]>
  /** Optional theme module (must default-export { enhanceApp? }). */
  theme?: string
  markdown?: Partial<MarkdownConfig>
}

export interface ResolvedSsgConfig {
  root: string
  outDir: string
  cacheDir: string
  publicDir: string
  base: string
  title: string
  description: string
  lang: string
  port: number
  home?: string
  kbId?: string
  repositoryUrl?: string
  icon?: { src: string }
  discussions: boolean
  ignoreDeadLinks: boolean | string[]
  head: Array<[string, Record<string, string>, string?]>
  theme?: string
  markdown: MarkdownConfig
}

export interface SiteNoteRef {
  index: string
  id?: string
}

/** The serialized `virtual:tnotes-site` payload available to the client. */
export interface SiteCompletionStats {
  byYear: Record<
    string,
    Record<string, Record<string, { delta: number; total: number; commits?: number }>>
  >
}

export interface SiteData {
  base: string
  title: string
  description: string
  lang: string
  repositoryUrl?: string
  kbId?: string
  discussions: boolean
  sidebar: SidebarItem[]
  markdown: MarkdownConfig
  notes: SiteNoteRef[]
  /** Derived from tnotes.stats.json when present. */
  completionStats: SiteCompletionStats | null
  /** Note completion and source length. Computed for this build or dev session. */
  corpus: { noteCount: number; charCount: number }
  /** Demo folders that have a `demos.json` entry. Titles come from the folder name. */
  demos: Array<{ id: string; title: string; description: string }>
}
