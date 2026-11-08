/**
 * src/excalidraw.ts
 *
 * `.excalidraw` 源文件是自由绘图的唯一真相源：图片内嵌在 JSON 的 `files` 里，
 * 不拆成 assets 图片。
 *
 * 笔记里引用的是**派生的同名 `.svg`**（`0013-x.excalidraw` ↔ `0013-x.svg`）：
 * 它由宿主用官方 `exportToSvg` 生成，只服务「别的 markdown 渲染器也能看」。
 * 判据只有一条：同名 `.excalidraw` 在 → 这张图可以编辑；不在 → 它就是一张普通图片。
 *
 * 本模块只做「文件级」的事：归属前缀校验、排他命名、原子写、期望版本校验、
 * 同笔记复制、派生产物的同名写入与识别。会话/自动写入/撤销历史由宿主负责。
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic } from './atomic'
import { ASSETS_DIR } from './constants'
import { KbError } from './errors'
import { hashBytes } from './asset-scan/hash'
import { ownerNoteIndexFromName } from './asset-scan/owner'

export const EXCALIDRAW_EXTENSION = '.excalidraw'
/** 派生产物后缀：与源画布同目录同名，只换后缀 */
export const EXCALIDRAW_DERIVED_EXTENSION = '.svg'

/** 单文件上限：画布内嵌图片会显著放大 JSON，给足空间但不能无上限。 */
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024

export interface ExcalidrawDocumentRef {
  relPath: string
  ownerNoteIndex: string
  revision: string
}

export interface ExcalidrawDocument extends ExcalidrawDocumentRef {
  content: string
  /** JSON 解析 + type 校验是否通过；false 时宿主必须只报错，不得写回。 */
  valid: boolean
  bytes: number
}

export interface CreateExcalidrawDocumentInput {
  ownerNoteIndex: string
  /** 空场景 JSON；由宿主用官方 serializeAsJSON 生成，缺省用内置最小场景 */
  content?: string
  /** 便于测试与可复现命名 */
  now?: Date
}

export interface WriteExcalidrawDocumentInput {
  relPath: string
  content: string
  /** 读取时的 revision；不一致说明磁盘被外部改过 */
  expectedRevision: string
}

export interface CopyExcalidrawDocumentInput {
  fromRelPath: string
  /** 目标笔记编号：跨笔记复制必须换前缀，禁止跨笔记共享同一文件 */
  toOwnerNoteIndex: string
  now?: Date
}

export interface WriteExcalidrawDerivedSvgInput {
  /** 源画布（assets/*.excalidraw）；派生产物与它同目录同名 */
  sourceRelPath: string
  content: string
}

export interface ExcalidrawDerivedSvgRef {
  /** 派生产物的 KB 相对路径，笔记里引用的就是它 */
  relPath: string
  sourceRelPath: string
  ownerNoteIndex: string
}

export interface ExcalidrawSourceRef {
  /** 同名 `.excalidraw` 的 KB 相对路径 */
  relPath: string
  ownerNoteIndex: string
}

/** 最小合法空场景。字段与官方 serializeAsJSON 输出保持同一形状。 */
export function emptyExcalidrawScene(): string {
  return `${JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'tnotes-desk',
      elements: [],
      appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
      files: {}
    },
    null,
    2
  )}\n`
}

function normalizeOwnerIndex(index: string): string {
  const trimmed = index.trim()
  if (!/^\d{4}$/.test(trimmed)) {
    throw new KbError('INVALID_INDEX', `笔记编号必须是四位数字：${index}`)
  }
  return trimmed
}

/** KB 相对路径 → 绝对路径，并确认没有逃出 assets/ 与 KB 根。 */
function resolveAssetPath(rootPath: string, relPath: string, extension: string): string {
  const normalized = relPath.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized.startsWith(`${ASSETS_DIR}/`)) {
    throw new KbError('INVALID_OPERATION', `画布必须放在 ${ASSETS_DIR}/ 下：${relPath}`)
  }
  if (path.posix.extname(normalized).toLowerCase() !== extension) {
    throw new KbError('INVALID_OPERATION', `只允许 ${extension} 文件：${relPath}`)
  }
  const withinAssets = path.posix.normalize(normalized)
  if (!withinAssets.startsWith(`${ASSETS_DIR}/`)) {
    throw new KbError('INVALID_OPERATION', `画布路径越界：${relPath}`)
  }
  const root = path.resolve(rootPath)
  const absolute = path.resolve(root, withinAssets)
  if (!absolute.startsWith(root + path.sep)) {
    throw new KbError('INVALID_OPERATION', `画布路径越界：${relPath}`)
  }
  return absolute
}

