import { extname, posix } from 'node:path'

import { readGitHubToken } from './imageSecret'
import { maybeOptimizeUploadRequest } from './imageUploadOptimize'
import { loadSettings } from './settings'
import { workspaceManager } from './workspaceManager'

import type {
  GitHubImageSettings,
  ImageSettingsValidateResult,
  ImageUploadRequest,
  ImageUploadResult
} from '../shared/contracts'

const GITHUB_API_VERSION = '2026-03-10'

export interface GitHubRepository {
  owner: string
  repository: string
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, '0')
}

export function parseGitHubRepository(input: string): GitHubRepository {
  const trimmed = input
    .trim()
    .replace(/\/$/, '')
    .replace(/\.git$/i, '')
  let pathname = trimmed
  try {
    const url = new URL(trimmed)
    if (url.hostname.toLowerCase() !== 'github.com') throw new Error('仅支持 GitHub 仓库')
    pathname = url.pathname
  } catch (error) {
    if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) throw error
  }
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length !== 2 || !segments.every((segment) => /^[\w.-]+$/.test(segment))) {
    throw new Error('GitHub 仓库应填写 owner/repository 或完整仓库地址')
  }
  return { owner: segments[0], repository: segments[1] }
}

/** Local paste into `assets/`: `{index}-{YY}-{MM}-{DD}-{HH}-{mm}-{ss}{ext}`. */
export const LOCAL_PASTED_ASSET_NAME_FORMAT = '${index}-${YY}-${MM}-${DD}-${HH}-${mm}-${ss}'

export function formatImageFileName(
  format: string,
  originalName: string,
  date = new Date(),
  duplicateIndex = 0,
  extraTokens: Record<string, string> = {}
): string {
  const tokens: Record<string, string> = {
    YYYY: date.getFullYear().toString(),
    YY: twoDigits(date.getFullYear() % 100),
    MM: twoDigits(date.getMonth() + 1),
    DD: twoDigits(date.getDate()),
    HH: twoDigits(date.getHours()),
    mm: twoDigits(date.getMinutes()),
    ss: twoDigits(date.getSeconds()),
    index: extraTokens.index ?? ''
  }
  const extension = extname(originalName).toLowerCase() || '.png'
  const replaced = format.replace(
    /\$\{(YYYY|YY|MM|DD|HH|mm|ss|index)\}/g,
    (_match, key) => tokens[key] ?? ''
  )
  const withoutControlCharacters = [...replaced]
    .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
    .join('')
  const sanitized = withoutControlCharacters
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^\.+/, '')
    .trim()
  const base = sanitized || `image-${date.getTime()}`
  const suffix = duplicateIndex > 0 ? `-${duplicateIndex + 1}` : ''
  return `${base}${suffix}${extname(base) ? '' : extension}`
}

export function normalizeRemotePath(configuredPath: string, fileName: string): string {
  const segments = configuredPath
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
  return posix.join(...segments, fileName)
}

export function renderCdnUrl(
  template: string,
  repository: GitHubRepository,
  branch: string,
  remotePath: string
): string {
  const values: Record<string, string> = {
    username: repository.owner,
    repository: repository.repository,
    branch,
    filepath: remotePath
  }
  const result = template.replace(
    /\$\{(username|repository|branch|filepath)\}/g,
    (_match, key) => values[key]
  )
  const url = new URL(result)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('CDN 模板必须生成 HTTP 或 HTTPS 地址')
  }
  return url.toString()
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION
  }
}

function encodedRepositoryPath(repository: GitHubRepository): string {
  return `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`
}

function encodedContentPath(remotePath: string): string {
  return remotePath.split('/').map(encodeURIComponent).join('/')
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: unknown }
    if (typeof payload.message === 'string') return payload.message
  } catch {
    // GitHub can return an empty body for some proxy and connectivity errors.
  }
  return `HTTP ${response.status}`
}

