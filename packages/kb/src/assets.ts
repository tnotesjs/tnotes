/**
 * src/assets.ts
 *
 * Library-level assets/ management: add (with name dedup), list, and
 * garbage-collect files not referenced from any note body.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  ASSETS_DIR,
  KB_ICON_EXTENSIONS,
  KB_ICON_FILE_BASENAME,
  isKbIconFileName,
  NOTES_DIR
} from './constants'
import { writeFileAtomic } from './atomic'
import { findReusableAsset } from './asset-scan/dedupe'
import { ownerNoteIndexFromName } from './asset-scan/owner'

import type { AssetEntry, KbIcon } from './types'

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
  '.ico'
])

/** Markdown reference to an asset, e.g. ../assets/a.png or /assets/a.png. */
const ASSET_REF_REGEX = /(?:\.\.\/|\.\/|\/)assets\/([^\s)"'<>]+)/g

const KB_ICON_EXT_SET = new Set<string>(KB_ICON_EXTENSIONS)

function dedupeFileName(existing: Set<string>, fileName: string): string {
  if (!existing.has(fileName)) return fileName
  const ext = path.posix.extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!existing.has(candidate)) return candidate
  }
}

async function walkAssets(dir: string, prefix: string): Promise<AssetEntry[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: AssetEntry[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Hidden files are the kb's own bookkeeping (and, before 0.5.2, the icon).
    // The icon is a visible file now, so a dot is enough to skip an entry.
    if (entry.name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await walkAssets(full, rel)))
    } else if (entry.isFile()) {
      const stat = await fs.stat(full)
      result.push({ name: entry.name, relPath: `${ASSETS_DIR}/${rel}`, size: stat.size })
    }
  }
  return result
}

export async function listAssets(rootPath: string): Promise<AssetEntry[]> {
  return walkAssets(path.join(rootPath, ASSETS_DIR), '')
}

/**
 * Write an asset into assets/, deduping the file name. Returns the kb-relative
 * path and the markdown reference to paste into a note (`../assets/...`).
 */
export async function addAsset(
  rootPath: string,
  fileName: string,
  data: Uint8Array
): Promise<{ relPath: string; markdownPath: string; reused: boolean }> {
  const baseName = path.basename(fileName)
  const ownerNoteIndex = ownerNoteIndexFromName(baseName)
  if (ownerNoteIndex) {
    const listed = await listAssets(rootPath)
    const reused = await findReusableAsset({
      rootPath,
      data,
      fileName: baseName,
      ownerNoteIndex,
      assets: listed
    })
    if (reused) {
      return { relPath: reused.relPath, markdownPath: `../${reused.relPath}`, reused: true }
    }
  }
  const assetsDir = path.join(rootPath, ASSETS_DIR)
  await fs.mkdir(assetsDir, { recursive: true })
  const existing = new Set(await fs.readdir(assetsDir))
  const finalName = dedupeFileName(existing, baseName)
  const relPath = `${ASSETS_DIR}/${finalName}`
  await writeFileAtomic(path.join(rootPath, relPath), data)
  return { relPath, markdownPath: `../${relPath}`, reused: false }
}

function normalizeIconExt(ext: string): string {
  const withDot = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  if (withDot === '.jpeg') return '.jpg'
  return withDot
}

/**
 * Delete every knowledge-base icon file — the current name and the pre-0.5.2
 * `.tn-kb-icon.*` spelling, so an upgrade does not leave the old hidden file
 * behind (nothing serves it, but it would sit in `assets/` forever).
 */
export async function clearKbIcon(rootPath: string): Promise<{ deleted: string[] }> {
  const assetsDir = path.join(rootPath, ASSETS_DIR)
  const deleted: string[] = []
  let entries: string[] = []
  try {
    entries = await fs.readdir(assetsDir)
  } catch {
    return { deleted }
  }
  for (const name of entries) {
    if (!isKbIconFileName(name)) continue
    const relPath = `${ASSETS_DIR}/${name}`
    await fs.rm(path.join(rootPath, relPath), { force: true })
    deleted.push(relPath)
  }
  return { deleted }
}

/**
 * Replace the knowledge-base icon with a fixed filename so repeated uploads
 * do not pile up historical icon assets.
 */
export async function replaceKbIcon(
  rootPath: string,
  ext: string,
  data: Uint8Array
): Promise<{ relPath: string; markdownPath: string; icon: KbIcon; deleted: string[] }> {
  const normalized = normalizeIconExt(ext)
  if (!KB_ICON_EXT_SET.has(normalized as (typeof KB_ICON_EXTENSIONS)[number])) {
    throw new Error(`不支持的知识库图标扩展名: ${ext}`)
  }
  const writeExt = normalized
  const { deleted } = await clearKbIcon(rootPath)
  const assetsDir = path.join(rootPath, ASSETS_DIR)
  await fs.mkdir(assetsDir, { recursive: true })
  const fileName = `${KB_ICON_FILE_BASENAME}${writeExt}`
  const relPath = `${ASSETS_DIR}/${fileName}`
  await writeFileAtomic(path.join(rootPath, relPath), data)
  const markdownPath = `../${relPath}`
  return {
    relPath,
    markdownPath,
    icon: { src: markdownPath },
    deleted
  }
}

/** Collect asset references from all note bodies. */
export async function collectAssetReferences(rootPath: string): Promise<Set<string>> {
  const refs = new Set<string>()
  let noteFiles: string[] = []
  try {
    noteFiles = await fs.readdir(path.join(rootPath, NOTES_DIR))
  } catch {
    return refs
  }
  for (const file of noteFiles) {
    if (!file.endsWith('.md')) continue
    const content = await fs.readFile(path.join(rootPath, NOTES_DIR, file), 'utf8')
    for (const match of content.matchAll(ASSET_REF_REGEX)) {
      refs.add(`${ASSETS_DIR}/${match[1]}`)
    }
  }
  return refs
}

export interface AssetsGcResult {
  /** kb-relative paths of assets not referenced by any note. */
  unreferenced: string[]
  deleted: string[]
}

/**
 * Find (and optionally delete) assets not referenced from any note.
 *
 * Scan is limited: `notes/` top-level `.md` only, whole-file regex, immediate
 * `fs.rm` when `delete: true`. Do not use as the safety basis for the resource
 * panel; new cleanup must go through analyze + operation plans.
 */
export async function gcAssets(
  rootPath: string,
  options: { delete?: boolean } = {}
): Promise<AssetsGcResult> {
  const [assets, refs] = await Promise.all([listAssets(rootPath), collectAssetReferences(rootPath)])
  const unreferenced = assets
    .map((a) => a.relPath)
    .filter((relPath) => {
      if (isKbIconFileName(path.posix.basename(relPath))) return false
      return !refs.has(relPath)
    })
  const deleted: string[] = []
  if (options.delete) {
    for (const relPath of unreferenced) {
      await fs.rm(path.join(rootPath, relPath), { force: true })
      deleted.push(relPath)
    }
  }
  return { unreferenced, deleted }
}

export function isImageFileName(fileName: string): boolean {
  return IMAGE_EXTENSIONS.has(path.posix.extname(fileName).toLowerCase())
}
