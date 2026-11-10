import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * 笔记/资源历史：**纯读取** Git 快照（计划 H1）。
 *
 * 约束：
 * - 只读：不改工作区、索引、HEAD，不执行 revision 表达式（只接受 40 位 OID，
 *   且必须能在本库 `rev-list` 里找到）
 * - 不能只 `git log --follow 当前文件名`：整篇笔记的历史包含「同编号的旧文件名」
 *   与「同编号资源」的变化，所以按**四位编号**识别
 * - 分页固定在一个 HEAD 上做（外部 HEAD 漂移不会让翻页重复/漏项）
 * - 路径用参数数组传递，不用 shell 拼接；blob 读写支持二进制与中文/空格/括号
 */

const FULL_OID = /^[0-9a-f]{40}$/
const NOTE_INDEX = /^(\d{4})[.\s-]/
const ASSET_OWNER = /^(\d{4})-/

function referencedAssetPaths(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(/(?:\.\.\/)?assets\/[^\s)"'>]+/g)) {
    const raw = (match[0] ?? '').replace(/^\.\.\//, '').split(/[?#]/)[0] ?? ''
    if (raw.startsWith('assets/')) found.add(raw)
  }
  return found
}

export type GitHistoryErrorCode =
  'NOT_A_REPO' | 'NO_HEAD' | 'BAD_REVISION' | 'UNKNOWN_COMMIT' | 'UNKNOWN_PATH' | 'GIT_FAILED'

export class GitHistoryError extends Error {
  readonly code: GitHistoryErrorCode
  readonly detail?: string

  constructor(code: GitHistoryErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'GitHistoryError'
    this.code = code
    this.detail = detail
  }
}

export interface GitHistoryOptions {
  gitExecutable?: string
  env?: NodeJS.ProcessEnv
}

async function runGit(
  rootPath: string,
  args: string[],
  options: GitHistoryOptions = {}
): Promise<{ stdout: Buffer; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.gitExecutable ?? 'git', ['-c', 'core.quotepath=false', ...args], {
      cwd: rootPath,
      env: {
        ...process.env,
        ...options.env,
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const out = Buffer.concat(stdout)
      const err = Buffer.concat(stderr).toString('utf8')
      if (code === 0) resolve({ stdout: out, stderr: err })
      else
        reject(
          new GitHistoryError(
            'GIT_FAILED',
            `git ${args.join(' ')} 失败（exit ${code}）：${err.trim()}`,
            err
          )
        )
    })
  })
}

async function runGitText(
  rootPath: string,
  args: string[],
  options: GitHistoryOptions = {}
): Promise<string> {
  return (await runGit(rootPath, args, options)).stdout.toString('utf8')
}

/** 当前 HEAD 的完整 OID；没有提交（空仓库）时返回 null。 */
export async function resolveHead(
  rootPath: string,
  options: GitHistoryOptions = {}
): Promise<string | null> {
  try {
    await runGitText(rootPath, ['rev-parse', '--git-dir'], options)
  } catch {
    throw new GitHistoryError('NOT_A_REPO', `不是 Git 仓库：${rootPath}`)
  }
  try {
    // --quiet：空仓库（HEAD 未诞生）时静默失败，不能当成错误
    const head = (
      await runGitText(rootPath, ['rev-parse', '--verify', '--quiet', 'HEAD'], options)
    ).trim()
    return FULL_OID.test(head) ? head : null
  } catch {
    return null
  }
}

export interface HistoryCommitSummary {
  oid: string
  shortOid: string
  /** Unix 秒（提交时间） */
  committedAt: number
  authorName: string
  subject: string
  parents: string[]
  /** 相对第一父提交的改动路径（含资源）；合并提交按第一父展开 */
  changedPaths: string[]
  isMerge: boolean
  /** 该提交是否与给定编号相关（笔记文件或同编号资源） */
  touchesIndex: boolean
}

export interface HistoryListOptions extends GitHistoryOptions {
  /** 固定在一个 commit 上翻页；缺省用当前 HEAD */
  head?: string
  skip?: number
  limit?: number
  /** 只保留与该编号相关的提交（笔记文件 + 同编号资源） */
  noteIndex?: string
  /** 按编号过滤时最多扫描多少个提交（测试与超长历史用） */
  maxScanCommits?: number
}

