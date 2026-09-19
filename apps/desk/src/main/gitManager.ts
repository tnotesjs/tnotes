import { EventEmitter } from 'node:events'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { deskLog } from './log'
import { loadSettings } from './settings'

import type { GitRepositoryDescriptor } from './workspaceManager'
import type {
  GitFileChangeDto,
  GitFileStatus,
  GitOperationResult,
  GitRepositoryStateDto
} from '../shared/contracts'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

interface GitManagerEvents {
  changed: [GitRepositoryStateDto]
}

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** 队列中的一项：取消只作用于自己。`id` 是它的稳定身份（用于精确取消）。 */
export interface QueueNode {
  id: string
  canceled: boolean
  running: boolean
  controller?: AbortController
  /** 终止本项登记的（且仅本项的）子进程 */
  killSpawns: () => void
}

function gitExecutable(): string {
  return loadSettings().gitPath || 'git'
}

/** 让调用方能在退出时终止正在跑的子进程。 */
export interface GitRunSpawnRegistry {
  register(kill: () => void): void
  unregister(): void
}

/** 命令任务的观察者：只用于展示实际执行过程，不参与业务判断。 */
export interface GitRunObserver {
  /** 实际执行的命令行（展示用，不重放） */
  commandLine?(line: string): void
  output(stream: 'stdout' | 'stderr', chunk: string): void
}

export interface GitRunExtras {
  observer?: GitRunObserver
  signal?: AbortSignal
  onSpawn?: GitRunSpawnRegistry
}

