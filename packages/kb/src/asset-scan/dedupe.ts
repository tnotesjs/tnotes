/**
 * Content-hash index for same-note reuse and duplicate grouping.
 * mtime/size only skip rehashing; callers re-verify bytes before merge/reuse.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { hashBytes, hashFile } from './hash'
import { compatibleAssetTypes, isContentReusableAsset, assetOwnerFromName } from './owner'

import type { AssetDuplicateGroup, AssetRecord, AssetScanReport } from './types'

export { hashBytes }

export interface AssetHashCacheFile {
  version: 1
  entries: Record<string, { size: number; mtimeMs: number; sha256: string }>
}

export async function readHashCache(cachePath: string | undefined): Promise<AssetHashCacheFile> {
  if (!cachePath) return { version: 1, entries: {} }
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as AssetHashCacheFile
    if (parsed.version !== 1 || !parsed.entries) return { version: 1, entries: {} }
    return parsed
  } catch {
    return { version: 1, entries: {} }
  }
}

export async function writeHashCache(
  cachePath: string | undefined,
  cache: AssetHashCacheFile
): Promise<void> {
  if (!cachePath) return
  await fs.mkdir(path.dirname(cachePath), { recursive: true })
  const staged = `${cachePath}.${process.pid}.tmp`
  await fs.writeFile(staged, `${JSON.stringify(cache)}\n`)
  await fs.rename(staged, cachePath)
}

export async function hashAssetFiles(
  rootPath: string,
  assets: Array<{ relPath: string; size: number; mtimeMs: number }>,
  options: { cachePath?: string; signal?: AbortSignal; concurrency?: number } = {}
): Promise<Map<string, string>> {
  const cache = await readHashCache(options.cachePath)
  const next: AssetHashCacheFile = { version: 1, entries: {} }
  const hashes = new Map<string, string>()
  const concurrency = Math.max(1, options.concurrency ?? 4)
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < assets.length) {
      if (options.signal?.aborted) {
        const error = new Error('ASSET_SCAN_ABORTED')
        error.name = 'AbortError'
        throw error
      }
      const index = cursor
      cursor += 1
      const asset = assets[index]
      if (!asset) return
      const cached = cache.entries[asset.relPath]
      let digest = cached?.sha256
      if (!cached || cached.size !== asset.size || cached.mtimeMs !== asset.mtimeMs) {
        digest = await hashFile(path.join(rootPath, asset.relPath))
      }
      if (!digest) continue
      hashes.set(asset.relPath, digest)
      next.entries[asset.relPath] = {
        size: asset.size,
        mtimeMs: asset.mtimeMs,
        sha256: digest
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, assets.length)) }, () => worker())
  )
  await writeHashCache(options.cachePath, next)
  return hashes
}

export function duplicateGroupsFromHashes(
  records: AssetRecord[],
  hashes: Map<string, string>
): { groups: AssetDuplicateGroup[]; crossNoteDuplicateCount: number } {
  const byHash = new Map<string, string[]>()
  for (const record of records) {
    const digest = hashes.get(record.relPath)
    if (!digest) continue
    const list = byHash.get(digest) ?? []
    list.push(record.relPath)
    byHash.set(digest, list)
  }
  const groups: AssetDuplicateGroup[] = []
  let crossNoteDuplicateCount = 0
  for (const [sha256, relPaths] of byHash) {
    if (relPaths.length < 2) continue
    const byOwner = new Map<string | null, string[]>()
    for (const relPath of relPaths) {
      const owner = assetOwnerFromName(path.posix.basename(relPath))
      const list = byOwner.get(owner) ?? []
      list.push(relPath)
      byOwner.set(owner, list)
    }
    if (byOwner.size > 1) crossNoteDuplicateCount += relPaths.length
    for (const [ownerNoteIndex, owned] of byOwner) {
      if (owned.length < 2) continue
      const names = owned.map((relPath) => path.posix.basename(relPath))
      const mergeable =
        ownerNoteIndex != null &&
        names.every(isContentReusableAsset) &&
        names.every((name) => compatibleAssetTypes(name, names[0] ?? name))
      groups.push({
        sha256,
        ownerNoteIndex,
        relPaths: [...owned].sort(),
        mergeable
      })
    }
  }
  groups.sort((a, b) => a.relPaths[0].localeCompare(b.relPaths[0]))
  return { groups, crossNoteDuplicateCount }
}

export function withAssetHashes(
  report: AssetScanReport,
  hashes: Map<string, string>
): AssetScanReport {
  const { groups, crossNoteDuplicateCount } = duplicateGroupsFromHashes(report.assets, hashes)
  const groupByPath = new Map<string, string>()
  for (const group of groups) {
    for (const relPath of group.relPaths) groupByPath.set(relPath, group.sha256)
  }
  const assets = report.assets.map((asset) => ({
    ...asset,
    sha256: hashes.get(asset.relPath),
    duplicateGroupId: groupByPath.get(asset.relPath)
  }))
  return {
    ...report,
    assets,
    duplicateGroups: groups,
    stats: {
      ...report.stats,
      mergeableDuplicateCount: groups.filter((group) => group.mergeable).length,
      crossNoteDuplicateCount
    }
  }
}

export async function findReusableAsset(input: {
  rootPath: string
  data: Uint8Array
  fileName: string
  ownerNoteIndex: string
  assets: Array<{ relPath: string; name: string; size: number }>
}): Promise<{ relPath: string } | null> {
  if (!isContentReusableAsset(input.fileName)) return null
  const digest = hashBytes(input.data)
  const size = input.data.byteLength
  for (const asset of input.assets) {
    if (asset.size !== size) continue
    if (assetOwnerFromName(asset.name) !== input.ownerNoteIndex) continue
    if (!compatibleAssetTypes(asset.name, input.fileName)) continue
    const existing = hashBytes(
      new Uint8Array(await fs.readFile(path.join(input.rootPath, asset.relPath)))
    )
    if (existing === digest) return { relPath: asset.relPath }
  }
  return null
}
