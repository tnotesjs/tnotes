import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'

import { deskLog } from './log'

import type { TerminalDataEvent, TerminalSessionDto } from '../shared/contracts'

/** 最小结构类型：避免把 node-pty 的类型拖进主进程的编译面。 */
interface PtyProcess {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pause(): void
  resume(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: Record<string, string | undefined>
    }
  ): PtyProcess
}

interface TerminalSession {
  dto: TerminalSessionDto
  pty: PtyProcess | null
  dataSub: { dispose(): void } | null
  exitSub: { dispose(): void } | null
  /** 尚未推送给渲染端的输出，按 flush 间隔合并发送 */
  pending: string[]
  pendingBytes: number
  /** 已推送但渲染端还没回执的字节数——流控的水位就看它 */
  unackedBytes: number
  flushTimer: NodeJS.Timeout | null
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

/**
 * 输出推送的批量间隔。逐块推送会让 IPC 成为瓶颈（`yes` 每秒能产出几百 MB），
 * 合并到 ~1 帧再发，配合水位线流控。
 */
const FLUSH_INTERVAL_MS = 16
/** 已推送未回执字节超过高水位就暂停 PTY；回落到低水位再恢复。 */
const HIGH_WATERMARK = 512 * 1024
const LOW_WATERMARK = 128 * 1024
/** 允许的终端尺寸范围，挡掉渲染端传来的异常值。 */
const MIN_COLS = 2
const MAX_COLS = 1000
const MIN_ROWS = 1
const MAX_ROWS = 500

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
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
      if (existsSync(candidate)) return { shell: candidate, args: [] }
    }
    return { shell: env.ComSpec ?? 'cmd.exe', args: [] }
  }

  const candidates = [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(
    (value): value is string => Boolean(value)
  )
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { shell: candidate, args: ['-l'] }
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
  fill('TERM', 'xterm-256color')
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
 */
export class TerminalManager {
  private sessions = new Map<string, TerminalSession>()
  private listener: ((state: TerminalSessionDto) => void) | null = null
  private dataListener: ((event: TerminalDataEvent) => void) | null = null
  private disposed = false

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

  list(): TerminalSessionDto[] {
    return [...this.sessions.values()].map((session) => ({ ...session.dto }))
  }

  create(input: TerminalCreateInput): TerminalSessionDto {
    if (this.disposed) throw new Error('终端管理器已释放')
    const id = randomUUID()
    const { shell, args } = detectShell()
    const cols = clamp(input.cols ?? 80, MIN_COLS, MAX_COLS)
    const rows = clamp(input.rows ?? 24, MIN_ROWS, MAX_ROWS)

    const session: TerminalSession = {
      dto: {
        id,
        knowledgeBaseId: input.knowledgeBaseId,
        knowledgeBaseName: input.knowledgeBaseName,
        title: basename(shell),
        cwd: input.cwd,
        shell,
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
      closed: false
    }
    this.sessions.set(id, session)

    try {
      const pty = this.loadPty()
      const { env } = buildTerminalEnv()
      const child = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: input.cwd,
        env
      })
      session.pty = child
      session.dto.pid = child.pid
      session.dto.title = this.uniqueTitle(basename(shell))
      session.dataSub = child.onData((data) => this.push(session, data))
      session.exitSub = child.onExit((event) => this.handleExit(session, event))
      deskLog('terminal:create', id, { shell, cwd: input.cwd, pid: child.pid })
    } catch (error) {
      session.dto.status = 'exited'
      session.dto.error = error instanceof Error ? error.message : '终端启动失败'
      deskLog('terminal:create-failed', id, { message: session.dto.error })
    }

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
    session.dto = {
      ...session.dto,
      status: 'running',
      pid: null,
      exitCode: null,
      exitSignal: null,
      error: null
    }

    try {
      const pty = this.loadPty()
      const { shell, args } = detectShell()
      const { env } = buildTerminalEnv()
      const child = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: session.dto.cols,
        rows: session.dto.rows,
        cwd: session.dto.cwd,
        env
      })
      session.pty = child
      session.dto.pid = child.pid
      session.dto.shell = shell
      session.dataSub = child.onData((data) => this.push(session, data))
      session.exitSub = child.onExit((event) => this.handleExit(session, event))
    } catch (error) {
      session.dto.status = 'exited'
      session.dto.error = error instanceof Error ? error.message : '终端重启失败'
    }

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
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty?.write(data)
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

  /** 渲染端消费回执：只在高低水位之间切换，避免每块数据都 pause/resume。 */
  ack(sessionId: string, bytes: number): void {
    const session = this.sessions.get(sessionId)
    if (!session?.pty) return
    if (!Number.isFinite(bytes) || bytes <= 0) return
    session.unackedBytes = Math.max(0, session.unackedBytes - Math.trunc(bytes))
    if (session.unackedBytes <= LOW_WATERMARK) {
      try {
        session.pty.resume()
      } catch {
        /* 进程可能恰好退出，忽略 */
      }
    }
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
  }

  private loadPty(): PtyModule {
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
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => this.flush(session), FLUSH_INTERVAL_MS)
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
    this.dataListener?.({ sessionId: session.dto.id, data, bytes })
    // 高水位：暂停 PTY 让内核管道背压到子进程，等回执降到低水位再恢复
    if (session.unackedBytes > HIGH_WATERMARK) {
      try {
        session.pty?.pause()
      } catch {
        /* 忽略：进程可能已退出 */
      }
    }
  }

  private handleExit(session: TerminalSession, event: { exitCode: number; signal?: number }): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    this.flush(session)
    session.pty = null
    session.dataSub?.dispose()
    session.exitSub?.dispose()
    session.dataSub = null
    session.exitSub = null
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

  private emit(dto: TerminalSessionDto): void {
    this.listener?.({ ...dto })
  }
}

export const terminalManager = new TerminalManager()
