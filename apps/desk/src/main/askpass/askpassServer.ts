import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import type { GitAskpassBridge } from '../gitManager'

/** 发给界面的一次凭据询问 */
export interface AskpassPrompt {
  id: string
  runId: string
  /** git / ssh 给出的提示原文，如 `Username for 'https://github.com': ` */
  prompt: string
  /** 密码、口令类提示：界面用密码框 */
  secret: boolean
}

export interface AskpassServerOptions {
  /** unix socket 路径或 Windows named pipe */
  socketPath?: string
  /** askpass.sh 写到哪个目录 */
  scriptDir: string
  /** askpassMain.js 的绝对路径 */
  mainPath: string
  /** 运行 askpassMain 的可执行文件（Electron 本体，以 ELECTRON_RUN_AS_NODE 运行） */
  nodePath?: string
  token?: string
}

interface PendingPrompt {
  prompt: AskpassPrompt
  resolve: (value: string | null) => void
}

const ASKPASS_SCRIPT = `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 "$TNOTES_ASKPASS_NODE" "$TNOTES_ASKPASS_MAIN" "$@"
`

export function isSecretPrompt(prompt: string): boolean {
  return /password|passphrase|token|密码|口令/i.test(prompt)
}

function defaultSocketPath(): string {
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`
  // macOS 的 unix socket 路径上限约 104 字节，userData 太长，放到临时目录
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\tnotes-askpass-${suffix}`
    : path.join(os.tmpdir(), `tnotes-askpass-${suffix}.sock`)
}

/**
 * 手动 Git 任务的凭据桥。
 *
 * git / ssh 需要用户名、密码或口令时调用 `GIT_ASKPASS` / `SSH_ASKPASS` 指向的脚本，
 * 脚本经本地 socket 把提示交给这里，再由界面弹框作答（与 VS Code 的做法一致）。
 * 每个连接都要带随机 token，别的进程拿不到答案。
 */
export class AskpassServer {
  private server: net.Server | null = null
  private readonly socketPath: string
  private readonly token: string
  private readonly scriptPath: string
  private readonly pending = new Map<string, PendingPrompt>()
  private readonly waitingListeners = new Map<string, Set<(waiting: boolean) => void>>()
  private requestListener: ((prompt: AskpassPrompt) => void) | null = null
  private dismissListener: ((id: string) => void) | null = null

  constructor(private readonly options: AskpassServerOptions) {
    this.socketPath = options.socketPath ?? defaultSocketPath()
    this.token = options.token ?? randomBytes(24).toString('hex')
    this.scriptPath = path.join(options.scriptDir, 'askpass.sh')
  }

  /** 有新的凭据询问需要界面作答 */
  onRequest(listener: (prompt: AskpassPrompt) => void): () => void {
    this.requestListener = listener
    return () => {
      if (this.requestListener === listener) this.requestListener = null
    }
  }

  /** 某个询问已失效（git 退出、任务取消），界面应关掉对应的框 */
  onDismiss(listener: (id: string) => void): () => void {
    this.dismissListener = listener
    return () => {
      if (this.dismissListener === listener) this.dismissListener = null
    }
  }

  async start(): Promise<void> {
    if (this.server) return
    await writeFile(this.scriptPath, ASKPASS_SCRIPT, 'utf8')
    await chmod(this.scriptPath, 0o755)
    if (process.platform !== 'win32') await rm(this.socketPath, { force: true })
    const server = net.createServer((socket) => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
  }

  /** 为某一轮手动任务生成桥；server 没起来时返回 undefined（退回无凭据提示的旧行为）。 */
  bridgeFor(runId: string): GitAskpassBridge | undefined {
    if (!this.server) return undefined
    const env: Record<string, string> = {
      GIT_ASKPASS: this.scriptPath,
      TNOTES_ASKPASS_NODE: this.options.nodePath ?? process.execPath,
      TNOTES_ASKPASS_MAIN: this.options.mainPath,
      TNOTES_ASKPASS_HANDLE: this.socketPath,
      TNOTES_ASKPASS_TOKEN: this.token,
      TNOTES_ASKPASS_RUN: runId
    }
    if (process.platform !== 'win32') {
      env.SSH_ASKPASS = this.scriptPath
      env.SSH_ASKPASS_REQUIRE = 'force'
    }
    return {
      env,
      onWaiting: (listener) => {
        const listeners = this.waitingListeners.get(runId) ?? new Set()
        listeners.add(listener)
        this.waitingListeners.set(runId, listeners)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) this.waitingListeners.delete(runId)
        }
      },
      cancel: () => this.cancelRun(runId)
    }
  }

  /** 界面作答；`null` 表示用户取消 */
  answer(id: string, value: string | null): void {
    this.pending.get(id)?.resolve(value)
  }

  /** 关掉这一轮所有还没回答的询问 */
  cancelRun(runId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.prompt.runId === runId) entry.resolve(null)
    }
  }

  async dispose(): Promise<void> {
    for (const entry of [...this.pending.values()]) entry.resolve(null)
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.platform !== 'win32') await rm(this.socketPath, { force: true })
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = ''
    let entry: PendingPrompt | null = null
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      if (entry) return
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        if (buffer.length > 64 * 1024) socket.destroy()
        return
      }
      let request: { token?: unknown; runId?: unknown; prompt?: unknown }
      try {
        request = JSON.parse(buffer.slice(0, newline))
      } catch {
        socket.end(`${JSON.stringify({ ok: false })}\n`)
        return
      }
      if (
        request.token !== this.token ||
        typeof request.runId !== 'string' ||
        typeof request.prompt !== 'string' ||
        !this.requestListener
      ) {
        socket.end(`${JSON.stringify({ ok: false })}\n`)
        return
      }
      entry = this.ask(request.runId, request.prompt.slice(0, 500), (value) => {
        if (socket.destroyed) return
        socket.end(`${JSON.stringify(value === null ? { ok: false } : { ok: true, value })}\n`)
      })
    })
    // git 被取消或超时时 askpass 子进程随之被杀，连接断开：询问随之失效
    socket.on('close', () => entry?.resolve(null))
    socket.on('error', () => entry?.resolve(null))
  }

  private ask(
    runId: string,
    promptText: string,
    reply: (value: string | null) => void
  ): PendingPrompt {
    const prompt: AskpassPrompt = {
      id: randomUUID(),
      runId,
      prompt: promptText,
      secret: isSecretPrompt(promptText)
    }
    let done = false
    const entry: PendingPrompt = {
      prompt,
      resolve: (value) => {
        if (done) return
        done = true
        this.pending.delete(prompt.id)
        reply(value)
        if (value === null) this.emitDismiss(prompt.id)
        if (![...this.pending.values()].some((item) => item.prompt.runId === runId)) {
          this.emitWaiting(runId, false)
        }
      }
    }
    this.pending.set(prompt.id, entry)
    this.emitWaiting(runId, true)
    try {
      this.requestListener?.(prompt)
    } catch {
      entry.resolve(null)
    }
    return entry
  }

  private emitWaiting(runId: string, waiting: boolean): void {
    for (const listener of [...(this.waitingListeners.get(runId) ?? [])]) {
      try {
        listener(waiting)
      } catch {
        /* 监听方异常不影响凭据流程 */
      }
    }
  }

  private emitDismiss(id: string): void {
    try {
      this.dismissListener?.(id)
    } catch {
      /* 窗口已销毁 */
    }
  }
}
