import { EventEmitter } from 'node:events'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { deskLog } from './log'
import { loadSettings } from './settings'
import { BackgroundFetchScheduler, BACKGROUND_FETCH_INTERVAL_MS } from './backgroundFetchScheduler'

import type { BackgroundFetchRequest } from './backgroundFetchScheduler'
import type { GitRepositoryDescriptor } from './workspaceManager'
import type {
  GitFileChangeDto,
  GitFileStatus,
  GitOperationResult,
  GitRepositoryStateDto
} from '../shared/contracts'

/** 切到某个知识库时，这么短时间内刚检查过就不再重复。 */
const FOCUSED_FETCH_FRESH_MS = 60_000

/**
 * 后台（定时 / 初次刷新）fetch 的超时。
 *
 * 与手动 fetch 的 60s 不同：后台抓取不该长时间占着队列，但 15s 也意味着
 * **慢于 15s 的远端在后台一定会失败**（终端里没有这个上限）。这是应用内与
 * 终端 `git fetch` 最确定的一处行为差异，诊断记录见报告。
 */
export const BACKGROUND_FETCH_TIMEOUT_MS = 15_000
export const MANUAL_FETCH_TIMEOUT_MS = 60_000

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
  /**
   * 所属进程组是否**已确认**清理完成。
   *
   * 正常情况为 true；只有在"清理超时仍探测到进程组存在"时才是 false ——
   * 这是如实标记，便于上层区分"没确认"与"没清理"。
   */
  cleanupConfirmed?: boolean
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
  /**
   * 运行期间为限制内存丢弃了最旧的输出时上报（保留必要的截断信息）。
   *
   * 这是**执行层**的缓存上限，与面板自己的日志上限是两回事：面板上限管不到
   * 这里累积的 Buffer（一次大输出会在任务面板之外把主进程内存吃满）。
   */
  outputTruncated?(droppedBytes: number): void
}

export interface GitRunExtras {
  observer?: GitRunObserver
  signal?: AbortSignal
  onSpawn?: GitRunSpawnRegistry
  /**
   * 本项**刚进入队列**时回调（还没轮到执行就会触发）。
   *
   * 调用方据此在「排队中」也能精确取消这一项：只凭知识库取消会打到当前正在跑的
   * **另一项**——同库可以有多个任务（后面的在队列里等），那正是必须避免的误杀。
   * `cancel` 只让这一项失效，不碰任何进程。
   */
  onEnqueued?: (operationId: string, cancel: () => void) => void
  /**
   * 判断"所属进程组是否还有存活成员"（默认用 `kill(-pgid, 0)`）。
   *
   * 抽出来是为了让测试能确定性地控制进程组的存活状态：真实进程组什么时候消失
   * 取决于操作系统，而"清理未确认时绝不能结算"这条约定必须可复现地钉住。
   */
  probeProcessGroup?: () => boolean
  /**
   * 「清理确认」硬上界的毫秒数（默认 `CLEANUP_ABSOLUTE_LIMIT_MS`）。
   *
   * 只为单测能快速验证这条兜底而暴露；生产不传。
   */
  cleanupAbsoluteLimitMs?: number
  /** 仅测试：硬上界到点时上报内部清理状态，便于定位"为何未结算" */
  onCleanupState?: (state: {
    childExited: boolean
    streamsEnded: boolean
    cleanupConfirmed: boolean
    groupAlive: boolean
    stopReason: string | null
    exitCode: number | null
  }) => void
  /**
   * 清理超时（`CLEANUP_GRACE_MS` 到点）但仍未确认进程组消失时上报。
   *
   * 这不是错误终态：调用方据此提示"进程还在收尾"，同时这一轮仍被跟踪、
   * **不会**被重试重复启动。
   */
  onCleanupUnconfirmed?: () => void
}

/** 后台 Git 任务的执行句柄（由装配方注入，避免 GitManager 直接依赖任务层）。 */
export interface BackgroundGitTaskHandle {
  observer: GitRunObserver
  finish(status: 'done' | 'failed' | 'timeout', error: string | null): void
}

export type BackgroundGitTaskFactory = (event: {
  knowledgeBaseId: string
  kind: 'git-fetch' | 'git-push'
}) => BackgroundGitTaskHandle | null

/**
 * 「没能建出可见任务」时的记录器（装配方注入，见 `onBackgroundFailureRecorder`）。
 *
 * 两步记录：先记"为什么没有标签"，执行完再用同一个 `id` 补上**真实 Git 结果**，
 * 这样界面里看到的是实际错误，而不是只看到容量门禁的抱怨。
 */
export type BackgroundFailureRecorder = (event: {
  knowledgeBaseId: string
  kind: 'git-fetch' | 'git-push'
  reason: string
  message: string
}) => { id: string }

/** 后台 fetch 的判定结果（比 `GitOperationResult` 多出"成功/超时"这一层）。 */
interface FetchOutcome {
  ok: boolean
  timedOut: boolean
  message: string | null
}

