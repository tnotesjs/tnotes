/**
 * src/constants.ts
 *
 * New-architecture knowledge-base layout constants and grammar.
 */

export const NOTES_DIR = 'notes'
export const ASSETS_DIR = 'assets'
export const TOC_FILE = 'TOC.md'
export const CONFIG_FILE = 'tnotes.json'

/**
 * Fixed basename for the knowledge-base icon (extension varies).
 *
 * Deliberately not a dotfile: this file is written to `assets/`, which the SSG
 * copies verbatim into the site, and a leading dot is not served by every static
 * host — GitHub Pages answers such a path with 404 while serving the same
 * directory's ordinary files, which would leave the site's favicon broken.
 */
export const KB_ICON_FILE_BASENAME = 'kb-icon'

/**
 * Basenames the knowledge-base icon has used. `.tn-kb-icon` is the pre-0.5.2
 * spelling; it stays listed so old icons are still recognised as the kb icon
 * (and cleaned up) after an upgrade.
 */
export const KB_ICON_BASENAMES = [KB_ICON_FILE_BASENAME, '.tn-kb-icon'] as const

/** True when `fileName` is the knowledge-base icon rather than a normal asset. */
export function isKbIconFileName(fileName: string): boolean {
  return KB_ICON_BASENAMES.some((basename) => fileName.startsWith(basename))
}

/** Allowed extensions for knowledge-base icon uploads. */
export const KB_ICON_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif'] as const

/** Default site-preview / SSG port when `tnotes.json` omits `port`. */
export const DEFAULT_PREVIEW_PORT = 9193

/** GitHub repository name rules. */
export const KB_NAME_REGEX = /^[A-Za-z0-9._-]{1,100}$/

/**
 * Note file name: `0001. 标题.md`. The 4-digit index is the stable ID and is
 * never reused or renumbered. A missing title is tolerated by the scanner but
 * reported as a diagnostic.
 */
export const NOTE_FILE_REGEX = /^(\d{4})(?:\.\s*(.+?))?\.md$/

/** Spaces per indent level in TOC.md. */
export const TOC_INDENT_SPACES = 2

/** Canonical note line: `- [x] 0001. 标题` / `- [ ] 0001`. */
export const TOC_NOTE_LINE_REGEX = /^( *)(-\s+\[(x|X| )\])\s+(\d{4})(?:\.\s*(.*?))?\s*$/

/** Group line: `- 标题` (no checkbox). */
export const TOC_GROUP_LINE_REGEX = /^( *)(-\s+(?!\[(?:x|X| )\]).+?)\s*$/

/** Frontmatter whitelist — everything else is stripped by migrations. */
export const FRONTMATTER_KEYS = ['id', 'description'] as const
