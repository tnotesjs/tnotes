/**
 * Note-owned asset filenames use a four-digit note index prefix: `0008-…`.
 * KB icons and historical files without a prefix have no merge/reuse owner.
 */

import path from 'node:path'

import { isKbIconFileName } from '../constants'

const OWNER_PREFIX = /^(\d{4})-/
const REUSE_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
  '.ico',
  '.bmp'
])

export function ownerNoteIndexFromName(fileName: string): string | null {
  const match = OWNER_PREFIX.exec(fileName)
  return match ? match[1] : null
}

/** 根目录 README.md 自己的资源：`README-…`。 */
export const README_ASSET_OWNER = 'README'
const README_OWNER_PREFIX = /^README-/

/**
 * 资源归属：笔记是四位编号，README 是 `README`。复用、合并按它分组；
 * 画布等只属于笔记的东西仍用 `ownerNoteIndexFromName`。
 */
export function assetOwnerFromName(fileName: string): string | null {
  if (README_OWNER_PREFIX.test(fileName)) return README_ASSET_OWNER
  return ownerNoteIndexFromName(fileName)
}

export function normalizeAssetExt(fileName: string): string {
  const ext = path.posix.extname(fileName).toLowerCase()
  return ext === '.jpeg' ? '.jpg' : ext
}

export function isContentReusableAsset(fileName: string): boolean {
  if (isKbIconFileName(fileName)) return false
  if (fileName.toLowerCase().endsWith('.excalidraw')) return false
  return REUSE_EXT.has(path.posix.extname(fileName).toLowerCase())
}

export function compatibleAssetTypes(left: string, right: string): boolean {
  return isContentReusableAsset(left) && normalizeAssetExt(left) === normalizeAssetExt(right)
}
