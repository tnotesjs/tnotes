import { describe, expect, it, vi } from 'vitest'

import {
  changesInsideTargets,
  GitManager,
  parseGitStatus,
  shouldScheduleAutoPush
} from './gitManager'

import type { CommandResult } from './gitManager'
import type { GitRepositoryDescriptor } from './workspace/types'

describe('Git porcelain parser', () => {
  it('parses tracked, untracked, renamed and conflicted paths', () => {
    const result = parseGitStatus(
      ' M notes/0001. 标题.md\0?? assets/new.png\0R  notes/0002. 新.md\0notes/0002. 旧.md\0UU TOC.md\0'
    )
    expect(result).toMatchObject([
      { path: 'notes/0001. 标题.md', status: 'modified', worktree: true },
      { path: 'assets/new.png', status: 'untracked' },
      {
        path: 'notes/0002. 新.md',
        previousPath: 'notes/0002. 旧.md',
        status: 'renamed',
        staged: true
      },
      { path: 'TOC.md', status: 'conflicted' }
    ])
  })
})

describe('changesInsideTargets', () => {
  const root = '/kb'
  const changes = [
    { path: 'notes/0042. A/0042. A.md', status: 'modified', staged: false, worktree: true },
    { path: 'notes/0042. A/0042. A 副本.md', status: 'untracked', staged: false, worktree: false },
    { path: 'assets/0042-a.png', status: 'modified', staged: true, worktree: false },
    { path: 'notes/0043. B/0043. B.md', status: 'modified', staged: false, worktree: true },
    { path: 'TOC.md', status: 'modified', staged: false, worktree: true }
  ] as const

  it('按文件与目录前缀匹配，且不做兄弟目录的前缀误判', () => {
    const inside = changesInsideTargets([...changes], root, ['/kb/notes/0042. A'])
    expect(inside.map((change) => change.path)).toEqual([
      'notes/0042. A/0042. A.md',
      'notes/0042. A/0042. A 副本.md'
    ])
    // 0043 不能因为 0042 的前缀被带进来
    expect(
      changesInsideTargets([...changes], root, ['/kb/notes/0042. A']).some((change) =>
        change.path.includes('0043')
      )
    ).toBe(false)
  })

  it('单文件目标精确匹配，空目标返回空', () => {
    expect(
      changesInsideTargets([...changes], root, ['/kb/assets/0042-a.png']).map(
        (change) => change.path
      )
    ).toEqual(['assets/0042-a.png'])
    expect(changesInsideTargets([...changes], root, [])).toEqual([])
  })
})

describe('删除范围提示（Git 未就绪时不能抛错）', () => {
  it('仓库还没注册时返回空数组，而不是让调用方失败', () => {
    const manager = new GitManager()
    // 启动后 configure 是 2 秒防抖：这个窗口内点删除必须还能弹出对话框
    expect(manager.untrackedFilesInside('未注册的知识库', ['/kb/notes/1.md'])).toEqual([])
    expect(manager.uncommittedFilesInside('未注册的知识库', ['/kb/notes/1.md'])).toEqual([])
    // 调用方要用 isReady 区分「真的没有变更」与「还读不到」
    expect(manager.isReady('未注册的知识库')).toBe(false)
  })
})

describe('shouldScheduleAutoPush', () => {
  it('does not reschedule while asset writes are paused', () => {
    expect(
      shouldScheduleAutoPush({
        enabled: true,
        paused: true,
        hasChanges: true,
        conflict: false,
        behind: 0
      })
    ).toBe(false)
    expect(
      shouldScheduleAutoPush({
        enabled: true,
        paused: false,
        hasChanges: true,
        conflict: false,
        behind: 0
      })
    ).toBe(true)
  })
})

/**
 * 确定性的队列与取消语义（注入假执行器）。
 *
 * 三条纪律，避免用猜测代替证据：
 *  1. **初始化、后台刷新、目标操作分开标识**：`configure()` 触发的 refresh 用
 *     `waitForIdle` 明确等它收敛，不靠"等一个 tick"或"静默窗口"。
 *  2. **假执行器按具体调用登记终止请求**：只释放被取消的那一个子进程，
 *     绝不用"释放全部"掩盖"误杀其他任务"——那正是本轮最需要防的问题。
 *  3. **abort 与 close 拆成两步**：取消只发终止信号（此时仍应是「取消中」、
 *     不可重试）；进程 close 之后才允许进入 canceled。
 */
