import { describe, expect, it, vi } from 'vitest'

import { BackgroundFetchScheduler } from './backgroundFetchScheduler'

import type { BackgroundFetchRequest } from './backgroundFetchScheduler'

/** 可控的执行器：手动决定每次请求何时成功/失败。 */
function createRunner() {
  const started: BackgroundFetchRequest[] = []
  const pending = new Map<string, (ok: boolean) => void>()
  const runner = vi.fn((request: BackgroundFetchRequest) => {
    started.push(request)
    return new Promise<boolean>((resolve) => {
      // 同一目标不会并发，用 knowledgeBaseId 作键即可
      pending.set(request.knowledgeBaseId, resolve)
    })
  })
  return {
    runner,
    started,
    finish(knowledgeBaseId: string, ok: boolean) {
      const resolve = pending.get(knowledgeBaseId)
      if (!resolve) throw new Error(`没有在跑的请求：${knowledgeBaseId}`)
      pending.delete(knowledgeBaseId)
      resolve(ok)
    },
    runningCount: () => pending.size
  }
}

function createScheduler(runner: ReturnType<typeof createRunner>['runner'], overrides = {}) {
  let now = 1_000_000
  const scheduler = new BackgroundFetchScheduler({
    runner,
    now: () => now,
    maxConcurrent: 2,
    backoffBaseMs: 60_000,
    backoffMaxMs: 10 * 60_000,
    ...overrides
  })
  return {
    scheduler,
    advance: (ms: number) => {
      now += ms
    },
    now: () => now
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('全局并发上限', () => {
  it('超过上限的目标进等待队列，前一个结束才补位', async () => {
    const fake = createRunner()
    const { scheduler } = createScheduler(fake.runner)

    expect(scheduler.request('kb1')).toBe('started')
    expect(scheduler.request('kb2')).toBe('started')
    expect(scheduler.request('kb3')).toBe('queued')
    expect(scheduler.request('kb4')).toBe('queued')
    expect(fake.started.map((item) => item.knowledgeBaseId)).toEqual(['kb1', 'kb2'])
    expect(scheduler.status()).toMatchObject({ running: 2, queued: 2 })

    // kb1 结束后空出一个名额：kb3 立刻补位
    fake.finish('kb1', true)
    await flush()
    expect(fake.started.map((item) => item.knowledgeBaseId)).toEqual(['kb1', 'kb2', 'kb3'])
    expect(scheduler.status()).toMatchObject({ running: 2, queued: 1 })

    fake.finish('kb2', true)
    fake.finish('kb3', true)
    await flush()
    expect(fake.started.map((item) => item.knowledgeBaseId)).toEqual(['kb1', 'kb2', 'kb3', 'kb4'])
    fake.finish('kb4', true)
    await scheduler.waitForIdle()
    expect(scheduler.status()).toMatchObject({ running: 0, queued: 0 })
  })

  it('默认上限是 3', () => {
    const fake = createRunner()
    const scheduler = new BackgroundFetchScheduler({ runner: fake.runner })
    expect(scheduler.status().running).toBe(0)
    scheduler.request('kb1')
    scheduler.request('kb2')
    scheduler.request('kb3')
    expect(scheduler.request('kb4')).toBe('queued')
    expect(scheduler.status().running).toBe(3)
  })
})

describe('同一目标不得重复入队', () => {
  it('运行中重复请求被拒，执行器只被调用一次', async () => {
    const fake = createRunner()
    const { scheduler } = createScheduler(fake.runner)
    expect(scheduler.request('kb1')).toBe('started')
    expect(scheduler.request('kb1')).toBe('duplicate')
    expect(scheduler.request('kb1')).toBe('duplicate')
    expect(fake.runner).toHaveBeenCalledTimes(1)
    fake.finish('kb1', true)
    await scheduler.waitForIdle()
  })

  it('排队中重复请求同样被拒，不会在队列里排两份', async () => {
    const fake = createRunner()
    const { scheduler } = createScheduler(fake.runner)
    scheduler.request('kb1')
    scheduler.request('kb2')
    expect(scheduler.request('kb3')).toBe('queued')
    expect(scheduler.request('kb3')).toBe('duplicate')
    expect(scheduler.status().queued).toBe(1)

    // kb1/kb2 释放后 kb3 只跑一次
    fake.finish('kb1', true)
    await flush()
    expect(fake.started.filter((item) => item.knowledgeBaseId === 'kb3')).toHaveLength(1)
  })
})

describe('失败退避', () => {
  it('失败后进入退避窗口，窗口内跳过；到点后允许重试', async () => {
    const fake = createRunner()
    const { scheduler, advance } = createScheduler(fake.runner)

    scheduler.request('kb1')
    fake.finish('kb1', false)
    await scheduler.waitForIdle()

    expect(scheduler.failureCount('kb1')).toBe(1)
    expect(scheduler.nextAttemptAt('kb1')).toBe(1_000_000 + 60_000)
    expect(scheduler.request('kb1')).toBe('backoff')

    advance(59_999)
    expect(scheduler.request('kb1')).toBe('backoff')
    advance(1)
    expect(scheduler.request('kb1')).toBe('started')
    expect(fake.started).toHaveLength(2)
  })

  it('连续失败退避翻倍并封顶；成功一次即清零', async () => {
    const fake = createRunner()
    const { scheduler, advance, now } = createScheduler(fake.runner)

    const delays: number[] = []
    for (let round = 0; round < 6; round += 1) {
      expect(scheduler.request('kb1')).toBe('started')
      fake.finish('kb1', false)
      await scheduler.waitForIdle()
      delays.push(scheduler.nextAttemptAt('kb1') - now())
      if (round < 5) advance(delays[round] + 1)
    }

    // 基数是 1 分钟：1、2、4、8 分钟后封顶到 10 分钟
    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
    expect(scheduler.failureCount('kb1')).toBe(6)

    // 推进到窗口之后成功一次 → 退避清零
    advance(delays[5] + 1)
    expect(scheduler.request('kb1')).toBe('started')
    fake.finish('kb1', true)
    await scheduler.waitForIdle()
    expect(scheduler.failureCount('kb1')).toBe(0)
    expect(scheduler.nextAttemptAt('kb1')).toBe(0)
    expect(scheduler.request('kb1')).toBe('started')
  })

  it('执行器抛错也按失败处理，不会卡在 running', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('boom')))
    const scheduler = new BackgroundFetchScheduler({ runner: failing, backoffBaseMs: 1000 })
    expect(scheduler.request('kb1')).toBe('started')
    await scheduler.waitForIdle()
    expect(scheduler.status().running).toBe(0)
    expect(scheduler.failureCount('kb1')).toBe(1)
  })
})