function resolveDocumentPath(rootPath: string, relPath: string): string {
  return resolveAssetPath(rootPath, relPath, EXCALIDRAW_EXTENSION)
}

function assertOwnership(relPath: string, expectedOwner?: string): string {
  const owner = ownerNoteIndexFromName(path.posix.basename(relPath))
  if (!owner) {
    // 新命名没有笔记前缀。旧的四位前缀仍校验归属；新文件的归属看谁引用了它。
    return expectedOwner ? normalizeOwnerIndex(expectedOwner) : ''
  }
  if (expectedOwner && owner !== normalizeOwnerIndex(expectedOwner)) {
    throw new KbError(
      'INVALID_OPERATION',
      `画布归属为 ${owner}，与目标笔记 ${expectedOwner} 不一致`,
      { owner, expectedOwner }
    )
  }
  return owner
}

function assertValidScene(content: string, relPath: string): void {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new KbError('INVALID_OPERATION', `画布文件过大（${bytes} 字节）`, {
      limit: MAX_DOCUMENT_BYTES
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new KbError('INVALID_OPERATION', `画布不是合法 JSON，已拒绝写入：${relPath}`, {
      cause: error instanceof Error ? error.message : String(error)
    })
  }
  if (!isExcalidrawScene(parsed)) {
    throw new KbError('INVALID_OPERATION', `不是 Excalidraw 场景，已拒绝写入：${relPath}`)
  }
}

function isExcalidrawScene(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const scene = value as { type?: unknown; elements?: unknown }
  return scene.type === 'excalidraw' && Array.isArray(scene.elements)
}

/** 新画板：`YY-MM-DD-HH-mm-ss-{random}`，不带笔记编号。随机段避免空场景内容哈希撞车。 */
function timestampName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    pad(now.getFullYear() % 100),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('-')
}

/**
 * 排他命名：同一秒内多次创建也不能互相覆盖。用 `wx` 打开，冲突则换后缀重试，
 * 因此并发创建（多窗口/多入口）不会写坏彼此的文件。
 */
async function createExclusive(
  rootPath: string,
  ownerNoteIndex: string,
  content: string,
  now: Date
): Promise<string> {
  void ownerNoteIndex
  const base = `${timestampName(now)}-${randomBytes(4).toString('hex')}`
  const assetsDir = path.join(path.resolve(rootPath), ASSETS_DIR)
  await fs.mkdir(assetsDir, { recursive: true })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`
    const fileName = `${base}${suffix}${EXCALIDRAW_EXTENSION}`
    const absolute = path.join(assetsDir, fileName)
    try {
      await fs.writeFile(absolute, content, { encoding: 'utf8', flag: 'wx' })
      return `${ASSETS_DIR}/${fileName}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  throw new KbError('INVALID_OPERATION', '同一秒内创建了过多画布，请稍后重试')
}

export async function createExcalidrawDocument(
  rootPath: string,
  input: CreateExcalidrawDocumentInput
): Promise<ExcalidrawDocumentRef> {
  const content = input.content ?? emptyExcalidrawScene()
  assertValidScene(content, 'new')
  const relPath = await createExclusive(
    rootPath,
    input.ownerNoteIndex,
    content,
    input.now ?? new Date()
  )
  return {
    relPath,
    ownerNoteIndex: normalizeOwnerIndex(input.ownerNoteIndex),
    revision: hashBytes(content)
  }
}

export async function readExcalidrawDocument(
  rootPath: string,
  relPath: string
): Promise<ExcalidrawDocument> {
  const owner = assertOwnership(relPath)
  const absolute = resolveDocumentPath(rootPath, relPath)
  let content: string
  try {
    content = await fs.readFile(absolute, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new KbError('NOTE_NOT_FOUND', `画布文件不存在：${relPath}`)
    }
    throw error
  }
  let valid = false
  try {
    valid = isExcalidrawScene(JSON.parse(content))
  } catch {
    valid = false
  }
  return {
    relPath,
    ownerNoteIndex: owner,
    revision: hashBytes(content),
    content,
    valid,
    bytes: Buffer.byteLength(content, 'utf8')
  }
}

export async function writeExcalidrawDocument(
  rootPath: string,
  input: WriteExcalidrawDocumentInput
): Promise<ExcalidrawDocumentRef> {
  // 归属与路径先校验：写操作绝不允许把文件写到别人的前缀上或库外
  const owner = assertOwnership(input.relPath)
  const absolute = resolveDocumentPath(rootPath, input.relPath)
  assertValidScene(input.content, input.relPath)

  let current: string
  try {
    current = await fs.readFile(absolute, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new KbError('NOTE_NOT_FOUND', `画布文件不存在：${input.relPath}`)
    }
    throw error
  }
  if (hashBytes(current) !== input.expectedRevision) {
    throw new KbError('REVISION_CONFLICT', `画布已被外部修改：${input.relPath}`, {
      expected: input.expectedRevision,
      actual: hashBytes(current)
    })
  }
  await writeFileAtomic(absolute, input.content)
  return { relPath: input.relPath, ownerNoteIndex: owner, revision: hashBytes(input.content) }
}

