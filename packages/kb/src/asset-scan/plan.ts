/**
 * Build rename / recycle plans from a scan report. Preview does not write.
 */

import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import { ASSETS_DIR, isKbIconFileName } from '../constants'
import {
  EXCALIDRAW_DERIVED_EXTENSION,
  EXCALIDRAW_EXTENSION,
  derivedSvgRelPath,
  sourceRelPathForDerived
} from '../excalidraw'
import { rewriteLocalAssetUrl } from './paths'

import type {
  AssetBackupSpec,
  AssetFileMove,
  AssetOperationPlan,
  AssetReference,
  AssetScanReport,
  AssetSourcePatch
} from './types'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function fingerprintRefs(refs: AssetReference[]): string {
  const lines = refs
    .map((ref) => `${ref.sourceRelPath}:${ref.startOffset}:${ref.endOffset}:${ref.rawUrl}`)
    .sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

function emptyPlan(
  kind: AssetOperationPlan['kind'],
  report: AssetScanReport,
  blockedReasons: string[]
): AssetOperationPlan {
  return {
    id: randomUUID(),
    knowledgeBaseId: '',
    generation: report.generation,
    coverageComplete: report.coverageComplete,
    kind,
    inputHashes: {},
    refFingerprint: '',
    patches: [],
    backups: [],
    moves: [],
    outputs: [],
    createdRelPaths: [],
    estimated: { filesTouched: 0, bytesMoved: 0 },
    blockedReasons
  }
}

function validateDestRelPath(destRelPath: string): string | null {
  const normalized = path.posix.normalize(destRelPath.replaceAll('\\', '/'))
  if (normalized !== destRelPath.replaceAll('\\', '/')) return '目标路径不合法'
  if (!normalized.startsWith(`${ASSETS_DIR}/`) || normalized.includes('/../')) {
    return '目标必须位于 assets/ 内'
  }
  const base = path.posix.basename(normalized)
  if (!base || base.startsWith('.') || WINDOWS_RESERVED.test(base)) {
    return '目标文件名不合法'
  }
  if (isKbIconFileName(base)) return '不能使用知识库图标保留名'
  return null
}

/**
 * 画布是「两个文件一份资源」：`x.excalidraw`（真相源）+ 同名 `x.svg`（派生图）。
 * 重命名任一侧都必须把另一半一起搬走，否则配对被打断——`.svg` 会退化成普通图片，
 * 而 `.excalidraw` 变成没人认领的孤儿。返回另一半的「源 → 目标」。
 */
function canvasCompanion(
  report: AssetScanReport,
  fromRelPath: string,
  toRelPath: string
): { fromRelPath: string; toRelPath: string } | null {
  const lower = fromRelPath.toLowerCase()
  let companionFrom: string
  let companionExt: string
  if (lower.endsWith(EXCALIDRAW_EXTENSION)) {
    companionFrom = derivedSvgRelPath(fromRelPath)
    companionExt = EXCALIDRAW_DERIVED_EXTENSION
  } else if (lower.endsWith(EXCALIDRAW_DERIVED_EXTENSION)) {
    companionFrom = sourceRelPathForDerived(fromRelPath)
    companionExt = EXCALIDRAW_EXTENSION
  } else {
    return null
  }
  if (!report.assets.some((asset) => asset.relPath === companionFrom)) return null
  const toExt = path.posix.extname(toRelPath)
  // 改名不能换后缀，否则另一半跟不过去（`x.svg` → `y.png`）
  if (toExt.toLowerCase() !== path.posix.extname(fromRelPath).toLowerCase()) {
    return { fromRelPath: companionFrom, toRelPath: '' }
  }
  return {
    fromRelPath: companionFrom,
    toRelPath: `${toRelPath.slice(0, -toExt.length)}${companionExt}`
  }
}

export function planRename(
  report: AssetScanReport,
  input: { fromRelPath: string; toRelPath: string }
): AssetOperationPlan {
  const from = report.assets.find((asset) => asset.relPath === input.fromRelPath)
  if (!from) return emptyPlan('rename', report, [`找不到资源 ${input.fromRelPath}`])

  const destError = validateDestRelPath(input.toRelPath)
  if (destError) return emptyPlan('rename', report, [destError])
  if (input.toRelPath === input.fromRelPath) {
    return emptyPlan('rename', report, ['新路径与原路径相同'])
  }

  const destClash = report.assets.find(
    (asset) => asset.relPath.toLocaleLowerCase() === input.toRelPath.toLocaleLowerCase()
  )
  if (destClash) return emptyPlan('rename', report, [`目标已存在: ${destClash.relPath}`])

  const blocked: string[] = []
  // 画布源文件的 `renameAllowed` 永远是 false（它带着 excalidraw-source 保护），
  // 但**重命名**是显式动作、不是当闲置清理，所以这里只放开这一条保护。
  const onlyCanvasProtection =
    from.protection.length > 0 && from.protection.every((item) => item === 'excalidraw-source')
  if (!from.renameAllowed && !onlyCanvasProtection) {
    blocked.push('该资源存在未知引用或覆盖未完成，不能重命名')
  }
  if (from.protection.includes('kb-icon')) blocked.push('知识库图标文件名固定，不能重命名')
  if (!report.coverageComplete) {
    blocked.push('扫描覆盖未完成，无法证明未知来源与该文件无关')
  }

  const companion = canvasCompanion(report, from.relPath, input.toRelPath)
  if (companion && !companion.toRelPath) {
    blocked.push('画布改名不能改后缀，否则派生图跟不上')
  }
  const renameTargets = new Map<string, string>([[from.relPath, input.toRelPath]])
  if (companion?.toRelPath) {
    renameTargets.set(companion.fromRelPath, companion.toRelPath)
    const pairClash = report.assets.find(
      (asset) =>
        asset.relPath.toLocaleLowerCase() === companion.toRelPath.toLocaleLowerCase() &&
        !renameTargets.has(asset.relPath)
    )
    if (pairClash) blocked.push(`目标已存在: ${pairClash.relPath}`)
  }

  const targetedRefs = (relPath: string) =>
    report.references.filter((ref) => ref.targetRelPath === relPath)
  const rewritable = [...renameTargets.keys()].flatMap((relPath) =>
    targetedRefs(relPath).filter((ref) => ref.rewritable)
  )
  const uncertain = [...renameTargets.keys()].flatMap((relPath) =>
    targetedRefs(relPath).filter((ref) => !ref.rewritable)
  )
  if (uncertain.length > 0) {
    blocked.push('存在不可改写或不确定的引用')
  }

  const patches: AssetSourcePatch[] = rewritable.map((ref) => {
    const target = ref.targetRelPath ? renameTargets.get(ref.targetRelPath) : undefined
    const replacement = target ? rewriteLocalAssetUrl(ref.rawUrl, target, ref.sourceRelPath) : null
    if (!replacement) {
      blocked.push(`无法保持原 URL 形式: ${ref.rawUrl}`)
    }
    return {
      sourceRelPath: ref.sourceRelPath,
      startOffset: ref.startOffset,
      endOffset: ref.endOffset,
      expected: ref.rawUrl,
      replacement: replacement ?? ref.rawUrl
    }
  })

  if (blocked.length > 0) return emptyPlan('rename', report, [...new Set(blocked)])

  const moves: AssetFileMove[] = [...renameTargets.entries()].map(([fromRelPath, toRelPath]) => ({
    fromRelPath,
    toRelPath,
    sha256: ''
  }))
  const sources = new Set([...renameTargets.keys(), ...patches.map((patch) => patch.sourceRelPath)])
  const bytesMoved = moves.reduce(
    (total, move) => total + (report.assets.find((a) => a.relPath === move.fromRelPath)?.size ?? 0),
    0
  )
  return {
    id: randomUUID(),
    knowledgeBaseId: '',
    generation: report.generation,
    coverageComplete: report.coverageComplete,
    kind: 'rename',
    inputHashes: Object.fromEntries([...sources].map((relPath) => [relPath, ''])),
    refFingerprint: fingerprintRefs(rewritable),
    patches,
    backups: [...sources].map((relPath) => ({ relPath, sha256: '' })),
    moves,
    outputs: [],
    createdRelPaths: [],
    estimated: { filesTouched: sources.size, bytesMoved },
    blockedReasons: []
  }
}

export interface RecyclePlanOptions {
  /**
   * 定向删除：用户在笔记资源面板里**逐个确认**后删自己那条资源。
   *
   * 与"资源面板批量清理"的区别只在两处放开：不再要求扫描覆盖完成（不是批量动作），
   * 并允许删 Excalidraw 真相源（笔记里已经不再引用它了，源文件留着才是垃圾）。
   * **"该资源确实没有引用"这条安全线不放开**——任何模式下都不删还被引用的资源。
   */
  targeted?: boolean
}

export function planRecycle(
  report: AssetScanReport,
  relPaths: string[],
  options: RecyclePlanOptions = {}
): AssetOperationPlan {
  const blocked: string[] = []
  if (!options.targeted && (!report.batchCleanupAllowed || !report.coverageComplete)) {
    blocked.push('扫描覆盖未完成，整库禁用批量清理')
  }
  const moves: AssetFileMove[] = []
  let bytesMoved = 0
  for (const relPath of relPaths) {
    const asset = report.assets.find((item) => item.relPath === relPath)
    if (!asset) {
      blocked.push(`找不到资源 ${relPath}`)
      continue
    }
    // 画布源文件平时永远是 `protected`（不进批量清理）。但用户在笔记资源面板里
    // 逐个确认删除自己那条资源时，它必须能删——前提是**真的没有任何引用**，
    // 连不确定引用（uncertain-*/unsupported-*）也算引用，宁可不删。
    const canvasSource =
      asset.kind === 'excalidraw' || asset.protection.includes('excalidraw-source')
    const mentionedAtAll = report.references.some((ref) => ref.targetRelPath === asset.relPath)
    const deletable =
      asset.status === 'idle-candidate' ||
      Boolean(options.targeted && canvasSource && !mentionedAtAll)
    if (!deletable) {
      blocked.push(`${relPath} 不是可清理的闲置候选`)
    }
    // 定向删除只放开 excalidraw-source；别的保护（例如库图标）照旧拦住
    const protections = options.targeted
      ? asset.protection.filter((item) => item !== 'excalidraw-source')
      : asset.protection
    if (protections.length > 0) {
      blocked.push(`${relPath} 受保护（${protections.join(', ')}）`)
    }
    if (
      !options.targeted &&
      (asset.kind === 'excalidraw' || asset.protection.includes('excalidraw-source'))
    ) {
      blocked.push(`${relPath} 是 Excalidraw 真相源，不能清理`)
    }
    moves.push({ fromRelPath: relPath, sha256: '' })
    bytesMoved += asset.size
  }
  if (blocked.length > 0) return emptyPlan('recycle', report, [...new Set(blocked)])
  if (moves.length === 0) return emptyPlan('recycle', report, ['没有可清理的文件'])

  const sources = moves.map((move) => move.fromRelPath)
  return {
    id: randomUUID(),
    knowledgeBaseId: '',
    generation: report.generation,
    coverageComplete: report.coverageComplete,
    kind: 'recycle',
    inputHashes: Object.fromEntries(sources.map((relPath) => [relPath, ''])),
    refFingerprint: fingerprintRefs([]),
    patches: [],
    backups: sources.map((relPath) => ({ relPath, sha256: '' })),
    moves,
    outputs: [],
    createdRelPaths: [],
    estimated: { filesTouched: sources.length, bytesMoved },
    // 计划自带模式：apply 重新校验时要用同一套规则，否则会「预览通过、执行被拒」
    targeted: options.targeted,
    blockedReasons: []
  }
}

function rewritePatches(
  report: AssetScanReport,
  fromRelPath: string,
  toRelPath: string,
  blocked: string[]
): AssetSourcePatch[] {
  const rewritable = report.references.filter(
    (ref) => ref.targetRelPath === fromRelPath && ref.rewritable
  )
  const uncertain = report.references.filter(
    (ref) => ref.targetRelPath === fromRelPath && !ref.rewritable
  )
  if (uncertain.length > 0) blocked.push(`存在不可改写或不确定的引用: ${fromRelPath}`)
  return rewritable.map((ref) => {
    const replacement = rewriteLocalAssetUrl(ref.rawUrl, toRelPath, ref.sourceRelPath)
    if (!replacement) blocked.push(`无法保持原 URL 形式: ${ref.rawUrl}`)
    return {
      sourceRelPath: ref.sourceRelPath,
      startOffset: ref.startOffset,
      endOffset: ref.endOffset,
      expected: ref.rawUrl,
      replacement: replacement ?? ref.rawUrl
    }
  })
}

export function planMerge(
  report: AssetScanReport,
  input: { keepRelPath: string; dropRelPaths: string[] }
): AssetOperationPlan {
  const keep = report.assets.find((asset) => asset.relPath === input.keepRelPath)
  if (!keep) return emptyPlan('merge', report, [`找不到保留文件 ${input.keepRelPath}`])
  const drops = [...new Set(input.dropRelPaths.filter((relPath) => relPath !== input.keepRelPath))]
  if (drops.length === 0) return emptyPlan('merge', report, ['没有可合并的重复文件'])

  const group = report.duplicateGroups.find(
    (item) => item.mergeable && item.relPaths.includes(keep.relPath)
  )
  const blocked: string[] = []
  if (!report.coverageComplete) {
    blocked.push('扫描覆盖未完成，无法证明未知来源与该文件无关')
  }
  if (!keep.sha256) blocked.push('缺少内容哈希，请重新扫描后再合并')
  if (!group) blocked.push('该组不可合并（需同一笔记归属且类型兼容）')

  const patches: AssetSourcePatch[] = []
  const moves: AssetFileMove[] = []
  let bytesMoved = 0
  for (const relPath of drops) {
    const asset = report.assets.find((item) => item.relPath === relPath)
    if (!asset) {
      blocked.push(`找不到资源 ${relPath}`)
      continue
    }
    if (group && !group.relPaths.includes(relPath)) {
      blocked.push(`${relPath} 不属于同一重复组`)
    }
    if (asset.sha256 && keep.sha256 && asset.sha256 !== keep.sha256) {
      blocked.push(`${relPath} 与保留文件内容不同`)
    }
    if (asset.protection.length > 0) {
      blocked.push(`${relPath} 受保护（${asset.protection.join(', ')}）`)
    }
    if (!asset.renameAllowed) {
      blocked.push(`${relPath} 存在未知引用或覆盖未完成，不能合并`)
    }
    patches.push(...rewritePatches(report, relPath, keep.relPath, blocked))
    moves.push({ fromRelPath: relPath, sha256: '' })
    bytesMoved += asset.size
  }

  if (blocked.length > 0) return emptyPlan('merge', report, [...new Set(blocked)])

  const sources = new Set([keep.relPath, ...drops, ...patches.map((patch) => patch.sourceRelPath)])
  return {
    id: randomUUID(),
    knowledgeBaseId: '',
    generation: report.generation,
    coverageComplete: report.coverageComplete,
    kind: 'merge',
    inputHashes: Object.fromEntries([...sources].map((relPath) => [relPath, ''])),
    refFingerprint: fingerprintRefs(
      report.references.filter(
        (ref) =>
          (ref.targetRelPath === keep.relPath || drops.includes(ref.targetRelPath ?? '')) &&
          ref.rewritable
      )
    ),
    patches,
    backups: [...sources].map((relPath) => ({ relPath, sha256: '' })),
    moves,
    outputs: [],
    createdRelPaths: [],
    estimated: { filesTouched: sources.size, bytesMoved },
    blockedReasons: []
  }
}

export interface OptimizePlanItem {
  fromRelPath: string
  toRelPath: string
  outputSha256: string
  bytesAfter: number
}

export function planOptimize(
  report: AssetScanReport,
  items: OptimizePlanItem[]
): AssetOperationPlan {
  if (items.length === 0) return emptyPlan('optimize', report, ['没有可优化的文件'])
  const blocked: string[] = []
  const patches: AssetSourcePatch[] = []
  const moves: AssetFileMove[] = []
  const outputs: AssetBackupSpec[] = []
  const createdRelPaths: string[] = []
  const backupSet = new Set<string>()
  let bytesMoved = 0
  let bytesSaved = 0

  for (const item of items) {
    const asset = report.assets.find((entry) => entry.relPath === item.fromRelPath)
    if (!asset) {
      blocked.push(`找不到资源 ${item.fromRelPath}`)
      continue
    }
    if (asset.kind === 'gif' || asset.kind === 'svg' || asset.kind === 'excalidraw') {
      blocked.push(`${item.fromRelPath} 不支持有损优化`)
      continue
    }
    if (asset.kind !== 'image') {
      blocked.push(`${item.fromRelPath} 不是可压缩的静态图片`)
      continue
    }
    if (asset.protection.includes('excalidraw-source') || asset.protection.includes('kb-icon')) {
      blocked.push(`${item.fromRelPath} 受保护，不能优化`)
      continue
    }
    if (item.bytesAfter >= asset.size) {
      blocked.push(`${item.fromRelPath} 优化后没有变小`)
      continue
    }
    const destError = validateDestRelPath(item.toRelPath)
    if (destError) {
      blocked.push(`${item.fromRelPath}: ${destError}`)
      continue
    }
    const inPlace = item.toRelPath === item.fromRelPath
    if (!inPlace) {
      if (!report.coverageComplete || !asset.renameAllowed) {
        blocked.push(`${item.fromRelPath} 存在未知引用或覆盖未完成，不能改扩展名`)
      }
      const destClash = report.assets.find(
        (entry) =>
          entry.relPath.toLocaleLowerCase() === item.toRelPath.toLocaleLowerCase() &&
          entry.relPath !== item.fromRelPath
      )
      if (destClash) blocked.push(`目标已存在: ${destClash.relPath}`)
      patches.push(...rewritePatches(report, item.fromRelPath, item.toRelPath, blocked))
      moves.push({ fromRelPath: item.fromRelPath, sha256: '' })
      createdRelPaths.push(item.toRelPath)
    }
    outputs.push({
      relPath: item.toRelPath,
      sha256: item.outputSha256,
      fromRelPath: item.fromRelPath
    })
    backupSet.add(item.fromRelPath)
    bytesMoved += asset.size
    bytesSaved += asset.size - item.bytesAfter
  }

  for (const patch of patches) backupSet.add(patch.sourceRelPath)
  if (blocked.length > 0) return emptyPlan('optimize', report, [...new Set(blocked)])

  return {
    id: randomUUID(),
    knowledgeBaseId: '',
    generation: report.generation,
    coverageComplete: report.coverageComplete,
    kind: 'optimize',
    inputHashes: Object.fromEntries([...backupSet].map((relPath) => [relPath, ''])),
    refFingerprint: fingerprintRefs(
      report.references.filter((ref) =>
        items.some((item) => item.fromRelPath === ref.targetRelPath && ref.rewritable)
      )
    ),
    patches,
    backups: [...backupSet].map((relPath) => ({ relPath, sha256: '' })),
    moves,
    outputs,
    createdRelPaths,
    estimated: { filesTouched: backupSet.size + createdRelPaths.length, bytesMoved, bytesSaved },
    blockedReasons: []
  }
}