describe('开关与退出', () => {
  it('关闭后不再受理请求，等待队列被清空；打开后可以重新请求', async () => {
    const fake = createRunner()
    const { scheduler } = createScheduler(fake.runner)
    scheduler.request('kb1')
    scheduler.request('kb2')
    expect(scheduler.request('kb3')).toBe('queued')

    scheduler.setEnabled(false)
    expect(scheduler.request('kb4')).toBe('disabled')
    expect(scheduler.status().queued).toBe(0)

    scheduler.setEnabled(true)
    // kb1、kb2 还占着全部名额，重新入队后应当等待而不是插队
    expect(scheduler.request('kb4')).toBe('queued')
    fake.finish('kb1', true)
    await flush()
    expect(fake.started.some((item) => item.knowledgeBaseId === 'kb4')).toBe(true)
    fake.finish('kb2', true)
    fake.finish('kb4', true)
    await scheduler.waitForIdle()
  })

  it('dispose 后不再受理；在跑的收敛后空闲', async () => {
    const fake = createRunner()
    const { scheduler } = createScheduler(fake.runner)
    scheduler.request('kb1')
    scheduler.dispose()
    expect(scheduler.request('kb2')).toBe('disabled')
    fake.finish('kb1', true)
    await scheduler.waitForIdle()
    expect(scheduler.status()).toMatchObject({ running: 0, queued: 0, disposed: true })
  })
})
