import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { deskLog } from './log'

/**
 * 一次命令执行的观察者：把实时输出与「实际执行的命令」报给命令任务面板。
 *
 * 只用于展示——**不参与**业务判断，也不会因为它的失败改变 Git 结果。
 */
export interface GitRunObserver {
  /** 实际的命令行（用于展示，不用于重放） */
  command(line: string): void
  output(stream: 'stdout' | 'stderr', chunk: string): void
}

export interface GitRunOptions {
  /** 覆盖默认超时；超时保留已产出的输出并追加原因 */
  timeoutMs?: number
  observer?: GitRunObserver
  signal?: AbortSignal
}

export interface GitStatus {
  repo: string
  isRepo: boolean
  branch: string | null
  clean: boolean
  changed: number
  ahead: number
  behind: number
  error: string | null
}

export interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  error: string | null
  /** Human-readable summary for UI (aligned with tn:pull / tn:push). */
  message: string | null
}

/** 子进程被终止的原因，供调用方区分「超时」与「用户取消」。 */
export type GitRunStopReason = 'timeout' | 'canceled' | null

export interface GitRunOutcome {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stopReason: GitRunStopReason
}

export class GitRunError extends Error {
  readonly outcome: GitRunOutcome

  constructor(message: string, outcome: GitRunOutcome) {
    super(message)
    this.name = 'GitRunError'
    this.outcome = outcome
  }
}

/** 渲染一句可读的命令行，供面板展示（参数含空格时加引号）。 */
export function formatGitCommand(args: string[]): string {
  return ['git', ...args]
    .map((part) => (/[\s"']/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(' ')
}

/**
 * 执行 git 并**实时**把输出交给观察者。
 *
 * 与原来的 `execFile` 版本的关键差别：
 *  - 输出边产出边上报（`execFile` 只在结束时给完整 stdout）；
 *  - 超时/取消时**保留已经产出的输出**再抛错——原实现在超时时会丢掉部分输出，
 *    正好是排查最需要的东西；
 *  - 终止先 SIGTERM，宽限期后 SIGKILL 兜底，并等待子进程真正退出。
 */
export function runGitStreaming(
  cwd: string,
  args: string[],
  options: GitRunOptions = {}
): Promise<GitRunOutcome> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const command = formatGitCommand(args)
  deskLog('git:run', 'exec', { cwd, args, timeoutMs })
  options.observer?.command(command)

  return new Promise<GitRunOutcome>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let stopReason: GitRunStopReason = null
    let settled = false
    let killTimer: NodeJS.Timeout | null = null
    let forceTimer: NodeJS.Timeout | null = null

    const cleanup = (): void => {
      if (killTimer) clearTimeout(killTimer)
      if (forceTimer) clearTimeout(forceTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    /** 先温和终止；宽限期后强杀，避免卡住的操作队列。 */
    const terminate = (): void => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 已退出 */
      }
      forceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已退出 */
        }
      }, 3000)
    }

    const onAbort = (): void => {
      if (settled || stopReason) return
      stopReason = 'canceled'
      terminate()
    }

    if (options.signal) {
      if (options.signal.aborted) {
        stopReason = 'canceled'
        terminate()
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    killTimer = setTimeout(() => {
      if (settled || stopReason) return
      stopReason = 'timeout'
      terminate()
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      options.observer?.output('stdout', text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      options.observer?.output('stderr', text)
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(
        new GitRunError(error.message, {
          stdout,
          stderr,
          exitCode: null,
          signal: null,
          stopReason
        })
      )
    })

    // 以 close 为准（stdio 全部关闭），确保最后一段输出已经收到
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      const outcome: GitRunOutcome = {
        stdout,
        stderr,
        exitCode: code,
        signal: signal ?? null,
        stopReason
      }
      deskLog('git:run', 'done', {
        cwd,
        args,
        exitCode: code,
        signal,
        stopReason,
        stdout: stdout.slice(0, 1000),
        stderr: stderr.slice(0, 1000)
      })
      if (stopReason === 'timeout') {
        // 原因追加在既有 stderr 之后，不覆盖原始输出
        reject(new GitRunError(`git ${args.join(' ')} 执行超时（${timeoutMs}ms）`, outcome))
        return
      }
      if (stopReason === 'canceled') {
        reject(new GitRunError('任务已取消', outcome))
        return
      }
      if (code === 0) {
        resolve(outcome)
        return
      }
      reject(new GitRunError(stderr.trim() || `git ${args.join(' ')} 退出码 ${code}`, outcome))
    })
  })
}

async function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
  options: { observer?: GitRunObserver; signal?: AbortSignal } = {}
): Promise<{ stdout: string; stderr: string }> {
  const outcome = await runGitStreaming(cwd, args, {
    timeoutMs,
    observer: options.observer,
    signal: options.signal
  })
  return { stdout: outcome.stdout, stderr: outcome.stderr }
}

function failResult(e: unknown): GitCommandResult {
  // 超时/取消/非零退出都会带出**已经产出的**输出，便于排查
  if (e instanceof GitRunError) {
    return {
      ok: false,
      stdout: e.outcome.stdout,
      stderr: e.outcome.stderr,
      error: e.message,
      message: null
    }
  }
  const err = e as { stdout?: string; stderr?: string; message?: string }
  const stdout = err.stdout?.toString() ?? ''
  const stderr = err.stderr?.toString() ?? ''
  const error = stderr || err.message || String(e)
  return { ok: false, stdout, stderr, error, message: null }
}

