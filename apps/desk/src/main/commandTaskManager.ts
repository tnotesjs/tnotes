import { randomUUID } from 'node:crypto'

import { deskLog } from './log'

import type {
  CommandTaskDto,
  CommandTaskLogEvent,
  CommandTaskStage,
  CommandTaskStatus
} from '../shared/contracts'

/**
 * 一次「命令操作」的上下文。
 *
 * 它不是通用任务系统：只记录**由既有实现执行的命令**（Git 拉取/推送/fetch、IDE 启动器）
 * 的执行过程，供底部面板展示。排队、门禁、业务检查仍归各自的既有实现。
 */
export interface CommandTaskHandle {
  readonly id: string
  /** 每次运行自增：旧运行的迟到输出与完成事件据此被丢弃 */
  readonly run: number
  stage(stage: CommandTaskStage, label?: string): void
  /** 追加输出；stdout / stderr 都走这里，带来源标记 */
  write(stream: 'stdout' | 'stderr', chunk: string): void
  /** 记录实际执行的命令行（仅用于展示） */
  command(line: string): void
  /** 自己是否仍是该任务的最新一轮运行 */
  isCurrent(): boolean
}

interface CommandTaskRecord {
  dto: CommandTaskDto
  /** 待推送的输出片段，按 flush 间隔合批 */
  pending: string[]
  pendingBytes: number
  flushTimer: NodeJS.Timeout | null
  /** 已丢弃的字节数（滚动截断），随每次推送带给界面 */
  truncated: number
}

export interface CommandTaskManagerOptions {
  /** 每个任务的日志上限；超出后丢最旧并累计截断量 */
  maxLogBytes?: number
  flushIntervalMs?: number
}

/** 512KB 够看清一次 git 操作的输出，又不会让长时间运行把内存吃满。 */
const DEFAULT_MAX_LOG_BYTES = 512 * 1024
const DEFAULT_FLUSH_INTERVAL_MS = 16
/** pending 的硬上限：达到就立刻冲刷，避免两次 flush 之间堆积 */
const PENDING_HARD_LIMIT = 1024 * 1024

/** 按**字符**截取尾部，保证不切断代理对（emoji / 组合字符）。 */
function tailWithin(text: string, maxBytes: number): { kept: string; bytes: number } {
  const characters = Array.from(text)
  let kept = ''
  let bytes = 0
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]
    const size = Buffer.byteLength(character)
    if (bytes + size > maxBytes) break
    kept = character + kept
    bytes += size
  }
  return { kept, bytes }
}

/**
 * 命令任务管理器。
 *
 * 生命周期：`queued → (saving | precheck) → running → done | failed | timeout | canceled`。
 *
 * 容量与推送：
 *  - 日志**有上限**，执行期间就按上限滚动丢弃最旧的字节（不是只在结束时截断字符串），
 *    并把累计截断量报给界面；
 *  - 输出按 ~1 帧合批推送，不逐行 IPC；
 *  - 推送回调一律 try/catch：这里常在子进程 data 回调栈里被调用，而窗口销毁时
 *    `webContents.send` 会抛（node-pty 那次的教训）。
 */
export class CommandTaskManager {
  private tasks = new Map<string, CommandTaskRecord>()
  /** (知识库, 种类) → 任务 id：重复点击定位已有标签，而不是新建 */
  private byKey = new Map<string, string>()
  private listener: ((state: CommandTaskDto) => void) | null = null
  private logListener: ((event: CommandTaskLogEvent) => void) | null = null
  private readonly maxLogBytes: number
  private readonly flushIntervalMs: number

  constructor(options: CommandTaskManagerOptions = {}) {
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  }