export async function validateGitHubImageSettings(
  github: GitHubImageSettings,
  tokenOverride?: string
): Promise<ImageSettingsValidateResult> {
  const repository = parseGitHubRepository(github.repository)
  const token = tokenOverride?.trim() || readGitHubToken()
  if (!token) throw new Error('请先填写或保存 GitHub Token')
  const branch = github.branch.trim()
  if (!branch) throw new Error('GitHub 分支不能为空')
  const endpoint = `https://api.github.com/repos/${encodedRepositoryPath(repository)}/contents?ref=${encodeURIComponent(branch)}`
  const response = await fetch(endpoint, { headers: githubHeaders(token) })
  if (!response.ok) {
    throw new Error(`GitHub 配置验证失败：${await responseMessage(response)}`)
  }
  return {
    repository: `${repository.owner}/${repository.repository}`,
    branch,
    message: '仓库、分支和 Token 均可访问'
  }
}

async function uploadToGitHub(
  request: ImageUploadRequest,
  github: GitHubImageSettings,
  token: string
): Promise<ImageUploadResult> {
  const repository = parseGitHubRepository(github.repository)
  const branch = github.branch.trim()
  if (!branch) throw new Error('GitHub 分支不能为空')
  const now = new Date()
  let lastError = '远端路径已存在'
  for (let duplicateIndex = 0; duplicateIndex < 10; duplicateIndex += 1) {
    const fileName = formatImageFileName(
      github.fileNameFormat,
      request.fileName,
      now,
      duplicateIndex
    )
    const remotePath = normalizeRemotePath(github.path, fileName)
    const endpoint = `https://api.github.com/repos/${encodedRepositoryPath(repository)}/contents/${encodedContentPath(remotePath)}`
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        ...githubHeaders(token),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `docs: upload ${fileName}`,
        content: Buffer.from(request.data).toString('base64'),
        branch
      })
    })
    if (response.ok) {
      return {
        markdownPath: renderCdnUrl(github.cdnTemplate, repository, branch, remotePath),
        target: 'github',
        fallback: false,
        remotePath
      }
    }
    lastError = await responseMessage(response)
    if (response.status !== 422) break
  }
  throw new Error(`GitHub 上传失败：${lastError}`)
}

/** 图床可用：仓库地址能解析、分支非空、Token 已保存（不发网络请求）。 */
export function imageBedReady(github: GitHubImageSettings = loadSettings().imageUpload.github): boolean {
  try {
    parseGitHubRepository(github.repository)
  } catch {
    return false
  }
  return Boolean(github.branch.trim()) && Boolean(readGitHubToken())
}

class ImageBedManager {
  private queue: Promise<void> = Promise.resolve()

  upload(request: ImageUploadRequest): Promise<ImageUploadResult> {
    return this.enqueue(() => this.performUpload(request))
  }

  /** 「推到图床」：只传 GitHub，失败直接报错，不回退本地 */
  pushToGitHub(request: ImageUploadRequest): Promise<ImageUploadResult> {
    return this.enqueue(async () => {
      const github = loadSettings().imageUpload.github
      const token = readGitHubToken()
      if (!token || !imageBedReady(github)) throw new Error('尚未配置 GitHub 图床')
      return await uploadToGitHub(request, github, token)
    })
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(run)
    this.queue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async performUpload(request: ImageUploadRequest): Promise<ImageUploadResult> {
    const settings = loadSettings().imageUpload
    // Paste/upload uses the same optimize defaults as the settings playground.
    const prepared = await maybeOptimizeUploadRequest(request)
    if (settings.defaultTarget === 'github') {
      const token = readGitHubToken()
      try {
        if (!token) throw new Error('尚未配置 GitHub Token')
        return await uploadToGitHub(prepared, settings.github, token)
      } catch (error) {
        const local = await workspaceManager.writeLocalAttachment(prepared)
        const reason = error instanceof Error ? error.message : String(error)
        return {
          ...local,
          target: 'local',
          fallback: true,
          warning: `${reason}；图片已自动保存到当前笔记的 assets 目录`
        }
      }
    }
    const local = await workspaceManager.writeLocalAttachment(prepared)
    return { ...local, target: 'local', fallback: false }
  }
}

export const imageBedManager = new ImageBedManager()
