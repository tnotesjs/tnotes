/**
 * Read-only asset scan: enumerate notes + README + TOC + config + nested
 * assets, classify references, follow HTML/CSS/Vue/Excalidraw, and never write
 * the knowledge base.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'

import {
  ASSETS_DIR,
  CONFIG_FILE,
  isKbIconFileName,
  NOTE_FILE_REGEX,
  NOTES_DIR,
  TOC_FILE
} from '../constants'
import { parseNoteContent } from '../frontmatter'
import { extractCssReferences } from './css'
import { extractAssetReferences, extractConfigIcon, extractHtmlFragment } from './extract'
import { extractExcalidraw } from './excalidraw'
import { addEdge, rootReachablePaths } from './graph'
import { assetFileKind } from './paths'
import { FOLLOW_SOURCE_EXT } from './specifiers'
import { extractVueSfc } from './vue'
import { hashAssetFiles, withAssetHashes } from './dedupe'
import { ownerNoteIndexFromName } from './owner'

import type {
  AssetBrokenLink,
  AssetCoverageAdapter,
  AssetDiagnostic,
  AssetRecord,
  AssetRecordStatus,
  AssetReference,
  AssetScanReport,
  AssetScanSource,
  ScanAssetsOptions
} from './types'
import type { ExtractContext, ExtractResult } from './extract'

const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', 'out', '.cache'])
const UNPARSED_SCRIPT_EXT = new Set(['.js', '.ts', '.mjs', '.cjs'])

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('ASSET_SCAN_ABORTED')
    error.name = 'AbortError'
    throw error
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results: R[] = new Array(items.length)
  let next = 0
  let processed = 0
  async function worker(): Promise<void> {
    while (true) {
      throwIfAborted(signal)
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
      processed += 1
      if (processed % 8 === 0) await yieldEventLoop()
    }
  }
  const workers = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

async function realPathInside(rootReal: string, candidate: string): Promise<boolean> {
  try {
    const real = await fs.realpath(candidate)
    return real === rootReal || real.startsWith(rootReal + path.sep)
  } catch {
    const resolved = path.resolve(candidate)
    return resolved === rootReal || resolved.startsWith(rootReal + path.sep)
  }
}

interface ListedAsset {
  relPath: string
  name: string
  size: number
  mtimeMs: number
  escaped: boolean
}

async function walkAssetFiles(
  dir: string,
  prefix: string,
  rootReal: string,
  signal?: AbortSignal
): Promise<ListedAsset[]> {
  throwIfAborted(signal)
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: ListedAsset[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    // Hidden files are the kb's own bookkeeping (and, before 0.5.2, the icon).
    // The icon is a visible file now, so a dot is enough to skip an entry.
    if (entry.name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await walkAssetFiles(full, rel, rootReal, signal)))
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const escaped = !(await realPathInside(rootReal, full))
      const stat = await fs.lstat(full)
      result.push({
        relPath: `${ASSETS_DIR}/${rel}`,
        name: entry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        escaped
      })
    }
  }
  return result
}

async function walkFollowableFiles(
  dir: string,
  prefix: string,
  rootReal: string,
  signal?: AbortSignal
): Promise<string[]> {
  throwIfAborted(signal)
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    if (entry.name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (rel === NOTES_DIR) continue
      result.push(...(await walkFollowableFiles(full, rel, rootReal, signal)))
    } else if (entry.isFile()) {
      if (!(await realPathInside(rootReal, full))) continue
      const ext = path.posix.extname(entry.name).toLowerCase()
      if (FOLLOW_SOURCE_EXT.has(ext)) result.push(rel)
    }
  }
  return result
}

async function readText(full: string): Promise<string | null> {
  try {
    return await fs.readFile(full, 'utf8')
  } catch {
    return null
  }
}

function determined(ref: AssetReference): boolean {
  return !ref.syntax.startsWith('uncertain-') && !ref.syntax.startsWith('unsupported-')
}

function sourceRoleForExt(ext: string): AssetScanSource['role'] | null {
  if (ext === '.html' || ext === '.htm') return 'html-asset'
  if (ext === '.css') return 'css-asset'
  if (ext === '.vue') return 'vue-source'
  if (ext === '.excalidraw') return 'excalidraw-asset'
  return null
}

function extractFollowable(ext: string, text: string, ctx: ExtractContext): ExtractResult {
  if (ext === '.vue') return extractVueSfc(text, ctx)
  if (ext === '.excalidraw') return extractExcalidraw(text, ctx)
  if (ext === '.css') {
    const references: AssetReference[] = []
    const css = extractCssReferences(text, ctx, references)
    return {
      references,
      componentTags: [],
      follows: css.follows,
      sawDynamicBinding: false,
      sawUnknownSrcset: false,
      sawUnknownCss: css.sawUnknown,
      sawUnknownExcalidraw: false
    }
  }
  return extractHtmlFragment(text, ctx)
}

function componentCandidates(tagName: string, sourceRelPath: string): string[] {
  const file = `${tagName}.vue`
  const dir = path.posix.dirname(sourceRelPath)
  const out = [file, `assets/${file}`, `components/${file}`]
  if (dir !== '.') out.push(`${dir}/${file}`)
  return [...new Set(out)]
}

export async function scanAssets(
  rootPath: string,
  options: ScanAssetsOptions = {}
): Promise<AssetScanReport> {
  const root = path.resolve(rootPath)
  const rootReal = await fs.realpath(root).catch(() => root)
  const concurrency = options.concurrency ?? 8
  const generation = options.generation ?? 0
  const signal = options.signal

  const assets = await walkAssetFiles(path.join(root, ASSETS_DIR), '', rootReal, signal)
  const followable = await walkFollowableFiles(root, '', rootReal, signal)
  const existingFiles = new Set([...assets.map((asset) => asset.relPath), ...followable])

  const sources: AssetScanSource[] = []
  const references: AssetReference[] = []
  const diagnostics: AssetDiagnostic[] = []
  const edges = new Map<string, Set<string>>()
  const rootSources = new Set<string>()
  const parsedSources = new Set<string>()

  let sawDynamic = false
  let sawUnknownSrcset = false
  let sawUnknownCss = false
  let sawUnknownExcalidraw = false
  let sawUnknownVue = false
  let unparsedScript = false
  let exampleHintCount = 0

  for (const asset of assets) {
    if (asset.escaped) {
      diagnostics.push({
        code: 'symlink-escape',
        message: `资源符号链接指向知识库外: ${asset.relPath}`,
        scope: 'target',
        targetRelPath: asset.relPath
      })
    }
    const ext = path.posix.extname(asset.name).toLowerCase()
    if (UNPARSED_SCRIPT_EXT.has(ext)) {
      unparsedScript = true
      sources.push({
        relPath: asset.relPath,
        role: 'unparsed-asset',
        bytes: asset.size
      })
      diagnostics.push({
        code: 'unparsed-source',
        message: `未解析脚本资源 ${asset.relPath}`,
        scope: 'knowledge-base',
        sourceRelPath: asset.relPath,
        targetRelPath: asset.relPath
      })
    }
  }

  const noteDir = path.join(root, NOTES_DIR)
  let noteNames: string[] = []
  try {
    noteNames = (await fs.readdir(noteDir)).filter((name) => NOTE_FILE_REGEX.test(name))
  } catch {
    noteNames = []
  }

  const textJobs: Array<{ relPath: string; role: AssetScanSource['role'] }> = [
    ...noteNames.map((name) => ({ relPath: `${NOTES_DIR}/${name}`, role: 'note' as const })),
    { relPath: 'README.md', role: 'readme' },
    { relPath: TOC_FILE, role: 'toc' },
    { relPath: CONFIG_FILE, role: 'config' }
  ]

  const followJobs = followable.map((relPath) => {
    const ext = path.posix.extname(relPath).toLowerCase()
    return { relPath, role: sourceRoleForExt(ext) ?? ('unparsed-asset' as const) }
  })

  const total = textJobs.length + followJobs.length + assets.length
  let done = 0
  const bump = (current?: string): void => {
    done += 1
    options.onProgress?.({ done, total, current })
  }

  const absorb = (fromRelPath: string, extracted: ExtractResult): void => {
    references.push(...extracted.references)
    extracted.follows.forEach((to) => addEdge(edges, fromRelPath, to))
    for (const ref of extracted.references) {
      if (ref.targetRelPath) addEdge(edges, fromRelPath, ref.targetRelPath)
      if (ref.syntax.startsWith('uncertain-')) exampleHintCount += 1
    }
    for (const tag of extracted.componentTags) {
      for (const candidate of componentCandidates(tag, fromRelPath)) {
        if (existingFiles.has(candidate)) addEdge(edges, fromRelPath, candidate)
      }
    }
    sawDynamic = sawDynamic || extracted.sawDynamicBinding
    sawUnknownSrcset = sawUnknownSrcset || extracted.sawUnknownSrcset
    sawUnknownCss = sawUnknownCss || extracted.sawUnknownCss
    sawUnknownExcalidraw = sawUnknownExcalidraw || extracted.sawUnknownExcalidraw
    if (extracted.parseError) {
      sawUnknownVue = true
      diagnostics.push({
        code: 'unparsed-source',
        message: extracted.parseError,
        scope: 'source',
        sourceRelPath: fromRelPath
      })
    }
    if (extracted.sawDynamicBinding) sawUnknownVue = true
  }

  await mapPool(textJobs, concurrency, signal, async (job) => {
    throwIfAborted(signal)
    const full = path.join(root, job.relPath)
    const text = await readText(full)
    if (text == null) {
      if (job.role === 'note') {
        diagnostics.push({
          code: 'read-error',
          message: `无法读取 ${job.relPath}`,
          scope: 'source',
          sourceRelPath: job.relPath
        })
        sources.push({ relPath: job.relPath, role: job.role, bytes: 0, error: 'unreadable' })
      }
      bump(job.relPath)
      return
    }
    sources.push({ relPath: job.relPath, role: job.role, bytes: Buffer.byteLength(text) })
    parsedSources.add(job.relPath)
    rootSources.add(job.relPath)

    if (job.role === 'config') {
      try {
        const parsed = JSON.parse(text) as { icon?: { src?: unknown } }
        const src = typeof parsed.icon?.src === 'string' ? parsed.icon.src : ''
        if (src) {
          const ref = extractConfigIcon(src, text)
          if (ref) {
            references.push(ref)
            if (ref.targetRelPath) addEdge(edges, job.relPath, ref.targetRelPath)
          }
        }
      } catch {
        diagnostics.push({
          code: 'read-error',
          message: 'tnotes.json 不是合法 JSON，配置图标未纳入引用图',
          scope: 'source',
          sourceRelPath: CONFIG_FILE
        })
      }
      bump(job.relPath)
      return
    }

    let noteUuid: string | undefined
    let noteTitle: string | undefined
    if (job.role === 'note') {
      const fileName = path.posix.basename(job.relPath)
      const match = fileName.match(NOTE_FILE_REGEX)
      noteTitle = match?.[2]?.trim() || fileName
      noteUuid = parseNoteContent(text).frontmatter.id ?? match?.[1]
    }

    absorb(
      job.relPath,
      extractAssetReferences(text, {
        sourceRelPath: job.relPath,
        noteUuid,
        noteTitle,
        noteLike: job.role === 'note'
      })
    )
    bump(job.relPath)
  })

  await mapPool(followJobs, concurrency, signal, async (job) => {
    throwIfAborted(signal)
    if (parsedSources.has(job.relPath)) {
      bump(job.relPath)
      return
    }
    const full = path.join(root, job.relPath)
    const text = await readText(full)
    const ext = path.posix.extname(job.relPath).toLowerCase()
    if (text == null) {
      diagnostics.push({
        code: 'read-error',
        message: `无法读取 ${job.relPath}`,
        scope: 'source',
        sourceRelPath: job.relPath
      })
      sources.push({ relPath: job.relPath, role: job.role, bytes: 0, error: 'unreadable' })
      bump(job.relPath)
      return
    }
    sources.push({ relPath: job.relPath, role: job.role, bytes: Buffer.byteLength(text) })
    parsedSources.add(job.relPath)
    absorb(job.relPath, extractFollowable(ext, text, { sourceRelPath: job.relPath }))
    bump(job.relPath)
  })

  for (const asset of assets) bump(asset.relPath)

  if (sawDynamic) {
    diagnostics.push({
      code: 'dynamic-expression',
      message:
        '发现动态资源绑定（:src / v-bind:src / v-bind 对象 / 动态 import），无法静态确定目标',
      scope: 'knowledge-base'
    })
  }
  if (sawUnknownSrcset) {
    diagnostics.push({
      code: 'unsupported-syntax',
      message: '存在无法静态解析的 srcset 候选项',
      scope: 'knowledge-base'
    })
  }
  if (sawUnknownCss) {
    diagnostics.push({
      code: 'unsupported-syntax',
      message: '存在无法静态解析的 CSS url() / @import',
      scope: 'knowledge-base'
    })
  }
  if (sawUnknownExcalidraw) {
    diagnostics.push({
      code: 'unsupported-syntax',
      message: 'Excalidraw 中存在无法在源码定位的本地路径',
      scope: 'knowledge-base'
    })
  }
  if (exampleHintCount > 0) {
    diagnostics.push({
      code: 'unsupported-syntax',
      message: `普通围栏、注释或行内代码中提到 ${exampleHintCount} 处资源路径，仅保护不改写`,
      scope: 'knowledge-base'
    })
  }

  const reachable = rootReachablePaths(rootSources, edges)
  const existingAssets = new Set(assets.map((asset) => asset.relPath))
  const brokenLinks: AssetBrokenLink[] = []
  for (const ref of references) {
    if (ref.urlKind === 'local-root') {
      diagnostics.push({
        code: 'path-compat-root-slash',
        message: `/assets/ 形式 Desk 与 SSG 均未完整支持: ${ref.rawUrl}`,
        scope: 'target',
        sourceRelPath: ref.sourceRelPath,
        targetRelPath: ref.targetRelPath ?? undefined
      })
    }
    if (!ref.targetRelPath) {
      if (ref.urlKind === 'local-relative' || ref.urlKind === 'local-root') {
        brokenLinks.push({ reference: ref, reason: 'out-of-bounds' })
        diagnostics.push({
          code: 'path-out-of-bounds',
          message: `资源路径越界: ${ref.rawUrl}`,
          scope: 'target',
          sourceRelPath: ref.sourceRelPath
        })
      }
      continue
    }
    if (!existingAssets.has(ref.targetRelPath) && determined(ref)) {
      brokenLinks.push({ reference: ref, reason: 'missing-file' })
    }
  }

  const refsByTarget = new Map<string, AssetReference[]>()
  const uncertainTargets = new Set<string>()
  for (const ref of references) {
    if (!ref.targetRelPath) continue
    const list = refsByTarget.get(ref.targetRelPath) ?? []
    list.push(ref)
    refsByTarget.set(ref.targetRelPath, list)
    if (!determined(ref)) uncertainTargets.add(ref.targetRelPath)
  }

  const scopeUnknown =
    sawDynamic ||
    sawUnknownSrcset ||
    sawUnknownCss ||
    sawUnknownExcalidraw ||
    sawUnknownVue ||
    unparsedScript
  const coverageComplete = !scopeUnknown
  const batchCleanupAllowed = coverageComplete

  const records: AssetRecord[] = assets.map((asset) => {
    const protection: string[] = []
    if (isKbIconFileName(asset.name)) protection.push('kb-icon')
    if (asset.escaped) protection.push('symlink-escape')
    // `.excalidraw` is the editable drawing source of truth. Companion SVG/PNG
    // files are historical derivatives. Desk + SSG will share one UI component
    // that reads this file; derived SVG removal is a later dedicated migration,
    // not idle GC. Never classify these as cleanup candidates.
    if (asset.name.toLowerCase().endsWith('.excalidraw')) protection.push('excalidraw-source')
    const related = refsByTarget.get(asset.relPath) ?? []
    const reachableFromRoot = reachable.has(asset.relPath)
    let status: AssetRecordStatus
    if (protection.length > 0) status = 'protected'
    else if (uncertainTargets.has(asset.relPath)) status = 'uncertain-affected'
    else if (reachableFromRoot) status = 'referenced'
    else if (coverageComplete) status = 'idle-candidate'
    else status = 'uncertain-idle'

    const renameAllowed =
      coverageComplete &&
      !uncertainTargets.has(asset.relPath) &&
      protection.length === 0 &&
      !asset.escaped

    return {
      relPath: asset.relPath,
      name: asset.name,
      size: asset.size,
      mtimeMs: asset.mtimeMs,
      kind: assetFileKind(asset.name),
      status,
      references: related.filter(determined),
      protection,
      renameAllowed,
      ownerNoteIndex: ownerNoteIndexFromName(asset.name)
    }
  })

  const adapters: AssetCoverageAdapter[] = [
    {
      id: 'p1-1a-markdown',
      status: 'complete',
      detail: 'Markdown 图片 / 链接 / 引用定义 + {w=}/{align=} 方言'
    },
    {
      id: 'p1-1a-html-src',
      status: 'complete',
      detail: 'HTML 静态 src/href'
    },
    {
      id: 'p1-1a-mindmap',
      status: 'complete',
      detail: 'mindmap fence 内图片与链接'
    },
    {
      id: 'p1-1a-uncertainty',
      status: 'complete',
      detail: '未适配来源进入不确定分类并关闭危险写操作'
    },
    {
      id: 'p1-1b-srcset',
      status: sawUnknownSrcset ? 'partial' : 'complete',
      detail: sawUnknownSrcset
        ? 'srcset / poster 已解析静态候选项；仍有无法静态确定的 srcset'
        : 'HTML srcset 候选项与 poster 静态 URL'
    },
    {
      id: 'p1-1b-css',
      status: sawUnknownCss ? 'partial' : 'complete',
      detail: sawUnknownCss
        ? 'CSS url() / @import 已解析静态字面量；仍有 var()/表达式'
        : 'CSS url() / @import 静态字面量（含独立 css 文件）'
    },
    {
      id: 'p1-1b-vue',
      status: sawUnknownVue || sawDynamic ? 'partial' : 'complete',
      detail:
        sawUnknownVue || sawDynamic
          ? 'Vue SFC 静态属性与 import 已解析；动态绑定不视为已完全解析'
          : 'Vue SFC 静态属性、静态 import 与可解析的本地组件文件'
    },
    {
      id: 'p1-1b-excalidraw',
      status: sawUnknownExcalidraw ? 'partial' : 'complete',
      detail: sawUnknownExcalidraw
        ? 'Excalidraw 已跳过 data URL；部分字符串无法在源码定位'
        : 'Excalidraw 内嵌路径（data URL 不当本地文件）'
    }
  ]

  records.sort((a, b) => a.relPath.localeCompare(b.relPath))
  references.sort(
    (a, b) => a.sourceRelPath.localeCompare(b.sourceRelPath) || a.startOffset - b.startOffset
  )

  const report: AssetScanReport = {
    generation,
    coverageComplete,
    batchCleanupAllowed,
    sources: sources.sort((a, b) => a.relPath.localeCompare(b.relPath)),
    assets: records,
    references,
    brokenLinks,
    diagnostics,
    adapters,
    duplicateGroups: [],
    stats: {
      assetCount: records.length,
      assetBytes: records.reduce((sum, item) => sum + item.size, 0),
      determinedReferenceCount: references.filter(determined).length,
      uncertainReferenceCount: references.filter((ref) => !determined(ref)).length,
      mergeableDuplicateCount: 0,
      crossNoteDuplicateCount: 0
    }
  }

  if (!options.includeHashes) return report
  const hashes = await hashAssetFiles(root, records, {
    cachePath: options.hashCachePath,
    signal,
    concurrency
  })
  return withAssetHashes(report, hashes)
}