export function runGit(
  rootPath: string,
  args: string[],
  timeoutMs = 30_000,
  extras: GitRunExtras = {}
): Promise<CommandResult> {
  const { observer, signal, onSpawn } = extras
  observer?.commandLine?.(formatCommandLine(args))
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32'
    const child = spawn(gitExecutable(), args, {
      cwd: rootPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // 自成进程组：git 会再 fork 出 git-remote-http 之类的孙子进程。
      // 它们会**直接继承** stdout/stderr 管道，只杀直接子进程就会留下它们。
      detached
    })

    // ── 运行期间的输出缓存：必须有上限 ──
    // 这里累积的是 Buffer，任务面板自己的日志上限管不到；一次大输出
    // （几十万条变更的 status）会把主进程内存吃满。只保留最近的，并记录丢弃量。
    const MAX_BUFFER_BYTES = 2 * 1024 * 1024
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let droppedBytes = 0
    const pushChunk = (into: Buffer[], chunk: Buffer, currentBytes: number): number => {
      into.push(chunk)
      let total = currentBytes + chunk.length
      while (total > MAX_BUFFER_BYTES && into.length > 1) {
        const removed = into.shift()!
        total -= removed.length
        droppedBytes += removed.length
      }
      // 单块就超上限：只保留它的尾部
      if (total > MAX_BUFFER_BYTES && into.length === 1) {
        const only = into[0]
        const kept = only.subarray(only.length - MAX_BUFFER_BYTES)
        droppedBytes += only.length - kept.length
        into[0] = kept
        total = kept.length
      }
      if (droppedBytes > 0) observer?.outputTruncated?.(droppedBytes)
      return total
    }

    // ── 三个必须分开处理的状态 ──
    // ── 完成条件的三个独立事实（不能用其中一个代替另一个）──
    /** 主进程（直接子进程）是否已退出 */
    let childExited = false
    /** **进程组是否已确认清理完成**（不是"已发出 SIGKILL"） */
    let cleanupConfirmed = false
    /** 输出是否已收尾（stdout 与 stderr 都 end） */
    let streamsEnded = false
    /** 停止原因（取消/超时）；null 表示正常完成 */
    let stopReason: 'timeout' | 'canceled' | null = null
    let settled = false
    let terminated = false
    let exitCode: number | null = null
    let timer: NodeJS.Timeout | null = null
    let cleanupTimer: NodeJS.Timeout | null = null
    /** 强杀兜底定时器；确认清理完成就取消，仍有存活成员才保留 */
    let forceTimer: NodeJS.Timeout | null = null

    /** 终止之后等所属进程组清理完成的上限（SIGTERM→强杀→再给一点时间） */
    const CLEANUP_GRACE_MS = 3500
    /**
     * 清理确认的**最长等待**（只在主进程已退出、且已发出 SIGKILL 之后才计时）。
     *
     * 为什么需要硬上界：确认清理唯一判据是 `process.kill(-pid, 0)` 给 ESRCH，而 PID
     * 被回收之后这里会拿到 **EPERM**（macOS 上 PID 不会很快回收，所以本地从来不复现；
     * CI 的 Linux 上会）。EPERM 被当成"还有成员活着"会让 `checkCleanup()` **永久轮询**，
     * 于是这一轮 git 永不结算、`dispose()` 永不返回 —— 实测（CI，git 2.55.0）：
     * `卡在 manager.dispose()（>20000ms）；阶段=repoReady=47ms,queueIdle=53ms,gitProcessUp=195ms`，
     * 而同一时刻 `ps` 里已经没有任何 git 进程。
     * 主进程已退出 + 整个进程组都被 SIGKILL 过 + 又等满这个上界，仍然探测不到 ESRCH
     * 就按"清理完成"结算，避免把队列、`dispose()`、退出流程一起卡死。
     */
    const CLEANUP_ABSOLUTE_LIMIT_MS = extras.cleanupAbsoluteLimitMs ?? 8000
    /** 首次发出终止请求的时间（用于上面那个硬上界），null = 还没终止过 */
    let terminatedAt: number | null = null
    /** SIGTERM 之后多久强杀整个进程组 */
    const FORCE_KILL_MS = 3000

    const killProcessGroup = (sig: NodeJS.Signals): void => {
      try {
        if (detached && child.pid) process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch {
        /* 进程组已不存在 */
      }
    }

    /**
     * 所属进程组是否还有存活成员。
     *
     * 与"管道是否关闭"是两件事：管道关了不等于成员都没了（成员可能已把
     * stdout/stderr 关掉却仍在跑），所以清理确认要看进程组本身。
     */
    const processGroupAlive = (): boolean => {
      if (extras.probeProcessGroup) return extras.probeProcessGroup()
      if (!detached || !child.pid) return false
      try {
        process.kill(-child.pid, 0)
        return true
      } catch (error) {
        // ESRCH = 没有成员了；EPERM = 有成员但不属于我们（仍然算活着）
        return (error as { code?: string }).code !== 'ESRCH'
      }
    }

    const settle = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (cleanupTimer) clearTimeout(cleanupTimer)
      if (cleanupPoll) clearTimeout(cleanupPoll)
      // 确认结束之后才取消强杀兜底：否则会无条件向原来那个进程组 ID 发 SIGKILL
      if (forceTimer) clearTimeout(forceTimer)
      signal?.removeEventListener('abort', onAbort)
      onSpawn?.unregister?.()
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      if (stopReason === 'timeout') {
        // 超时：保留此前输出，把原因**追加**在既有 stderr 之后（不覆盖原始错误）
        resolve({
          code: 124,
          stdout,
          stderr: [stderr.trim(), `Git 操作超时：git ${args[0]}（${timeoutMs}ms）`]
            .filter(Boolean)
            .join('\n'),
          cleanupConfirmed
        })
        return
      }
      if (stopReason === 'canceled') {
        resolve({
          code: 130,
          stdout,
          stderr: [stderr.trim(), 'Git 操作已取消'].filter(Boolean).join('\n'),
          cleanupConfirmed
        })
        return
      }
      resolve({
        code: exitCode ?? 1,
        stdout,
        stderr,
        cleanupConfirmed
      })
    }

    /**
     * 确认**所属进程组**是否已清理完成。
     *
     * 唯一判据是进程组里**已经没有成员**（探测得到 ESRCH）。管道关闭、`close`、
     * `stopReason`、以及"已发出 SIGKILL"都**不算**：孙进程可能已经关掉输出流
     * 却仍在跑（真实 git 的传输子进程就是这样），那时结算就是提前解除占用。
     * 未自成进程组（Windows / 未 detached）没有独立的组要收，只认主进程退出。
     */
    let cleanupPoll: NodeJS.Timeout | null = null
    const checkCleanup = (): void => {
      if (cleanupConfirmed || settled) return
      // 清理确认看**进程组本身**，不是管道是否关闭，也不是"已发出 SIGKILL"：
      // 孙进程可能已经关掉输出流却仍在跑（真实 git 的传输子进程就是这样）。
      // 未自成进程组（Windows / 未 detached）没有独立的组要收，就只认主进程退出。
      let reaped = !detached || !processGroupAlive()
      // 有界兜底：主进程已退出 + 已强杀 + 等满上界 → 认定 pid 已被回收（探测拿到 EPERM），
      // 不再无限轮询。见 CLEANUP_ABSOLUTE_LIMIT_MS 的说明。
      const pastAbsoluteLimit =
        terminatedAt !== null && Date.now() - terminatedAt >= CLEANUP_ABSOLUTE_LIMIT_MS
      if (!reaped && pastAbsoluteLimit) {
        extras.onCleanupState?.({
          childExited,
          streamsEnded,
          cleanupConfirmed,
          groupAlive: processGroupAlive(),
          stopReason,
          exitCode
        })
      }
      if (!reaped && childExited && pastAbsoluteLimit) {
        reaped = true
      }
      if (reaped) {
        cleanupConfirmed = true
        if (cleanupPoll) {
          clearTimeout(cleanupPoll)
          cleanupPoll = null
        }
        maybeSettle()
        return
      }
      // 还有成员活着：低频轮询继续确认（不能自旋——自旋会占住事件循环，
      // 连强杀定时器都跑不到）。组可能晚于主进程才消失，所以必须一直等它。
      if (!cleanupPoll) {
        cleanupPoll = setTimeout(() => {
          cleanupPoll = null
          checkCleanup()
        }, 50)
      }
    }

    /** 输出收尾检查：只负责"读到尾巴了"，不负责清理确认 */
    const checkDrain = (): void => {
      if (settled || streamsEnded) return
      if (!child.stdout.readableEnded || !child.stderr.readableEnded) return
      streamsEnded = true
      checkCleanup()
    }

    /**
     * 三个事实**都**成立才结算：主进程已退出、所属进程组清理完成、输出已收尾。
     *
     * 不能用 `stopReason` 或"已发出 SIGKILL"代替退出确认：取消/超时只说明我们
     * 发出了终止请求，进程可能还在跑（忽略 SIGTERM）——那时结算就是提前解除占用、
     * 把还在跑的进程留成孤儿。
     */
    function maybeSettle(): void {
      if (settled) return
      if (!childExited || !cleanupConfirmed || !streamsEnded) return
      settle()
    }

    /**
     * 清理超时提示（**不是**完成信号）。
     *
     * 到点仍未确认进程组消失时，只记下"清理未确认"并通知调用方，然后继续按
     * `probeProcessGroup` 轮询——**绝不**把"时间到了"当成"清理完成"：
     * 那会提前结算、注销进程登记、释放队列，而进程还在跑。
     * 保留跟踪也就意味着这一轮不会被重试重复启动。
     */
    const bumpCleanupWatchdog = (): void => {
      if (cleanupTimer) return
      cleanupTimer = setTimeout(() => {
        cleanupTimer = null
        if (cleanupConfirmed || settled) return
        // 只上报"清理仍未确认"，**不**改任何完成状态：时间到了不等于清理成功
        extras.onCleanupUnconfirmed?.()
        // 继续等进程组真的消失；强杀兜底仍在（未被取消），必要时再确认一次
        checkCleanup()
      }, CLEANUP_GRACE_MS)
    }

    /**
     * 终止这一轮：SIGTERM → （FORCE_KILL_MS 后）SIGKILL。
     *
     * 幂等；main 进程先退出也**不取消**强杀兜底——孙子进程可能还活着。兜底只在
     * 确认清理完成（settle）时取消。
     */
    const terminate = (): void => {
      if (!terminated) {
        terminated = true
        terminatedAt = Date.now()
        killProcessGroup('SIGTERM')
        forceTimer = setTimeout(() => {
          forceTimer = null
          killProcessGroup('SIGKILL')
          // 强杀之后再确认一次：可能有成员刚被收掉
          checkCleanup()
        }, FORCE_KILL_MS)
      }
      bumpCleanupWatchdog()
      checkCleanup()
    }

    const onAbort = (): void => {
      if (settled || stopReason) return
      stopReason = 'canceled'
      terminate()
    }

    // ── 让调用方（gitManager.dispose / 应用退出）能终止这个子进程 ──
    // 少了这一步，退出时谁也碰不到正在跑的 git，孙子进程会留下来卡住退出。
    // 注册的终止器要覆盖"注册之前就已经在终止"的窗口：terminate 幂等，直接调一次。
    onSpawn?.register(terminate)

    if (signal) {
      if (signal.aborted) {
        stopReason = 'canceled'
        terminate()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    const trackStream = (stream: NodeJS.ReadableStream, isStdout: boolean): void => {
      stream.on('end', checkDrain)
      stream.on('data', (chunk: Buffer) => {
        if (isStdout) stdoutBytes = pushChunk(stdoutChunks, chunk, stdoutBytes)
        else stderrBytes = pushChunk(stderrChunks, chunk, stderrBytes)
        observer?.output(isStdout ? 'stdout' : 'stderr', chunk.toString('utf8'))
      })
    }
    trackStream(child.stdout, true)
    trackStream(child.stderr, false)

    timer = setTimeout(() => {
      if (settled || stopReason) return
      stopReason = 'timeout'
      terminate()
    }, timeoutMs)

    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (cleanupTimer) clearTimeout(cleanupTimer)
      if (forceTimer) clearTimeout(forceTimer)
      signal?.removeEventListener('abort', onAbort)
      onSpawn?.unregister?.()
      reject(error)
    })

    child.on('exit', (code) => {
      exitCode = code
      childExited = true
      // 主进程退出 ≠ 进程组清理完成（可能有孙进程）≠ 输出已收尾：
      // 三个事实分别确认，谁先到都只推进自己那一项。
      if (streamsEnded) checkCleanup()
      maybeSettle()
    })
    child.on('close', (code) => {
      exitCode = code
      childExited = true
      // close = 输出管道关闭：可以据此确认清理（管道关了说明没人在写了）
      if (streamsEnded) checkCleanup()
      checkCleanup()
    })

    // close 不一定来（孙进程可能一直占着管道），事件都挂好之后主动确认一次清理
    checkCleanup()
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
  /** 已开始退出：不再接收新任务，未启动的队列项一律失效 */
  private disposed = false
  /** 每个知识库当前正在执行的那一项（用于「运行中取消」精确定位） */
  private runningNode = new Map<string, QueueNode>()
  /** 进程级退出：所有在跑子进程的终止器（只用于 dispose，不参与单任务取消） */
  private disposeKills = new Set<() => void>()
  private autoPushTimers = new Map<string, NodeJS.Timeout>()
  /**
   * 后台任务工厂（由装配方注入，见 onBackgroundTaskFactory）。
   *
   * 后台 fetch / 自动推送在**开始时**通过它认领一个可见任务，结束时按真实结果结算：
   * 这样任务记录有真实的开始/结束时间与失败分类，而不是失败后补一条 0ms 的假记录。
   */
  private backgroundTaskFactory: BackgroundGitTaskFactory | null = null
  /** 「没能建出可见任务」时的记录器；未注入时退化为只写日志 */
  private backgroundFailureRecorder: BackgroundFailureRecorder | null = null
  /** 后台自动抓取调度闸门：全局并发上限 + 同目标去重 + 失败退避 */
  private readonly backgroundFetch = new BackgroundFetchScheduler({
    runner: (request) => this.runBackgroundFetch(request)
  })
  /** 当前设置里后台自动抓取是否开启（与调度器同步，避免每次判定都读配置） */
  private backgroundFetchEnabled = false
  private periodicFetchTimer: NodeJS.Timeout | null = null
  /** 后台只检查用户正在看的那个知识库；其它库不在后台联网。 */
  private focusedKnowledgeBaseId: string | null = null
  /** 窗口在后台时暂停定时检查，回到前台再按需补查。 */
  private windowActive = true
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

  /**
   * 注入后台任务工厂（定时 fetch、自动推送）。
   *
   * 后台操作原本只写日志：用户看不到失败，也没有「查看输出」的入口。接上工厂后，
   * 后台操作在开始时就会出现在命令任务面板里，失败/超时按真实分类结算，面板据此
   * 弹出带「查看输出」的通知。由装配方（main/index.ts）注入，避免 GitManager 直接
   * 依赖任务层。
   */
  onBackgroundTaskFactory(factory: BackgroundGitTaskFactory): void {
    this.backgroundTaskFactory = factory
  }

  /**
   * 注入"没能建出可见任务"的记录器。
   *
   * 没有可见任务时用户本来无从上图看到后台失败；注入后由 GitManager 在执行**结束后**
   * 用真实 `outcome.message` 补记，所以设置里看到的是真实 Git 错误，
   * 而不是"标签已满"这种挡在前面的原因。
   */
  onBackgroundFailureRecorder(recorder: BackgroundFailureRecorder): void {
    this.backgroundFailureRecorder = recorder
  }

  private createBackgroundTask(
    knowledgeBaseId: string,
    kind: 'git-fetch' | 'git-push'
  ): BackgroundGitTaskHandle | null {
    try {
      return this.backgroundTaskFactory?.({ knowledgeBaseId, kind }) ?? null
    } catch (cause) {
      // 任务层失败不能反过来影响 Git 流程
      deskLog('git:background-task', 'factory failed', {
        knowledgeBaseId,
        kind,
        message: cause instanceof Error ? cause.message : String(cause)
      })
      return null
    }
  }

  /** 设置里后台自动抓取是否开启。读配置失败时按**默认关闭**处理。 */
  private readAutoFetchSetting(): boolean {
    try {
      return loadSettings().git?.autoFetch === true
    } catch {
      return false
    }
  }

  /**
   * 把设置里的开关落到运行时：关闭时停掉定时器并清空等待队列（在跑的自然收敛），
   * 打开时启动定时器；**从关到开**的那一刻额外安排一轮抓取，用户不必等 5 分钟。
   *
   * 手动 fetch / pull 完全不经过这里——关掉后台抓取不影响用户主动操作。
   */
  applyBackgroundFetchPreference(options: { scheduleNow?: boolean } = {}): void {
    const enabled = this.readAutoFetchSetting()
    const transitioned = enabled && !this.backgroundFetchEnabled
    this.backgroundFetchEnabled = enabled
    this.backgroundFetch.setEnabled(enabled)
    if (!enabled) {
      this.stopPeriodicFetchTimer()
      return
    }
    this.startPeriodicFetchTimer()
    if (transitioned && options.scheduleNow !== false) this.scheduleBackgroundFetches()
  }

  private startPeriodicFetchTimer(): void {
    if (this.periodicFetchTimer || this.disposed) return
    this.periodicFetchTimer = setInterval(() => {
      if (this.disposed || !this.backgroundFetchEnabled) return
      this.scheduleBackgroundFetches()
    }, BACKGROUND_FETCH_INTERVAL_MS)
  }

  private stopPeriodicFetchTimer(): void {
    if (!this.periodicFetchTimer) return
    clearInterval(this.periodicFetchTimer)
    this.periodicFetchTimer = null
  }

  /**
   * 对当前知识库请求一次后台抓取（定时器与开关打开时走这里）。窗口在后台时跳过。
   *
   * 是否真的执行由调度器裁决：同一目标不会重复入队，处于失败退避窗口内的会被跳过。
   */
  scheduleBackgroundFetches(): void {
    if (!this.windowActive) return
    this.requestFocusedFetch('periodic', FOCUSED_FETCH_FRESH_MS)
  }

  /**
   * 用户切换到另一个知识库：立刻检查一次它的远端，定时器从这一刻重新计时。
   * 1 分钟内刚检查过的不再重复（来回切库不刷屏）。
   */
  setFocusedKnowledgeBase(knowledgeBaseId: string | null): void {
    if (this.focusedKnowledgeBaseId === knowledgeBaseId) return
    this.focusedKnowledgeBaseId = knowledgeBaseId
    if (!this.backgroundFetchEnabled || this.disposed) return
    this.stopPeriodicFetchTimer()
    this.startPeriodicFetchTimer()
    this.requestFocusedFetch('initial', FOCUSED_FETCH_FRESH_MS)
  }

  /** 窗口回到前台时，若距上次检查已超过一个周期就补查一次。 */
  setWindowActive(active: boolean): void {
    if (this.windowActive === active) return
    this.windowActive = active
    if (active) this.requestFocusedFetch('periodic', BACKGROUND_FETCH_INTERVAL_MS)
  }

  private requestFocusedFetch(trigger: 'initial' | 'periodic', freshWithinMs: number): void {
    const knowledgeBaseId = this.focusedKnowledgeBaseId
    if (!knowledgeBaseId || !this.backgroundFetchEnabled || this.disposed) return
    const state = this.states.get(knowledgeBaseId)
    // 手动操作正在跑（fetch/pull/publish 会置 busy）时不跟它抢，下一轮再来
    if (!state?.initialized || state.busy || this.assetWritePaused.has(knowledgeBaseId)) return
    const last = state.lastFetchedAt ? Date.parse(state.lastFetchedAt) : Number.NaN
    if (freshWithinMs > 0 && Number.isFinite(last) && Date.now() - last < freshWithinMs) return
    this.backgroundFetch.request(knowledgeBaseId, trigger)
  }

  /** 后台抓取的调度状态（测试与排查用）。 */
  backgroundFetchStatus(): ReturnType<BackgroundFetchScheduler['status']> {
    return this.backgroundFetch.status()
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
      // 只在开关打开时联网，且只查当前知识库。configure 在保存时也会触发，
      // 所以这里只补「从没检查过」的那一次，不按时间重复抓。
      const focused = this.focusedKnowledgeBaseId ? this.states.get(this.focusedKnowledgeBaseId) : null
      if (focused && !focused.lastFetchedAt) this.requestFocusedFetch('initial', 0)
      this.applyAutoPushSchedules(true)
    })
    // configure 期间只把开关落到运行时（不额外安排一轮）：refresh 完成后自会安排初次抓取
    this.applyBackgroundFetchPreference({ scheduleNow: false })
  }

  list(): GitRepositoryStateDto[] {
    return [...this.states.values()].sort((left, right) =>
      left.knowledgeBaseName.localeCompare(right.knowledgeBaseName)
    )
  }

  async refresh(knowledgeBaseId?: string): Promise<GitRepositoryStateDto[]> {
    // 退出已经开始就不再派生新的 git 进程：dispose() 会把未启动的队列项排空、
    // 终止在跑的子进程，但收尾的 best-effort 刷新是绕过队列直接执行的
    // （runGitTask 的 finally），如果不拦住，它会在排空之后再造出一个子进程，
    // 既没人等它，也没人杀它。
    if (this.disposed) return this.list()
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
    return this.enqueue<GitOperationResult>(
      knowledgeBaseId,
      async (repository, runExtras) => {
        if (!background) this.setBusy(knowledgeBaseId, 'fetch')
        const outcome = await this.executeFetch(repository, background, runExtras)
        if (!outcome.ok && !background) {
          await this.refreshRepository(repository, outcome.message)
          throw new Error(outcome.message ?? 'Git fetch 失败')
        }
        if (!outcome.ok) {
          deskLog('git:fetch', 'background fetch failed', {
            knowledgeBaseId,
            message: outcome.message,
            timedOut: outcome.timedOut
          })
        }
        const state = await this.refreshRepository(
          repository,
          null,
          outcome.ok ? new Date().toISOString() : undefined
        )
        return {
          state,
          message: outcome.ok ? '已获取远端最新状态' : (outcome.message ?? 'Git fetch 失败'),
          conflict: false
        }
      },
      extras
    ).result
  }

  /**
   * 执行一次 `git fetch --prune` 并**如实分类**结果。
   *
   * 超时由执行层用 code 124 表达（runGit 在超时时保留已有输出并追加原因），
   * 这里把它单独标出来：后台任务要结算成 `timeout` 而不是笼统的 `failed`。
   */
  private async executeFetch(
    repository: GitRepositoryDescriptor,
    background: boolean,
    runExtras: GitRunExtras
  ): Promise<FetchOutcome> {
    const result = await this.execute(
      repository.rootPath,
      ['fetch', '--prune'],
      background ? BACKGROUND_FETCH_TIMEOUT_MS : MANUAL_FETCH_TIMEOUT_MS,
      runExtras
    )
    if (result.code === 0) return { ok: true, timedOut: false, message: null }
    return {
      ok: false,
      timedOut: result.code === 124,
      message: operationMessage(commandError(result, 'Git fetch 失败'))
    }
  }

  /**
   * 后台抓取：走同一条 per-KB 队列，但由一个**可见任务**包住。
   *
   * 与手动 fetch 的区别只在超时（15s）与任务来源（background），业务路径完全一致；
   * 任务在真正开始执行时认领，结束时按真实结果结算（done / failed / timeout），
   * 因此任务记录里的时长与分类都是真的。
   */
  private runBackgroundFetch(request: BackgroundFetchRequest): Promise<boolean> {
    const knowledgeBaseId = request.knowledgeBaseId
    const repository = this.repositories.get(knowledgeBaseId)
    const state = this.states.get(knowledgeBaseId)
    // 目标已消失 / 还没就绪 / 资源写入暂停：当作"无需重试"（成功结算），清掉退避
    if (this.disposed || !repository || !state?.initialized) return Promise.resolve(true)
    if (this.assetWritePaused.has(knowledgeBaseId)) return Promise.resolve(true)

    // 任务在**执行开始时**才认领：观察者是稳定的转发器，避免 extras 工厂被
    // enqueue 调用两次而认领出两个任务。
    const holder: { task: BackgroundGitTaskHandle | null } = { task: null }
    const observer: GitRunObserver = {
      commandLine: (line) => holder.task?.observer.commandLine?.(line),
      output: (stream, chunk) => holder.task?.observer.output(stream, chunk),
      outputTruncated: (bytes) => holder.task?.observer.outputTruncated?.(bytes)
    }

    // 没有可见任务时（容量门禁拦下）也要把**真实执行结果**记下来。
    // 只在**最终失败**时记一条：成功不留下任何失败记录，也不会出现"先建后更"的 ×2。

    return new Promise<boolean>((resolve) => {
      void this.enqueue<FetchOutcome>(
        knowledgeBaseId,
        async (target, runExtras) => {
          holder.task = this.createBackgroundTask(knowledgeBaseId, 'git-fetch')
          const outcome = await this.executeFetch(target, true, runExtras)
          // 没有可见任务 + 最终失败 → 记一条（成功不记）
          if (!holder.task && !outcome.ok) {
            this.recordMissingBackgroundTask(
              knowledgeBaseId,
              'git-fetch',
              outcome.timedOut
                ? `Git 执行超时：${outcome.message ?? 'git fetch 超时'}`
                : (outcome.message ?? 'git fetch 失败')
            )
          }
          await this.refreshRepository(
            target,
            null,
            outcome.ok ? new Date().toISOString() : undefined
          )
          if (!outcome.ok) {
            deskLog('git:fetch', 'background fetch failed', {
              knowledgeBaseId,
              attempt: request.attempt,
              message: outcome.message,
              timedOut: outcome.timedOut
            })
          }
          return outcome
        },
        { observer }
      ).result.then(
        (outcome) => {
          holder.task?.finish(
            outcome.ok ? 'done' : outcome.timedOut ? 'timeout' : 'failed',
            outcome.ok ? null : outcome.message
          )
          resolve(outcome.ok)
        },
        (error) => {
          // 排队中被取消 / 退出 / 资源写入暂停：按失败计入退避，任务如实结算
          const message = operationMessage(error)
          if (!holder.task) {
            this.recordMissingBackgroundTask(
              knowledgeBaseId,
              'git-fetch',
              `Git 未执行完成：${message}`
            )
          }
          holder.task?.finish('failed', message)
          resolve(false)
        }
      )
    })
  }

  /**
   * 记录一条"没有可见任务"的后台失败。
   *
   * 没注入记录器时退化为只写日志（不能反过来影响 Git 流程）。
   * 传 `id` 表示**更新已有条目**（先记原因、执行完补真实错误）。
   */
  private recordMissingBackgroundTask(
    knowledgeBaseId: string,
    kind: 'git-fetch' | 'git-push',
    message: string
  ): string | null {
    // reason 说明"为什么这条失败没有可见任务"；message 是**真实执行结果**。
    // 两者分开，聚合才按最终错误走，而不是按容量提示走。
    const reason = '底部面板标签已达上限，没有可见任务'
    if (!this.backgroundFailureRecorder) {
      deskLog('git:background-task', 'no visible task', { knowledgeBaseId, kind, message })
      return null
    }
    try {
      return this.backgroundFailureRecorder({ knowledgeBaseId, kind, reason, message }).id
    } catch (cause) {
      deskLog('git:background-task', 'failure recorder failed', {
        knowledgeBaseId,
        kind,
        message: cause instanceof Error ? cause.message : String(cause)
      })
      return null
    }
  }

  pull(knowledgeBaseId: string, extras: GitRunExtras = {}): Promise<GitOperationResult> {
    return this.enqueue(
      knowledgeBaseId,
      async (repository, runExtras) => {
        this.setBusy(knowledgeBaseId, 'pull')
        const fetchResult = await this.execute(
          repository.rootPath,
          ['fetch', '--prune'],
          MANUAL_FETCH_TIMEOUT_MS,
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
            // 自动推送也走可见任务：开始前认领、结束后按真实结果结算（失败/超时分类）。
            // 满额时没有可见任务 → 与 fetch 同样处理：**最终失败**才记一条无标签失败，
            // 否则用户完全看不到自动推送失败。
            const task = this.createBackgroundTask(repository.knowledgeBaseId, 'git-push')
            void this.publish(
              repository.knowledgeBaseId,
              task ? { observer: task.observer } : {}
            ).then(
              (outcome) => {
                if (outcome.conflict) {
                  const message = outcome.message || '自动推送未完成'
                  deskLog('git:auto-push', 'failed', message)
                  if (!task) {
                    this.recordMissingBackgroundTask(
                      repository.knowledgeBaseId,
                      'git-push',
                      message
                    )
                  }
                  task?.finish('failed', message)
                  return
                }
                task?.finish('done', null)
              },
              (error) => {
                const message = operationMessage(error)
                deskLog('git:auto-push', 'failed', message)
                if (!task) {
                  this.recordMissingBackgroundTask(
                    repository.knowledgeBaseId,
                    'git-push',
                    /超时/.test(message) ? `Git 执行超时：${message}` : message
                  )
                }
                task?.finish(/超时/.test(message) ? 'timeout' : 'failed', message)
              }
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
    // 1) 退出开始：不再接收新任务，并停掉后台调度
    this.disposed = true
    this.stopPeriodicFetchTimer()
    // 等待队列清空；在跑的后台 fetch 会在各自任务里如实结算
    this.backgroundFetch.dispose()
    for (const timer of this.autoPushTimers.values()) clearTimeout(timer)
    this.autoPushTimers.clear()

    // 2) 让未启动的队列项失效，并**迭代**到队列排空：
    //    一个 pending 队列项会串在 operationTails 上；它结算后其后继才轮到执行，
    //    因此单次快照会漏掉链式后继——那些项的 promise 会永远挂着。
    for (let pass = 0; pass < 50; pass += 1) {
      let touched = false
      for (const nodes of this.queueNodes.values()) {
        for (const node of nodes) {
          if (!node.running && !node.canceled) {
            node.canceled = true
            touched = true
          }
        }
      }
      // 3) 终止正在跑的 git 子进程（等 close 的那一套由 runGit 负责）
      const killCount = this.disposeKills.size
      for (const kill of [...this.disposeKills]) kill()
      // 临时诊断（定位 CI 上 dispose() 卡在哪一步）：只写日志，不改行为
      const nodesSnapshot = [...this.queueNodes.values()]
        .flat()
        .map(
          (node) =>
            `${node.id}:${node.running ? 'running' : 'idle'}:${node.canceled ? 'canceled' : 'live'}`
        )
      deskLog('git:dispose', `pass=${pass}`, {
        knowledgeBaseId: null,
        tails: this.operationTails.size,
        kills: killCount,
        nodes: nodesSnapshot.join(',')
      })
      let tailTimedOut = false
      await Promise.race([
        Promise.allSettled([...this.operationTails.values()]),
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            tailTimedOut = true
            resolve()
          }, GitManager.DISPOSE_TAIL_TIMEOUT_MS)
          timer.unref?.()
        })
      ])
      if (tailTimedOut) {
        // 如实记录"还有谁没结算"，然后结束这一轮：继续等会把退出流程拖死
        deskLog('git:dispose', 'tail timeout', {
          knowledgeBaseId: null,
          tails: this.operationTails.size,
          nodes: nodesSnapshot.join(',')
        })
        break
      }
      const pending = [...this.queueNodes.values()].flat().filter((node) => !node.canceled)
      if (pending.length === 0) break
      if (!touched && pending.every((node) => node.running)) break
    }
    this.events.removeAllListeners()
  }

  /**
   * `dispose()` 每轮等待队列结算的上界。
   *
   * 退出流程不允许被单个操作无限拖住：CI 上实测过 `dispose()` 卡在
   * `Promise.allSettled(operationTails)` 超过 20s 仍不返回（本地从未复现，
   * 详见 `docs/round-fixes-report.md`）。到点不再干等，改为如实记录"谁还没结算"
   * 后继续/结束退出——宁可留下一条可诊断的日志，也不让应用退不掉。
   */
  static readonly DISPOSE_TAIL_TIMEOUT_MS = 5000

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
        120_000,
        // 漏传 extras 会让 commit 阶段既看不到输出、也收不到取消信号：
        // 取消 push 任务时 commit 子进程会一直跑到自己结束。
        extras
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
  private enqueue<T>(
    knowledgeBaseId: string,
    operation: (repository: GitRepositoryDescriptor, extras: GitRunExtras) => Promise<T>,
    extras: GitRunExtras | (() => GitRunExtras) = {}
  ): { result: Promise<T>; node: QueueNode } {
    if (this.disposed) {
      return {
        result: Promise.reject(new Error('Desk 正在退出，Git 操作不再受理')),
        node: { id: 'rejected', canceled: true, running: false, killSpawns: () => {} }
      }
    }
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

    // 入队就已确定身份：调用方在「排队中」也能精确取消这一项（不碰正在跑的另一项）。
    // extras 可能是工厂（pull 用它推迟读取观察者），这里解析一次只为取入口回调；
    // 真正的执行仍会在轮到时重新解析。
    const resolvedAtEnqueue = typeof extras === 'function' ? extras() : extras
    resolvedAtEnqueue.onEnqueued?.(node.id, () => {
      node.canceled = true
    })

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
      // 一进队列就已被取消（信号已中止 / 排队期间被取消）：直接拒绝，不执行任何命令。
      // 原先这里只是 abort 自己的 controller，而此刻还没有任何子进程登记，
      // 于是操作照常执行 —— 取消请求被完全忽略。
      if (node.canceled || resolved.signal?.aborted) {
        node.canceled = true
        throw new Error('操作已取消')
      }
      // 调用方的取消信号与本次项的信号合并：任一触发都终止本项的子进程
      resolved.signal?.addEventListener('abort', () => controller.abort(), { once: true })
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

  /**
   * 队列状态快照：明确表达「有多少项在排队 / 正在跑 / 已失效」。
   *
   * 供调用方（含测试）确定性判断队列是否空闲，不需要去猜"安静了多久"。
   */
  queueStatus(knowledgeBaseId?: string): {
    queued: number
    running: number
    canceled: number
    disposed: boolean
  } {
    const groups = knowledgeBaseId
      ? [[knowledgeBaseId, this.queueNodes.get(knowledgeBaseId) ?? []] as const]
      : [...this.queueNodes.entries()]
    let queued = 0
    let running = 0
    let canceled = 0
    for (const [, nodes] of groups) {
      for (const node of nodes) {
        if (node.canceled) canceled += 1
        else if (node.running) running += 1
        else queued += 1
      }
    }
    return { queued, running, canceled, disposed: this.disposed }
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
