import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GitManager 的后台自动抓取治理（第 11 项需求）。
 *
 * 这里用**假的 git 可执行文件**（可挂起、可指定退出码）验证：
 *  - 开关默认关闭时完全不抓取，但手动 fetch 仍可用；
 *  - 打开后按全局并发上限抓取、同一目标不重复入队；
 *  - 后台失败/超时按真实分类落到命令任务，失败后进入退避。
 */

const settingsState = vi.hoisted(() => ({ autoFetch: false }))

vi.mock('./settings', () => ({
  loadSettings: () => ({ git: { autoFetch: settingsState.autoFetch } })
}))

import { GitManager } from './gitManager'
import type { CommandResult } from './gitManager'
import type { GitRepositoryDescriptor } from './workspace/types'

interface FakeCall {
  id: number
  root: string
  args: string[]
  hung: boolean
  resolve: (result: CommandResult) => void
}

function createExecutor() {
  const calls: FakeCall[] = []
  let seq = 0
  let hangFetches = false
  /** 下一次 fetch 的退出码（0 = 成功） */
  let fetchCode = 0
  let fetchStderr = ''

  const executor = vi.fn(
    (
      root: string,
      args: string[],
      _timeout?: number,
      extras?: {
        observer?: { commandLine?(line: string): void; output?(s: string, c: string): void }
      }
    ): Promise<CommandResult> => {
      const call: FakeCall = { id: ++seq, root, args, hung: false, resolve: () => {} }
      calls.push(call)
      extras?.observer?.commandLine?.(args.join(' '))
      extras?.observer?.output?.('stdout', `${args[0]} ok\n`)
      if (args[0] === 'fetch' && hangFetches) {
        call.hung = true
        return new Promise<CommandResult>((resolve) => {
          call.resolve = resolve
        })
      }
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return Promise.resolve({ code: 0, stdout: 'true\n', stderr: '' })
      }
      if (args[0] === 'branch') return Promise.resolve({ code: 0, stdout: 'main\n', stderr: '' })
      if (args[0] === 'rev-list') return Promise.resolve({ code: 0, stdout: '0\t0\n', stderr: '' })
      if (args[0] === 'rev-parse')
        return Promise.resolve({ code: 0, stdout: 'abc123\n', stderr: '' })
      if (args[0] === 'status') return Promise.resolve({ code: 0, stdout: '', stderr: '' })
      if (args[0] === 'fetch') {
        return Promise.resolve({ code: fetchCode, stdout: '', stderr: fetchStderr })
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
  )

  return {
    executor,
    calls,
    fetchCalls: (root?: string) =>
      calls.filter((call) => call.args[0] === 'fetch' && (!root || call.root === root)),
    hungFetches: () => calls.filter((call) => call.hung && call.args[0] === 'fetch'),
    setFetchFailure: (code: number, stderr = 'fatal: unable to access remote') => {
      fetchCode = code
      fetchStderr = stderr
    },
    hangFetchesFromNow: () => {
      hangFetches = true
    },
    releaseHung: (code = 0) => {
      for (const call of calls.filter((item) => item.hung)) {
        call.hung = false
        call.resolve({ code, stdout: '', stderr: '' })
      }
    }
  }
}

interface TaskRecord {
  knowledgeBaseId: string
  kind: 'git-fetch' | 'git-push'
  startedAt: number
  finishedAt: number | null
  status: 'done' | 'failed' | 'timeout' | null
  error: string | null
}

function descriptor(knowledgeBaseId: string): GitRepositoryDescriptor {
  return {
    knowledgeBaseId,
    knowledgeBaseName: `TNotes.${knowledgeBaseId}`,
    configId: `cfg-${knowledgeBaseId}`,
    rootPath: `/tmp/${knowledgeBaseId}`,
    notes: []
  } as GitRepositoryDescriptor
}

function createManager(fake: ReturnType<typeof createExecutor>) {
  const manager = new GitManager(fake.executor)
  activeFake = fake
  const tasks: TaskRecord[] = []
  manager.onBackgroundTaskFactory((event) => {
    const record: TaskRecord = {
      knowledgeBaseId: event.knowledgeBaseId,
      kind: event.kind,
      startedAt: Date.now(),
      finishedAt: null,
      status: null,
      error: null
    }
    tasks.push(record)
    return {
      observer: { output: () => {}, commandLine: () => {}, outputTruncated: () => {} },
      finish: (status, error) => {
        record.status = status
        record.error = error
        record.finishedAt = Date.now()
      }
    }
  })
  return { manager, tasks }
}

/** 等队列与后台调度都空闲（后台调度器自己会 pump，不能用固定时长猜）。 */
async function waitIdle(manager: GitManager): Promise<void> {
  await vi.waitFor(
    () => {
      const status = manager.backgroundFetchStatus()
      expect(status.running + status.queued).toBe(0)
    },
    { timeout: 5000 }
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let active: GitManager | null = null
let activeFake: ReturnType<typeof createExecutor> | null = null

beforeEach(() => {
  settingsState.autoFetch = false
})

afterEach(async () => {
  // 兜底释放挂起的假 fetch：否则 dispose 等 operationTails 会一直挂住
  activeFake?.releaseHung()
  activeFake = null
  if (active) {
    await active.dispose()
    active = null
  }
}, 15000)

describe('后台自动抓取开关（默认关闭）', () => {
  it('关闭时不发起任何后台 fetch，调度器处于停用状态', async () => {
    const fake = createExecutor()
    const { manager } = createManager(fake)
    active = manager
    manager.configure([descriptor('kb1'), descriptor('kb2')])

    // 初始化刷新（rev-parse/status/...）会跑，但一个 fetch 都不许有
    await vi.waitFor(() => expect(manager.list().every((state) => state.initialized)).toBe(true))
    await sleep(30)
    expect(fake.fetchCalls()).toHaveLength(0)
    expect(manager.backgroundFetchStatus().enabled).toBe(false)
    expect(manager.list().every((state) => state.lastFetchedAt === null)).toBe(true)
  })

  it('关闭时手动 fetch 仍然可用，并更新上次远端检查时间', async () => {
    const fake = createExecutor()
    const { manager } = createManager(fake)
    active = manager
    manager.configure([descriptor('kb1')])
    await vi.waitFor(() => expect(manager.list()[0]?.initialized).toBe(true))

    const result = await manager.fetch('kb1')
    expect(result.message).toBe('已获取远端最新状态')
    expect(fake.fetchCalls('/tmp/kb1')).toHaveLength(1)
    expect(manager.list()[0].lastFetchedAt).not.toBeNull()
    // 手动操作不产生后台任务
    expect(manager.backgroundFetchStatus().enabled).toBe(false)
  })

  it('打开开关后立刻安排一轮，并更新上次检查时间', async () => {
    const fake = createExecutor()
    const { manager, tasks } = createManager(fake)
    active = manager
    manager.configure([descriptor('kb1'), descriptor('kb2')])
    await vi.waitFor(() => expect(manager.list().every((state) => state.initialized)).toBe(true))

    settingsState.autoFetch = true
    manager.applyBackgroundFetchPreference()
    await waitIdle(manager)

    expect(fake.fetchCalls()).toHaveLength(2)
    expect(manager.list().every((state) => state.lastFetchedAt !== null)).toBe(true)
    expect(tasks).toHaveLength(2)
    expect(tasks.every((task) => task.status === 'done' && task.finishedAt !== null)).toBe(true)
    expect(tasks.every((task) => task.finishedAt! - task.startedAt >= 0)).toBe(true)
  })

  it('关掉开关会停止后续调度；手动 fetch 不受影响', async () => {
    const fake = createExecutor()
    const { manager } = createManager(fake)
    active = manager
    manager.configure([descriptor('kb1')])
    await vi.waitFor(() => expect(manager.list()[0]?.initialized).toBe(true))

    settingsState.autoFetch = true
    manager.applyBackgroundFetchPreference()
    await waitIdle(manager)
    const afterFirstRound = fake.fetchCalls().length

    settingsState.autoFetch = false
    manager.applyBackgroundFetchPreference()
    expect(manager.backgroundFetchStatus().enabled).toBe(false)

    manager.scheduleBackgroundFetches()
    await sleep(30)
    expect(fake.fetchCalls()).toHaveLength(afterFirstRound)

    // 手动仍然可用
    await manager.fetch('kb1')
    expect(fake.fetchCalls()).toHaveLength(afterFirstRound + 1)
  })
})

describe('全局并发上限与去重', () => {
  it('同时最多 3 个后台 fetch，其余排队', async () => {
    const fake = createExecutor()
    const { manager } = createManager(fake)
    active = manager
    const ids = ['kb1', 'kb2', 'kb3', 'kb4', 'kb5']
    manager.configure(ids.map(descriptor))
    await vi.waitFor(() => expect(manager.list().every((state) => state.initialized)).toBe(true))

    settingsState.autoFetch = true
    fake.hangFetchesFromNow()
    manager.applyBackgroundFetchPreference()
    await vi.waitFor(() => expect(fake.hungFetches()).toHaveLength(3), { timeout: 5000 })
    expect(manager.backgroundFetchStatus()).toMatchObject({ running: 3, queued: 2 })

    // 释放第一波 → 立刻补位，5 个目标全部启动过
    fake.releaseHung()
    await vi.waitFor(() => expect(fake.fetchCalls()).toHaveLength(5), { timeout: 5000 })
    expect(manager.backgroundFetchStatus()).toMatchObject({ running: 2, queued: 0 })

    fake.releaseHung()
    await waitIdle(manager)
    expect(fake.fetchCalls()).toHaveLength(5)
  })

  it('同一目标不会重复入队', async () => {
    const fake = createExecutor()
    const { manager } = createManager(fake)
    active = manager
    manager.configure([descriptor('kb1')])
    await vi.waitFor(() => expect(manager.list()[0]?.initialized).toBe(true))

    settingsState.autoFetch = true
    fake.hangFetchesFromNow()
    manager.applyBackgroundFetchPreference()
    await vi.waitFor(() => expect(fake.hungFetches()).toHaveLength(1))
    // 再触发两次（模拟定时器与设置保存同时发生）
    manager.scheduleBackgroundFetches()
    manager.scheduleBackgroundFetches()
    await sleep(20)
    expect(fake.fetchCalls()).toHaveLength(1)
    fake.releaseHung()
    await waitIdle(manager)
  })
})

describe('后台失败分类与退避', () => {
  it('超时结算成 timeout，保留错误原因', async () => {
    const fake = createExecutor()
    const { manager, tasks } = createManager(fake)
    active = manager
    manager.configure([descriptor('kb1')])
    await vi.waitFor(() => expect(manager.list()[0]?.initialized).toBe(true))

    fake.setFetchFailure(124, 'Git 操作超时：git fetch（15000ms）')
    settingsState.autoFetch = true
    manager.applyBackgroundFetchPreference()
    await waitIdle(manager)

    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe('timeout')
    expect(tasks[0].error).toContain('超时')
  })

  it('失败结算成 failed 并进入退避：随后再调度不会立刻重打', async () => {
    const fake = createExecutor()
    const { manager, tasks } = createManager(fake)
    active = manager
    manager.configure([descriptor('kb1')])
    await vi.waitFor(() => expect(manager.list()[0]?.initialized).toBe(true))

    fake.setFetchFailure(1, 'fatal: unable to access remote')
    settingsState.autoFetch = true
    manager.applyBackgroundFetchPreference()
    await waitIdle(manager)

    expect(tasks[0].status).toBe('failed')
    const status = manager.backgroundFetchStatus()
    expect(status.failures).toHaveLength(1)
    expect(status.failures[0]).toMatchObject({ knowledgeBaseId: 'kb1', count: 1 })
    expect(status.failures[0].nextAt).toBeGreaterThan(Date.now())

    // 退避窗口内：定时器/手动触发调度都不会重打
    manager.scheduleBackgroundFetches()
    await sleep(30)
    expect(fake.fetchCalls()).toHaveLength(1)
  })
})
