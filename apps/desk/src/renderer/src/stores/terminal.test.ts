import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 记录每一笔回执的 (代次, 字节)，供跨代次断言 */
interface AckCall {
  sessionId: string
  bytes: number
  generation: number
}

import { useTerminalStore } from './terminal'

import type { TerminalDataEvent, TerminalSessionDto } from '../../../shared/contracts'

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

function makeSession(id: string, generation = 1): TerminalSessionDto {
  return {
    id,
    generation,
    knowledgeBaseId: 'kb-1',
    knowledgeBaseName: 'TNotes.kb',
    title: 'bash',
    cwd: '/kb',
    shell: '/bin/bash',
    status: 'running',
    pid: 1,
    cols: 80,
    rows: 24,
    exitCode: null,
    exitSignal: null,
    error: null,
    createdAt: 0
  }
}

let emitData: ((event: TerminalDataEvent) => void) | null
let emitState: ((state: TerminalSessionDto) => void) | null
let ackSpy: ReturnType<typeof vi.fn>
let ackCalls: AckCall[]
let listSessions: TerminalSessionDto[]

beforeEach(() => {
  emitData = null
  emitState = null
  listSessions = [makeSession('s1')]
  ackCalls = []
  ackSpy = vi.fn(async (sessionId: string, bytes: number, generation: number) => {
    ackCalls.push({ sessionId, bytes, generation })
    return { ok: true, value: undefined }
  })
  ;(globalThis as unknown as { window: unknown }).window = {
    desk: {
      terminal: {
        list: async () => ({ ok: true, value: listSessions }),
        onChanged: (callback: (state: TerminalSessionDto) => void) => {
          emitState = callback
          return () => {}
        },
        onData: (callback: (event: TerminalDataEvent) => void) => {
          emitData = callback
          return () => {}
        },
        ack: ackSpy,
        write: async () => ({ ok: true, value: undefined }),
        close: async () => ({ ok: true, value: undefined })
      }
    }
  }
  setActivePinia(createPinia())
})

beforeEach(() => {
  // store 用 localStorage 存字号偏好；node 环境下补一个最小实现
  const store = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear()
  }
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage
})

async function setup() {
  const store = useTerminalStore()
  store.subscribe()
  await store.load()
  return store
}

/**
 * store 的缓冲分支：消费者（xterm）还没挂上来时到达的输出不能丢，也不能只留不结算。
 * 这些字节主进程已经计入「已发送未回执」，丢弃若不同步回执，未确认量就永远归不了零。
 */
describe('终端输出缓冲与丢弃结算', () => {
  it('消费者未就绪：输出进缓冲不丢，注册后按序回放（回执交给消费端，不在缓冲层重复报）', async () => {
    const store = await setup()
    const received: Array<{ data: string; bytes: number }> = []

    emitData?.({ sessionId: 's1', generation: 1, data: '第一段', bytes: 9 })
    emitData?.({ sessionId: 's1', generation: 1, data: '第二段', bytes: 9 })
    // 只要没发生丢弃，缓冲层不该回执——回执由 xterm 的 write 回调负责，
    // 两边都报会把未确认量扣穿，反而让背压失灵
    expect(ackSpy).not.toHaveBeenCalled()

    store.registerHandler('s1', (data, bytes) => received.push({ data, bytes }))

    expect(received).toEqual([
      { data: '第一段', bytes: 9 },
      { data: '第二段', bytes: 9 }
    ])
    expect(ackSpy).not.toHaveBeenCalled()
  })

  it('消费者就绪后直接转发，不再进缓冲', async () => {
    const store = await setup()
    const received: string[] = []
    store.registerHandler('s1', (data) => received.push(data))

    emitData?.({ sessionId: 's1', generation: 1, data: '直通', bytes: 6 })

    expect(received).toEqual(['直通'])
    expect(ackSpy).not.toHaveBeenCalled() // 直通路径由 xterm 的 write 回调负责回执
  })

  it('溢出：丢最旧的那一块，并在丢弃当场结算回执（否则未确认量永远归不了零）', async () => {
    const store = await setup()
    const chunk = 1024 * 1024

    // 5 块 × 1MB > 4MB 上限：最旧的会被丢掉
    for (let index = 0; index < 5; index += 1) {
      emitData?.({
        sessionId: 's1',
        generation: 1,
        data: `第${index}块`,
        bytes: chunk
      })
    }

    // 丢弃发生在缓冲阶段：当场就该有且只有一次回执，金额正好是被丢的 1MB
    expect(store.droppedBytes).toBe(chunk)
    expect(ackSpy).toHaveBeenCalledTimes(1)
    expect(ackSpy).toHaveBeenCalledWith('s1', chunk, 1)

    const received: string[] = []
    store.registerHandler('s1', (data) => received.push(data))

    // 保留后 4 块（丢第 0 块），且回放不再重复回执
    expect(received).toEqual(['第1块', '第2块', '第3块', '第4块'])
    expect(ackSpy).toHaveBeenCalledTimes(1)
  })

  it('单块就超过上限时也会被丢弃（上限对总字节数有效，不是"至少留一块"）', async () => {
    const store = await setup()

    emitData?.({
      sessionId: 's1',
      generation: 1,
      data: '超大块',
      bytes: MAX_BUFFERED_BYTES + 1
    })

    const received: string[] = []
    store.registerHandler('s1', (data) => received.push(data))

    expect(received).toEqual([])
    expect(store.droppedBytes).toBe(MAX_BUFFERED_BYTES + 1)
    // 全部丢弃也必须全部回执，且只回执一次
    expect(ackSpy).toHaveBeenCalledTimes(1)
    expect(ackSpy).toHaveBeenCalledWith('s1', MAX_BUFFERED_BYTES + 1, 1)
  })

  it('重启换代次：丢弃结算带回**当前**代次，不会被旧代次吞掉', async () => {
    // 只要 store 完成订阅与初始加载，本用例不看它的实例
    await setup()
    // 会话已重启到代次 2：由主进程推一次状态变化（store 借此更新代次记录）
    listSessions = [makeSession('s1', 2)]
    emitState?.(makeSession('s1', 2))

    // 触发一次丢弃，检查回执里的代次是 2
    emitData?.({
      sessionId: 's1',
      generation: 2,
      data: '超大块',
      bytes: MAX_BUFFERED_BYTES + 1
    })

    expect(ackSpy).toHaveBeenCalledWith('s1', MAX_BUFFERED_BYTES + 1, 2)
  })

  it('关闭会话时清掉缓冲，之后到达的数据不再占用内存', async () => {
    const store = await setup()
    emitData?.({ sessionId: 's1', generation: 1, data: '待回放', bytes: 9 })
    expect(store.sessions).toHaveLength(1)

    await store.closeSession('s1')

    // 关闭后缓冲被清空：再注册消费者不会回放出旧数据
    const received: string[] = []
    store.registerHandler('s1', (data) => received.push(data))
    expect(received).toEqual([])
  })
})

