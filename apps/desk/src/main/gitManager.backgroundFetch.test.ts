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

import {
  listBackgroundFailures,
  recordBackgroundFailureWithoutTask,
  resetBackgroundFailureLog
} from './backgroundFailureLog'
import { commandTaskManager } from './commandTaskManager'
import { createBackgroundGitTask } from './backgroundGitFailure'
import { configureBottomPanelMaxTabs, resetBottomPanelMaxTabs } from './bottomPanelTabs'
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

function createManager(
  fake: ReturnType<typeof createExecutor>,
  options: { realBackgroundTasks?: boolean } = {}
) {
  const manager = new GitManager(fake.executor)
  activeFake = fake
  const tasks: TaskRecord[] = []
  if (options.realBackgroundTasks) {
    // 用**真实** factory：它内部会走 commandTaskManager 的容量门禁，
    // 这样"满额 → 建不出可见任务"这条路径才是真的被触发。
    manager.onBackgroundTaskFactory((event) => createBackgroundGitTask(event))
    manager.onBackgroundFailureRecorder((event) => recordBackgroundFailureWithoutTask(event))
    return { manager, tasks }
  }
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
  // 任务管理器是跨文件单例：先彻底清空，避免上一个用例残留的任务把容量占掉
  commandTaskManager.dispose()
  resetBottomPanelMaxTabs()
  resetBackgroundFailureLog()
  // 假执行器也会在用例之间残留（fetchCode/hang），每个用例都用新的，避免串场
  sharedFake = createExecutor()
})

/** 每个用例一个干净的假执行器（见 beforeEach） */
let sharedFake: ReturnType<typeof createExecutor> | null = null

