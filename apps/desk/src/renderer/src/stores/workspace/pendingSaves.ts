/**
 * 同一文档 key 的保存队列：**在途 1 个 + 排队槽位 1 个**（coalesce）。
 *
 * - 已在跑的落盘任务不中断；
 * - 在途期间的重叠请求只保留最新一次（含最新 options，可用 `merge` 决定如何合并），
 *   所有重叠调用方拿到同一个「后续一轮」的 Promise；
 * - 在途任务结束（无论成败）后，若排队槽位有请求就再跑一轮；
 *   是否真的还要落盘（仍 dirty）由 `perform` 自己判断。
 *
 * 不会逐个串行执行中间被挤掉的请求。
 */
interface QueuedSave<O> {
  options: O
  perform: (options: O) => Promise<void>
  promise: Promise<void>
  resolve: () => void
  reject: (cause: unknown) => void
}

interface SaveSlot<O> {
  current: Promise<void>
  queued: QueuedSave<O> | null
}

export function createPendingSaves<O = void>(
  merge: (queued: O, next: O) => O = (_queued, next) => next
) {
  const slots = new Map<string, SaveSlot<O>>()

  function start(key: string, options: O, perform: (options: O) => Promise<void>): Promise<void> {
    let operation: Promise<void>
    try {
      operation = perform(options)
    } catch (cause) {
      operation = Promise.reject(cause)
    }
    const slot: SaveSlot<O> = { current: operation, queued: null }
    slots.set(key, slot)
    const settle = (): void => {
      if (slots.get(key) !== slot) return
      const next = slot.queued
      if (!next) {
        slots.delete(key)
        return
      }
      const followUp = start(key, next.options, next.perform)
      followUp.then(next.resolve, next.reject)
    }
    operation.then(settle, settle)
    return operation
  }

  function run(key: string, options: O, perform: (options: O) => Promise<void>): Promise<void> {
    const slot = slots.get(key)
    if (!slot) return start(key, options, perform)
    if (slot.queued) {
      slot.queued.options = merge(slot.queued.options, options)
      slot.queued.perform = perform
      return slot.queued.promise
    }
    let resolve!: () => void
    let reject!: (cause: unknown) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    slot.queued = { options, perform, promise, resolve, reject }
    return promise
  }

  /**
   * 等到该 key 当前的保存（含排队中的后续一轮）全部结束。
   * 与旧语义一致：最后一轮失败时把错误抛给调用方。
   */
  async function wait(key: string): Promise<void> {
    for (;;) {
      const slot = slots.get(key)
      if (!slot) return
      const last = slot.queued?.promise ?? slot.current
      try {
        await last
      } catch (cause) {
        if (!slots.has(key)) throw cause
      }
    }
  }

  /** 是否已有排队中的后续保存（在途结束后会立刻再跑一轮）。 */
  function hasQueued(key: string): boolean {
    return Boolean(slots.get(key)?.queued)
  }

  return { run, wait, hasQueued }
}