export interface HistoryListPage {
  head: string
  commits: HistoryCommitSummary[]
  hasMore: boolean
  /** 浅克隆：本地历史只到克隆深度，更早的提交不可见 */
  shallow: boolean
  /** 命中扫描上限：更早的相关提交没有全部读完 */
  truncated: boolean
}

function isIndexRelated(relPath: string, noteIndex: string): boolean {
  const basename = relPath.split('/').pop() ?? ''
  const noteMatch = NOTE_INDEX.exec(basename)
  if (relPath.startsWith('notes/') && noteMatch?.[1] === noteIndex) return true
  const assetMatch = ASSET_OWNER.exec(basename)
  return relPath.startsWith('assets/') && assetMatch?.[1] === noteIndex
}

/**
 * 相对第一父提交的改动路径。
 *
 * 用 `--name-status`（带 `--find-renames`）而不是 `--name-only`：改名必须同时保留
 * 旧、新两个路径，否则按编号过滤会漏掉「改名前」的历史。
 */
async function changedPathsOf(
  rootPath: string,
  commit: string,
  options: GitHistoryOptions
): Promise<string[]> {
  const output = await runGitText(
    rootPath,
    [
      'log',
      '-1',
      '--format=',
      '--name-status',
      '--find-renames',
      '-m',
      '--first-parent',
      commit,
      '--'
    ],
    options
  )
  const paths: string[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('\t')
    if (parts.length >= 3) {
      // R100\told\tnew / C100\told\tnew
      paths.push(parts[1]!, parts[2]!)
    } else if (parts.length === 2) {
      paths.push(parts[1]!)
    }
  }
  return [...new Set(paths)]
}

/**
 * 该 commit 是否真的存在于本库（浅克隆/对象缺失都会被识别）。
 * 计划阶段先验证它，避免把 `ls-tree` 的底层错误当成「源快照缺失」。
 */
export async function assertCommitExists(
  rootPath: string,
  commit: string,
  options: GitHistoryOptions = {}
): Promise<void> {
  if (!FULL_OID.test(commit)) {
    throw new GitHistoryError('BAD_REVISION', `只接受完整 commit OID：${commit}`)
  }
  try {
    await runGitText(rootPath, ['cat-file', '-e', `${commit}^{commit}`], options)
  } catch {
    throw new GitHistoryError('UNKNOWN_COMMIT', `该提交不在当前知识库里：${commit}`)
  }
}

/**
 * 是否浅克隆（`git clone --depth`）。
 *
 * 新 Git 用 `rev-parse --is-shallow-repository`；老版本不认这个参数时回退到
 * 检查 `.git/shallow`（worktree/子模块里 git-dir 可能不是 `<root>/.git`）。
 */
export async function isShallowRepository(
  rootPath: string,
  options: GitHistoryOptions = {}
): Promise<boolean> {
  try {
    const value = (await runGitText(rootPath, ['rev-parse', '--is-shallow-repository'], options))
      .trim()
      .toLowerCase()
    return value === 'true'
  } catch {
    try {
      const gitDir = (await runGitText(rootPath, ['rev-parse', '--git-dir'], options)).trim()
      const shallowFile = path.isAbsolute(gitDir)
        ? path.join(gitDir, 'shallow')
        : path.join(rootPath, gitDir, 'shallow')
      await stat(shallowFile)
      return true
    } catch {
      return false
    }
  }
}

/**
 * 按固定 HEAD 分页列出提交；`noteIndex` 给定时只保留与该编号相关的提交
 * （同编号的旧文件名、改名、资源单独改动、合并带来的改动都算）。
 *
 * 分页语义：
 * - 不带 `noteIndex`：`skip/limit` 直接作用在 `git log` 窗口上（H1 行为不变）
 * - 带 `noteIndex`：先扫描、过滤，再对**过滤后的序列**分页。否则 `limit=1` 这种
 *   「只要最新一条相关提交」的调用会被最新的无关提交挤空（真实缺陷：打开历史
 *   标签页时总是报「还没有历史提交」）
 *
 * 扫描有上限（`maxScanCommits`）：知识库历史很长时宁可给 `truncated` 也不把
 * 整个历史读进内存。
 */
