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
}

function createExecutor() {
  const calls: FakeCall[] = []
  let hangFetches = false
  let seq = 0
  const executor = vi.fn((root: string, args: string[]): Promise<CommandResult> => {
    const call: FakeCall = {
      id: ++seq,
      root,
      args,
      hung: false,
      resolve: () => {}
    }
    calls.push(call)
    if (hangFetches && args[0] === 'fetch') {
      call.hung = true
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
    if (args[0] === 'rev-parse') return Promise.resolve({ code: 0, stdout: 'abc123\n', stderr: '' })
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  })
  const hungFetches = (root?: string): FakeCall[] =>
    calls.filter((call) => call.hung && call.args[0] === 'fetch' && (!root || call.root === root))
  return {
    executor,
    calls,
    /** 从此刻起挂起 fetch（必须在 waitForIdle 之后调用） */
    hangFetchesFromNow: () => {
      hangFetches = true
    },
    hungFetches,
    /** 关闭**指定**那几个挂起的调用（模拟这些子进程退出）；绝不批量释放 */
    closeHung: (targets: FakeCall[], code = 130): void => {
      for (const call of targets.splice(0)) {
        call.hung = false
        call.resolve({ code, stdout: '', stderr: code === 0 ? '' : 'Git 操作已取消' })
      }
    },
    closeAllHung: (code = 0): void => {
      for (const call of hungFetches()) {
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
  // 初始化（含 configure 触发的 refresh）走的是同一条队列：明确等它空闲
  for (const id of ids) await manager.whenQueueIdle(id)
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
    // 只关闭 kb1 的子进程：kb2 的必须仍然挂着
    fake.closeHung(fake.hungFetches('/tmp/kb1'))
    await expect(kb1).rejects.toThrow()
    expect(fake.hungFetches('/tmp/kb2').length).toBe(1)

    fake.closeHung(fake.hungFetches('/tmp/kb2'), 0)
    await expect(kb2).resolves.toBeTruthy()
  })

  it('同库先后：取消排队中的后任务，不影响前任务，且后任务永不启动', async () => {
    const fake = createExecutor()
    const { manager } = await ready(fake, ['kb1'])

    const fetch = manager.fetch('kb1')
    await vi.waitFor(() => expect(fake.hungFetches('/tmp/kb1').length).toBe(1))
    const fetchCall = fake.hungFetches('/tmp/kb1')[0]

    const pull = manager.pull('kb1')
    expect(manager.cancelQueuedOperation('kb1')).toBe(true)

    // 前任务正常完成
    fake.closeHung([fetchCall], 0)
    await expect(fetch).resolves.toBeTruthy()
    await expect(pull).rejects.toThrow(/取消/)
    // 排队项从未启动：始终只有那一次 fetch 调用
    expect(fetchCallsFor(fake, 'kb1').length).toBe(1)
    // 队列已释放：后续操作能执行
    const next = manager.fetch('kb1')
    await vi.waitFor(() => expect(fetchCallsFor(fake, 'kb1').length).toBe(2))
    fake.closeAllHung(0)
    await expect(next).resolves.toBeTruthy()
  })

  it('同库多任务：取消绑定到具体正在运行的那一项（身份不匹配则拒绝）', async () => {
    const fake = createExecutor()
    const { manager } = await ready(fake, ['kb1'])

    const fetch = manager.fetch('kb1')
    await vi.waitFor(() => expect(fake.hungFetches('/tmp/kb1').length).toBe(1))
    const runningId = manager.getRunningOperationId('kb1')
    expect(runningId).toBeTruthy()

    // 身份不匹配：不能取消（避免用知识库 ID 误取消同库的其他任务）
    expect(manager.cancelRunningOperation('kb1', 'op-does-not-exist')).toBe(false)
    expect(fake.hungFetches('/tmp/kb1').length).toBe(1)

    // 精确身份：取消成功
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
    // 已发出终止信号，但子进程还没退出：操作不能算结束
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    expect(fake.hungFetches('/tmp/kb1').length).toBe(1)

    // 子进程 close 之后才允许结束
    fake.closeHung(fake.hungFetches('/tmp/kb1'))
    await expect(fetch).rejects.toThrow(/取消/)
    expect(settled).toBe(true)
  })

  it('dispose 终止所有在跑的进程并等队列收敛', async () => {
    const fake = createExecutor()
    const { manager } = await ready(fake, ['kb1', 'kb2'])
    const kb1 = manager.fetch('kb1')
    const kb2 = manager.fetch('kb2')
    await vi.waitFor(() => {
      expect(fake.hungFetches().length).toBe(2)
    })

    const disposed = manager.dispose()
    fake.closeAllHung(130)
    await expect(disposed).resolves.toBeUndefined()
    await expect(kb1).rejects.toThrow()
    await expect(kb2).rejects.toThrow()
  }, 15000)
})

describe('业务结果映射（明确失败但不抛错的场景）', () => {
  it('本地有未提交变更时 pull 返回 conflict，而不是抛错', async () => {
    const fake = createExecutor()
    fake.executor.mockImplementation(async (_root: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return { code: 0, stdout: 'true\n', stderr: '' }
      }
      // 上游分支必须存在，pull 才会去做「本地变更 + 落后」的判断
      if (args[0] === 'rev-parse' && args.includes('@{upstream}')) {
        return { code: 0, stdout: 'origin/main\n', stderr: '' }
      }
      if (args[0] === 'branch') return { code: 0, stdout: 'main\n', stderr: '' }
      // -z 格式：`XY<space><path>\0`
      if (args[0] === 'status') return { code: 0, stdout: 'M  notes/1.md\u0000', stderr: '' }
      // left=ahead, right=behind → ahead=0, behind=1
      if (args[0] === 'rev-list') return { code: 0, stdout: '0\t1\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const manager = new GitManager(fake.executor)
    manager.configure([descriptor('kb1')])
    await manager.whenQueueIdle('kb1')

    const result = await manager.pull('kb1')
    // 先暴露状态，便于确认 mock 是否真的构造出「本地变更 + 落后」
    expect({ changes: result.state.changes.length, behind: result.state.behind }).toEqual({
      changes: 1,
      behind: 1
    })
    // 命令任务层据此标 failed；只看 Promise 会把它显示成成功
    expect(result.conflict).toBe(true)
    expect(result.message).toMatch(/提交|处理/)
  })
})
