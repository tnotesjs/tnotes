/**
 * Knowledge-base push / pull — owned by @tnotesjs/kb so CLI, Desk, and scripts share one path.
 *
 * Push optionally runs `update` first (`push.runUpdateBefore`, default true), then
 * `git add .` → commit (one short sentence) → `git push`.
 * Pull is a thin `fetch` + `pull --ff-only`; conflicts fail clearly.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { KbError } from './errors'
import { isGitRepository } from './git'
import { readKbConfig } from './scanner'
import { updateCompletedNotesStats } from './stats'

import type { KbConfig } from './types'

const execFileAsync = promisify(execFile)

export interface KbGitCommandResult {
  code: number
  stdout: string
  stderr: string
}

/** Injectable git runner (Desk passes its observer-aware execute; CLI uses default). */
export type KbGitRunner = (args: string[], timeoutMs?: number) => Promise<KbGitCommandResult>

export interface PushOptions {
  /** Override `tnotes.json` → `push.runUpdateBefore`. */
  runUpdateBefore?: boolean
  runGit?: KbGitRunner
  /** Skip the network push (tests / dry paths). */
  skipRemotePush?: boolean
  /** Override the default one-sentence commit message. */
  commitMessage?: string
  /** Injected config (Desk); skips `readKbConfig` when set. */
  config?: KbConfig
  /** Skip `isGitRepository` when Desk already validated the work tree. */
  assumeGitRepo?: boolean
  /** Injected update step; default runs `updateCompletedNotesStats` when stats.enabled. */
  runUpdate?: () => Promise<boolean>
}

export interface PushResult {
  updated: boolean
  committed: boolean
  pushed: boolean
  message: string
  commitMessage: string | null
}

export interface PullLocalState {
  behind: number
  hasChanges: boolean
  conflict: boolean
}

export interface PullOptions {
  runGit?: KbGitRunner
  assumeGitRepo?: boolean
  /**
   * Optional Desk preflight: dirty work tree while behind remote, or existing
   * conflict markers → fail without attempting pull.
   */
  local?: PullLocalState
}

export interface PullResult {
  ok: boolean
  conflict: boolean
  message: string
}

/** Default commit message: one short sentence. */
export const DEFAULT_PUSH_COMMIT_MESSAGE = 'Update knowledge base notes.'

const PULL_CONFLICT_MESSAGE = '拉取失败：本地有冲突或远程无法合并，请自行处理冲突。'

function defaultRunner(rootPath: string): KbGitRunner {
  return async (args, timeoutMs = 60_000) => {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: rootPath,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
      })
      return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' }
    } catch (error) {
      const err = error as {
        code?: number | string
        stdout?: string
        stderr?: string
        message?: string
        killed?: boolean
      }
      const code = typeof err.code === 'number' ? err.code : err.killed ? 124 : 1
      return {
        code,
        stdout: err.stdout ?? '',
        stderr: (err.stderr ?? err.message ?? String(error)).trim()
      }
    }
  }
}

function failGit(result: KbGitCommandResult, fallback: string): never {
  const detail = (result.stderr || result.stdout || '').trim()
  throw new KbError('INVALID_OPERATION', detail ? `${fallback}：${detail}` : fallback, {
    code: result.code,
    stderr: result.stderr,
    stdout: result.stdout
  })
}

/** Resolve whether push should run update first (default true). */
export function shouldRunUpdateBeforePush(config: KbConfig, override?: boolean): boolean {
  if (override !== undefined) return override
  const configured = config.push?.runUpdateBefore
  if (configured === false) return false
  return true
}

async function loadConfig(rootPath: string, injected?: KbConfig): Promise<KbConfig> {
  if (injected) return injected
  try {
    return (await readKbConfig(rootPath)).config
  } catch {
    return {}
  }
}

/**
 * Push the knowledge base: optional update → `git add .` → commit → push.
 */