async function readCommitWindow(
  rootPath: string,
  head: string,
  skip: number,
  count: number,
  options: GitHistoryOptions
): Promise<string[]> {
  const format = '%H%x1f%h%x1f%ct%x1f%an%x1f%P%x1f%s'
  const raw = await runGitText(
    rootPath,
    ['log', head, `--format=${format}`, '-z', `--max-count=${count}`, `--skip=${skip}`],
    options
  )
  return raw
    .split('\0')
    .map((row) => row.replace(/^\n+/, ''))
    .filter((row) => row.trim().length > 0)
}

async function summarizeCommit(
  rootPath: string,
  row: string,
  noteIndex: string | undefined,
  options: GitHistoryOptions
): Promise<HistoryCommitSummary | null> {
  const [oid, shortOid, committedAt, authorName, parents, subject] = row.split('\x1f')
  if (!oid) return null
  const changedPaths = await changedPathsOf(rootPath, oid, options)
  const isMerge = (parents ?? '').split(' ').filter(Boolean).length > 1
  return {
    oid,
    shortOid: shortOid ?? oid.slice(0, 7),
    committedAt: Number.parseInt(committedAt ?? '0', 10),
    authorName: authorName ?? '',
    subject: subject ?? '',
    parents: (parents ?? '').split(' ').filter(Boolean),
    changedPaths,
    isMerge,
    touchesIndex: noteIndex
      ? changedPaths.some((changed) => isIndexRelated(changed, noteIndex))
      : false
  }
}

export const HISTORY_SCAN_WINDOW = 100
export const HISTORY_MAX_SCAN_COMMITS = 2000

export async function listHistoryCommits(
  rootPath: string,
  options: HistoryListOptions = {}
): Promise<HistoryListPage> {
  const head = options.head ?? (await resolveHead(rootPath, options))
  if (!head) throw new GitHistoryError('NO_HEAD', '当前知识库还没有任何提交')
  if (!FULL_OID.test(head)) {
    throw new GitHistoryError('BAD_REVISION', `只接受完整 commit OID：${head}`)
  }
  const skip = Math.max(0, options.skip ?? 0)
  const limit = options.limit ?? 30
  const shallow = await isShallowRepository(rootPath, options)

  if (!options.noteIndex) {
    const rows = await readCommitWindow(rootPath, head, skip, limit + 1, options)
    const commits: HistoryCommitSummary[] = []
    for (const row of rows.slice(0, limit)) {
      const commit = await summarizeCommit(rootPath, row, undefined, options)
      if (commit) commits.push(commit)
    }
    return { head, commits, hasMore: rows.length > limit, shallow, truncated: false }
  }

  const noteIndex = options.noteIndex
  const maxScan = Math.max(1, options.maxScanCommits ?? HISTORY_MAX_SCAN_COMMITS)
  const wanted = skip + limit + 1
  const related: HistoryCommitSummary[] = []
  let scanned = 0
  let exhausted = false
  while (related.length < wanted && scanned < maxScan) {
    const count = Math.min(HISTORY_SCAN_WINDOW, maxScan - scanned)
    const rows = await readCommitWindow(rootPath, head, scanned, count, options)
    if (rows.length === 0) {
      exhausted = true
      break
    }
    for (const row of rows) {
      const commit = await summarizeCommit(rootPath, row, noteIndex, options)
      if (commit?.touchesIndex) related.push(commit)
    }
    scanned += rows.length
    if (rows.length < count) {
      exhausted = true
      break
    }
  }
  const truncated = !exhausted && related.length < wanted
  return {
    head,
    commits: related.slice(skip, skip + limit),
    hasMore: related.length > skip + limit || truncated,
    shallow,
    truncated
  }
}

export interface HistoryTreeEntry {
  relPath: string
  oid: string
  mode: string
  size: number
}