export async function copyExcalidrawDocument(
  rootPath: string,
  input: CopyExcalidrawDocumentInput
): Promise<ExcalidrawDocumentRef> {
  const source = await readExcalidrawDocument(rootPath, input.fromRelPath)
  if (!source.valid) {
    throw new KbError('INVALID_OPERATION', `源画布不是合法场景，已拒绝复制：${input.fromRelPath}`)
  }
  // 复制保留全部内容与内嵌图片；目标换前缀，绝不跨笔记共享同一文件
  return await createExcalidrawDocument(rootPath, {
    ownerNoteIndex: input.toOwnerNoteIndex,
    content: source.content,
    now: input.now
  })
}

/** 由源画布路径推出派生产物路径：同目录同名，只换后缀 */
export function derivedSvgRelPath(sourceRelPath: string): string {
  const normalized = sourceRelPath.replaceAll('\\', '/')
  return `${normalized.slice(0, -EXCALIDRAW_EXTENSION.length)}${EXCALIDRAW_DERIVED_EXTENSION}`
}

/** 由派生产物路径推回源画布路径（同一规则的反向） */
export function sourceRelPathForDerived(derivedRelPath: string): string {
  const normalized = derivedRelPath.replaceAll('\\', '/')
  return `${normalized.slice(0, -EXCALIDRAW_DERIVED_EXTENSION.length)}${EXCALIDRAW_EXTENSION}`
}

const SVG_DOCUMENT = /^\s*(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*)*<svg[\s>]/i

function assertSvgContent(content: string, relPath: string): void {
  if (!SVG_DOCUMENT.test(content)) {
    throw new KbError('INVALID_OPERATION', `派生产物必须是 SVG：${relPath}`)
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new KbError('INVALID_OPERATION', `派生 SVG 过大（${bytes} 字节）`, {
      limit: MAX_DOCUMENT_BYTES
    })
  }
}

/**
 * 写入画布的派生 SVG（`assets/0013-x.svg`）。
 *
 * 路径不接受调用方指定：只能由源画布路径推出来，且源画布必须已经存在 ——
 * 否则派生产物就成了没人管的孤儿文件，笔记里那张图也就失去了「可编辑」的判据。
 */
export async function writeExcalidrawDerivedSvg(
  rootPath: string,
  input: WriteExcalidrawDerivedSvgInput
): Promise<ExcalidrawDerivedSvgRef> {
  const owner = assertOwnership(input.sourceRelPath)
  const sourceAbsolute = resolveDocumentPath(rootPath, input.sourceRelPath)
  const relPath = derivedSvgRelPath(input.sourceRelPath)
  assertSvgContent(input.content, relPath)
  try {
    await fs.access(sourceAbsolute)
  } catch {
    throw new KbError('NOTE_NOT_FOUND', `画布文件不存在：${input.sourceRelPath}`)
  }
  await writeFileAtomic(
    resolveAssetPath(rootPath, relPath, EXCALIDRAW_DERIVED_EXTENSION),
    input.content
  )
  return { relPath, sourceRelPath: input.sourceRelPath, ownerNoteIndex: owner }
}

/**
 * 笔记里引用的 `.svg` 是不是某张画布的派生图 —— 判据是**同名 `.excalidraw` 在不在**。
 *
 * 这不是校验而是探测：普通图片（含没有四位编号前缀的 `.svg`）一律返回 null，不抛错。
 */
export async function findExcalidrawSourceFor(
  rootPath: string,
  derivedRelPath: string
): Promise<ExcalidrawSourceRef | null> {
  const normalized = derivedRelPath.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized.startsWith(`${ASSETS_DIR}/`)) return null
  if (path.posix.extname(normalized).toLowerCase() !== EXCALIDRAW_DERIVED_EXTENSION) return null
  const sourceRelPath = sourceRelPathForDerived(path.posix.normalize(normalized))
  const owner = ownerNoteIndexFromName(path.posix.basename(sourceRelPath)) ?? ''
  try {
    await fs.access(resolveDocumentPath(rootPath, sourceRelPath))
  } catch {
    return null
  }
  return { relPath: sourceRelPath, ownerNoteIndex: owner }
}
