/**
 * 后台自动 fetch 的调度闸门：**全局并发上限 + 同一目标去重 + 失败退避**。
 *
 * 为什么单独一层：`GitManager` 的队列是按 knowledgeBaseId 分键的（同库串行、
 * 跨库并行）。后台定时抓取如果只挂在那条队列上，多知识库会**同时**向远端发起
 * 请求：本机代理、远端限流、网络抖动都会被放大。这里在队列之外再加一层全局
 * 配额，且不改变同库串行语义（同一个库在同一时刻最多只有一个后台 fetch 在跑）。
 *
 * 去重与退避的必要性：
 *  - 5 分钟定时器每轮都会对每个库发起请求，若上一轮还没跑完就再入队，会无限堆积；
 *  - 失败后如果每 5 分钟固定重打，弱网/远端故障时就是稳定的失败节拍。改为
 *    指数退避（5/10/20/40/60 分钟封顶），成功一次即清零。
 */

export type BackgroundFetchTrigger = 'initial' | 'periodic'

export interface BackgroundFetchRequest {
  knowledgeBaseId: string
  trigger: BackgroundFetchTrigger
  /** 连续第几次尝试（首次为 1，失败后递增） */
  attempt: number
}

/**
 * 一次调度请求的结果：
 *  - `started`  立即开始执行
 *  - `queued`   已受理，等全局配额
 *  - `duplicate` 该目标已在跑或已在等，不重复入队
 *  - `backoff`  处于失败退避窗口内，本轮跳过
 *  - `disabled` 开关关闭（或已 dispose）
 */
export type BackgroundFetchDecision = 'started' | 'queued' | 'duplicate' | 'backoff' | 'disabled'

export interface BackgroundFetchSchedulerOptions {
  /** 同时执行的后台 fetch 上限 */
  maxConcurrent?: number
  /** 退避基数：第一次失败后等这么久 */
  backoffBaseMs?: number
  /** 退避上限 */
  backoffMaxMs?: number
  /** 注入时钟，测试用 */
  now?: () => number
  /** 真正执行一次抓取；resolve true = 成功（清零退避），false = 失败（进入退避） */
  runner: (request: BackgroundFetchRequest) => Promise<boolean>
}

export const BACKGROUND_FETCH_MAX_CONCURRENT = 3
/** 后台定时抓取的周期：5 分钟。真正的重试节奏由退避决定（见 backoffFor）。 */
export const BACKGROUND_FETCH_INTERVAL_MS = 5 * 60_000
export const BACKGROUND_FETCH_BACKOFF_BASE_MS = 5 * 60_000
export const BACKGROUND_FETCH_BACKOFF_MAX_MS = 60 * 60_000

interface QueuedFetch {
  knowledgeBaseId: string
  trigger: BackgroundFetchTrigger
}

interface FailureState {
  /** 连续失败次数 */
  count: number
  /** 早于这个时刻不再尝试 */
  nextAt: number
}

export interface BackgroundFetchSchedulerStatus {
  enabled: boolean
  disposed: boolean
  running: number
  queued: number
  runningIds: string[]
  queuedIds: string[]
  failures: Array<{ knowledgeBaseId: string; count: number; nextAt: number }>
}

export class BackgroundFetchScheduler {
  private readonly maxConcurrent: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly now: () => number
  private readonly runner: (request: BackgroundFetchRequest) => Promise<boolean>

  private running = new Map<string, BackgroundFetchRequest>()
  private queue: QueuedFetch[] = []
  private queued = new Set<string>()
  private failures = new Map<string, FailureState>()
  private enabled = true
  private disposed = false
  private idleWaiters: Array<() => void> = []