/** 枚举某个 commit 的完整 tree（只读）。 */
export async function listHistoryTree(
  rootPath: string,
  commit: string,
  options: GitHistoryOptions = {}
): Promise<HistoryTreeEntry[]> {
  if (!FULL_OID.test(commit)) {
    throw new GitHistoryError('BAD_REVISION', `只接受完整 commit OID：${commit}`)
  }
  const output = await runGitText(rootPath, ['ls-tree', '-r', '-l', '-z', commit], options)
  const entries: HistoryTreeEntry[] = []
  for (const record of output.split('\0')) {
    if (!record.trim()) continue
    const match = /^(\d+)\s+(\w+)\s+([0-9a-f]{40})\s+(\d+|-)\t([\s\S]+)$/.exec(record)
    if (!match) continue
    entries.push({
      mode: match[1],
      oid: match[3],
      size: Number.parseInt(match[4] === '-' ? '-1' : match[4], 10),
      relPath: match[5]
    })
  }
  return entries
}

export interface HistorySnapshotLimitation {
  code:
    'reused-index' | 'unknown-uuid' | 'non-standard-note-path' | 'unowned-assets' | 'missing-object'
  message: string
}

export interface HistorySnapshotManifest {
  commit: string
  noteIndex: string
  /** 该 commit 里属于这篇笔记的 Markdown 文件 */
  note: { relPath: string; oid: string; noteUuid: string | null } | null
  /** 同编号但无法唯一确定时的候选（按路径排序） */
  ambiguousNotePaths: string[]
  /** 同编号资源（含子目录），按路径排序 */
  assets: HistoryTreeEntry[]
  noteCandidates: HistoryTreeEntry[]
  limitations: HistorySnapshotLimitation[]
}

function readFrontmatterId(text: string): string | null {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  const block = text.slice(3, end)
  const match = /^id:\s*(.+)$/m.exec(block)
  const value = match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  return /^[0-9a-fA-F-]{36}$/.test(value) ? value : null
}

async function readBlobText(
  rootPath: string,
  oid: string,
  options: GitHistoryOptions
): Promise<string | null> {
  try {
    return (await runGit(rootPath, ['cat-file', 'blob', oid], options)).stdout.toString('utf8')
  } catch {
    return null
  }
}

/**
 * 在指定 commit 上建立「这篇笔记 + 同编号资源」的快照 manifest。
 *
 * - 通过四位编号识别历史文件名（改名后编号不变），不依赖当前路径
 * - 同编号出现多个 note 文件时报告歧义，不任选一个
 * - 归属未知资源、非标准路径、缺对象都以 limitations 明确列出，不自动迁移
 */
