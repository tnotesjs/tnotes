/**
 * src/files.ts
 *
 * 知识库文件浏览与只读文本读取 —— Monaco 文本入口的数据面。
 *
 * 三条硬约束：
 * 1. **只列一层**：真实 KB 里有 node_modules 与构建产物（几百 MB～几 GB），
 *    递归遍历既慢又没意义；目录展开由 UI 逐层请求。
 * 2. **拒绝名单优先于一切**：`.git`、`node_modules`、生成目录（`.tnotes/dist`）
 *    与系统垃圾文件既不出现在列表里，也读不到。以后开放写入时同一份名单复用。
 * 3. **能不能当文本看由字节决定，不看扩展名**：采样里有 NUL 或不是合法 UTF-8
 *    就判二进制。`.gitignore`、`LICENSE` 这类没有扩展名的文件靠这条兜住，
 *    也避免"打开 + 保存"把二进制写坏。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { KbError } from './errors'
import { hashBytes } from './asset-scan/hash'

/** 单个文本文件上限：再大眼睛和 Monaco 都不合适，直接让用户用外部编辑器 */
export const KB_TEXT_MAX_BYTES = 4 * 1024 * 1024
/** 文本判定采样长度 */
const SNIFF_BYTES = 64 * 1024

/** 任何层级的这些目录都不可见、不可读 */
const DENIED_SEGMENTS = new Set(['.git', 'node_modules'])
/** 生成目录（相对库根，前缀匹配） */
const DENIED_PREFIXES = ['.tnotes/dist']
/** 系统垃圾文件 */
const DENIED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** 判断用的扩展名/文件名 → 文本线索（只影响 UI 提示，不作为打开依据） */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.vue',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.svg',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.sql',
  '.csv',
  '.tsv',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.editorconfig',
  '.prettierrc',
  '.eslintrc'
])
/** 无扩展名但明确是文本的文件名 */
const TEXT_FILENAMES = new Set([
  'LICENSE',
  'LICENCE',
  'COPYING',
  'NOTICE',
  'AUTHORS',
  'CHANGELOG',
  'CODEOWNERS',
  'Dockerfile',
  'Makefile',
  'Procfile'
])

export interface KbPathPolicy {
  /** 能否在 Desk 里打开（列出 / 读取） */
  openable: boolean
  /** 能否写入。本阶段（只读浏览）恒为 false，为后续"可写"预留同一判据 */
  writable: boolean
  reason?: string
}

export interface KbDirectoryEntry {
  name: string
  /** 库根相对路径（posix） */
  relPath: string
  kind: 'directory' | 'file'
  /** 文件字节数；目录为 null */
  bytes: number | null
  /** 扩展名/文件名线索：像不像文本（真正的判定在读取时按字节做） */
  textLike: boolean
}

export interface KbTextFile {
  relPath: string
  /** 已解码内容（不含 BOM） */
  content: string
  /** 原始字节数 */
  bytes: number
  /** 原始字节 hash：后续可写时的冲突判据 */
  revision: string
  /** 原文件是否带 BOM（写回时要保留，现在只上报） */
  hasBom: boolean
  eol: 'lf' | 'crlf' | 'mixed' | 'none'
  /** 给 Monaco 的初始语言 id */
  language: string
}

function normalizeRelPath(relPath: string): string {
  const normalized = relPath
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
  if (normalized === '' || normalized === '.') return ''
  const segments: string[] = []
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      throw new KbError('INVALID_OPERATION', `路径越界：${relPath}`)
    }
    segments.push(segment)
  }
  return segments.join('/')
}

