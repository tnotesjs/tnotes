/**
 * 知识库路径面包屑的纯逻辑。
 *
 * 这里不碰 Vue、也不碰 `@tnotesjs/kb`（那是主进程的 Node 包，渲染端不能引），
 * 只做四件可单测的事：
 *  1. 把「库根相对路径」切成面包屑分段，并在空间不够时把中间段折成省略号；
 *  2. 把 TOC 里的笔记编号（`0001`）索引成 uuid；
 *  3. 判断「点这一项该做什么」——进目录 / 开笔记 / 开文本 / 明确拒绝；
 *  4. 体积、编号这类小格式化。
 */

import type { DeskTocNode } from '../../../shared/contracts'

/** 面包屑里的一个路径段 */
export interface KbPathSegment {
  /** 显示文本：库根段是知识库名，其余是目录 / 文件名 */
  label: string
  /** 库根相对路径；库根段为 '' */
  relPath: string
  /** 是不是库根段（库名） */
  isRoot: boolean
}

/** 中间层级被折叠后插入的省略号段 */
export interface KbPathEllipsisSegment {
  label: string
  relPath: ''
  isRoot: false
  isEllipsis: true
  /** 被折叠掉的层级（保持原顺序），供下拉里直接访问 */
  hidden: KbPathSegment[]
}

export type KbBreadcrumbItem = KbPathSegment | KbPathEllipsisSegment

/** `noteIndex` → 笔记身份；`openNoteByUuid` 只认 uuid，标题用于兜底提示 */
export interface KbNoteRef {
  uuid: string
  title: string
}

export type KbPathOpenDecision =
  | { action: 'enter-directory'; relPath: string }
  | { action: 'open-note'; relPath: string; noteIndex: string; note: KbNoteRef }
  | { action: 'open-text'; relPath: string; notice?: string }
  | { action: 'blocked'; relPath: string; reason: string }

/**
 * 明确不是文本的扩展名（小写，含点）。
 *
 * 只列「确定打不开成文本」的：图片 / 音视频 / 压缩包 / 办公文档 / 字体 / 二进制。
 * 认不出来的扩展名一律按文本尝试——真正能不能当文本看由主进程按字节判定，
 * 渲染端不替它下结论，免得把 `Cargo.lock` 这类无扩展名配置挡在门外。
 */
const BINARY_EXTENSIONS = new Set([
  // 图片
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.icns',
  '.avif',
  '.tiff',
  '.tif',
  '.heic',
  '.heif',
  '.psd',
  '.ai',
  '.eps',
  // 音视频
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
  '.aac',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  // 压缩包
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.tgz',
  // 办公文档
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  // 字体
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  // 二进制 / 产物
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.class',
  '.jar',
  '.wasm',
  '.o',
  '.obj',
  '.lib',
  '.pdb',
  '.node',
  '.pyc',
  '.sqlite',
  '.sqlite3',
  '.db'
])

/** 画布源文件：能列出来、也能读字节，但本阶段不接渲染端画布入口 */
export const EXCALIDRAW_EXTENSION = '.excalidraw'

/** 笔记目录（库根相对）：只有这里的 `.md` 才按「笔记」路由 */
const NOTES_DIR = 'notes'

/** 把斜杠路径切成非空段（容忍反斜杠与多余分隔符） */
export function splitKbRelPath(relPath: string): string[] {
  return relPath
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.')
}

/** 取库根相对路径的父目录；根 / 顶层条目的父目录是 '' */
export function parentDirOf(relPath: string): string {
  const segments = splitKbRelPath(relPath)
  return segments.slice(0, -1).join('/')
}

/** 取路径里的文件名（最后一段） */
export function baseNameOf(relPath: string): string {
  return splitKbRelPath(relPath).at(-1) ?? ''
}

/** 小写扩展名（含点）；`.gitignore` 这种没有扩展名，返回 '' */
export function extensionOf(relPath: string): string {
  const name = baseNameOf(relPath)
  const index = name.lastIndexOf('.')
  if (index <= 0) return ''
  return name.slice(index).toLowerCase()
}

/**
 * 构造从库根出发的完整分段：库名 + 每一级目录 + 文件名。
 *
 * 例：`buildKbPathSegments('hello-algo', 'notes/0001. hello-algo.md')`
 * → `[hello-algo(''), notes, 0001. hello-algo.md]`
 */
export function buildKbPathSegments(rootName: string, relPath: string): KbPathSegment[] {
  const segments = splitKbRelPath(relPath)
  const result: KbPathSegment[] = [{ label: rootName, relPath: '', isRoot: true }]
  let current = ''
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment
    result.push({ label: segment, relPath: current, isRoot: false })
  }
  return result
}