export async function readHistorySnapshot(
  rootPath: string,
  input: { commit: string; noteIndex: string; noteUuid?: string },
  options: GitHistoryOptions = {}
): Promise<HistorySnapshotManifest> {
  if (!FULL_OID.test(input.commit)) {
    throw new GitHistoryError('BAD_REVISION', `只接受完整 commit OID：${input.commit}`)
  }
  if (!/^\d{4}$/.test(input.noteIndex)) {
    throw new GitHistoryError('UNKNOWN_COMMIT', `笔记编号必须是四位数字：${input.noteIndex}`)
  }
  const entries = await listHistoryTree(rootPath, input.commit, options)
  const limitations: HistorySnapshotLimitation[] = []
  const noteCandidates = entries.filter((entry) => {
    const basename = entry.relPath.split('/').pop() ?? ''
    return entry.relPath.startsWith('notes/') && NOTE_INDEX.exec(basename)?.[1] === input.noteIndex
  })
  const assets = entries
    .filter((entry) => {
      const basename = entry.relPath.split('/').pop() ?? ''
      return (
        entry.relPath.startsWith('assets/') && ASSET_OWNER.exec(basename)?.[1] === input.noteIndex
      )
    })
    .sort((left, right) => left.relPath.localeCompare(right.relPath))

  const unownedAssets = entries.filter((entry) => {
    if (!entry.relPath.startsWith('assets/')) return false
    const basename = entry.relPath.split('/').pop() ?? ''
    return !ASSET_OWNER.exec(basename)
  })

  let note: HistorySnapshotManifest['note'] = null
  const ambiguousNotePaths: string[] = []
  if (noteCandidates.length > 1) {
    // 同编号多个文件：优先用 UUID 唯一确定；否则报歧义
    const matched: typeof noteCandidates = []
    for (const candidate of noteCandidates) {
      const text = await readBlobText(rootPath, candidate.oid, options)
      const uuid = text ? readFrontmatterId(text) : null
      if (input.noteUuid && uuid === input.noteUuid) matched.push(candidate)
    }
    const pool = matched.length === 1 ? matched : noteCandidates
    if (pool.length > 1) {
      ambiguousNotePaths.push(...pool.map((entry) => entry.relPath).sort())
      limitations.push({
        code: 'reused-index',
        message: `编号 ${input.noteIndex} 在本 commit 下有多个笔记文件：${ambiguousNotePaths.join('、')}`
      })
    } else {
      note = { relPath: pool[0]!.relPath, oid: pool[0]!.oid, noteUuid: input.noteUuid ?? null }
    }
  } else if (noteCandidates.length === 1) {
    const candidate = noteCandidates[0]!
    const text = await readBlobText(rootPath, candidate.oid, options)
    if (text == null) {
      limitations.push({
        code: 'missing-object',
        message: `无法读取历史对象：${candidate.relPath}`
      })
    }
    const uuid = text ? readFrontmatterId(text) : null
    if (text != null && !uuid) {
      limitations.push({
        code: 'unknown-uuid',
        message: `历史笔记缺少可识别的 frontmatter id：${candidate.relPath}`
      })
    }
    note = { relPath: candidate.relPath, oid: candidate.oid, noteUuid: uuid }
  }

  for (const entry of noteCandidates) {
    const basename = entry.relPath.split('/').pop() ?? ''
    if (!/^\d{4}\.\s.+\.md$/.test(basename)) {
      limitations.push({
        code: 'non-standard-note-path',
        message: `历史笔记文件名不符合「NNNN. 标题.md」约定：${entry.relPath}`
      })
    }
  }

  if (note) {
    const text = await readBlobText(rootPath, note.oid, options)
    const wanted = text ? referencedAssetPaths(text) : new Set<string>()
    for (const entry of unownedAssets) {
      if (!wanted.has(entry.relPath)) continue
      if (assets.some((asset) => asset.relPath === entry.relPath)) continue
      assets.push(entry)
    }
    assets.sort((left, right) => left.relPath.localeCompare(right.relPath))
  }
  const dropped = unownedAssets.filter(
    (entry) => !assets.some((asset) => asset.relPath === entry.relPath)
  )
  if (dropped.length > 0) {
    limitations.push({
      code: 'unowned-assets',
      message: `本 commit 有 ${dropped.length} 个资源文件名没有四位归属前缀，且未被这篇笔记引用，不纳入快照`
    })
  }

  return {
    commit: input.commit,
    noteIndex: input.noteIndex,
    note,
    ambiguousNotePaths,
    assets,
    noteCandidates: noteCandidates.sort((left, right) => left.relPath.localeCompare(right.relPath)),
    limitations
  }
}

export interface HistoryBlob {
  commit: string
  relPath: string
  oid: string
  bytes: Buffer
  text: string | null
}

/**
 * 读取某个 commit 上**清单内**的文件内容。
 *
 * 只允许该 commit 上真实存在的路径（用 manifest 校验），渲染端不能借它读任意文件。
 */
export async function readHistoryBlob(
  rootPath: string,
  input: { commit: string; relPath: string; allow?: string[] },
  options: GitHistoryOptions = {}
): Promise<HistoryBlob> {
  if (!FULL_OID.test(input.commit)) {
    throw new GitHistoryError('BAD_REVISION', `只接受完整 commit OID：${input.commit}`)
  }
  const entries = await listHistoryTree(rootPath, input.commit, options)
  const entry = entries.find((candidate) => candidate.relPath === input.relPath)
  if (!entry) {
    throw new GitHistoryError('UNKNOWN_PATH', `该 commit 上不存在此文件：${input.relPath}`)
  }
  if (input.allow && !input.allow.includes(input.relPath)) {
    throw new GitHistoryError('UNKNOWN_PATH', `该路径不在允许的快照清单里：${input.relPath}`)
  }
  const result = await runGit(rootPath, ['cat-file', 'blob', entry.oid], options)
  const bytes = result.stdout
  let text: string | null = null
  if (!bytes.includes(0)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      text = null
    }
  }
  return { commit: input.commit, relPath: input.relPath, oid: entry.oid, bytes, text }
}
