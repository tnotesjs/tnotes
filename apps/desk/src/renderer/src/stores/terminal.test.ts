import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

/**
 * store 的缓冲分支：消费者（xterm）还没挂上来时到达的输出不能丢，也不能只留不结算。
 * 这些字节主进程已经计入「已发送未回执」，丢弃若不同步回执，未确认量就永远归不了零。
 */
describe('终端输出缓冲与丢弃结算', () => {
  let emitData: ((event: TerminalDataEvent) => void) | null
  let emitState: ((state: TerminalSessionDto) => void) | null
  let ackSpy: ReturnType<typeof vi.fn>
  let listSessions: TerminalSessionDto[]

  beforeEach(() => {
    emitData = null
    emitState = null
    listSessions = [makeSession('s1')]
    ackSpy = vi.fn(async () => ({ ok: true, value: undefined }))
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