function runGit(
  rootPath: string,
  args: string[],
  timeoutMs = 30_000,
  extras: GitRunExtras = {}
): Promise<CommandResult> {
  const { observer, signal, onSpawn } = extras
  observer?.commandLine?.(formatCommandLine(args))
  return new Promise((resolve, reject) => {
    const child = spawn(gitExecutable(), args, {
      cwd: rootPath,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    // Accumulate chunks and join once — template-literal appends are O(n²)
    // and a large `git status` (tens of thousands of changes) would block the
    // main process for seconds.
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const cap = (text: string): string => text.slice(-2 * 1024 * 1024)

    let stopReason: 'timeout' | 'canceled' | null = null
    let settled = false
    let forceTimer: NodeJS.Timeout | null = null

    const cleanup = (): void => {
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      signal?.removeEventListener('abort', onAbort)
      onSpawn?.unregister?.()
    }

    const terminate = (): void => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 已退出 */
      }
      // 强杀兜底：不能因为子进程赖着不走而卡住整个操作队列
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

    if (signal) {
      if (signal.aborted) {
        stopReason = 'canceled'
        terminate()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
      observer?.output('stdout', chunk.toString('utf8'))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
      observer?.output('stderr', chunk.toString('utf8'))
    })

    const timer = setTimeout(() => {
      if (settled || stopReason) return
      stopReason = 'timeout'
      terminate()
    }, timeoutMs)

    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })

    // 以 close 为准：确保子进程**真的退出**（信号发出不等于结束）后才解除忙碌
    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      const stdout = cap(Buffer.concat(stdoutChunks).toString('utf8'))
      const stderr = cap(Buffer.concat(stderrChunks).toString('utf8'))
      if (stopReason === 'timeout') {
        // 超时：保留此前输出，把原因**追加**在既有 stderr 之后（不覆盖原始错误）
        resolve({
          code: 124,
          stdout,
          stderr: [stderr.trim(), `Git 操作超时：git ${args[0]}（${timeoutMs}ms）`]
            .filter(Boolean)
            .join('\n')
        })
        return
      }
      if (stopReason === 'canceled') {
        resolve({
          code: 130,
          stdout,
          stderr: [stderr.trim(), 'Git 操作已取消'].filter(Boolean).join('\n')
        })
        return
      }
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

/** 展示用命令行（含空格参数加引号）。 */
function formatCommandLine(args: string[]): string {
  return [gitExecutable(), ...args]
    .map((part) => (/[\s"']/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(' ')
}

function commandError(result: CommandResult, fallback: string): Error {
  const message = result.stderr.trim() || result.stdout.trim() || fallback
  return new Error(message)
}

function fileStatus(code: string): GitFileStatus {
  if (CONFLICT_CODES.has(code) || code.includes('U')) return 'conflicted'
  if (code === '??') return 'untracked'
  if (code.includes('R') || code.includes('C')) return 'renamed'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  return 'modified'
}

/** 变更项是否落在给定目标（文件或目录）范围内。 */
export function changesInsideTargets(
  changes: GitFileChangeDto[],
  rootPath: string,
  targets: string[]
): GitFileChangeDto[] {
  if (targets.length === 0) return []
  const normalizedTargets = targets.map((target) => path.resolve(target))
  return changes.filter((change) => {
    const absolutePath = path.resolve(rootPath, change.path)
    return normalizedTargets.some(
      (target) => absolutePath === target || absolutePath.startsWith(`${target}${path.sep}`)
    )
  })
}

export function parseGitStatus(output: string): GitFileChangeDto[] {
  const entries = output.split('\0')
  const changes: GitFileChangeDto[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry || entry.length < 3) continue
    const code = entry.slice(0, 2)
    const filePath = entry.slice(3)
    if (!filePath) continue
    let previousPath: string | undefined
    if (code.includes('R') || code.includes('C')) {
      previousPath = entries[index + 1] || undefined
      index += 1
    }
    changes.push({
      path: filePath.replaceAll('\\', '/'),
      previousPath: previousPath?.replaceAll('\\', '/'),
      status: fileStatus(code),
      staged: code[0] !== ' ' && code[0] !== '?',
      worktree: code[1] !== ' ' && code[1] !== '?'
    })
  }
  return changes
}

export function shouldScheduleAutoPush(input: {
  enabled: boolean
  paused: boolean
  hasChanges: boolean
  conflict: boolean
  behind: number
}): boolean {
  return input.enabled && !input.paused && input.hasChanges && !input.conflict && input.behind <= 0
}

function defaultState(repository: GitRepositoryDescriptor): GitRepositoryStateDto {
  return {
    knowledgeBaseId: repository.knowledgeBaseId,
    knowledgeBaseName: repository.knowledgeBaseName,
    initialized: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    conflict: false,
    busy: null,
    lastFetchedAt: null,
    error: null
  }
}

function operationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^fatal:\s*/i, '').trim()
}

export class GitManager {
  private readonly events = new EventEmitter<GitManagerEvents>()
  private repositories = new Map<string, GitRepositoryDescriptor>()
  private states = new Map<string, GitRepositoryStateDto>()
  private operationTails = new Map<string, Promise<void>>()
  /**
   * 每个知识库的**队列项**（按入队顺序）。
   *
   * 取消必须精确到具体那一项：排队中的取消只是让该项失效（轮到它时跳过），
   * **绝不能**去杀前一个操作（那可能是别的任务、甚至别的知识库的 Git 操作）。
   * 运行中的取消只终止该项自己派生并登记的进程。
   */
  private queueNodes = new Map<string, QueueNode[]>()
  private operationSeq = 0
  /** 每个知识库当前正在执行的那一项（用于「运行中取消」精确定位） */
  private runningNode = new Map<string, QueueNode>()
  /** 进程级退出：所有在跑子进程的终止器（只用于 dispose，不参与单任务取消） */
  private disposeKills = new Set<() => void>()
  private autoPushTimers = new Map<string, NodeJS.Timeout>()
  private periodicFetchTimer: NodeJS.Timeout | null = null
  private assetWritePaused = new Set<string>()

  constructor(
    /**
     * 命令执行器。默认走真实的 `runGit`；测试注入假实现即可确定性验证
     * 「排队取消不误杀前一个操作」「同一运行只启动一次」这类时序约定。
     */
    private readonly execute: typeof runGit = runGit
  ) {}

  onChanged(listener: (state: GitRepositoryStateDto) => void): () => void {
    this.events.on('changed', listener)
    return () => this.events.off('changed', listener)
  }

  configure(repositories: GitRepositoryDescriptor[]): void {
    const next = new Map(repositories.map((repository) => [repository.knowledgeBaseId, repository]))
    this.repositories = next
    for (const key of [...this.states.keys()]) {
      if (!next.has(key)) this.states.delete(key)
    }
    for (const repository of repositories) {
      if (!this.states.has(repository.knowledgeBaseId)) {
        this.states.set(repository.knowledgeBaseId, defaultState(repository))
      }
    }
    void this.refresh().then(() => {
      for (const repository of repositories) {
        const state = this.states.get(repository.knowledgeBaseId)
        if (
          state?.initialized &&
          !state.lastFetchedAt &&
          !this.assetWritePaused.has(repository.knowledgeBaseId)
        ) {
          void this.fetch(repository.knowledgeBaseId, true).catch(() => undefined)
        }
      }
      this.applyAutoPushSchedules(true)
    })
    if (!this.periodicFetchTimer) {
      this.periodicFetchTimer = setInterval(() => {
        for (const state of this.states.values()) {
          if (
            state.initialized &&
            !state.busy &&
            !this.assetWritePaused.has(state.knowledgeBaseId)
          ) {
            void this.fetch(state.knowledgeBaseId, true).catch(() => undefined)
          }
        }
      }, 5 * 60_000)
    }
  }

  list(): GitRepositoryStateDto[] {
    return [...this.states.values()].sort((left, right) =>
      left.knowledgeBaseName.localeCompare(right.knowledgeBaseName)
    )
  }

  async refresh(knowledgeBaseId?: string): Promise<GitRepositoryStateDto[]> {
    const targets = knowledgeBaseId
      ? [this.getRepository(knowledgeBaseId)]
      : [...this.repositories.values()]
    await Promise.all(targets.map((repository) => this.refreshRepository(repository)))
    return this.list()
  }

  fetch(
    knowledgeBaseId: string,
    background = false,
    extras: GitRunExtras = {}
  ): Promise<GitOperationResult> {
    return this.enqueue(
      knowledgeBaseId,
      async (repository, runExtras) => {
        if (!background) this.setBusy(knowledgeBaseId, 'fetch')
        const result = await this.execute(
          repository.rootPath,
          ['fetch', '--prune'],
          background ? 15_000 : 60_000,
          runExtras
        )
        if (result.code !== 0) {
          const message = operationMessage(commandError(result, 'Git fetch 失败'))
          if (!background) {
            await this.refreshRepository(repository, message)
            throw new Error(message)
          }
          deskLog('git:fetch', 'background fetch failed', {
            knowledgeBaseId,
            message
          })
          const state = await this.refreshRepository(repository)
          return {
            state,
            message,
            conflict: false
          }
        }
        const state = await this.refreshRepository(repository, null, new Date().toISOString())
        return { state, message: '已获取远端最新状态', conflict: false }
      },
      extras
    ).result
  }

  pull(knowledgeBaseId: string, extras: GitRunExtras = {}): Promise<GitOperationResult> {
    return this.enqueue(
      knowledgeBaseId,
      async (repository, runExtras) => {
        this.setBusy(knowledgeBaseId, 'pull')
        const fetchResult = await this.execute(
          repository.rootPath,
          ['fetch', '--prune'],
          60_000,
          runExtras
        )
        if (fetchResult.code !== 0) throw commandError(fetchResult, '无法获取远端状态')
        const before = await this.readState(repository, new Date().toISOString())
        if (before.conflict || (before.behind > 0 && before.changes.length > 0)) {
          const state = this.storeState({
            ...before,
            busy: null,
            error: '本地存在未提交变更，无法安全快进；请在 IDE 中处理后重试'
          })
          return { state, message: state.error!, conflict: true }
        }
        const result = await this.execute(
          repository.rootPath,
          ['pull', '--ff-only'],
          90_000,
          runExtras
        )
        if (result.code !== 0) {
          const message = operationMessage(commandError(result, 'Git pull 失败'))
          const state = await this.refreshRepository(repository, message)
          return { state, message, conflict: true }
        }
        const state = await this.refreshRepository(repository)
        return { state, message: '已快进到远端最新版本', conflict: false }
      },
      // 工厂：真正开始执行时才读观察者与取消信号
      () => extras
    ).result
  }

  publish(knowledgeBaseId: string, extras: GitRunExtras = {}): Promise<GitOperationResult> {
    return this.enqueue(
      knowledgeBaseId,
      (repository, runExtras) => this.publishRepository(repository, runExtras),
      extras
    ).result
  }

  /**
   * 目标范围内的变更项；仓库/状态还没准备好时返回空数组。
   *
   * 这两个方法只用于「给用户提示后果」，不能因为启动后 Git 状态尚未就绪
   * （`configure` 是 2 秒防抖）就抛错——否则打开知识库后立刻点删除会直接失败。
   */
  /** Git 状态是否已就绪（启动后 configure 有 2 秒防抖）。 */
  isReady(knowledgeBaseId: string): boolean {
    return this.repositories.has(knowledgeBaseId) && this.states.has(knowledgeBaseId)
  }

  private changesInsideScope(knowledgeBaseId: string, targets: string[]): GitFileChangeDto[] {
    const repository = this.repositories.get(knowledgeBaseId)
    const state = this.states.get(knowledgeBaseId)
    if (!repository || !state) return []
    return changesInsideTargets(state.changes, repository.rootPath, targets)
  }

  untrackedFilesInside(knowledgeBaseId: string, targets: string[]): string[] {
    const rootPath = this.repositories.get(knowledgeBaseId)?.rootPath
    if (!rootPath) return []
    return this.changesInsideScope(knowledgeBaseId, targets)
      .filter((change) => change.status === 'untracked')
      .map((change) => path.resolve(rootPath, change.path))
  }

  /** 目标范围内「已跟踪但有未提交改动」的文件（删除后这部分内容 git 里没有）。 */
  uncommittedFilesInside(knowledgeBaseId: string, targets: string[]): string[] {
    const rootPath = this.repositories.get(knowledgeBaseId)?.rootPath
    if (!rootPath) return []
    return this.changesInsideScope(knowledgeBaseId, targets)
      .filter((change) => change.status !== 'untracked')
      .map((change) => path.resolve(rootPath, change.path))
  }

  applyAutoPushSchedules(reset = false): void {
    for (const repository of this.repositories.values()) {
      // 库级约定（tnotes.json）唯一来源；desk 侧旧值已迁移。
      const override = repository.autoPush
      const existing = this.autoPushTimers.get(repository.knowledgeBaseId)
      if (
        existing &&
        (reset || !override?.enabled || this.assetWritePaused.has(repository.knowledgeBaseId))
      ) {
        clearTimeout(existing)
        this.autoPushTimers.delete(repository.knowledgeBaseId)
      }
      const state = this.states.get(repository.knowledgeBaseId)
      if (
        !shouldScheduleAutoPush({
          enabled: Boolean(override?.enabled),
          paused: this.assetWritePaused.has(repository.knowledgeBaseId),
          hasChanges: Boolean(state?.changes.length),
          conflict: Boolean(state?.conflict),
          behind: state?.behind ?? 0
        })
      ) {
        continue
      }
      if (this.autoPushTimers.has(repository.knowledgeBaseId)) continue
      this.autoPushTimers.set(
        repository.knowledgeBaseId,
        setTimeout(
          () => {
            this.autoPushTimers.delete(repository.knowledgeBaseId)
            if (this.assetWritePaused.has(repository.knowledgeBaseId)) return
            void this.publish(repository.knowledgeBaseId).catch((error) =>
              deskLog('git:auto-push', 'failed', operationMessage(error))
            )
          },
          (override?.idleMinutes ?? 1) * 60_000
        )
      )
    }
  }

  pauseForAssetWrite(knowledgeBaseId: string): void {
    this.assetWritePaused.add(knowledgeBaseId)
    const timer = this.autoPushTimers.get(knowledgeBaseId)
    if (timer) {
      clearTimeout(timer)
      this.autoPushTimers.delete(knowledgeBaseId)
    }
  }

  resumeAfterAssetWrite(knowledgeBaseId: string): void {
    if (!this.assetWritePaused.delete(knowledgeBaseId)) return
    this.applyAutoPushSchedules()
  }

  isPausedForAssetWrite(knowledgeBaseId: string): boolean {
    return this.assetWritePaused.has(knowledgeBaseId)
  }

  async waitForIdle(knowledgeBaseId: string): Promise<void> {
    const tail = this.operationTails.get(knowledgeBaseId)
    if (tail) await tail.catch(() => undefined)
  }

  async dispose(): Promise<void> {
    if (this.periodicFetchTimer) clearInterval(this.periodicFetchTimer)
    this.periodicFetchTimer = null
    for (const timer of this.autoPushTimers.values()) clearTimeout(timer)
    this.autoPushTimers.clear()
    // 先终止所有在跑的 git 子进程，再等队列收敛：不这么做，一个挂住的 fetch 会让
    // dispose 永久等待（也会把退出流程拖死）
    for (const kill of [...this.disposeKills]) kill()
    await Promise.allSettled(this.operationTails.values())
    this.events.removeAllListeners()
  }

  private async publishRepository(
    repository: GitRepositoryDescriptor,
    extras: GitRunExtras = {}
  ): Promise<GitOperationResult> {
    this.setBusy(repository.knowledgeBaseId, 'publish')
    const current = await this.readState(repository)
    if (current.conflict) throw new Error('仓库存在冲突，请先在 IDE 中处理')
    if (current.behind > 0) throw new Error('本地版本落后于远端，请先拉取最新版本')
    const add = await this.execute(repository.rootPath, ['add', '-A'], 30_000, extras)
    if (add.code !== 0) throw commandError(add, 'Git 暂存失败')
    const staged = await this.execute(
      repository.rootPath,
      ['diff', '--cached', '--quiet'],
      30_000,
      extras
    )
    let committed = false
    if (staged.code === 1) {
      const timestamp = new Intl.DateTimeFormat('sv-SE', {
        dateStyle: 'short',
        timeStyle: 'short',
        hour12: false
      }).format(new Date())
      const commit = await this.execute(
        repository.rootPath,
        ['commit', '-m', `docs: update notes ${timestamp}`],
        120_000
      )
      if (commit.code !== 0) throw commandError(commit, 'Git commit 失败')
      committed = true
    } else if (staged.code !== 0) {
      throw commandError(staged, '无法检查待提交变更')
    }
    const stateBeforePush = await this.readState(repository)
    if (!stateBeforePush.upstream) throw new Error('当前分支没有配置上游仓库，Desk 未执行 push')
    if (!committed && stateBeforePush.ahead === 0) {
      const state = this.storeState({ ...stateBeforePush, busy: null, error: null })
      return { state, message: '没有需要提交或推送的变更', conflict: false }
    }
    const push = await this.execute(repository.rootPath, ['push'], 120_000, extras)
    if (push.code !== 0) throw commandError(push, 'Git push 失败')
    const state = await this.refreshRepository(repository)
    return { state, message: '变更已提交并推送到远端', conflict: false }
  }

  private async refreshRepository(
    repository: GitRepositoryDescriptor,
    error: string | null = null,
    lastFetchedAt?: string
  ): Promise<GitRepositoryStateDto> {
    try {
      const state = await this.readState(repository, lastFetchedAt)
      return this.storeState({ ...state, busy: null, error })
    } catch (cause) {
      const previous = this.states.get(repository.knowledgeBaseId) ?? defaultState(repository)
      return this.storeState({
        ...previous,
        busy: null,
        error: error ?? operationMessage(cause)
      })
    }
  }

  private async readState(
    repository: GitRepositoryDescriptor,
    lastFetchedAt?: string
  ): Promise<GitRepositoryStateDto> {
    const inside = await this.execute(repository.rootPath, ['rev-parse', '--is-inside-work-tree'])
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      return { ...defaultState(repository), error: '目录不是 Git 仓库' }
    }
    const [statusResult, branchResult, upstreamResult] = await Promise.all([
      this.execute(repository.rootPath, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all'
      ]),
      this.execute(repository.rootPath, ['branch', '--show-current']),
      this.execute(repository.rootPath, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}'
      ])
    ])
    if (statusResult.code !== 0) throw commandError(statusResult, 'Git status 失败')
    const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() || null : null
    let ahead = 0
    let behind = 0
    if (upstream) {
      const counts = await this.execute(repository.rootPath, [
        'rev-list',
        '--left-right',
        '--count',
        `HEAD...${upstream}`
      ])
      if (counts.code === 0) {
        const [left, right] = counts.stdout.trim().split(/\s+/).map(Number)
        ahead = Number.isFinite(left) ? left : 0
        behind = Number.isFinite(right) ? right : 0
      }
    }
    const changes = parseGitStatus(statusResult.stdout)
    // Attach notes via a dirName lookup — a linear `notes.find` per change is
    // O(changes × notes) and froze the main process for seconds on repos with
    // tens of thousands of pending changes.
    const notesByDirName = new Map(repository.notes.map((note) => [note.dirName, note]))
    const attached = changes.map((change) => this.attachNote(notesByDirName, change))
    // Precompute sort keys; localeCompare per comparison is ICU-slow at 40k+.
    const keyed = attached.map((change) => ({
      key: `${change.noteIndex ?? 'zzzz'}:${change.path}`,
      change
    }))
    keyed.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    const sorted = keyed.map((entry) => entry.change)
    const previous = this.states.get(repository.knowledgeBaseId)
    return {
      knowledgeBaseId: repository.knowledgeBaseId,
      knowledgeBaseName: repository.knowledgeBaseName,
      initialized: true,
      branch: branchResult.code === 0 ? branchResult.stdout.trim() || null : null,
      upstream,
      ahead,
      behind,
      changes: sorted,
      conflict: sorted.some((change) => change.status === 'conflicted'),
      busy: previous?.busy ?? null,
      lastFetchedAt: lastFetchedAt ?? previous?.lastFetchedAt ?? null,
      error: null
    }
  }

  private attachNote(
    notesByDirName: Map<string, GitRepositoryDescriptor['notes'][number]>,
    change: GitFileChangeDto
  ): GitFileChangeDto {
    const relative = change.path.replaceAll('\\', '/')
    const match = /^notes\/([^/]+)\//.exec(relative)
    const note = match ? notesByDirName.get(match[1]!) : undefined
    return note
      ? {
          ...change,
          noteUuid: note.uuid,
          noteIndex: note.index,
          noteTitle: note.title
        }
      : change
  }

  /**
   * 入队一个操作。
   *
   * 每个队列项是一个独立节点，取消**只作用于该项**：
   *  - 排队中取消：把该项标记失效，轮到它时**跳过执行**（不碰前面正在跑的操作）；
   *  - 运行中取消：触发该项自己的 AbortController，只终止它派生并登记的进程。
   *
   * `extras` 允许传工厂函数：操作可能在队列里等很久，观察者与取消信号是调用方在
   * 入队之后才准备好的（命令任务面板就是先认领标签、再开始执行）。入队时固化会让
   * 整条操作丢失实时输出与取消能力——实测踩过。
   */
  private enqueue(
    knowledgeBaseId: string,
    operation: (
      repository: GitRepositoryDescriptor,
      extras: GitRunExtras
    ) => Promise<GitOperationResult>,
    extras: GitRunExtras | (() => GitRunExtras) = {}
  ): { result: Promise<GitOperationResult>; node: QueueNode } {
    if (this.assetWritePaused.has(knowledgeBaseId)) {
      return {
        result: Promise.reject(new Error('资源整理进行中，Git 操作已暂停')),
        node: { id: 'rejected', canceled: true, running: false, killSpawns: () => {} }
      }
    }
    const repository = this.getRepository(knowledgeBaseId)
    const controller = new AbortController()
    const spawnKills = new Set<() => void>()
    const node: QueueNode = {
      id: `op-${++this.operationSeq}`,
      canceled: false,
      running: false,
      killSpawns: () => {
        for (const kill of [...spawnKills]) kill()
      }
    }
    node.controller = controller

    const nodes = this.queueNodes.get(knowledgeBaseId) ?? []
    nodes.push(node)
    this.queueNodes.set(knowledgeBaseId, nodes)

    const previous = this.operationTails.get(knowledgeBaseId) ?? Promise.resolve()
    const result = previous.then(async () => {
      // 排队期间被取消：跳过执行（前一个操作完全不受影响）
      if (node.canceled) throw new Error('操作已取消')
      if (this.assetWritePaused.has(knowledgeBaseId)) {
        throw new Error('资源整理进行中，Git 操作已暂停')
      }
      node.running = true
      this.runningNode.set(knowledgeBaseId, node)
      // 本次操作产生的子进程只登记在这一个节点上
      const registry: GitRunSpawnRegistry = {
        register: (kill) => {
          spawnKills.add(kill)
          this.disposeKills.add(kill)
        },
        unregister: () => {
          for (const kill of [...spawnKills]) {
            this.disposeKills.delete(kill)
          }
          spawnKills.clear()
        }
      }
      const resolved = typeof extras === 'function' ? extras() : extras
      // 调用方的取消信号与本次项的信号合并：任一触发都终止本项的子进程
      await new Promise<void>((resolve) => {
        if (node.canceled) {
          controller.abort()
          resolve()
          return
        }
        if (resolved.signal) {
          if (resolved.signal.aborted) {
            controller.abort()
            resolve()
            return
          }
          resolved.signal.addEventListener('abort', () => controller.abort(), { once: true })
        }
        resolve()
      })
      try {
        return await operation(repository, {
          ...resolved,
          signal: controller.signal,
          onSpawn: registry
        })
      } finally {
        node.running = false
        if (this.runningNode.get(knowledgeBaseId) === node) {
          this.runningNode.delete(knowledgeBaseId)
        }
      }
    })
    const tail = result.then(
      () => undefined,
      async (error) => {
        this.removeNode(knowledgeBaseId, node)
        // 被取消的操作**不做刷新**：取消不是失败，也不该因为一次刷新
        // （可能挂住的 fetch）把队列尾拖住——那会让后续操作永远排不上。
        if (node.canceled) return
        await this.refreshRepository(repository, operationMessage(error))
      }
    )
    this.operationTails.set(knowledgeBaseId, tail)
    const cleanup = (): void => {
      this.removeNode(knowledgeBaseId, node)
      if (this.operationTails.get(knowledgeBaseId) === tail) {
        this.operationTails.delete(knowledgeBaseId)
      }
      this.applyAutoPushSchedules()
    }
    void result.then(cleanup, cleanup)
    return { result, node }
  }

  private removeNode(knowledgeBaseId: string, node: QueueNode): void {
    const nodes = this.queueNodes.get(knowledgeBaseId)
    if (!nodes) return
    const next = nodes.filter((item) => item !== node)
    if (next.length === 0) this.queueNodes.delete(knowledgeBaseId)
    else this.queueNodes.set(knowledgeBaseId, next)
  }

  /**
   * 取消一个知识库上「尚未开始」的那一项（排队取消）。
   *
   * 只让该项失效，跳过它自己不执行；**不终止任何正在跑的操作**，更不碰其他知识库。
   * 返回被取消的项是否存在，便于调用方决定后续动作。
   */
  cancelQueuedOperation(knowledgeBaseId: string): boolean {
    const nodes = this.queueNodes.get(knowledgeBaseId)
    if (!nodes) return false
    const queued = nodes.find((node) => !node.running && !node.canceled)
    if (!queued) return false
    queued.canceled = true
    return true
  }

  /**
   * 取消一个知识库上**正在执行**的那一项。
   *
   * 只触发该项自己的 AbortController（其子进程终止器只登记在该项上），
   * 不涉及其他知识库或队列中的其他项。返回是否确实有运行中的项被终止。
   */
  cancelRunningOperation(knowledgeBaseId: string, operationId?: string): boolean {
    const running = this.runningNode.get(knowledgeBaseId)
    if (!running) return false
    // 只按知识库定位可能取消到同库的其他任务：带 operationId 时必须精确匹配
    if (operationId && running.id !== operationId) return false
    running.canceled = true
    running.controller?.abort()
    running.killSpawns()
    return true
  }

  /** 当前正在执行的那一项的身份（调用方用它做精确取消）。 */
  getRunningOperationId(knowledgeBaseId: string): string | null {
    return this.runningNode.get(knowledgeBaseId)?.id ?? null
  }

  /** 等该知识库的队列推进到空闲（初始化 refresh 也走这条队列）。 */
  async whenQueueIdle(knowledgeBaseId: string): Promise<void> {
    await this.waitForIdle(knowledgeBaseId)
  }

  private setBusy(knowledgeBaseId: string, busy: GitRepositoryStateDto['busy']): void {
    const state = this.getState(knowledgeBaseId)
    this.storeState({ ...state, busy, error: null })
  }

  private storeState(state: GitRepositoryStateDto): GitRepositoryStateDto {
    this.states.set(state.knowledgeBaseId, state)
    this.events.emit('changed', state)
    return state
  }

  private getState(knowledgeBaseId: string): GitRepositoryStateDto {
    const state = this.states.get(knowledgeBaseId)
    if (!state) throw new Error(`Git 状态不存在：${knowledgeBaseId}`)
    return state
  }

  private getRepository(knowledgeBaseId: string): GitRepositoryDescriptor {
    const repository = this.repositories.get(knowledgeBaseId)
    if (!repository) throw new Error(`知识库不存在：${knowledgeBaseId}`)
    return repository
  }
}

export const gitManager = new GitManager()