/**
 * 跨代次交错：输出侧的代次必须**随数据携带**，不能在任何环节被"当前代次"顶替。
 * 上一版只验证了「当前代次的数据按当前代次结算」，漏掉了这三条。
 */
describe('输出侧的代次贯通（跨代次交错）', () => {
  it('回归 1：代次 1 的输出先缓冲，切到代次 2 后注册消费者，不回放旧输出', async () => {
    const store = await setup()

    // 代次 1 的输出在消费者就绪前到达 → 进缓冲
    emitData?.({ sessionId: 's1', generation: 1, data: 'GEN1_OLD_OUTPUT', bytes: 17 })
    expect(store.sessions).toHaveLength(1)

    // 进程重启到代次 2；面板会调用 dropBufferedBefore 隔离旧代次缓冲
    emitState?.(makeSession('s1', 2))
    store.dropBufferedBefore('s1', 2)

    // 消费者这时才挂上来：不得回放代次 1 的输出
    const received: Array<{ data: string; generation: number }> = []
    store.registerHandler('s1', (data, _bytes, generation) => received.push({ data, generation }))

    expect(received).toEqual([])
    // 旧输出的字节按**旧代次**结算（不是记到代次 2 头上）
    expect(ackCalls).toEqual([{ sessionId: 's1', bytes: 17, generation: 1 }])
  })

  it('回归 2：当前代次为 2 时收到代次 1 的丢弃数据，不得发送代次 2 的回执', async () => {
    const store = await setup()
    emitState?.(makeSession('s1', 2))

    const chunk = 1024 * 1024
    // 先塞代次 1 的 5MB（会被后续丢弃），再塞代次 2 的数据
    for (let index = 0; index < 5; index += 1) {
      emitData?.({ sessionId: 's1', generation: 1, data: `G1-${index}`, bytes: chunk })
    }
    emitData?.({ sessionId: 's1', generation: 2, data: 'G2-NEW', bytes: chunk })

    // 丢弃发生的回执必须标代次 1；绝不能出现代次 2 的回执（那会扣新进程的账）
    const badAck = ackCalls.filter((call) => call.generation === 2)
    expect(badAck).toEqual([])
    expect(ackCalls.every((call) => call.generation === 1)).toBe(true)
    expect(ackCalls.length).toBeGreaterThan(0)
    expect(store.droppedBytes).toBeGreaterThan(0)
  })

  it('回归 3：人为延迟代次 1 的写完成回调，重启后再触发，新进程未确认量保持不变', async () => {
    const store = await setup()

    // 代次 1 的数据交给消费者，但**回调被压住不触发**（模拟 xterm 写入很慢）
    const deferred: Array<() => void> = []
    store.registerHandler('s1', (data, bytes, generation) => {
      deferred.push(() => store.ackWithGeneration('s1', bytes, generation))
    })
    emitData?.({ sessionId: 's1', generation: 1, data: 'GEN1_SLOW', bytes: 9 })
    expect(deferred).toHaveLength(1)
    expect(ackCalls).toEqual([])

    // 重启到代次 2，然后旧回调才触发
    emitState?.(makeSession('s1', 2))
    for (const fire of deferred) fire()

    // 这笔回执必须带代次 1（主进程按代次忽略），绝不能带代次 2
    expect(ackCalls).toEqual([{ sessionId: 's1', bytes: 9, generation: 1 }])
    expect(ackCalls.some((call) => call.generation === 2)).toBe(false)
  })

  it('回放的块各自带自己的代次（同代次场景不受影响）', async () => {
    const store = await setup()
    emitData?.({ sessionId: 's1', generation: 1, data: 'A', bytes: 1 })
    emitData?.({ sessionId: 's1', generation: 1, data: 'B', bytes: 2 })

    const seen: Array<{ data: string; generation: number }> = []
    store.registerHandler('s1', (data, _bytes, generation) => seen.push({ data, generation }))

    expect(seen).toEqual([
      { data: 'A', generation: 1 },
      { data: 'B', generation: 1 }
    ])
  })
})