export async function pushKnowledgeBase(
  rootPath: string,
  options: PushOptions = {}
): Promise<PushResult> {
  if (!options.assumeGitRepo && !(await isGitRepository(rootPath))) {
    throw new KbError('INVALID_OPERATION', '当前目录不是 Git 仓库，无法推送')
  }

  const config = await loadConfig(rootPath, options.config)
  const runGit = options.runGit ?? defaultRunner(rootPath)
  const commitMessage = options.commitMessage?.trim() || DEFAULT_PUSH_COMMIT_MESSAGE

  let updated = false
  if (shouldRunUpdateBeforePush(config, options.runUpdateBefore)) {
    if (options.runUpdate) {
      updated = await options.runUpdate()
    } else if (config.stats?.enabled) {
      await updateCompletedNotesStats(rootPath)
      updated = true
    }
  }

  const add = await runGit(['add', '.'], 30_000)
  if (add.code !== 0) failGit(add, 'Git 暂存失败')

  const staged = await runGit(['diff', '--cached', '--quiet'], 30_000)
  let committed = false
  if (staged.code === 1) {
    const commit = await runGit(['commit', '-m', commitMessage], 120_000)
    if (commit.code !== 0) failGit(commit, 'Git commit 失败')
    committed = true
  } else if (staged.code !== 0) {
    failGit(staged, '无法检查待提交变更')
  }

  const upstream = await runGit(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    15_000
  )
  if (upstream.code !== 0 || !upstream.stdout.trim()) {
    throw new KbError('INVALID_OPERATION', '当前分支没有配置上游仓库，未执行 push')
  }

  if (!committed) {
    const counts = await runGit(
      ['rev-list', '--left-right', '--count', `HEAD...${upstream.stdout.trim()}`],
      30_000
    )
    let ahead = 0
    if (counts.code === 0) {
      const [left] = counts.stdout.trim().split(/\s+/).map(Number)
      ahead = Number.isFinite(left) ? left : 0
    }
    if (ahead === 0) {
      return {
        updated,
        committed: false,
        pushed: false,
        message: '没有需要提交或推送的变更',
        commitMessage: null
      }
    }
  }

  if (options.skipRemotePush) {
    return {
      updated,
      committed,
      pushed: false,
      message: committed ? '已提交（跳过远端推送）' : '有未推送提交（跳过远端推送）',
      commitMessage: committed ? commitMessage : null
    }
  }

  const push = await runGit(['push'], 120_000)
  if (push.code !== 0) failGit(push, 'Git push 失败')

  return {
    updated,
    committed,
    pushed: true,
    message: '变更已提交并推送到远端',
    commitMessage: committed ? commitMessage : null
  }
}

/**
 * Thin pull: fetch --prune then pull --ff-only. Conflict / non-ff → conflict:true.
 */
export async function pullKnowledgeBase(
  rootPath: string,
  options: PullOptions = {}
): Promise<PullResult> {
  if (!options.assumeGitRepo && !(await isGitRepository(rootPath))) {
    throw new KbError('INVALID_OPERATION', '当前目录不是 Git 仓库，无法拉取')
  }

  if (options.local?.conflict) {
    return { ok: false, conflict: true, message: PULL_CONFLICT_MESSAGE }
  }
  if (options.local && options.local.behind > 0 && options.local.hasChanges) {
    return { ok: false, conflict: true, message: PULL_CONFLICT_MESSAGE }
  }

  const runGit = options.runGit ?? defaultRunner(rootPath)

  const fetch = await runGit(['fetch', '--prune'], 60_000)
  if (fetch.code !== 0) {
    const detail = (fetch.stderr || fetch.stdout || '').trim()
    return {
      ok: false,
      conflict: true,
      message: detail ? `${PULL_CONFLICT_MESSAGE}（${detail}）` : PULL_CONFLICT_MESSAGE
    }
  }

  const pull = await runGit(['pull', '--ff-only'], 90_000)
  if (pull.code !== 0) {
    return {
      ok: false,
      conflict: true,
      message: PULL_CONFLICT_MESSAGE
    }
  }

  return {
    ok: true,
    conflict: false,
    message: '已快进到远端最新版本'
  }
}

/** Fixed copy for Desk / CLI conflict surfaces. */
export const PULL_CONFLICT_USER_MESSAGE = PULL_CONFLICT_MESSAGE

/** Build the Agent preset prompt for a pull conflict (user must still click send). */
export function buildPullConflictAgentPrompt(input: {
  name: string
  rootPath: string
}): string {
  return (
    `本地知识库 ${input.name}:${input.rootPath} 在 git pull 时发生冲突或无法快进合并。` +
    `请分析冲突原因，必要时协助解决冲突并完成拉取（可先查看 git status / 冲突文件，再提出或直接修复方案）。`
  )
}