/**
 * 空间不够时把中间层级折成一个省略号段：保留库名与当前文件名，
 * 被折掉的层级挂在 `hidden` 上，下拉里仍可直接进入。
 *
 * `capacity` 是预估能放下的分段数；小于 3 时不折叠（放不下「首段 + … + 末段」）。
 */
export function foldKbPathSegments(
  segments: KbPathSegment[],
  capacity: number
): KbBreadcrumbItem[] {
  const limit = Math.floor(capacity)
  if (!Number.isFinite(limit) || limit < 3 || segments.length <= limit) return [...segments]
  const head = segments.slice(0, limit - 2)
  const hidden = segments.slice(limit - 2, segments.length - 1)
  if (hidden.length === 0) return [...segments]
  const tail = segments[segments.length - 1]
  return [...head, { label: '…', relPath: '', isRoot: false, isEllipsis: true, hidden }, tail]
}

/** 文件名开头的四位编号（必须后面不是数字，`00012` 不算） */
export function noteIndexFromFileName(fileName: string): string | null {
  const matched = /^(\d{4})(?=\D|$)/.exec(fileName.trim())
  return matched ? matched[1] : null
}

/** 是不是 `notes/` 下的文件（笔记候选只看这个目录） */
export function isUnderNotesDir(relPath: string): boolean {
  const segments = splitKbRelPath(relPath)
  return segments.length >= 2 && segments[0] === NOTES_DIR
}

/** 画布源文件 */
export function isExcalidrawPath(relPath: string): boolean {
  return extensionOf(relPath) === EXCALIDRAW_EXTENSION
}

/**
 * 扩展名层面的「像不像文本」：只用于「已知非文本不打开」这条规则与下拉弱提示。
 * 真正判定在主进程按字节做，这里宁可放过、不要错杀。
 */
export function looksLikeTextPath(relPath: string): boolean {
  return !BINARY_EXTENSIONS.has(extensionOf(relPath))
}

/**
 * 递归索引 TOC：`noteIndex` → `{ uuid, title }`。
 *
 * 同一编号出现多次（不同目录）时保留先遇到的，行为稳定且可预期。
 */
export function buildNoteIndex(toc: DeskTocNode[]): Map<string, KbNoteRef> {
  const index = new Map<string, KbNoteRef>()
  const queue = [...toc]
  while (queue.length > 0) {
    const node = queue.shift()!
    if (node.type === 'note' && !index.has(node.noteIndex)) {
      index.set(node.noteIndex, { uuid: node.uuid, title: node.title })
    }
    queue.unshift(...node.children)
  }
  return index
}

/**
 * 「点这一项该做什么」的唯一判据。纯函数，UI 只负责执行结果。
 *
 * - 目录 → 推进层级（不是打开文件）
 * - `.excalidraw` → 明确拒绝（从引用它的笔记打开画布）
 * - `notes/` 下带四位编号的 `.md` → 命中 TOC 就用笔记会话打开；没命中退回文本并说明
 * - 已知二进制扩展名 → 明确拒绝
 * - 其余 → 按文本文件打开
 */
export function decideKbPathOpen(input: {
  relPath: string
  kind: 'directory' | 'file'
  noteIndex: ReadonlyMap<string, KbNoteRef>
}): KbPathOpenDecision {
  const { relPath, kind, noteIndex } = input
  if (kind === 'directory') return { action: 'enter-directory', relPath }
  if (isExcalidrawPath(relPath)) {
    return {
      action: 'blocked',
      relPath,
      reason: '这是画布源文件，请从引用它的笔记中打开画布'
    }
  }
  const fileName = baseNameOf(relPath)
  if (isUnderNotesDir(relPath)) {
    const fileIndex = noteIndexFromFileName(fileName)
    if (fileIndex) {
      const note = noteIndex.get(fileIndex)
      if (note) return { action: 'open-note', relPath, noteIndex: fileIndex, note }
      return {
        action: 'open-text',
        relPath,
        notice: `目录里没有编号 ${fileIndex} 的笔记，已按文本文件打开`
      }
    }
  }
  if (!looksLikeTextPath(relPath)) {
    return {
      action: 'blocked',
      relPath,
      reason: `${fileName} 不是文本文件，Desk 暂不支持打开`
    }
  }
  return { action: 'open-text', relPath }
}

/** 下拉里的体积展示；目录（null）返回空串 */
export function formatKbEntryBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
