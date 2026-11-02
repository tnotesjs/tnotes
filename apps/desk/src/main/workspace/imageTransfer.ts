import path from 'node:path'
import fs from 'node:fs/promises'

import { README_NOTE_UUID } from '../../shared/contracts'
import { resolveNoteAsset, resolveNoteIndex, type NoteMutationSideEffects } from './noteIo'

import type {
  AttachmentReleaseLocalRequest,
  AttachmentReleaseLocalResult
} from '../../shared/contracts'
import type { KnowledgeBaseHandle } from './types'

/** 与附件写入同口径 */
export const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp'
}

export interface DownloadedImage {
  fileName: string
  data: Uint8Array
}

/** 下载在线图片：只认 http(s)、`image/*`，体积不超过 25 MB。文件名取 URL 末段，缺扩展名按 MIME 补。 */
export async function downloadRemoteImage(
  url: string,
  fetchImpl: (input: string) => Promise<Response>
): Promise<DownloadedImage> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('图片地址无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只能拉取 http / https 图片')
  }
  const response = await fetchImpl(parsed.toString())
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!mime.startsWith('image/')) throw new Error('下载到的不是图片')
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_REMOTE_IMAGE_BYTES) throw new Error('图片超过 25 MB')
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength === 0) throw new Error('下载到的图片为空')
  if (data.byteLength > MAX_REMOTE_IMAGE_BYTES) throw new Error('图片超过 25 MB')
  let base = ''
  try {
    base = decodeURIComponent(path.posix.basename(parsed.pathname))
  } catch {
    base = path.posix.basename(parsed.pathname)
  }
  const extension = path.extname(base).toLowerCase()
  const known = Object.values(EXTENSION_BY_MIME).includes(extension) || extension === '.jpeg'
  const fileName = known ? base : `${base || 'image'}${EXTENSION_BY_MIME[mime] ?? '.png'}`
  return { fileName, data }
}

/** 复制 / 导出：按 Markdown 地址取图片原始字节（在线图下载、assets 图读盘、data: 直接解码） */
export async function loadImageBytes(
  src: string,
  deps: {
    resolveLocal: (src: string) => Promise<string>
    fetchImpl: (input: string) => Promise<Response>
  }
): Promise<DownloadedImage> {
  const trimmed = src.trim()
  if (/^https?:\/\//i.test(trimmed)) return downloadRemoteImage(trimmed, deps.fetchImpl)
  const data = /^data:(image\/[\w.+-]+)(;base64)?,(.*)$/is.exec(trimmed)
  if (data) {
    const bytes = data[2]
      ? Buffer.from(data[3], 'base64')
      : Buffer.from(decodeURIComponent(data[3]), 'utf8')
    return {
      fileName: `image${EXTENSION_BY_MIME[data[1].toLowerCase()] ?? '.png'}`,
      data: new Uint8Array(bytes)
    }
  }
  let local = trimmed
  try {
    local = decodeURI(trimmed)
  } catch {
    // 保留原样
  }
  const absolutePath = await deps.resolveLocal(local)
  return {
    fileName: path.basename(absolutePath),
    data: new Uint8Array(await fs.readFile(absolutePath))
  }
}

/**
 * Markdown 原文是否还引用 `assets/<relWithinAssets>`。前缀不限（`../assets/`、`./assets/`、
 * 裸 `assets/` 都算），也认 URL 编码写法；宁可多认，不误删。
 */
export function referencesAsset(content: string, relWithinAssets: string): boolean {
  const variants = new Set([
    relWithinAssets,
    encodeURI(relWithinAssets),
    relWithinAssets.split('/').map(encodeURIComponent).join('/')
  ])
  for (const variant of variants) {
    if (content.includes(`assets/${variant}`)) return true
  }
  return false
}

async function markdownFilesOf(handle: KnowledgeBaseHandle): Promise<string[]> {
  const files = new Set<string>(handle.snapshot.notes.map((note) => note.relPath))
  for (const name of await fs.readdir(path.join(handle.rootPath, 'notes'))) {
    if (name.endsWith('.md')) files.add(`notes/${name}`)
  }
  try {
    await fs.access(path.join(handle.rootPath, 'README.md'))
    files.add('README.md')
  } catch {
    // 没有 README
  }
  return [...files]
}

/**
 * 推到图床并改写 `src` 之后调用：扫知识库所有笔记（含 README），当前笔记用编辑器里的最新内容；
 * 没有任何引用才删除本地文件。扫描或删除出错一律不删。
 */
export async function releaseLocalAsset(
  handle: KnowledgeBaseHandle,
  request: AttachmentReleaseLocalRequest,
  effects: NoteMutationSideEffects
): Promise<AttachmentReleaseLocalResult> {
  try {
    const absolutePath = await resolveNoteAsset(handle, request.src)
    const relPath = path.relative(path.resolve(handle.rootPath), absolutePath).replaceAll('\\', '/')
    const relWithinAssets = relPath.replace(/^assets\//, '')
    const currentRelPath =
      request.noteUuid === README_NOTE_UUID
        ? 'README.md'
        : handle.snapshot.notes.find(
            (note) => note.index === resolveNoteIndex(handle, request.noteUuid)
          )?.relPath
    if (!currentRelPath) return { deleted: false, reason: 'scan-failed' }
    if (referencesAsset(request.content, relWithinAssets)) {
      return { deleted: false, reason: 'referenced' }
    }
    for (const file of await markdownFilesOf(handle)) {
      if (file === currentRelPath) continue
      const content = await fs.readFile(path.join(handle.rootPath, file), 'utf8')
      if (referencesAsset(content, relWithinAssets)) return { deleted: false, reason: 'referenced' }
    }
    await fs.rm(absolutePath)
    effects.markInternalWrites(handle.rootPath, [{ path: relPath }])
    handle.snapshot = await handle.workspace.scan()
    effects.emitChanged()
    return { deleted: true }
  } catch {
    return { deleted: false, reason: 'scan-failed' }
  }
}