interface FakeCall {
  id: number
  root: string
  args: string[]
  hung: boolean
  resolve: (result: CommandResult) => void
  /** 该次调用收到的运行参数（观察者 / 取消信号 / 子进程登记表）。 */
  extras?: unknown
  /** 假子进程是否已收到终止请求（abort 时置位，close 时据此给出退出码）。 */
  terminateRequested?: boolean
}

function createExecutor(options: { publish?: boolean } = {}) {
  const calls: FakeCall[] = []
  let hangFetches = false
  let hangCommits = false
  let seq = 0
  const executor = vi.fn(
    (root: string, args: string[], _timeout?: number, extras?: unknown): Promise<CommandResult> => {
      const call: FakeCall = {
        id: ++seq,
        root,
        args,
        hung: false,
        resolve: () => {},
        extras
      }
      calls.push(call)
      // 真实 runGit 会驱动观察者；假执行器如实模拟，否则"输出能在 commit 阶段被看到"
      // 这条契约在假执行器下永远看不到内容。
      const observer = (
        extras as
          | {
              observer?: {
                commandLine?(line: string): void
                output?(s: 'stdout' | 'stderr', c: string): void
              }
            }
          | undefined
      )?.observer
      observer?.commandLine?.(args.join(' '))
      observer?.output?.('stdout', `${args[0]} ok\n`)
      const hang = (hangFetches && args[0] === 'fetch') || (hangCommits && args[0] === 'commit')
      if (hang) {
        call.hung = true
        // 假子进程必须像真 runGit 一样对中止信号作出反应：收到 abort 才置位终止请求。
        // 否则"取消后没 push"只是因为假执行器不看信号，测试就没有区分力。
        const signal = (extras as { signal?: AbortSignal } | undefined)?.signal
        if (signal?.aborted) {
          call.terminateRequested = true
        } else {
          signal?.addEventListener(
            'abort',
            () => {
              call.terminateRequested = true
            },
            { once: true }
          )
        }
        return new Promise<CommandResult>((resolve) => {
          call.resolve = resolve
        })
      }
      // 干净、与远端同步的仓库
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return Promise.resolve({ code: 0, stdout: 'true\n', stderr: '' })
      }
      if (args[0] === 'branch') return Promise.resolve({ code: 0, stdout: 'main\n', stderr: '' })
      if (args[0] === 'rev-list') return Promise.resolve({ code: 0, stdout: '0\t0\n', stderr: '' })
      if (args[0] === 'rev-parse')
        return Promise.resolve({ code: 0, stdout: 'abc123\n', stderr: '' })
      if (options.publish) {
        // -z 格式的工作区：本地有未提交变更（publish 的前置条件之一）
        if (args[0] === 'status') {
          return Promise.resolve({ code: 0, stdout: ' M notes/1.md\u0000', stderr: '' })
        }
        // `diff --cached --quiet`：code 1 表示**有已暂存变更** → 必须执行 commit
        if (args[0] === 'diff') return Promise.resolve({ code: 1, stdout: '', stderr: '' })
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
  )
  const hungFetches = (root?: string): FakeCall[] =>
    calls.filter((call) => call.hung && call.args[0] === 'fetch' && (!root || call.root === root))
  const hungCommits = (): FakeCall[] =>
    calls.filter((call) => call.hung && call.args[0] === 'commit')
  return {
    executor,
    calls,
    /** 从此刻起挂起 fetch（必须在 waitForIdle 之后调用） */
    hangFetchesFromNow: () => {
      hangFetches = true
    },
    /** 从此刻起挂起 commit（用于「取消发生在 commit 阶段」） */
    hangCommitsFromNow: () => {
      hangCommits = true
    },
    hungFetches,
    hungCommits,
    /** **指定**的几个挂起调用已经关闭（真实子进程已退出）。 */
    closedCalls: (targets: FakeCall[]): boolean =>
      targets.length > 0 && targets.every((call) => !call.hung),
    /** 关闭**指定**那几个挂起的调用（模拟这些子进程退出）；绝不批量释放 */
    closeHung: (targets: FakeCall[], code?: number): void => {
      for (const call of targets.splice(0)) {
        call.hung = false
        // 收到过终止请求的进程以 130 退出（被信号终止），否则正常退出
        const exitCode = code ?? (call.terminateRequested ? 130 : 0)
        call.resolve({
          code: exitCode,
          stdout: '',
          stderr: exitCode === 0 ? '' : 'Git 操作已取消'
        })
      }
    },
    closeAllHung: (code = 0): void => {
      const targets = [...hungFetches(), ...hungCommits()]
      for (const call of targets) {
        call.hung = false
        call.resolve({ code, stdout: '', stderr: code === 0 ? '' : 'Git 操作已取消' })
      }
    }
  }
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

/** 建一个已经完成初始化、可以开始目标操作的 manager。 */
async function ready(fake: ReturnType<typeof createExecutor>, ids: string[]) {
  const manager = new GitManager(fake.executor)
  manager.configure(ids.map(descriptor))
  // 初始化（含 configure 触发的 refresh，它自己也会再入队）走的是同一条队列。
  // 用**队列状态**确凿地等到真正空闲，不用"安静了多久"来猜。
  // configure() 之后还有一次「自动刷新」定时器会再入队，因此要等到**连续两次**
  // 检查都空闲（队列状态是明确信号，不是靠等待时长猜）。
  let idleStreak = 0
  for (let i = 0; i < 300 && idleStreak < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const idle = ids.every((id) => {
      const status = manager.queueStatus(id)
      return status.queued === 0 && status.running === 0 && status.canceled === 0
    })
    idleStreak = idle ? idleStreak + 1 : 0
  }
  expect(idleStreak).toBeGreaterThanOrEqual(2)
  const initCalls = fake.calls.length
  fake.hangFetchesFromNow()
  return { manager, initCalls }
}

const fetchCallsFor = (fake: ReturnType<typeof createExecutor>, id: string): FakeCall[] =>
  fake.calls.filter((call) => call.args[0] === 'fetch' && call.root === `/tmp/${id}`)

describe('取消与队列（确定性）', () => {
  it('跨库并行：取消一个库的运行，另一个库的进程不受影响', async () => {
    const fake = createExecutor()
    const { manager } = await ready(fake, ['kb1', 'kb2'])

    const kb1 = manager.fetch('kb1')
    const kb2 = manager.fetch('kb2')
    await vi.waitFor(() => {
      expect(fake.hungFetches('/tmp/kb1').length).toBe(1)
      expect(fake.hungFetches('/tmp/kb2').length).toBe(1)
    })

    expect(manager.cancelRunningOperation('kb1')).toBe(true)
    fake.closeHung(fake.hungFetches('/tmp/kb1'))
    await expect(kb1).rejects.toThrow()
    // kb2 的进程必须仍然挂着（没有被误杀）
    expect(fake.hungFetches('/tmp/kb2').length).toBe(1)

    fake.closeHung(fake.hungFetches('/tmp/kb2'), 0)
    await expect(kb2).resolves.toBeTruthy()
  })

  it('入队即回调 onEnqueued：排队中的项也能被精确取消，不碰正在跑的那一项', async () => {
    const fake = createExecutor()
    const { manager } = await ready(fake, ['kb1'])

    // 前任务启动并挂起
    const fetch = manager.fetch('kb1')
    await vi.waitFor(() => expect(fake.hungFetches('/tmp/kb1').length).toBe(1))
    const fetchCall = fake.hungFetches('/tmp/kb1')[0]

    // 后任务入队：还没轮到执行，但身份与取消入口必须已经拿到
    let queuedId: string | null = null
    let cancelQueued: (() => void) | null = null
    const pull = manager.pull('kb1', {
      onEnqueued: (id, cancel) => {
        queuedId = id
        cancelQueued = cancel
      }
    })
    expect(queuedId).toBeTruthy()
    expect(cancelQueued).toBeTruthy()
    // 还没执行：本次 pull 一个命令都没发
    const pullCommands = fake.calls.filter(
      (call) => call.root === '/tmp/kb1' && call.args[0] === 'pull'
    )
    expect(pullCommands).toHaveLength(0)

    // 精确取消排在后面的这一项：正在跑的 fetch 进程必须原封不动
    cancelQueued!()
    expect(fake.hungFetches('/tmp/kb1').length).toBe(1)
    expect(fake.hungFetches('/tmp/kb1')[0]).toBe(fetchCall)

    // 前任务正常完成，被取消的 pull 永不执行
    fake.closeHung([fetchCall], 0)
    await expect(fetch).resolves.toBeTruthy()
    await expect(pull).rejects.toThrow(/取消/)
    expect(
      fake.calls.filter((call) => call.root === '/tmp/kb1' && call.args[0] === 'pull')
    ).toHaveLength(0)
  }, 20000)

  it('同库先后：取消排队中的后任务，不影响前任务，且后任务永不启动', async () => {
    const fake = createExecutor()
    const { manager } = await ready(fake, ['kb1'])

    // ① 前任务启动并挂起
    const fetch = manager.fetch('kb1')
    await vi.waitFor(() => expect(fake.hungFetches('/tmp/kb1').length).toBe(1))
    const fetchCall = fake.hungFetches('/tmp/kb1')[0]
    expect(manager.queueStatus('kb1').running).toBe(1)

    // ② 后任务入队（尚未启动）
    const pull = manager.pull('kb1')
    await vi.waitFor(() => expect(manager.queueStatus('kb1').queued).toBe(1))

    // ③ 取消排队项：只让它失效，不动前任务
    expect(manager.cancelQueuedOperation('kb1')).toBe(true)
    expect(manager.queueStatus('kb1').canceled).toBe(1)
    expect(fake.hungFetches('/tmp/kb1').length).toBe(1)

    // ④ 前任务正常完成
    fake.closeHung([fetchCall], 0)
    await expect(fetch).resolves.toBeTruthy()

    // ⑤ 被取消项结算为取消（而不是悬挂）
    await expect(pull).rejects.toThrow(/取消/)

    // ⑥ 队列确实空闲
    await vi.waitFor(() => {
      const status = manager.queueStatus('kb1')
      expect({ queued: status.queued, running: status.running, canceled: status.canceled }).toEqual(
        {
          queued: 0,
          running: 0,
          canceled: 0
        }
      )
    })

    // ⑦ 后续操作能启动并完成
    const before = fetchCallsFor(fake, 'kb1').length
    const next = manager.fetch('kb1')
    await vi.waitFor(() => expect(fetchCallsFor(fake, 'kb1').length).toBe(before + 1))
    fake.closeAllHung(0)
    await expect(next).resolves.toBeTruthy()
  }, 20000)

  it('同库多任务：取消绑定到具体正在运行的那一项（身份不匹配则拒绝）', async () => {
    const fake = createExecutor()
    const { manager } = await ready(fake, ['kb1'])

    const fetch = manager.fetch('kb1')
    await vi.waitFor(() => expect(fake.hungFetches('/tmp/kb1').length).toBe(1))
    const runningId = manager.getRunningOperationId('kb1')
    expect(runningId).toBeTruthy()

    expect(manager.cancelRunningOperation('kb1', 'op-does-not-exist')).toBe(false)
    expect(fake.hungFetches('/tmp/kb1').length).toBe(1)

    expect(manager.cancelRunningOperation('kb1', runningId!)).toBe(true)
    fake.closeHung(fake.hungFetches('/tmp/kb1'))
    await expect(fetch).rejects.toThrow()
  })

  it('abort 与 close 分离：abort 后进程未退出前不得算结束', async () => {
    const fake = createExecutor()
    const { manager } = await ready(fake, ['kb1'])

    let settled = false
    const fetch = manager.fetch('kb1').finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(fake.hungFetches('/tmp/kb1').length).toBe(1))

    manager.cancelRunningOperation('kb1')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    expect(fake.hungFetches('/tmp/kb1').length).toBe(1)

    fake.closeHung(fake.hungFetches('/tmp/kb1'))
    await expect(fetch).rejects.toThrow(/取消/)
    expect(settled).toBe(true)
  })

  it('dispose：停止受理、使未启动项失效、等进程关闭，且不让排队任务在退出中启动', async () => {
    const fake = createExecutor()
    const { manager } = await ready(fake, ['kb1', 'kb2'])

    const kb1 = manager.fetch('kb1')
    const kb2 = manager.fetch('kb2')
    await vi.waitFor(() => expect(fake.hungFetches().length).toBe(2))

    // 排一个尚未启动的项：退出时它必须失效，绝不能继续启动
    const queued = manager.pull('kb2')
    await vi.waitFor(() => expect(manager.queueStatus('kb2').queued).toBe(1))

    const outcomes: string[] = []
    const track = (label: string, promise: Promise<unknown>): void => {
      promise.then(
        () => outcomes.push(`${label}:resolved`),
        (error) => outcomes.push(`${label}:rejected ${String(error).slice(0, 20)}`)
      )
    }
    track('kb1', kb1)
    track('kb2', kb2)
    track('queued', queued)

    const disposed = manager.dispose()
    let disposeDone = false
    void disposed.then(() => {
      disposeDone = true
    })

    // ① 退出开始后不再受理新任务
    await expect(manager.fetch('kb1')).rejects.toThrow(/退出/)
    // ② 未启动的队列项被标记失效
    expect(manager.queueStatus('kb2').canceled).toBeGreaterThanOrEqual(1)
    expect(manager.queueStatus().disposed).toBe(true)
    // ③ **进程尚未退出前，dispose 不得返回**（信号发出 ≠ 结束）
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(disposeDone).toBe(false)
    expect(outcomes).toEqual([])

    // ④ 关闭本管理器拥有的进程后，各项才结算、dispose 才返回
    fake.closeAllHung(130)
    await expect(disposed).resolves.toBeUndefined()
    await expect(kb1).rejects.toThrow()
    await expect(kb2).rejects.toThrow()
    await expect(queued).rejects.toThrow()
    expect(outcomes).toHaveLength(3)
  }, 20000)
})

describe('业务结果映射（明确失败但不抛错的场景）', () => {
  it('本地有未提交变更时 pull 返回 conflict，而不是抛错', async () => {
    const fake = createExecutor()
    fake.executor.mockImplementation(async (_root: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return { code: 0, stdout: 'true\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('@{upstream}')) {
        return { code: 0, stdout: 'origin/main\n', stderr: '' }
      }
      if (args[0] === 'branch') return { code: 0, stdout: 'main\n', stderr: '' }
      // -z 格式：`XY<space><path>\0`
      if (args[0] === 'status') return { code: 0, stdout: ' M notes/1.md\u0000', stderr: '' }
      // left=ahead, right=behind → ahead=0, behind=1
      if (args[0] === 'rev-list') return { code: 0, stdout: '0\t1\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const manager = new GitManager(fake.executor)
    manager.configure([descriptor('kb1')])
    await manager.whenQueueIdle('kb1')

    const result = await manager.pull('kb1')
    // 命令任务层据此标 failed；只看 Promise 会把它显示成成功
    expect(result.conflict).toBe(true)
    expect(result.message).toMatch(/提交|处理/)
  })
})

describe('取消后的刷新不得拖住队列（best-effort）', () => {
  // 注意：收尾刷新本身就是**本地状态读取**（readState），从不发 fetch，所以
  // 「断言刷新不发 fetch」是同义反复，不能证明实现正确——这里不做那种断言。
  // 真正要钉住的不变量是：**未结算的刷新不进队列状态**，因此不会让后续操作排不上。
  it('未结算的刷新不影响队列状态：后续操作照常启动并完成', async () => {
    const fake = createExecutor()
    const { manager } = await ready(fake, ['kb1'])

    // ready() 之后所有 fetch 都会挂住
    const fetch = manager.fetch('kb1')
    await vi.waitFor(() => expect(fake.hungFetches('/tmp/kb1').length).toBe(1))
    const runningId = manager.getRunningOperationId('kb1')
    manager.cancelRunningOperation('kb1', runningId!)
    fake.closeHung(fake.hungFetches('/tmp/kb1'))
    await expect(fetch).rejects.toThrow(/取消/)

    // 队列必须已经空闲（挂住的刷新不计入队列状态）
    expect(manager.queueStatus('kb1')).toMatchObject({ queued: 0, running: 0, canceled: 0 })

    // 后续操作能启动
    const next = manager.fetch('kb1')
    await vi.waitFor(() => expect(fake.hungFetches('/tmp/kb1').length).toBeGreaterThanOrEqual(1))
    fake.closeAllHung(0)
    await expect(next).resolves.toBeTruthy()
    await vi.waitFor(() =>
      expect(manager.queueStatus('kb1')).toMatchObject({ queued: 0, running: 0, canceled: 0 })
    )
  })

  it('退出开始后，收尾刷新不得再派生 git 进程', async () => {
    const fake = createExecutor()
    const { manager } = await ready(fake, ['kb1'])

    // 一个取消中的任务：它的收尾 finally 会做 best-effort 刷新
    const fetch = manager.fetch('kb1')
    await vi.waitFor(() => expect(fake.hungFetches('/tmp/kb1').length).toBe(1))
    const runningId = manager.getRunningOperationId('kb1')
    manager.cancelRunningOperation('kb1', runningId!)
    fake.closeHung(fake.hungFetches('/tmp/kb1'))
    await expect(fetch).rejects.toThrow(/取消/)

    const before = fake.calls.length
    // 对照：未退出时 refresh 一定会派生进程，证明下面的断言不是同义反复
    await manager.refresh('kb1')
    expect(fake.calls.length).toBeGreaterThan(before)

    await manager.dispose()
    const afterDispose = fake.calls.length
    await manager.refresh('kb1')
    expect(fake.calls.length).toBe(afterDispose)
  })
})

describe('推送阶段的观察者与取消（commit 阶段）', () => {
  it('add / commit / push 都收到 observer，输出能在 commit 阶段被看到', async () => {
    const fake = createExecutor({ publish: true })
    const manager = new GitManager(fake.executor)
    manager.configure([descriptor('kb1')])
    await manager.whenQueueIdle('kb1')

    const lines: string[] = []
    const chunks: string[] = []
    const observer = {
      commandLine: (line: string): void => {
        lines.push(line)
      },
      output: (_stream: 'stdout' | 'stderr', chunk: string): void => {
        chunks.push(chunk)
      }
    }

    const result = await manager.publish('kb1', { observer } as never)
    expect(result.conflict).toBe(false)

    // commit 与 push 必须真的被调用过（不是"没跑命令就返回成功"）
    const commands = fake.calls.map((call) => call.args[0])
    expect(commands).toContain('add')
    expect(commands).toContain('commit')
    expect(commands).toContain('push')

    // 三个阶段的命令都必须把 extras 传下去，否则观察者与取消信号会丢在中间
    for (const verb of ['add', 'diff', 'commit', 'push']) {
      const call = fake.calls.find((item) => item.args[0] === verb)
      expect(call, `${verb} 应当被执行`).toBeTruthy()
      expect(call!.extras, `${verb} 必须收到 extras`).toMatchObject({ observer })
    }

    // 观察者确实被驱动过（命令行 + 输出；用假执行器时输出由假执行器给出）
    expect(lines.length).toBeGreaterThan(0)
    expect(chunks.join('')).toContain('commit')
  })

  it('取消发生在 commit 阶段时：不执行 push，且等进程 close 才结算', async () => {
    const fake = createExecutor({ publish: true })
    fake.hangCommitsFromNow()
    const manager = new GitManager(fake.executor)
    manager.configure([descriptor('kb1')])
    await manager.whenQueueIdle('kb1')

    const controller = new AbortController()
    let settled = false
    const publish = manager.publish('kb1', { signal: controller.signal } as never).finally(() => {
      settled = true
    })

    // 走到 commit：前面的 add / diff 都已完成，commit 子进程挂住
    await vi.waitFor(() => expect(fake.hungCommits().length).toBe(1))
    const commitCall = fake.hungCommits()[0]

    controller.abort()
    // abort 必须把终止请求送到 commit 子进程（extras 丢了就送不到）
    await vi.waitFor(() => expect(commitCall.terminateRequested).toBe(true))
    // 但只发终止信号：commit 进程还没 close，操作不得算结束
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    expect(commitCall.hung).toBe(true)
    expect(fake.calls.some((call) => call.args[0] === 'push')).toBe(false)

    // 进程真正退出后才结算，并且**始终没有 push**
    fake.closeHung([commitCall])
    await expect(publish).rejects.toThrow(/取消/)
    expect(settled).toBe(true)
    expect(fake.calls.some((call) => call.args[0] === 'push')).toBe(false)
  })

  it('已中止的信号会让 commit 阶段的操作直接以取消结束', async () => {
    const fake = createExecutor({ publish: true })
    const manager = new GitManager(fake.executor)
    manager.configure([descriptor('kb1')])
    await manager.whenQueueIdle('kb1')

    const controller = new AbortController()
    controller.abort()
    await expect(manager.publish('kb1', { signal: controller.signal } as never)).rejects.toThrow(
      /取消|退出/
    )
    // 一进队列就已取消：任何命令都不该被执行
    expect(fake.calls.some((call) => call.args[0] === 'commit')).toBe(false)
    expect(fake.calls.some((call) => call.args[0] === 'push')).toBe(false)
  })
})