afterEach(async () => {
  // 容量上限是模块级单例：不复位会漏到后面的用例（实测后续用例被误拦成"上限 1"）
  resetBottomPanelMaxTabs()
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
    const fake = sharedFake!
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
    const fake = sharedFake!
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
    const fake = sharedFake!
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
    const fake = sharedFake!
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
    const fake = sharedFake!
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
    const fake = sharedFake!
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
    const fake = sharedFake!
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
    const fake = sharedFake!
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

/**
 * 第 5 项验收：**后台与手动操作的运行归属隔离**。
 *
 * `claimHandle` 对同一个 `(知识库, kind)` 是复用语义（渲染端与主进程各 claim 一次
 * 必须复用同一条，否则标签会永远停在「已排队」）。但"后台 fetch"与"手动 fetch"
 * 恰好是同一个 `(库, kind=git-fetch)`：如果后台在手动任务**运行中**认领，就会
 * 复用同一条记录、共用同一个 `id/run`，于是：
 *  - 两边的输出会串到同一个任务里；
 *  - 后台先结束会把**手动**那一轮提前结算掉；
 *  - 取消归属也被改写（取消打到别人的运行上）。
 *
 * 下面用确定性时序（假执行器可挂起）把两个方向的时序都钉住。
 */
describe('后台与手动操作的运行归属隔离（第 5 项）', () => {
  // 单例 manager 会跨用例保留任务：每条用例先清空，计数才有确定性
  beforeEach(() => {
    commandTaskManager.dispose()
  })

  const claim = (
    background: boolean,
    overrides: Partial<{ kind: 'git-fetch' | 'git-push'; knowledgeBaseId: string }> = {}
  ) =>
    commandTaskManager.claimHandle({
      knowledgeBaseId: overrides.knowledgeBaseId ?? 'kb1',
      knowledgeBaseName: 'TNotes.kb1',
      kind: overrides.kind ?? 'git-fetch',
      title: background ? '获取远端更新' : '获取远端更新',
      cwd: '/tmp/kb1',
      background
    })

  it('同一 (库, kind) 但**来源不同**时不复用标签：各自独立成一条', () => {
    const manual = claim(false)
    const background = claim(true)
    expect(background.dto.id).not.toBe(manual.dto.id)
    expect(background.dto.run).toBe(1)
    expect(manual.dto.run).toBe(1)
    expect(manual.dto.background).toBe(false)
    expect(background.dto.background).toBe(true)
    expect(commandTaskManager.list().filter((task) => task.kind === 'git-fetch')).toHaveLength(2)
  })

  it('同一 (库, kind) 且**来源相同**时仍然复用同一条（渲染端与主进程各 claim 一次）', () => {
    const first = claim(false)
    const second = claim(false)
    expect(second.dto.id).toBe(first.dto.id)
    // 运行中复用不得自增 run（否则渲染端手里的 run 会失效、标签永远停在「已排队」）
    expect(second.dto.run).toBe(first.dto.run)
    expect(commandTaskManager.list().filter((task) => task.kind === 'git-fetch')).toHaveLength(1)
  })

  it('三步交错（手动 A → 后台 B → 再次手动认领）：必须复用仍活跃的 A，不得建 C', () => {
    const a = claim(false)
    const b = claim(true)
    expect(b.dto.id).not.toBe(a.dto.id)

    // 第三次：手动再次认领 —— 必须回到 A（它仍活跃），而不是新建 C
    const again = claim(false)
    expect(again.dto.id).toBe(a.dto.id)
    expect(again.dto.run).toBe(a.dto.run)
    // 总量仍是 2 条（A 与 B），没有第三条
    expect(commandTaskManager.list().filter((task) => task.kind === 'git-fetch')).toHaveLength(2)
  })

  it('三步交错（后台 A → 手动 B → 再次后台认领）：必须复用仍活跃的 A，不得建 C', () => {
    const a = claim(true)
    const b = claim(false)
    expect(b.dto.id).not.toBe(a.dto.id)

    const again = claim(true)
    expect(again.dto.id).toBe(a.dto.id)
    expect(again.dto.run).toBe(a.dto.run)
    expect(commandTaskManager.list().filter((task) => task.kind === 'git-fetch')).toHaveLength(2)
  })

  it('交错后关闭其中一条：只影响自己那条索引，另一条仍能按来源找到', () => {
    const manual = claim(false)
    const background = claim(true)
    // 走公开的 close（与容量回收、关闭 IPC 同一入口）
    commandTaskManager.close(background.dto.id)

    expect(commandTaskManager.find('kb1', 'git-fetch', false)?.id).toBe(manual.dto.id)
    // 后台那条要么已从索引移除，要么仍是它自己；绝不能变成手动那条
    const foundBackground = commandTaskManager.find('kb1', 'git-fetch', true)
    expect(foundBackground?.id ?? null).not.toBe(manual.dto.id)
  })

  it('手动任务已结束后，后台同类操作另起一条：手动历史不被改写、输出不串', async () => {
    // `onLog` 是**单监听**（会替换上一个）：这里先订阅，再按 `id + run` 归属断言
    const logEvents: { taskId: string; run: number; data: string }[] = []
    commandTaskManager.onLog((event) => {
      logEvents.push({ taskId: event.taskId, run: event.run, data: event.data })
    })
    const manual = commandTaskManager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.kb1',
      kind: 'git-fetch',
      title: '获取远端更新',
      cwd: '/tmp/kb1'
    })
    manual.handle.stage('running', '获取远端更新')
    manual.handle.write('stdout', 'manual-only\n')
    commandTaskManager.finishRun(manual.dto.id, manual.dto.run, 'done', null)

    const background = commandTaskManager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.kb1',
      kind: 'git-fetch',
      title: '获取远端更新',
      cwd: '/tmp/kb1',
      background: true
    })
    // 另起一条：id 与 run 都是新的
    expect(background.dto.id).not.toBe(manual.dto.id)
    expect(background.dto.run).toBe(1)
    background.handle.stage('running', '获取远端更新')
    background.handle.write('stdout', 'bg-fetch\n')
    // 日志是**节流冲刷**的（flushIntervalMs），等一次冲刷再断言
    await sleep(120)

    // 手动那条历史完全没被动过
    const manualHistory = commandTaskManager.list().find((task) => task.id === manual.dto.id)
    expect(manualHistory?.status).toBe('done')
    expect(manualHistory?.error).toBeNull()
    expect(manualHistory?.run).toBe(manual.dto.run)
    expect(manualHistory?.background).toBe(false)

    // 输出按 `id + run` 归属，两边不串
    const manualLogs = logEvents.filter(
      (event) => event.taskId === manual.dto.id && event.run === manual.dto.run
    )
    expect(manualLogs.some((event) => event.data.includes('manual-only'))).toBe(true)
    expect(manualLogs.some((event) => event.data.includes('bg-fetch'))).toBe(false)
    const backgroundLogs = logEvents.filter(
      (event) => event.taskId === background.dto.id && event.run === background.dto.run
    )
    expect(backgroundLogs.some((event) => event.data.includes('bg-fetch'))).toBe(true)
    expect(backgroundLogs.some((event) => event.data.includes('manual-only'))).toBe(false)

    // 反向：后台收尾不得结算手动那一轮（id 不同，天然隔离）
    commandTaskManager.finishRun(background.dto.id, background.dto.run, 'failed', 'bg 失败')
    expect(commandTaskManager.list().find((task) => task.id === manual.dto.id)?.status).toBe('done')
    expect(commandTaskManager.list().find((task) => task.id === background.dto.id)?.status).toBe(
      'failed'
    )
  })

  it('后台轮次运行中时手动开始：后台轮次不被提前结算、取消只作用于自己那一轮', () => {
    const background = commandTaskManager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.kb1',
      kind: 'git-fetch',
      title: '获取远端更新',
      cwd: '/tmp/kb1',
      background: true
    })
    background.handle.stage('running', '获取远端更新')

    const manual = commandTaskManager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.kb1',
      kind: 'git-fetch',
      title: '获取远端更新',
      cwd: '/tmp/kb1'
    })
    expect(manual.dto.id).not.toBe(background.dto.id)

    // 后台那一轮仍在运行：没有被手动认领提前结算
    const during = commandTaskManager.list().find((task) => task.id === background.dto.id)
    expect(during?.status).toBe('running')
    expect(during?.finishedAt).toBeNull()
    expect(during?.run).toBe(background.dto.run)

    // 取消手动那一轮不能动到后台那一轮
    commandTaskManager.cancelQueued(manual.dto.id, manual.dto.run, '用户取消')
    expect(commandTaskManager.list().find((task) => task.id === background.dto.id)?.status).toBe(
      'running'
    )

    // 手动取消后，后台那一轮的"这一轮仍是当前运行"校验仍为真
    expect(
      commandTaskManager.reportStageChecked(background.dto.id, background.dto.run, 'running')
    ).toBe(true)
  })
})

