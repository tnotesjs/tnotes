import { randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { basename } from 'node:path'

import { ensureBottomPanelCapacity, registerBottomPanelTabProvider } from './bottomPanelTabs'
import { deskLog } from './log'

import type { BottomPanelTabSnapshot } from '../shared/bottomPanelTabs'
import type { TerminalDataEvent, TerminalSessionDto } from '../shared/contracts'

/** 最小结构类型：避免把 node-pty 的类型拖进主进程的编译面。 */
export interface PtyProcess {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pause(): void
  resume(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

export interface PtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string | undefined>
}

export interface PtyModule {
  spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess
}

interface TerminalSession {
  dto: TerminalSessionDto
  /**
   * 运行代次：每次 spawn 自增，并写进 dto 与数据事件。
   *
   * 重启复用 sessionId，但旧运行的延迟回执、未发完的输入、残留的 xterm 回调都不能
   * 作用于新进程，否则未确认量会被错误扣减、旧粘贴会进新 shell。所有 write/ack 都按
   * 这个代次校验。
   */
  generation: number
  pty: PtyProcess | null
  dataSub: { dispose(): void } | null
  exitSub: { dispose(): void } | null
  /** 还没合批推送的输出 */
  pending: string[]
  pendingBytes: number
  /** 已推送但渲染端还没回执的字节数 */
  unackedBytes: number
  flushTimer: NodeJS.Timeout | null
  /** 是否已因背压暂停 PTY，避免重复调用 pause/resume */
  paused: boolean
  /** 用户主动关闭时不要再往外推 exited 状态 */
  closed: boolean
}

export interface TerminalCreateInput {
  knowledgeBaseId: string
  knowledgeBaseName: string
  cwd: string
  cols?: number
  rows?: number
}

export interface TerminalManagerOptions {
  /** 注入 PTY 实现，默认延迟 require('node-pty')；测试用假实现 */
  loadPty?: () => PtyModule
  /** 背压上限，测试里调小以便触发 */
  highWatermark?: number
  lowWatermark?: number
  flushIntervalMs?: number
}

/**
 * 输出推送的批量间隔。逐块推送会让 IPC 成为瓶颈（`yes` 每秒能产出几百 MB），
 * 合并到 ~1 帧再发。
 */
const DEFAULT_FLUSH_INTERVAL_MS = 16
/**
 * 背压水位，**按整条链路**算：`待发送(pending) + 已发送未回执(unacked)`。
 * 只算 unacked 的话，一个不消费的渲染端会让我们在两次 flush 之间无限堆 pending，
 * 512KB 就不是链路上限了。
 */
const DEFAULT_HIGH_WATERMARK = 512 * 1024
const DEFAULT_LOW_WATERMARK = 128 * 1024
/** 允许的终端尺寸范围，挡掉渲染端传来的异常值。 */
const MIN_COLS = 2
const MAX_COLS = 1000
const MIN_ROWS = 1
const MAX_ROWS = 500

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 文件存在**且可执行候选**才算数：只看存在会把不可执行的路径选成 shell。 */
function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 探测本机 shell：macOS/Linux 优先 `$SHELL`（存在且可执行才算），否则依次回退；
 * Windows 优先 PowerShell，再回退 `cmd.exe`。
 *
 * 第一版只自动探测，不做配置项。
 */
export function detectShell(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env
): { shell: string; args: string[] } {
  if (platform === 'win32') {
    const candidates = [
      `${env.ProgramFiles ?? 'C:\\Program Files'}\\PowerShell\\7\\pwsh.exe`,
      `${env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    ]
    for (const candidate of candidates) {
      if (isExecutable(candidate)) return { shell: candidate, args: [] }
    }
    return { shell: env.ComSpec ?? 'cmd.exe', args: [] }
  }

  const candidates = [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(
    (value): value is string => Boolean(value)
  )
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return { shell: candidate, args: ['-l'] }
  }
  return { shell: '/bin/sh', args: ['-l'] }
}

/**
 * 继承并补全环境变量：只在缺失时补，**绝不覆盖**用户已有值。
 *
 * 打包应用被 Finder 启动时继承的 PATH 可能只有几段（没有 /opt/homebrew/bin 等），
 * 但登录 shell 自己会把 PATH 补全，所以这里不手工拼 PATH —— 实测见阶段 0 报告。
 * 真正需要补的是 `TERM`/`COLORTERM`（彩色输出）与 `LANG`（中文输入输出）。
 */
export function buildTerminalEnv(env: Record<string, string | undefined> = process.env): {
  env: Record<string, string | undefined>
  filled: string[]
} {
  const next = { ...env }
  const filled: string[] = []
  const fill = (key: string, value: string): void => {
    if (!next[key]) {
      next[key] = value
      filled.push(key)
    }
  }
  // `TERM=dumb` 对终端来说是「不可用值」而不是用户偏好：它会让颜色与 TUI 程序
  // 直接降级（Finder 启动的打包应用、部分 CI 都会带着它）。这里升级掉。
  if (!next.TERM || next.TERM === 'dumb') {
    next.TERM = 'xterm-256color'
    filled.push('TERM')
  }
  fill('COLORTERM', 'truecolor')
  fill('LANG', process.platform === 'win32' ? 'zh_CN.UTF-8' : 'en_US.UTF-8')
  return { env: next, filled }
}

/**
 * 终端会话管理器。
 *
 * 生命周期规则（阶段 1 定死）：
 *  - **收起面板 ≠ 结束进程**：面板只是视图，会话由本管理器持有；
 *  - **切换知识库不改变已有会话的 cwd**；新会话才用传入的 cwd；
 *  - 退出应用时 `dispose()` 结束所有会话，避免预览服务之类的残留。
 *
 * 背压不变量：`pendingBytes + unackedBytes > highWatermark` 时暂停 PTY 读取，
 * 回落到 lowWatermark 以下再恢复——两个量都必须参与，否则队列上限形同虚设。
 */
export class TerminalManager {
  private sessions = new Map<string, TerminalSession>()
  private listener: ((state: TerminalSessionDto) => void) | null = null
  private dataListener: ((event: TerminalDataEvent) => void) | null = null
  /** 会话被移除（用户关闭 / 容量回收）时通知渲染端，避免界面留下已经不存在的标签 */
  private removedListener: ((sessionId: string) => void) | null = null
  private disposed = false
  private readonly ptyLoader: () => PtyModule
  private readonly highWatermark: number
  private readonly lowWatermark: number
  private readonly flushIntervalMs: number
  /** 便于测试观察背压行为：当前暂停中的会话数量 */
  private pausedSessions = 0

  constructor(options: TerminalManagerOptions = {}) {
    this.ptyLoader = options.loadPty ?? (() => this.requirePty())
    this.highWatermark = options.highWatermark ?? DEFAULT_HIGH_WATERMARK
    this.lowWatermark = options.lowWatermark ?? DEFAULT_LOW_WATERMARK
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    // 底部面板的统一容量检查要把终端会话算进去：本管理器只提供「有哪些标签 / 怎么回收」，
    // 判定规则在 shared/bottomPanelTabs（主进程与渲染端共用一份）。
    registerBottomPanelTabProvider({
      kind: 'terminal',
      listTabs: () => this.bottomPanelTabs(),
      closeTab: (sessionId) => this.close(sessionId)
    })
  }

  onChanged(listener: (state: TerminalSessionDto) => void): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = null
    }
  }

  onData(listener: (event: TerminalDataEvent) => void): () => void {
    this.dataListener = listener
    return () => {
      if (this.dataListener === listener) this.dataListener = null
    }
  }

  /** 会话被移除时回调（用户关闭或容量回收都会走这里）。 */
  onRemoved(listener: (sessionId: string) => void): () => void {
    this.removedListener = listener
    return () => {
      if (this.removedListener === listener) this.removedListener = null
    }
  }

  list(): TerminalSessionDto[] {
    return [...this.sessions.values()].map((session) => ({ ...session.dto }))
  }

  /**
   * 容量检查用的标签快照。
   *
   * 只有**仍在运行**的会话不可回收；已退出的会话是回收候选（回收它不会结束任何进程）。
   * 这里用 `status` 判定，而不是「有没有 pty」——spawn 失败的会话也是 exited，同样可回收。
   */
  bottomPanelTabs(): BottomPanelTabSnapshot[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.dto.id,
      kind: 'terminal' as const,
      active: session.dto.status === 'running',
      createdAt: session.dto.createdAt
    }))
  }

  create(input: TerminalCreateInput): TerminalSessionDto {
    if (this.disposed) throw new Error('终端管理器已释放')
    // 统一容量检查：达到上限时优先回收最老的已退出会话；全部在运行则抛错拦住创建。
    // 必须在这里（真正 spawn 之前）判，不能先起进程再报错。
    ensureBottomPanelCapacity({ kind: 'terminal' })
    const id = randomUUID()
    const cols = clamp(input.cols ?? 80, MIN_COLS, MAX_COLS)
    const rows = clamp(input.rows ?? 24, MIN_ROWS, MAX_ROWS)

    const session: TerminalSession = {
      generation: 1,
      dto: {
        id,
        generation: 1,
        knowledgeBaseId: input.knowledgeBaseId,
        knowledgeBaseName: input.knowledgeBaseName,
        title: basename(input.cwd),
        cwd: input.cwd,
        shell: '',
        status: 'running',
        pid: null,
        cols,
        rows,
        exitCode: null,
        exitSignal: null,
        error: null,
        createdAt: Date.now()
      },
      pty: null,
      dataSub: null,
      exitSub: null,
      pending: [],
      pendingBytes: 0,
      unackedBytes: 0,
      flushTimer: null,
      paused: false,
      closed: false
    }
    this.sessions.set(id, session)
    this.spawn(session, input.cwd, true)

    const dto = { ...session.dto }
    this.emit(dto)
    return dto
  }

  /** 进程已退出时重新起一个（保留标签与目录归属，符合"退出后保留输出可重启"）。 */
  restart(sessionId: string): TerminalSessionDto {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('终端会话不存在')
    this.kill(session)
    session.closed = false
    session.pending = []
    session.pendingBytes = 0
    session.unackedBytes = 0
    session.paused = false
    // 代次 +1：新进程与旧进程的回执/输入从此对不上号
    session.generation += 1
    session.dto = {
      ...session.dto,
      generation: session.generation,
      status: 'running',
      pid: null,
      exitCode: null,
      exitSignal: null,
      error: null
    }
    this.spawn(session, session.dto.cwd)

    const dto = { ...session.dto }
    this.emit(dto)
    return dto
  }

  rename(sessionId: string, title: string): TerminalSessionDto {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('终端会话不存在')
    const trimmed = title.trim()
    if (trimmed) session.dto.title = trimmed.slice(0, 60)
    const dto = { ...session.dto }
    this.emit(dto)
    return dto
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.closed = true
    this.kill(session)
    this.sessions.delete(sessionId)
    deskLog('terminal:close', sessionId)
    this.emitRemoved(sessionId)
  }

  /**
   * 写入终端。`generation` 与当前运行不符时抛错——那是上一次运行残留的输入
   * （例如粘贴发到一半时进程退出并重启），不能送进新 shell。
   */
  write(sessionId: string, data: string, generation: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('终端会话不存在')
    if (generation !== session.generation) {
      throw new Error('该输入属于上一次终端运行，已丢弃')
    }
    session.pty?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session?.pty) return
    const nextCols = clamp(cols, MIN_COLS, MAX_COLS)
    const nextRows = clamp(rows, MIN_ROWS, MAX_ROWS)
    if (nextCols === session.dto.cols && nextRows === session.dto.rows) return
    session.dto.cols = nextCols
    session.dto.rows = nextRows
    try {
      session.pty.resize(nextCols, nextRows)
    } catch (error) {
      deskLog('terminal:resize-failed', sessionId, {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * 渲染端消费回执：只在高低水位之间切换，避免每块数据都 pause/resume。
   *
   * **必须按代次过滤**：延迟回执属于旧运行，直接扣减会凭空抹掉新进程的未确认量，
   * 让背压彻底失效（新进程变成永不暂停）。代次不符就静默忽略——这是预期内的竞态，
   * 不该报错打扰调用方。
   */
  ack(sessionId: string, bytes: number, generation: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (generation !== session.generation) return
    if (!Number.isFinite(bytes) || bytes <= 0) return
    session.unackedBytes = Math.max(0, session.unackedBytes - Math.trunc(bytes))
    this.settleBackpressure(session)
  }

  /** 观测用：当前被背压暂停的会话数与各会话链路字节数。 */
  backpressureSnapshot(): Array<{
    sessionId: string
    pending: number
    unacked: number
    paused: boolean
  }> {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.dto.id,
      pending: session.pendingBytes,
      unacked: session.unackedBytes,
      paused: session.paused
    }))
  }

  /** 退出应用时结束所有会话；不 await 任何可能挂住的东西。 */
  dispose(): void {
    this.disposed = true
    for (const session of this.sessions.values()) {
      session.closed = true
      this.kill(session)
    }
    this.sessions.clear()
    this.listener = null
    this.dataListener = null
    this.removedListener = null
    this.pausedSessions = 0
  }

  /** 通知渲染端某个会话已经不在注册表里了（关闭或容量回收）。异常不能逃出去。 */
  private emitRemoved(sessionId: string): void {
    try {
      this.removedListener?.(sessionId)
    } catch (error) {
      deskLog('terminal:removed-failed', sessionId, {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** 起一个 PTY 挂到会话上；失败落到 dto.error，不让调用方抛出。 */
  private spawn(session: TerminalSession, cwd: string, nameFromShell = false): void {
    try {
      const pty = this.ptyLoader()
      const { shell, args } = detectShell()
      const { env } = buildTerminalEnv()
      const child = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: session.dto.cols,
        rows: session.dto.rows,
        cwd,
        env
      })
      session.pty = child
      session.dto.pid = child.pid
      session.dto.shell = shell
      // 只有首次创建用 shell 名当标题：重启不该把用户改过的标签覆盖掉
      if (nameFromShell) session.dto.title = this.uniqueTitle(basename(shell))
      session.dto.error = null
      session.dataSub = child.onData(
        this.guardPtyCallback('onData', session.dto.id, (data: string) => this.push(session, data))
      )
      session.exitSub = child.onExit(
        this.guardPtyCallback(
          'onExit',
          session.dto.id,
          (event: { exitCode: number; signal?: number }) => this.handleExit(session, event)
        )
      )
      deskLog('terminal:create', session.dto.id, { shell, cwd, pid: child.pid })
    } catch (error) {
      session.dto.status = 'exited'
      session.dto.error = error instanceof Error ? error.message : '终端启动失败'
      deskLog('terminal:create-failed', session.dto.id, { message: session.dto.error })
    }
  }

  private requirePty(): PtyModule {
    // 延迟到真正建会话时再 require：node-pty 是原生模块，加载失败要能落到
    // 「会话创建失败」而不是让整个主进程起不来。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node-pty') as PtyModule
  }

  private uniqueTitle(base: string): string {
    const used = new Set([...this.sessions.values()].map((session) => session.dto.title))
    if (!used.has(base)) return base
    let index = 2
    while (used.has(`${base} (${index})`)) index += 1
    return `${base} (${index})`
  }

  private push(session: TerminalSession, data: string): void {
    if (session.closed || !data) return
    session.pending.push(data)
    session.pendingBytes += Buffer.byteLength(data)
    // 队列本身也要参与背压：否则两次 flush 之间就能堆出任意大小的 pending
    this.applyBackpressure(session)
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => this.flush(session), this.flushIntervalMs)
    }
  }

  private flush(session: TerminalSession): void {
    session.flushTimer = null
    if (session.closed || session.pending.length === 0) return
    const data = session.pending.join('')
    const bytes = session.pendingBytes
    session.pending = []
    session.pendingBytes = 0
    session.unackedBytes += bytes
    this.safeSendData({
      sessionId: session.dto.id,
      generation: session.generation,
      data,
      bytes
    })
    this.applyBackpressure(session)
  }

  /** 超过高水位就暂停 PTY 读取，让内核管道把背压传回子进程。 */
  private applyBackpressure(session: TerminalSession): void {
    if (session.paused || !session.pty) return
    if (session.pendingBytes + session.unackedBytes <= this.highWatermark) return
    try {
      session.pty.pause()
      session.paused = true
      this.pausedSessions += 1
    } catch {
      /* 进程可能恰好退出，忽略 */
    }
  }

  /** 回执之后尝试恢复；只有回落到低水位以下才 resume。 */
  private settleBackpressure(session: TerminalSession): void {
    if (!session.paused) return
    if (session.pendingBytes + session.unackedBytes > this.lowWatermark) return
    try {
      session.pty?.resume()
    } catch {
      /* 忽略：进程可能已退出 */
    }
    session.paused = false
    this.pausedSessions = Math.max(0, this.pausedSessions - 1)
  }

  private handleExit(session: TerminalSession, event: { exitCode: number; signal?: number }): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    // 退出前把残留输出送出去，保证渲染端能看到最后几行
    this.flush(session)
    session.pty = null
    session.dataSub?.dispose()
    session.exitSub?.dispose()
    session.dataSub = null
    session.exitSub = null
    session.paused = false
    session.dto.status = 'exited'
    session.dto.pid = null
    session.dto.exitCode = event.exitCode ?? null
    session.dto.exitSignal = event.signal ?? null
    deskLog('terminal:exit', session.dto.id, {
      exitCode: session.dto.exitCode,
      signal: session.dto.exitSignal
    })
    if (!session.closed) this.emit({ ...session.dto })
  }

  private kill(session: TerminalSession): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    session.dataSub?.dispose()
    session.exitSub?.dispose()
    session.dataSub = null
    session.exitSub = null
    session.pending = []
    session.pendingBytes = 0
    session.unackedBytes = 0
    if (session.paused) {
      session.paused = false
      this.pausedSessions = Math.max(0, this.pausedSessions - 1)
    }
    const child = session.pty
    session.pty = null
    if (!child) return
    try {
      // 结束整个进程组：只 kill shell 会把它启动的子进程（如 vite dev）留成孤儿
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGHUP')
        } catch {
          child.kill('SIGHUP')
        }
      } else {
        child.kill()
      }
    } catch (error) {
      deskLog('terminal:kill-failed', session.dto.id, {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * 通知渲染端状态变化。
   *
   * **异常绝不能逃出去**：`onExit` 回调由 node-pty 的线程安全函数调用，而
   * `Napi::ThreadSafeFunction::CallJS` 不捕获宿主回调抛出的异常——一旦抛出就会变成
   * 未捕获的 C++ 异常并 `abort()` 整个应用（实测崩溃栈：pty.node → CallJS →
   * __cxa_throw → abort）。窗口正在销毁时 `webContents.send` 正好会抛。
   */
  private emit(dto: TerminalSessionDto): void {
    try {
      this.listener?.({ ...dto })
    } catch (error) {
      deskLog('terminal:emit-failed', dto.id, {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** 同 emit：推数据也在 PTY 的回调栈里，失败只能记日志，不能向上抛。 */
  private safeSendData(event: TerminalDataEvent): void {
    try {
      this.dataListener?.(event)
    } catch (error) {
      deskLog('terminal:data-failed', event.sessionId, {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** 包装 PTY 回调：订阅方与原生回调之间必须有一层兜底。 */
  private guardPtyCallback<T extends unknown[]>(
    label: string,
    sessionId: string,
    handler: (...args: T) => void
  ): (...args: T) => void {
    return (...args: T): void => {
      try {
        handler(...args)
      } catch (error) {
        deskLog(`terminal:${label}-failed`, sessionId, {
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}

export const terminalManager = new TerminalManager()