/** `📝 Update notes - YYYY-MM-DD HH:MM:SS` */
export function generateCommitMessage(): string {
  const now = new Date()
  const date = now.toISOString().split('T')[0]
  const time = now.toTimeString().split(' ')[0]
  return `📝 Update notes - ${date} ${time}`
}

async function countAheadBehind(
  repoDir: string,
  options: GitRunOptions = {}
): Promise<{ ahead: number; behind: number }> {
  try {
    const { stdout } = await runGit(
      repoDir,
      ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
      60_000,
      options
    )
    const [behindRaw, aheadRaw] = stdout.trim().split(/\s+/)
    return {
      behind: Number(behindRaw) || 0,
      ahead: Number(aheadRaw) || 0
    }
  } catch {
    return { ahead: 0, behind: 0 }
  }
}

async function countChangedFiles(repoDir: string, options: GitRunOptions = {}): Promise<number> {
  const { stdout } = await runGit(repoDir, ['status', '--porcelain'], 60_000, options)
  return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length
}

export async function getGitStatus(repoName: string, repoDir: string): Promise<GitStatus> {
  const base: GitStatus = {
    repo: repoName,
    isRepo: false,
    branch: null,
    clean: true,
    changed: 0,
    ahead: 0,
    behind: 0,
    error: null
  }

  if (!existsSync(join(repoDir, '.git'))) {
    return { ...base, error: '不是 git 仓库' }
  }

  try {
    await runGit(repoDir, ['rev-parse', '--is-inside-work-tree'])
    base.isRepo = true

    try {
      const { stdout } = await runGit(repoDir, ['branch', '--show-current'])
      base.branch = stdout.trim() || null
    } catch {
      base.branch = null
    }

    base.changed = await countChangedFiles(repoDir)
    base.clean = base.changed === 0

    const ab = await countAheadBehind(repoDir)
    base.ahead = ab.ahead
    base.behind = ab.behind

    return base
  } catch (e) {
    return {
      ...base,
      isRepo: true,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/**
 * Align with tn:pull → GitManager.pull({ rebase: true, autostash: true })
 */
export async function gitPull(
  repoDir: string,
  options: GitRunOptions = {}
): Promise<GitCommandResult> {
  deskLog('git:pull', 'start (tn-like)', { repoDir })
  try {
    const before = (await runGit(repoDir, ['rev-parse', 'HEAD'], 60_000, options)).stdout.trim()
    const { stdout, stderr } = await runGit(
      repoDir,
      ['pull', '--rebase', '--autostash'],
      180_000,
      options
    )
    const after = (await runGit(repoDir, ['rev-parse', 'HEAD'], 60_000, options)).stdout.trim()
    const message = before === after ? '已是最新，没有需要拉取的更新' : '拉取完成'
    deskLog('git:pull', 'ok', { message, before, after })
    return { ok: true, stdout, stderr, error: null, message }
  } catch (e) {
    deskLog('git:pull', 'failed', e instanceof Error ? e.message : String(e))
    return failResult(e)
  }
}

/**
 * Align with tn:push → PushCommand:
 * if dirty: git add -A + commit (auto message) + push
 * else if ahead: git push
 * else: nothing to push
 */
export async function gitPush(
  repoDir: string,
  options: GitRunOptions = {}
): Promise<GitCommandResult> {
  deskLog('git:push', 'start (tn-like)', { repoDir })
  try {
    const changed = await countChangedFiles(repoDir, options)
    const { ahead } = await countAheadBehind(repoDir, options)
    deskLog('git:push', 'precheck', { changed, ahead })

    if (changed === 0 && ahead === 0) {
      const message = '没有更改需要推送'
      deskLog('git:push', message)
      return { ok: true, stdout: '', stderr: '', error: null, message }
    }

    const logs: string[] = []

    if (changed > 0) {
      const commitMessage = generateCommitMessage()
      deskLog('git:push', 'commit then push', { changed, commitMessage })
      await runGit(repoDir, ['add', '-A'], 60_000, options)
      try {
        const committed = await runGit(repoDir, ['commit', '-m', commitMessage], 60_000, options)
        logs.push(committed.stdout.trim(), committed.stderr.trim())
      } catch (e) {
        const err = e as { stderr?: string; message?: string }
        const text = err.stderr?.toString() || err.message || String(e)
        // Race / empty index: continue to push if we still have ahead commits.
        if (!/nothing to commit/i.test(text)) {
          throw e
        }
        logs.push(text)
      }
    } else {
      deskLog('git:push', 'push existing commits', { ahead })
    }

    const pushed = await runGit(repoDir, ['push'], 180_000, options)
    logs.push(pushed.stdout.trim(), pushed.stderr.trim())
    const combined = logs.filter(Boolean).join('\n')
    const message = '推送完成'
    deskLog('git:push', 'ok', { message, combined: combined.slice(0, 1000) })
    return {
      ok: true,
      stdout: combined,
      stderr: pushed.stderr,
      error: null,
      message
    }
  } catch (e) {
    deskLog('git:push', 'failed', e instanceof Error ? e.message : String(e))
    return failResult(e)
  }
}