/**
 * P1 验收：底部面板满额（建不出可见任务）时，记录里必须是**真实 Git 结果**，
 * 不能只留"标签已满"这种挡在前面的原因；fetch 成功时也不得被展示成 Git 执行失败。
 */
describe('满额兜底记录真实 Git 结果（P1）', () => {
  async function runOneBackgroundFetch(
    fake: ReturnType<typeof createExecutor>
  ): Promise<{ manager: GitManager }> {
    // 先占满容量（上限 1，占一条别的 kind 的运行中任务），**再**打开自动抓取：
    // 这样"后台 fetch 建不出可见任务"是唯一路径，记录里只会有一条。
    configureBottomPanelMaxTabs(() => 1)
    commandTaskManager.claimHandle({
      knowledgeBaseId: 'blocker',
      knowledgeBaseName: 'TNotes.blocker',
      kind: 'git-pull',
      title: '拉取',
      cwd: '/tmp/blocker'
    })
    expect(commandTaskManager.bottomPanelTabs()).toHaveLength(1)

    const { manager } = createManager(fake, { realBackgroundTasks: true })
    active = manager
    manager.configure([descriptor('kb1')])
    await vi.waitFor(() => expect(manager.list()[0]?.initialized).toBe(true))
    settingsState.autoFetch = true
    manager.applyBackgroundFetchPreference({ scheduleNow: false })
    manager.scheduleBackgroundFetches()
    await vi.waitFor(
      () =>
        expect(
          manager.backgroundFetchStatus().running + manager.backgroundFetchStatus().queued
        ).toBe(0),
      { timeout: 5000 }
    )
    // 让调度器/队列里最后一跳的 promise 落地（否则未处理的拒绝会被算到**下一个**用例头上）
    await sleep(50)
    return { manager }
  }

  it('满额 + fetch 实际失败：记录里是真实 Git 错误（不是"标签已满"）', async () => {
    const fake = sharedFake!
    fake.setFetchFailure(128, 'fatal: unable to access remote: Could not resolve host')

    const { manager } = await runOneBackgroundFetch(fake)
    void manager

    // 真实结果是执行**结束后**补记的，等它落到同一条记录上
    await vi.waitFor(
      () =>
        expect(
          listBackgroundFailures().some((r) => r.message.includes('Could not resolve host'))
        ).toBe(true),
      { timeout: 5000 }
    )
    const items = listBackgroundFailures()
    const record = items[0]
    expect(record.knowledgeBaseId).toBe('kb1')
    // 关键：message 是真实 Git 错误
    expect(record.message).toContain('Could not resolve host')
    // 同时保留"为什么没有标签"
    expect(record.reason).toContain('底部面板')
    // 没有多占面板标签：仍然只有占位那一条
    expect(commandTaskManager.list()).toHaveLength(1)
  })

  it('满额 + fetch 超时：记录里是超时（含"超时"字样），不是笼统的标签已满', async () => {
    const fake = sharedFake!
    // 执行层用 code 124 表达超时
    fake.setFetchFailure(124, 'Git 操作超时：git fetch（15000ms）')

    await runOneBackgroundFetch(fake)

    await vi.waitFor(
      () => expect(listBackgroundFailures().some((r) => r.message.includes('超时'))).toBe(true),
      { timeout: 5000 }
    )
    const items = listBackgroundFailures()
    expect(items.length).toBeGreaterThan(0)
    expect(items[0].message).toContain('超时')
    expect(items[0].reason).toContain('底部面板')
  })

  it('满额 + fetch **成功**：不得记录成 Git 执行失败', async () => {
    const fake = sharedFake!

    const { manager } = await runOneBackgroundFetch(fake)
    // fetch 真的执行过且成功
    expect(fake.fetchCalls('/tmp/kb1').length).toBeGreaterThan(0)
    expect(manager.list()[0].lastFetchedAt).not.toBeNull()

    // 允许留下"没能建出可见任务"的记录（这是事实），但不能出现 Git 失败/超时的措辞
    for (const record of listBackgroundFailures()) {
      // 只允许"标签已满"这类**未执行**原因，不允许任何真实 Git 结果措辞
      expect(record.message).toBe(record.reason)
      expect(record.message).not.toContain('fatal')
      expect(record.message).not.toContain('超时')
      expect(record.message).not.toContain('失败：')
    }
  })
})