  constructor(options: BackgroundFetchSchedulerOptions) {
    this.runner = options.runner
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? BACKGROUND_FETCH_MAX_CONCURRENT)
    this.backoffBaseMs = Math.max(0, options.backoffBaseMs ?? BACKGROUND_FETCH_BACKOFF_BASE_MS)
    this.backoffMaxMs = Math.max(
      this.backoffBaseMs,
      options.backoffMaxMs ?? BACKGROUND_FETCH_BACKOFF_MAX_MS
    )
    this.now = options.now ?? Date.now
  }

  /**
   * 开关联动：关闭时清空等待队列（在跑的那几个自然收敛），打开时立刻尝试消化队列。
   * 退避状态**不清空**：关掉再打开不应该变成绕过退避的捷径。
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.queue = []
      this.queued.clear()
      this.notifyIdle()
      return
    }
    this.pump()
  }

  isEnabled(): boolean {
    return this.enabled && !this.disposed
  }

  /** 退出：不再受理新请求；在跑的结束后不会再被 pump 续上。 */
  dispose(): void {
    this.disposed = true
    this.enabled = false
    this.queue = []
    this.queued.clear()
    this.notifyIdle()
  }

  /**
   * 请求一次后台抓取。调用方（定时器 / 初次刷新 / 开关打开）不需要自己判重与退避：
   * 这里统一裁决，并保证同一目标不会同时出现两份。
   */
  request(
    knowledgeBaseId: string,
    trigger: BackgroundFetchTrigger = 'periodic'
  ): BackgroundFetchDecision {
    if (this.disposed || !this.enabled) return 'disabled'
    if (this.running.has(knowledgeBaseId) || this.queued.has(knowledgeBaseId)) return 'duplicate'
    if (this.inBackoff(knowledgeBaseId)) return 'backoff'
    if (this.running.size >= this.maxConcurrent) {
      this.queue.push({ knowledgeBaseId, trigger })
      this.queued.add(knowledgeBaseId)
      return 'queued'
    }
    this.start({ knowledgeBaseId, trigger })
    return 'started'
  }

  /** 连续失败次数（0 = 当前没有退避）。 */
  failureCount(knowledgeBaseId: string): number {
    return this.failures.get(knowledgeBaseId)?.count ?? 0
  }

  /** 下一次允许尝试的时间戳；无退避时返回 0。 */
  nextAttemptAt(knowledgeBaseId: string): number {
    return this.failures.get(knowledgeBaseId)?.nextAt ?? 0
  }

  status(): BackgroundFetchSchedulerStatus {
    return {
      enabled: this.enabled,
      disposed: this.disposed,
      running: this.running.size,
      queued: this.queue.length,
      runningIds: [...this.running.keys()],
      queuedIds: this.queue.map((entry) => entry.knowledgeBaseId),
      failures: [...this.failures.entries()].map(([knowledgeBaseId, state]) => ({
        knowledgeBaseId,
        count: state.count,
        nextAt: state.nextAt
      }))
    }
  }

  /** 等到没有在跑也没有在等的请求（测试与「退出前排空」用）。 */
  async waitForIdle(): Promise<void> {
    if (this.isIdle()) return
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve)
    })
  }

  private isIdle(): boolean {
    return this.running.size === 0 && this.queue.length === 0
  }

  private inBackoff(knowledgeBaseId: string): boolean {
    const failure = this.failures.get(knowledgeBaseId)
    return Boolean(failure && this.now() < failure.nextAt)
  }

  private start(entry: QueuedFetch): void {
    const attempt = (this.failures.get(entry.knowledgeBaseId)?.count ?? 0) + 1
    const request: BackgroundFetchRequest = {
      knowledgeBaseId: entry.knowledgeBaseId,
      trigger: entry.trigger,
      attempt
    }
    this.running.set(entry.knowledgeBaseId, request)
    void this.runner(request).then(
      (ok) => this.settle(entry.knowledgeBaseId, ok),
      // 执行器自身抛错也算失败：不能因为一次异常把这一项永远留在 running 里
      () => this.settle(entry.knowledgeBaseId, false)
    )
  }

  private settle(knowledgeBaseId: string, ok: boolean): void {
    this.running.delete(knowledgeBaseId)
    if (ok) {
      this.failures.delete(knowledgeBaseId)
    } else {
      const count = (this.failures.get(knowledgeBaseId)?.count ?? 0) + 1
      this.failures.set(knowledgeBaseId, {
        count,
        nextAt: this.now() + this.backoffFor(count)
      })
    }
    this.pump()
    this.notifyIdle()
  }

  /** 指数退避：5、10、20、40、60（封顶）分钟。 */
  private backoffFor(attempts: number): number {
    const exponent = Math.min(attempts - 1, 16)
    return Math.min(this.backoffBaseMs * 2 ** exponent, this.backoffMaxMs)
  }

  /** 有空位就继续消化等待队列；等待期间已经进入退避的项直接丢弃。 */
  private pump(): void {
    if (this.disposed || !this.enabled) return
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift()!
      this.queued.delete(entry.knowledgeBaseId)
      if (this.running.has(entry.knowledgeBaseId)) continue
      if (this.inBackoff(entry.knowledgeBaseId)) continue
      this.start(entry)
    }
  }

  private notifyIdle(): void {
    if (!this.isIdle() || this.idleWaiters.length === 0) return
    const waiters = this.idleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }
}
