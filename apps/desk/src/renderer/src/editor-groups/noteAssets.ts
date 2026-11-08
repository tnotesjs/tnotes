/**
 * 笔记级资源面板的纯逻辑。
 *
 * 数据来源刻意保持廉价：**不跑整库资源扫描**（真实库有几千个资源、2GB+，面板为了一篇笔记
 * 不该付这个代价）。
 * - 本笔记引用的资源：直接从笔记 markdown 解析（带偏移，供"定位引用"用）
 * - 编号匹配的资源：`kbFiles.list(kb, 'assets')` 列一层目录（只 stat，不读内容）
 *
 * 判定规则（与主进程的归属模型一致）：文件名四位前缀 `{index}-` 是主人。
 */
import { noteRelativeAssetPath, resolveNoteAssetRelPath } from '../markdown/noteAssetPath'
import { ownerIndexFromRelPath } from '../editor/markdown/canvasImageRefs'

/** 资源引用（笔记正文里出现的一处） */
export interface NoteAssetReference {
  /** 原文里的 URL（相对笔记文件） */
  rawPath: string
  /** KB 相对路径；解析不出来（外链 / data: / 越界）为 null */
  relPath: string | null
  /** 在笔记源码里的偏移（用于定位） */
  startOffset: number
  endOffset: number
  line: number
  column: number
  syntax: 'image' | 'link' | 'html'
  alt: string
}

/** 面板里的一行 */
export interface NoteAssetEntry {
  /** KB 相对路径（`assets/…`）；引用了但磁盘上没有时也保留路径 */
  relPath: string
  name: string
  bytes: number | null
  /** 本笔记里的引用处（按出现顺序） */
  references: NoteAssetReference[]
  /** 文件名四位前缀 */
  ownerIndex: string | null
  /** 与当前笔记编号一致 */
  indexMatched: boolean
  /** 磁盘上是否存在 */
  exists: boolean
  /** 像不像文本（列表给图标的弱提示） */
  textLike: boolean
  /** 编号匹配但没被本笔记引用（画布还要看同名 .svg）→ 可一键删除 */
  invalid: boolean
  /** 被本笔记引用但编号不匹配 → 可一键修复（重命名加前缀 + 改引用） */
  needsIndexFix: boolean
  /** 修复后的文件名（`{noteIndex}-{去掉旧前缀的名字}`） */
  fixedName: string
  /** 同名配对文件（`.excalidraw` ↔ `.svg`） */
  pairRelPath: string | null
}

export interface NoteAssetsView {
  noteIndex: string
  /** 本笔记引用的资源（含编号不匹配的） */
  referenced: NoteAssetEntry[]
  /** 编号匹配的资源（无论是否被引用） */
  own: NoteAssetEntry[]
  /** 编号匹配但没被引用 → 可删 */
  invalid: NoteAssetEntry[]
  /** 引用缺失：笔记里引用了但磁盘上没有 */
  missing: NoteAssetEntry[]
}

/** 面板的最小输入：来自 `kbFiles.list(kb, 'assets')` */
export interface NoteAssetsListingEntry {
  name: string
  relPath: string
  kind: 'directory' | 'file'
  bytes: number | null
  textLike: boolean
}

const MARKDOWN_REF = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const HTML_REF = /<(?:img|a)\b[^>]*\b(?:src|href)="([^"]+)"/gi

/** 资源文件（`assets/…`）才进面板；外链、data:、越界一律忽略 */
function toAssetRelPath(noteRelPath: string, rawPath: string): string | null {
  if (!rawPath) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(rawPath) || rawPath.startsWith('//')) return null
  const resolved = resolveNoteAssetRelPath(noteRelPath, rawPath)
  if (!resolved) return null
  return resolved.startsWith('assets/') ? resolved : null
}

function lineColumnOf(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset)
  const lines = before.split('\n')
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

/** 解析笔记里的资源引用（markdown 图片/链接 + HTML img/a），带偏移 */
export function parseNoteAssetReferences(
  source: string,
  noteRelPath: string
): NoteAssetReference[] {
  const references: NoteAssetReference[] = []
  const push = (
    rawPath: string,
    startOffset: number,
    endOffset: number,
    syntax: NoteAssetReference['syntax'],
    alt: string
  ): void => {
    const { line, column } = lineColumnOf(source, startOffset)
    references.push({
      rawPath,
      relPath: toAssetRelPath(noteRelPath, rawPath),
      startOffset,
      endOffset,
      line,
      column,
      syntax,
      alt
    })
  }

  for (const match of source.matchAll(MARKDOWN_REF)) {
    const start = match.index ?? 0
    push(
      match[3] ?? '',
      start,
      start + match[0].length,
      match[1] === '!' ? 'image' : 'link',
      match[2] ?? ''
    )
  }
  for (const match of source.matchAll(HTML_REF)) {
    const start = match.index ?? 0
    push(match[1] ?? '', start, start + match[0].length, 'html', '')
  }
  return references.sort((a, b) => a.startOffset - b.startOffset)
}

/** `.excalidraw` ↔ 同名 `.svg`（同一规则：只换后缀）；非画布返回 null */
export function canvasPairRelPath(relPath: string): string | null {
  if (relPath.toLowerCase().endsWith('.excalidraw')) {
    return `${relPath.slice(0, -'.excalidraw'.length)}.svg`
  }
  if (relPath.toLowerCase().endsWith('.svg')) {
    return `${relPath.slice(0, -'.svg'.length)}.excalidraw`
  }
  return null
}

