import { describe, expect, it } from 'vitest'

import { createPendingSaves } from './pendingSaves'

function deferred() {
  let resolve!: () => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('createPendingSaves', () => {
  it('在途保存不中断，重叠请求只保留最新一次并在结束后再跑一轮', async () => {
    const saves = createPendingSaves<{ tag: string }>()
    const calls: string[] = []
    const gates: Array<ReturnType<typeof deferred>> = []
    const perform = (options: { tag: string }) => {
      calls.push(options.tag)
      const gate = deferred()
      gates.push(gate)
      return gate.promise
    }

    const first = saves.run('k', { tag: 'a' }, perform)
    const second = saves.run('k', { tag: 'b' }, perform)
    const third = saves.run('k', { tag: 'c' }, perform)
    expect(calls).toEqual(['a'])
    expect(second).toBe(third)
    expect(saves.hasQueued('k')).toBe(true)

    gates[0].resolve()
    await first
    await flush()
    // b 被 c 挤掉，不单独执行
    expect(calls).toEqual(['a', 'c'])
    expect(saves.hasQueued('k')).toBe(false)

    let settled = false
    void third.then(() => (settled = true))
    await flush()
    expect(settled).toBe(false)
    gates[1].resolve()
    await expect(third).resolves.toBeUndefined()

    // 队列清空后新请求立即执行
    void saves.run('k', { tag: 'd' }, perform)
    expect(calls).toEqual(['a', 'c', 'd'])
    gates[2].resolve()
  })

  it('支持自定义合并 options', async () => {
    const saves = createPendingSaves<{ silent?: boolean }>((queued, next) => ({
      silent: Boolean(queued.silent && next.silent)
    }))
    const seen: Array<{ silent?: boolean }> = []
    const gate = deferred()
    const perform = (options: { silent?: boolean }) => {
      seen.push(options)
      return seen.length === 1 ? gate.promise : Promise.resolve()
    }
    const first = saves.run('k', { silent: true }, perform)
    saves.run('k', {}, perform)
    const last = saves.run('k', { silent: true }, perform)
    gate.resolve()
    await first
    await last
    expect(seen).toEqual([{ silent: true }, { silent: false }])
  })

  it('在途保存失败后仍执行排队请求，各自的 Promise 反映各自结果', async () => {
    const saves = createPendingSaves()
    const gate = deferred()
    let count = 0
    const perform = () => {
      count += 1
      return count === 1 ? gate.promise : Promise.resolve()
    }
    const first = saves.run('k', undefined, perform)
    const second = saves.run('k', undefined, perform)
    gate.reject(new Error('disk'))
    await expect(first).rejects.toThrow('disk')
    await expect(second).resolves.toBeUndefined()
    expect(count).toBe(2)
  })

  it('wait 会等到排队中的后续一轮也结束；不同 key 互不影响', async () => {
    const saves = createPendingSaves()
    const gates: Array<ReturnType<typeof deferred>> = []
    const perform = () => {
      const gate = deferred()
      gates.push(gate)
      return gate.promise
    }
    void saves.run('k', undefined, perform)
    void saves.run('k', undefined, perform)
    void saves.run('other', undefined, perform)
    expect(gates).toHaveLength(2)

    let waited = false
    const waiting = saves.wait('k').then(() => (waited = true))
    gates[0].resolve()
    await flush()
    expect(waited).toBe(false)
    expect(gates).toHaveLength(3)
    gates[2].resolve()
    await waiting
    expect(waited).toBe(true)
    gates[1].resolve()
    await expect(saves.wait('none')).resolves.toBeUndefined()
  })

  it('wait 在最后一轮失败时抛错', async () => {
    const saves = createPendingSaves()
    const run = saves.run('k', undefined, () => Promise.reject(new Error('boom')))
    await expect(saves.wait('k')).rejects.toThrow('boom')
    await expect(run).rejects.toThrow('boom')
  })
})
