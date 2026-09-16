/**
 * src/types.ts
 *
 * Public types for the single-file knowledge-base workspace.
 */

/** Frontmatter whitelist fields of a single-file note. */
export interface NoteFrontmatter {
  /** UUID — stable machine key, currently the giscus comment mapping term. */
  id?: string
  /** Shown by NotesTable blocks; future SEO description. */
  description?: string
}

/** A note as seen by the scanner (file + frontmatter + TOC placement). */
export interface NoteMeta {
  /** 4-digit stable ID, e.g. "0001". */
  index: string
  /** Title from the file name (`0001. 标题.md`). */
  title: string
  /** File name inside notes/, e.g. "0001. 标题.md". */
  fileName: string
  /** POSIX path relative to the kb root, e.g. "notes/0001. 标题.md". */
  relPath: string
  frontmatter: NoteFrontmatter
  /** Completion state — owned by the TOC checkbox. */
  done: boolean
  /** Whether the note appears in TOC.md. */
  inToc: boolean
  /** Group titles from root to the note's immediate parent. */
  groupPath: string[]
}

/** TOC tree node. Notes may nest children (yuque-style parent notes). */
export type TocNode = TocGroupNode | TocNoteNode

export interface TocGroupNode {
  kind: 'group'
  title: string
  /** 0-based line number in TOC.md (drag/CRUD key). */
  lineIndex: number
  children: TocNode[]
}

export interface TocNoteNode {
  kind: 'note'
  index: string
  done: boolean
  /** 0-based line number in TOC.md (drag/CRUD key). */
  lineIndex: number
  children: TocNode[]
}

/** Knowledge-base icon. Prefer at most one of src / svg / letter. */
export interface KbIcon {
  /** Markdown- or kb-relative image path, e.g. `../assets/kb-icon.png`. */
  src?: string
  /** Inline SVG markup. */
  svg?: string
  /** Single display character when no image is set. */
  letter?: string
}

/** Optional completion-trend statistics (populated by `tnotes-kb update`). */
export interface KbStats {
  /** When false/undefined, update skips rewriting counts. Default off. */
  enabled?: boolean
  /** Monthly completed-note counts keyed by `YY.MM` (deduped by note index). */
  completedNotesCount?: Record<string, number>
}

/** tnotes.json — kb-level configuration. Unknown keys are preserved. */
export interface KbConfig {
  /**
   * GitHub-style repository name (`^[A-Za-z0-9._-]{1,100}$`).
   * Does not rename the on-disk folder.
   */
  name?: string
  /** Display name in Desk's KB list. Falls back to `name` / directory name. */
  title?: string
  description?: string
  icon?: KbIcon
  /** Git clone / GitHub URL. */
  repositoryUrl?: string
  /** Root-library URL (collection TBD). */
  rootUrl?: string
  /** Site preview / SSG port. Defaults to 9193. */
  port?: number
  /** Public deploy URL (e.g. GitHub Pages). */
  pageUrl?: string
  stats?: KbStats
  /** Deploy base path, e.g. "/TNotes.vite/". Defaults to "/". */
  base?: string
  /** Note index used as the site home page. Defaults to the first TOC note. */
  home?: string
  /** kb-level comments switch (giscus). */
  discussions?: boolean
  /**
   * Save-time Prettier formatting convention for this repo. When set, it
   * overrides the app-level default (Desk 全局设置)。
   */
  prettier?: boolean
  /**
   * Auto commit+push convention for this repo (Desk)。随仓库走，协作者/CI 一致。
   */
  autoPush?: { enabled: boolean; idleMinutes: number }
  /**
   * Heading numbering depth cap (1–6) for this repo (Desk 标题编号)。
   * 超过该层级的标题不加编号前缀。
   */
  headingNumberMaxDepth?: number
  [key: string]: unknown
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface KbDiagnostic {
  code:
    | 'toc-entry-missing-file'
    | 'file-missing-from-toc'
    | 'duplicate-index'
    | 'missing-title'
    | 'missing-note-id'
    | 'invalid-config'
    | 'invalid-toc'
  message: string
  severity: DiagnosticSeverity
  path?: string
}

export interface KbSnapshot {
  rootPath: string
  config: KbConfig
  toc: TocNode[]
  notes: NoteMeta[]
  diagnostics: KbDiagnostic[]
  /** Hash over config + TOC + file listing; changes on any structural edit. */
  revision: string
}

/** A note with its full content. */
export interface NoteDoc extends NoteMeta {
  /** Markdown body without the frontmatter block. */
  body: string
  /** Full file content (frontmatter + body). */
  content: string
  /** sha256 of content — used for optimistic conflict detection. */
  revision: string
}

export interface ChangedFile {
  /** POSIX path relative to the kb root. */
  path: string
  kind: 'created' | 'updated' | 'deleted' | 'renamed'
  previousPath?: string
}

export interface MutationResult<T> {
  value: T
  changedFiles: ChangedFile[]
}

/** Where to place a new note/group inside the TOC. */
export type Placement =
  | { type: 'root'; placement?: 'start' | 'end' }
  | { type: 'note'; targetIndex: string; placement: 'before' | 'after' | 'inside' }
  | { type: 'group'; groupPath: string[]; placement: 'before' | 'after' | 'inside' }

export type TocEntryRef = { type: 'note'; index: string } | { type: 'group'; groupPath: string[] }

export interface AssetEntry {
  /** File name inside assets/. */
  name: string
  /** POSIX path relative to the kb root, e.g. "assets/pic/a.png". */
  relPath: string
  size: number
}