  onChanged(listener: (state: CommandTaskDto) => void): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = null
    }
  }

  onLog(listener: (event: CommandTaskLogEvent) => void): () => void {
    this.logListener = listener
    return () => {
      if (this.logListener === listener) this.logListener = null
    }
  }

  list(): CommandTaskDto[] {
    return [...this.tasks.values()].map((task) => ({ ...task.dto }))
  }

  /** 定位已有任务（「查看输出」用）；没有则 null。 */
  find(knowledgeBaseId: string, kind: CommandTaskDto['kind']): CommandTaskDto | null {
    const id = this.byKey.get(`${knowledgeBaseId}::${kind}`)
    const record = id ? this.tasks.get(id) : undefined
    return record ? { ...record.dto } : null
  }

  /**
   * 创建或复用任务。
   *
   * 同一 (知识库, 种类) 只保留一个标签：**仍在运行时直接复用**（界面定位，不重复提交）；
   * 已结束则在其上开始新一轮运行（`run` 自增，旧运行的迟到事件会被丢弃）。
   */
  claim(input: {
    knowledgeBaseId: string
    knowledgeBaseName: string
    kind: CommandTaskDto['kind']
    title: string
    cwd: string
    command?: string
  }): CommandTaskDto {
    const { dto } = this.claimHandle(input)
    return dto
  }

  /**
   * 认领并拿到**执行句柄**。
   *
   * 句柄带方法，**不能作为 IPC 返回值**：函数无法被 structured clone，渲染端只会收到
   * 「An object could not be cloned.」。跨 IPC 用 `claim()` 取纯 DTO，进程内用本方法。
   */
  claimHandle(input: {
    knowledgeBaseId: string
    knowledgeBaseName: string
    kind: CommandTaskDto['kind']
    title: string
    cwd: string
    command?: string
  }): { handle: CommandTaskHandle; dto: CommandTaskDto } {
    const key = `${input.knowledgeBaseId}::${input.kind}`
    const existingId = this.byKey.get(key)
    const existing = existingId ? this.tasks.get(existingId) : undefined

    if (existing && this.isActive(existing.dto.status)) {
      // 正在跑：复用同一个标签，**且不自增 run**。
      //
      // 自增会破坏运行标识：渲染端与主进程各自 claim 一次同一个任务（渲染端为了
      // 立刻拿到标签、主进程为了拿到执行句柄），若第二次把 run 从 1 推到 2，渲染端
      // 手里的 run=1 就变成"旧运行"，它的阶段上报与完成事件会全被丢弃，
      // 任务会永远停在「已排队」。只有真正开始新一轮运行才允许自增。
      const handle = this.handleFor(existing)
      return { handle, dto: { ...existing.dto } }
    }

    const record = existing ?? this.createRecord(input)
    record.dto = {
      ...record.dto,
      knowledgeBaseName: input.knowledgeBaseName,
      title: input.title,
      cwd: input.cwd,
      command: input.command ?? record.dto.command,
      // 新建时 createRecord 已把 run 置为 1；这里只在"在旧标签上重跑"时自增
      run: record.dto.run + (existing ? 1 : 0),
      status: 'queued',
      stage: 'queued',
      stageLabel: '已排队',
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      truncatedBytes: 0
    }
    record.pending = []
    record.pendingBytes = 0
    record.truncated = 0
    this.byKey.set(key, record.dto.id)
    this.emit(record)
    return { handle: this.handleFor(record), dto: { ...record.dto } }
  }

  /**
   * 由外部（渲染端上报保存阶段等）直接设置阶段。
   * `run` 不符时忽略——旧运行的迟到上报不能改新运行的状态。
   */
  reportStage(taskId: string, run: number, stage: CommandTaskStage, label?: string): void {
    this.setStage(taskId, run, stage, label)
  }

  /** 排队中取消：没有任何子进程需要终止，直接收尾。 */
  cancelQueued(taskId: string, run: number, reason: string): void {
    const record = this.tasks.get(taskId)
    if (!record || record.dto.run !== run) return
    if (!this.isActive(record.dto.status)) return
    this.finish(record, 'canceled', reason)
  }

  /** 由执行方在完成时调用，带上最终状态与原因（原因与既有输出并存，不覆盖输出）。 */
  finishRun(
    taskId: string,
    run: number,
    status: Extract<CommandTaskStatus, 'done' | 'failed' | 'timeout' | 'canceled'>,
    error: string | null
  ): void {
    const record = this.tasks.get(taskId)
    if (!record || record.dto.run !== run) return
    this.finish(record, status, error)
  }

  /** 关闭输出标签：只移除视图，**不影响**正在运行的任务。 */
  close(taskId: string): void {
    const record = this.tasks.get(taskId)
    if (!record) return
    if (record.flushTimer) {
      clearTimeout(record.flushTimer)
      record.flushTimer = null
    }
    this.tasks.delete(taskId)
    const key = `${record.dto.knowledgeBaseId}::${record.dto.kind}`
    if (this.byKey.get(key) === taskId) this.byKey.delete(key)
  }

  dispose(): void {
    for (const record of this.tasks.values()) {
      if (record.flushTimer) clearTimeout(record.flushTimer)
    }
    this.tasks.clear()
    this.byKey.clear()
    this.listener = null
    this.logListener = null
  }

  private createRecord(input: {
    knowledgeBaseId: string
    knowledgeBaseName: string
    kind: CommandTaskDto['kind']
    title: string
    cwd: string
    command?: string
  }): CommandTaskRecord {
    const id = randomUUID()
    const record: CommandTaskRecord = {
      dto: {
        id,
        knowledgeBaseId: input.knowledgeBaseId,
        knowledgeBaseName: input.knowledgeBaseName,
        kind: input.kind,
        title: input.title.slice(0, 80),
        cwd: input.cwd,
        command: input.command ?? '',
        status: 'queued',
        stage: 'queued',
        stageLabel: '已排队',
        run: 1,
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        logBytes: 0,
        truncatedBytes: 0
      },
      pending: [],
      pendingBytes: 0,
      flushTimer: null,
      truncated: 0
    }
    this.tasks.set(id, record)
    return record
  }

  private isActive(status: CommandTaskStatus): boolean {
    return (
      status === 'queued' || status === 'saving' || status === 'precheck' || status === 'running'
    )
  }

  private handleFor(record: CommandTaskRecord): CommandTaskHandle {
    const taskId = record.dto.id
    const run = record.dto.run
    return {
      id: taskId,
      run,
      isCurrent: () => {
        const current = this.tasks.get(taskId)
        return Boolean(current && current.dto.run === run)
      },
      stage: (stage, label) => this.setStage(taskId, run, stage, label),
      write: (stream, chunk) => this.appendLog(taskId, run, stream, chunk),
      command: (line) => this.setCommand(taskId, run, line)
    }
  }

  private setStage(taskId: string, run: number, stage: CommandTaskStage, label?: string): void {
    const record = this.tasks.get(taskId)
    if (!record || record.dto.run !== run) return
    if (!this.isActive(record.dto.status)) return
    const status: CommandTaskStatus =
      stage === 'queued'
        ? 'queued'
        : stage === 'saving'
          ? 'saving'
          : stage === 'precheck'
            ? 'precheck'
            : stage === 'running'
              ? 'running'
              : record.dto.status
    record.dto = {
      ...record.dto,
      stage,
      status,
      stageLabel: label ?? stage
    }
    this.emit(record)
  }

  private setCommand(taskId: string, run: number, line: string): void {
    const record = this.tasks.get(taskId)
    if (!record || record.dto.run !== run) return
    record.dto = { ...record.dto, command: line.slice(0, 2000) }
    this.emit(record)
  }

  private appendLog(taskId: string, run: number, stream: 'stdout' | 'stderr', chunk: string): void {
    const record = this.tasks.get(taskId)
    if (!record || record.dto.run !== run || !chunk) return
    // 统一换行：Windows 的 \r\n 在面板里会显示成双换行
    const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    // \u0000stderr\u0001 前缀标记来源；flush 时解析回 { stream, text }
    record.pending.push(stream === 'stderr' ? `\u0000stderr\u0001${normalized}` : normalized)
    record.pendingBytes += Buffer.byteLength(normalized)
    if (record.pendingBytes >= PENDING_HARD_LIMIT) {
      // 极端情况：一次灌入巨量输出，不等定时器直接冲刷
      this.flush(record)
      return
    }
    if (!record.flushTimer) {
      record.flushTimer = setTimeout(() => this.flush(record), this.flushIntervalMs)
    }
  }

  private flush(record: CommandTaskRecord): void {
    if (record.flushTimer) {
      clearTimeout(record.flushTimer)
      record.flushTimer = null
    }
    if (record.pending.length === 0) return

    const raw = record.pending.join('')
    const rawBytes = record.pendingBytes
    record.pending = []
    record.pendingBytes = 0

    // 日志上限：只保留尾部，超出的部分计入截断。执行期间就生效，不是结束才截。
    let data = raw
    let bytes = rawBytes
    if (bytes > this.maxLogBytes) {
      const tail = tailWithin(raw, this.maxLogBytes)
      record.truncated += bytes - tail.bytes
      data = tail.kept
      bytes = tail.bytes
    }

    record.dto = {
      ...record.dto,
      logBytes: record.dto.logBytes + bytes,
      truncatedBytes: record.truncated
    }
    this.emitLog({
      taskId: record.dto.id,
      run: record.dto.run,
      data,
      bytes,
      truncatedBytes: record.truncated
    })
    this.emit(record)
  }

  private finish(
    record: CommandTaskRecord,
    status: Extract<CommandTaskStatus, 'done' | 'failed' | 'timeout' | 'canceled'>,
    error: string | null
  ): void {
    // 先把残留输出冲出去，保证「超时/失败也保留真实输出」
    this.flush(record)
    record.dto = {
      ...record.dto,
      status,
      stage: 'finished',
      stageLabel:
        status === 'done'
          ? '已完成'
          : status === 'timeout'
            ? '已超时'
            : status === 'canceled'
              ? '已取消'
              : '失败',
      error: error ? error.slice(0, 4000) : null,
      finishedAt: Date.now()
    }
    this.emit(record)
    deskLog('command-task:finish', record.dto.id, {
      kind: record.dto.kind,
      status,
      run: record.dto.run,
      error: error?.slice(0, 300)
    })
  }

  /** 状态推送：常在子进程回调栈里被调用，异常绝不能逃出去。 */
  private emit(record: CommandTaskRecord): void {
    try {
      this.listener?.({ ...record.dto })
    } catch (error) {
      deskLog('command-task:emit-failed', record.dto.id, {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private emitLog(event: CommandTaskLogEvent): void {
    try {
      this.logListener?.(event)
    } catch (error) {
      deskLog('command-task:log-failed', event.taskId, {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

export const commandTaskManager = new CommandTaskManager()