/** 拒绝名单：不可见、不可读、不可写 */
function deniedReason(relPath: string): string | null {
  const segments = relPath.split('/').filter(Boolean)
  if (segments.some((segment) => DENIED_SEGMENTS.has(segment))) {
    return '该目录由 Git / 依赖管理维护，Desk 不打开'
  }
  if (DENIED_PREFIXES.some((prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`))) {
    return '这是构建产物目录，改动会被下次构建覆盖'
  }
  const name = segments.at(-1) ?? ''
  if (DENIED_NAMES.has(name)) return '系统生成的文件，Desk 不打开'
  return null
}

/** 是不是像文本：只用于列表里的图标/提示 */
export function isLikelyTextPath(relPath: string): boolean {
  const name = relPath.split('/').pop() ?? ''
  if (TEXT_FILENAMES.has(name)) return true
  if (name.startsWith('.') && !name.slice(1).includes('.')) {
    // `.gitignore` / `.npmrc` 这类"点 + 单词"的配置文件名
    return TEXT_EXTENSIONS.has(name) || TEXT_FILENAMES.has(name)
  }
  return TEXT_EXTENSIONS.has(path.posix.extname(name).toLowerCase())
}

/** 文本文件的语言 id（判不出来就是 plaintext，用来选语法高亮） */
export function languageForKbPath(relPath: string): string {
  const name = relPath.split('/').pop() ?? ''
  const lower = name.toLowerCase()
  const ext = path.posix.extname(lower)
  if (lower === '.gitignore' || lower === '.gitattributes' || lower === 'codeowners') {
    return 'plaintext'
  }
  if (lower === '.npmrc' || lower === '.editorconfig' || ext === '.ini') return 'ini'
  if (lower === 'dockerfile' || lower === 'makefile') return 'plaintext'
  switch (ext) {
    case '.md':
    case '.markdown':
      return 'markdown'
    case '.json':
    case '.jsonc':
      return 'json'
    case '.yaml':
    case '.yml':
      return 'yaml'
    case '.toml':
      return 'ini'
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    case '.ts':
    case '.tsx':
      return 'typescript'
    case '.jsx':
      return 'javascript'
    case '.vue':
      return 'html'
    case '.css':
    case '.scss':
    case '.less':
      return 'css'
    case '.html':
    case '.htm':
    case '.xml':
    case '.svg':
      return 'html'
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'shell'
    case '.py':
      return 'python'
    case '.sql':
      return 'sql'
    default:
      return 'plaintext'
  }
}

/**
 * 采样判断是不是文本。
 *
 * 只看采样：文件开头就有 NUL 或不是合法 UTF-8，就不用继续判了。
 */
export function looksLikeText(sample: Uint8Array): boolean {
  if (sample.length === 0) return true
  if (sample.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample)
    return true
  } catch {
    // 采样可能刚好切在多字节字符中间：截掉尾部最多 3 字节再试一次
    for (let trim = 1; trim <= 3 && trim < sample.length; trim += 1) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - trim))
        return true
      } catch {
        continue
      }
    }
    return false
  }
}

function detectEol(text: string): KbTextFile['eol'] {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  if (crlf === 0 && lf === 0) return 'none'
  if (crlf > 0 && lf > 0) return 'mixed'
  return crlf > 0 ? 'crlf' : 'lf'
}

export function classifyKbPath(relPath: string): KbPathPolicy {
  let normalized: string
  try {
    normalized = normalizeRelPath(relPath)
  } catch {
    return { openable: false, writable: false, reason: '路径越界' }
  }
  const denied = deniedReason(normalized)
  if (denied) return { openable: false, writable: false, reason: denied }
  // 本阶段只读：写入留到"可写文件会话"那一步，判据在这里统一
  return { openable: true, writable: false, reason: '当前只支持查看，编辑能力在后续版本开放' }
}

function resolveWithinRoot(rootPath: string, relPath: string): string {
  const root = path.resolve(rootPath)
  const absolute = path.resolve(root, relPath)
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new KbError('INVALID_OPERATION', `路径越界：${relPath}`)
  }
  return absolute
}

/**
 * 目录里除了被拒绝的条目以外什么都没有时，整个目录就不列出来。
 *
 * 典型例子是 `.tnotes`：目前里面只有构建产物 `dist`，列出来只会得到一个空目录。
 * 注意只有「确实有内容但全被拒绝」才隐藏；真正的空目录照常显示（用户可能正要看它）。
 */
async function onlyDeniedChildren(absolute: string, relPath: string): Promise<boolean> {
  let dirents
  try {
    dirents = await fs.readdir(absolute, { withFileTypes: true })
  } catch {
    return false
  }
  if (dirents.length === 0) return false
  return dirents.every((dirent) => deniedReason(`${relPath}/${dirent.name}`) !== null)
}

/** 列一层目录（`relPath` 为空串表示库根）。上游拒绝名单里的条目直接不返回。 */
export async function listKbDirectory(rootPath: string, relPath = ''): Promise<KbDirectoryEntry[]> {
  const normalized = normalizeRelPath(relPath)
  const policy = classifyKbPath(normalized)
  if (!policy.openable) {
    throw new KbError('INVALID_OPERATION', policy.reason ?? `不可访问：${relPath}`)
  }
  const absolute = resolveWithinRoot(rootPath, normalized)
  let dirents
  try {
    dirents = await fs.readdir(absolute, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new KbError('NOTE_NOT_FOUND', `目录不存在：${relPath || '/'}`)
    }
    throw error
  }

  const entries: KbDirectoryEntry[] = []
  for (const dirent of dirents) {
    const childRel = normalized ? `${normalized}/${dirent.name}` : dirent.name
    if (deniedReason(childRel)) continue
    const isDirectory = dirent.isDirectory()
    if (!isDirectory && !dirent.isFile()) continue // 符号链接等一律不列，避免越出知识库
    let bytes: number | null = null
    if (isDirectory) {
      if (await onlyDeniedChildren(resolveWithinRoot(rootPath, childRel), childRel)) continue
    } else {
      try {
        bytes = (await fs.stat(resolveWithinRoot(rootPath, childRel))).size
      } catch {
        continue // 读不到 stat 的（权限/竞态）就当不存在
      }
    }
    entries.push({
      name: dirent.name,
      relPath: childRel,
      kind: isDirectory ? 'directory' : 'file',
      bytes,
      textLike: isDirectory ? false : isLikelyTextPath(childRel)
    })
  }

  // 目录在前，各自按名字自然序（`0009` 排在 `0010` 前）
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return collator.compare(a.name, b.name)
  })
  return entries
}

/**
 * 读一个文本文件。
 *
 * 超限、命中拒绝名单、或字节判定为二进制时都抛 `KbError`：调用方据此显示原因，
 * 不猜内容、也不让 Monaco 去渲染二进制。
 */
export async function readKbTextFile(
  rootPath: string,
  relPath: string,
  options: { maxBytes?: number } = {}
): Promise<KbTextFile> {
  const normalized = normalizeRelPath(relPath)
  if (!normalized) throw new KbError('INVALID_OPERATION', '必须指定文件路径')
  const policy = classifyKbPath(normalized)
  if (!policy.openable) {
    throw new KbError('INVALID_OPERATION', policy.reason ?? `不可访问：${relPath}`)
  }
  const absolute = resolveWithinRoot(rootPath, normalized)
  let stat
  try {
    stat = await fs.stat(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new KbError('NOTE_NOT_FOUND', `文件不存在：${normalized}`)
    }
    throw error
  }
  if (stat.isDirectory()) {
    throw new KbError('INVALID_OPERATION', `这是目录，不是文件：${normalized}`)
  }
  const maxBytes = options.maxBytes ?? KB_TEXT_MAX_BYTES
  if (stat.size > maxBytes) {
    throw new KbError(
      'INVALID_OPERATION',
      `文件过大（${Math.round(stat.size / 1024)} KB），请用外部编辑器打开`
    )
  }

  const buffer = await fs.readFile(absolute)
  const head = buffer.subarray(0, SNIFF_BYTES)
  if (!looksLikeText(head)) {
    throw new KbError('INVALID_OPERATION', `不是文本文件（含二进制内容）：${normalized}`)
  }

  const hasBom =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  const body = hasBom ? buffer.subarray(3) : buffer
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new KbError('INVALID_OPERATION', `不是合法的 UTF-8 文本：${normalized}`)
  }

  return {
    relPath: normalized,
    content,
    bytes: buffer.length,
    revision: hashBytes(buffer),
    hasBom,
    eol: detectEol(content),
    language: languageForKbPath(normalized)
  }
}