/**
 * 加/换编号前缀：先剥掉可能存在的旧四位前缀，再冠以当前笔记编号。
 *
 * 用户给的说法是「加上编号前缀 {index}-{filename}」。对**没有前缀**的文件两种理解一致；
 * 对**前缀错误**的文件（`0001-photo.png` 被 0007 引用）这里选择"替换"而不是"再拼一层"，
 * 否则会得到 `0007-0001-photo.png` 这种双前缀。
 */
export function indexPrefixedName(noteIndex: string, name: string): string {
  const stripped = name.replace(/^\d{4}-/, '')
  return `${noteIndex}-${stripped}`
}

/** 感知「本笔记引用了哪些资源、编号匹配的又有哪些」 */
export function buildNoteAssetsView(input: {
  source: string
  noteRelPath: string
  noteIndex: string
  listing: readonly NoteAssetsListingEntry[]
}): NoteAssetsView {
  const { source, noteRelPath, noteIndex } = input
  const files = input.listing.filter((entry) => entry.kind === 'file')
  const byPath = new Map(files.map((entry) => [entry.relPath, entry]))

  // 1) 引用 → 按 KB 路径聚合（同一资源可以引用多次）
  const refsByAsset = new Map<string, NoteAssetReference[]>()
  for (const reference of parseNoteAssetReferences(source, noteRelPath)) {
    if (!reference.relPath) continue
    const bucket = refsByAsset.get(reference.relPath) ?? []
    bucket.push(reference)
    refsByAsset.set(reference.relPath, bucket)
  }

  const entryFor = (relPath: string, references: NoteAssetReference[]): NoteAssetEntry => {
    const listing = byPath.get(relPath)
    const name = listing?.name ?? (relPath.split('/').pop() || relPath)
    const ownerIndex = ownerIndexFromRelPath(relPath)
    const indexMatched = Boolean(noteIndex) && ownerIndex === noteIndex
    return {
      relPath,
      name,
      bytes: listing?.bytes ?? null,
      references,
      ownerIndex,
      indexMatched,
      exists: Boolean(listing),
      textLike: listing?.textLike ?? false,
      invalid: false,
      needsIndexFix: false,
      fixedName: indexPrefixedName(noteIndex, name),
      pairRelPath: canvasPairRelPath(relPath)
    }
  }

  const referenced = [...refsByAsset.entries()]
    .map(([relPath, references]) => entryFor(relPath, references))
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
  const referencedPaths = new Set(referenced.map((entry) => entry.relPath))

  // 2) 编号匹配的资源（含被引用的）
  const ownFromPrefix = files
    .filter((entry) => Boolean(noteIndex) && ownerIndexFromRelPath(entry.relPath) === noteIndex)
    .map((entry) => entryFor(entry.relPath, refsByAsset.get(entry.relPath) ?? []))
  const ownFromRefs = referenced.filter((entry) => !entry.ownerIndex && entry.exists)
  const ownSeen = new Set<string>()
  const own = [...ownFromPrefix, ...ownFromRefs]
    .filter((entry) => (ownSeen.has(entry.relPath) ? false : (ownSeen.add(entry.relPath), true)))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))

  // 3) 无效资源：编号匹配但没被引用。
  //    画布特例：`.excalidraw` 与同名 `.svg` 是**一份资源的两半**（源文件 + 派生图），
  //    只要任一侧被本笔记引用，两半都不算无效；两侧都没被引用才一起列为可删。
  const invalid = own.filter((entry) => {
    if (referencedPaths.has(entry.relPath)) return false
    if (entry.pairRelPath && referencedPaths.has(entry.pairRelPath)) return false
    return true
  })
  // 让 `entry.invalid` 名副其实（面板/其它消费方可以只看行本身，不必再对着 invalid 集合查）
  for (const entry of invalid) entry.invalid = true

  // 4) 引用但编号不匹配 → 需要修复
  const mismatched = referenced.filter((entry) => !entry.indexMatched && Boolean(entry.ownerIndex))
  for (const entry of mismatched) entry.needsIndexFix = true

  // 5) 引用缺失（磁盘上没有，且不在 assets/ 下的也归到这里）
  const missing = referenced.filter((entry) => !entry.exists)

  return {
    noteIndex,
    referenced,
    own,
    invalid,
    missing
  }
}

/** 一键修复后要写回笔记的新相对路径（同一个 rawPath 只换文件名） */
export function fixedReferencePath(
  noteRelPath: string,
  relPath: string,
  noteIndex: string
): string | null {
  const name = relPath.split('/').pop()
  if (!name) return null
  const next = relPath.replace(/[^/]+$/, indexPrefixedName(noteIndex, name))
  return noteRelativeAssetPath(noteRelPath, next)
}

/** 插入到笔记里的 markdown：图片走共享序列化，其它类型暂无（初版只做图片） */
export function insertableImageMarkdown(
  noteRelPath: string,
  relPath: string,
  alt = ''
): string | null {
  if (!/\.(?:png|jpe?g|jfif|gif|webp|avif|bmp|svg)$/i.test(relPath)) return null
  const relative = noteRelativeAssetPath(noteRelPath, relPath)
  if (!relative) return null
  return `![${alt.replaceAll('[', '').replaceAll(']', '')}](${relative})`
}

/** 文件体积（面板展示用） */
export function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
