import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { commandTaskManager } from '../commandTaskManager'
import {
  beginCommandTask,
  cancelRunningExecution,
  ensureExecution,
  requestCancel,
  runGitTask
} from './commandTask'

import type { CommandTaskDto } from '../../shared/contracts'

/**
 * 命令任务执行层：业务结果映射、单次执行、取消语义。
 *
 * `gitManager` 被替换成可控替身——这里的重点是**执行层如何解释业务结果**，
 * 不再重复 `gitManager.test.ts` 已经覆盖的队列与进程语义。
 */
const { gitManagerMock } = vi.hoisted(() => ({
  gitManagerMock: {
    refresh: vi.fn(async () => []),
    fetch: vi.fn(),
    pull: vi.fn(),
    publish: vi.fn(),
    cancelRunningOperation: vi.fn(() => true),
    cancelQueuedOperation: vi.fn(() => true),
    getRunningOperationId: vi.fn((): string | null => null),
    find: vi.fn(() => null),
    list: vi.fn(() => [])
  }
}))

vi.mock('../gitManager', () => ({ gitManager: gitManagerMock }))

vi.mock('../settings', () => ({
  loadSettings: () => ({ gitPath: 'git', ide: 'vscode' })
}))

function ok(conflict = false, message = '完成') {
  return {
    state: { knowledgeBaseId: 'kb1', knowledgeBaseName: 'a', busy: null, error: null },
    message,
    conflict
  }
}

// refresh 会走真实 GitManager（未被替换），因此给它一个真实的临时仓库
const repoRoot = mkdtempSync(join(tmpdir(), 'desk-ct-'))
mkdirSync(join(repoRoot, 'notes'), { recursive: true })
execFileSync('git', ['-C', repoRoot, 'init', '-q', '-b', 'main'])
execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'e@t'])
execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'e'])
afterAll(() => rmSync(repoRoot, { recursive: true, force: true }))

vi.mock('../workspaceManager', () => ({
  workspaceManager: {
    getLocation: () => ({ name: 'TNotes.a', rootPath: repoRoot }),
    getNoteLocation: () => repoRoot
  }
}))

const manager = commandTaskManager

// 顶层钩子：所有 describe 共用同一份单例，重置必须对所有用例生效
// （挂在某一个 describe 里时，别的 describe 的用例会带着上一轮实现与历史跑）。
beforeEach(() => {
  // runGitTask 用的是模块单例：必须操作同一个实例，否则状态永远不变
  manager.dispose()
  // reset（不是 clear）：clearAllMocks 只清调用历史，上一用例的 mockImplementation
  // 会留到这一用例，制造出"实现残留"的假象。
  vi.resetAllMocks()
  gitManagerMock.refresh.mockResolvedValue([])
  gitManagerMock.cancelRunningOperation.mockReturnValue(true)
  gitManagerMock.cancelQueuedOperation.mockReturnValue(true)
  gitManagerMock.find.mockReturnValue(null)
  gitManagerMock.list.mockReturnValue([])
  // null = 该知识库当前没有运行项（排队中的项据此被正确识别）
  gitManagerMock.getRunningOperationId.mockReturnValue(null)
})

describe('命令任务的业务结果映射', () => {
  let handle: ReturnType<typeof manager.claimHandle>['handle']

  beforeEach(() => {
    handle = manager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.a',
      kind: 'git-pull',
      title: '拉取更新',
      cwd: repoRoot
    }).handle
  })

  it('业务层返回 conflict（明确失败但不抛错）→ 标 failed 并保留原因', async () => {
    gitManagerMock.pull.mockResolvedValue(ok(true, '本地存在未提交变更，无法安全快进'))
    await runGitTask(handle, 'git-pull', 'kb1')

    const task = manager.list()[0]
    expect(task.status).toBe('failed')
    expect(task.error).toContain('未提交变更')
    // 不能因为 Promise 没抛错就显示成功
    expect(task.status).not.toBe('done')
  })

  it('业务层成功 → done', async () => {
    gitManagerMock.pull.mockResolvedValue(ok(false, '已快进到远端最新版本'))
    await runGitTask(handle, 'git-pull', 'kb1')
    expect(manager.list()[0].status).toBe('done')
  })

  it('抛错 → failed 且保留错误信息', async () => {
    gitManagerMock.fetch.mockRejectedValue(new Error('fatal: unable to access remote'))
    const fetchHandle = manager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.a',
      kind: 'git-fetch',
      title: '获取远端更新',
      cwd: repoRoot
    }).handle
    await runGitTask(fetchHandle, 'git-fetch', 'kb1')
    const task = manager.list().find((item) => item.kind === 'git-fetch')
    expect(task?.status).toBe('failed')
    expect(task?.error).toContain('unable to access')
  })

  it('取消（已进入取消中）→ canceled，并且不会误标 done', async () => {
    let release: (value: unknown) => void = () => {}
    gitManagerMock.pull.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const running = runGitTask(handle, 'git-pull', 'kb1')
    // 模拟界面发出取消：进入取消中
    manager.reportStage(handle.id, handle.run, 'canceling', '正在停止…')
    expect(manager.isActive(manager.list()[0].status)).toBe(true)
    release(ok(false))
    await running
    expect(manager.list()[0].status).toBe('canceled')
    // 收尾后补一次状态刷新：取消可能已经改了暂存区，界面要重新拿到真实状态
    expect(gitManagerMock.refresh).toHaveBeenCalledWith('kb1')
  })

  it('未取消且成功时不额外刷新（避免无谓的 fetch）', async () => {
    gitManagerMock.pull.mockResolvedValue(ok(false))
    await runGitTask(handle, 'git-pull', 'kb1')
    expect(gitManagerMock.refresh).not.toHaveBeenCalled()
  })
})

describe('同一运行只执行一次', () => {
  it('并发调用 ensureExecution：只启动一次，后来者等待同一结果', async () => {
    manager.dispose()
    const handle = manager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.a',
      kind: 'git-pull',
      title: '拉取更新',
      cwd: repoRoot
    }).handle

    let calls = 0
    gitManagerMock.pull.mockImplementation(async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return ok(false)
    })

    // 连续点击三次：实际执行一次
    await Promise.all([
      ensureExecution(handle, 'git-pull', 'kb1'),
      ensureExecution(handle, 'git-pull', 'kb1'),
      ensureExecution(handle, 'git-pull', 'kb1')
    ])

    expect(calls).toBe(1)
    expect(manager.list()[0].status).toBe('done')
  })

  it('取消要带上本轮的队列身份，不能按知识库盲取消', async () => {
    manager.dispose()
    const fetchHandle = manager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.a',
      kind: 'git-fetch',
      title: '获取远端更新',
      cwd: repoRoot
    }).handle

    // 入队时执行层应记下这一项的身份；第一条命令出现表示「已开始执行」。
    // 随后驱动**真实的取消处理器**（先标取消中，再终止本轮）。
    let release: (value: unknown) => void = () => {}
    gitManagerMock.fetch.mockImplementation(
      async (
        _kb: string,
        _background?: boolean,
        extras?: {
          observer?: { commandLine(line: string): void }
          onEnqueued?: (id: string, cancel: () => void) => void
        }
      ) => {
        // 推迟一个微任务：ensureExecution 是在 runGitTask 返回 promise 之后才把
        // 本轮登记进 runningExecutions 的，取消必须发生在登记之后。
        await Promise.resolve()
        extras?.onEnqueued?.('op-42', () => {})
        // 已经在跑：gitManager 把这一项标成当前运行项，并产生了第一条命令
        gitManagerMock.getRunningOperationId.mockReturnValue('op-42')
        extras?.observer?.commandLine('git fetch --prune')
        cancelRunningExecution(fetchHandle.id, fetchHandle.run)
        return new Promise((resolve) => {
          release = resolve
        })
      }
    )

    const running = ensureExecution(fetchHandle, 'git-fetch', 'kb1')
    await vi.waitFor(() =>
      expect(gitManagerMock.cancelRunningOperation).toHaveBeenCalledWith('kb1', 'op-42')
    )
    // 已经在跑：取消不提前结算，本轮还没返回时仍是「取消中」
    expect(manager.list().find((item) => item.kind === 'git-fetch')?.status).toBe('canceling')
    release(ok(false))
    await running

    // 终态由 runGitTask 在本轮返回之后结算
    expect(manager.list().find((item) => item.kind === 'git-fetch')?.status).toBe('canceled')
  })

  it('排队中的项被取消：只让这一项失效，不碰同库正在跑的另一项，并立即结算', async () => {
    manager.dispose()
    const queuedHandle = manager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.a',
      kind: 'git-pull',
      title: '拉取更新',
      cwd: repoRoot
    }).handle

    // 模拟「已入队但在排队」：onEnqueued 触发后一直不产生任何命令
    let queuedCancelCalled = false
    let release: (value: unknown) => void = () => {}
    let enqueued: () => void = () => {}
    const enqueuedSignal = new Promise<void>((resolve) => {
      enqueued = resolve
    })
    gitManagerMock.pull.mockImplementation(
      async (_kb: string, extras?: { onEnqueued?: (id: string, cancel: () => void) => void }) => {
        await Promise.resolve()
        extras?.onEnqueued?.('op-99', () => {
          queuedCancelCalled = true
        })
        enqueued()
        return new Promise((resolve) => {
          release = resolve
        })
      }
    )

    const running = ensureExecution(queuedHandle, 'git-pull', 'kb1')
    // 等它真的入队（onEnqueued 触发）再取消
    await enqueuedSignal
    cancelRunningExecution(queuedHandle.id, queuedHandle.run)

    // 排队取消：只让该项失效，**不**调用按知识库的取消（那会误杀别人）
    expect(queuedCancelCalled).toBe(true)
    expect(gitManagerMock.cancelRunningOperation).not.toHaveBeenCalled()
    // 取消已受理：进入「取消中」，等轮到时以「已取消」立即结算
    expect(manager.list().find((item) => item.kind === 'git-pull')?.status).toBe('canceling')

    // 排队项轮到时 gitManager 以「已取消」拒绝 → 任务结算 canceled
    release(Promise.reject(new Error('操作已取消')))
    await running
    expect(manager.list().find((item) => item.kind === 'git-pull')?.status).toBe('canceled')
  })
})

describe('保存阶段取消（任务还没进 Git 队列）', () => {
  it('取消停在保存阶段的推送：不按知识库取消任何 Git 队列项，同库其他任务不受影响', async () => {
    manager.dispose()
    // 同库另一个任务正排在 gitManager 队列里（模拟"其他排队任务"）
    const otherHandle = manager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.a',
      kind: 'git-pull',
      title: '拉取更新',
      cwd: repoRoot
    }).handle

    // 推送：渲染端已认领并**声明开始**（保存阶段），但一条 Git 命令都还没发
    const pushHandle = manager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.a',
      kind: 'git-push',
      title: '推送更改',
      cwd: repoRoot
    }).handle
    expect(beginCommandTask(pushHandle.id, pushHandle.run)).toBe(true)
    expect(manager.list().find((item) => item.id === pushHandle.id)?.status).toBe('queued')

    // 用户在保存期间点了停止
    requestCancel(pushHandle.id)

    // 关键：**没有**按知识库去取消 gitManager 里的队列项——那会打到同库其他任务
    expect(gitManagerMock.cancelQueuedOperation).not.toHaveBeenCalled()
    expect(gitManagerMock.cancelRunningOperation).not.toHaveBeenCalled()
    // 也没有为这个任务启动任何 Git 执行（拉取队列里的那一项不受影响）
    expect(gitManagerMock.publish).not.toHaveBeenCalled()
    expect(gitManagerMock.pull).not.toHaveBeenCalled()
    // 保存完成后收尾方据此判定"不得进入 Git"
    expect(manager.list().find((item) => item.id === pushHandle.id)?.status).toBe('canceling')
    expect(manager.list().find((item) => item.id === otherHandle.id)?.status).toBe('queued')
  })

  it('保存期间取消后，执行层一条 Git 命令都不执行', async () => {
    manager.dispose()
    const handle = manager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.a',
      kind: 'git-push',
      title: '推送更改',
      cwd: repoRoot
    }).handle
    beginCommandTask(handle.id, handle.run)
    requestCancel(handle.id)

    // 保存完成后渲染端仍会调一次（真实流程），但已被取消 → 不得进入 Git
    await ensureExecution(handle, 'git-push', 'kb1')

    expect(gitManagerMock.publish).not.toHaveBeenCalled()
    expect(manager.list().find((item) => item.id === handle.id)?.status).toBe('canceled')
  })

  it('没有运行记录时取消：不取消任何 Git 队列项，只把该任务收尾', () => {
    manager.dispose()
    const handle = manager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.a',
      kind: 'git-fetch',
      title: '获取远端更新',
      cwd: repoRoot
    }).handle

    requestCancel(handle.id)

    expect(gitManagerMock.cancelQueuedOperation).not.toHaveBeenCalled()
    expect(gitManagerMock.cancelRunningOperation).not.toHaveBeenCalled()
    expect(manager.list().find((item) => item.id === handle.id)?.status).toBe('canceled')
  })
})

describe('取消中的任务不允许重试', () => {
  it('canceling 仍算活动状态', () => {
    const dto: CommandTaskDto = {
      id: 'x',
      generation: 0,
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'a',
      kind: 'git-pull',
      title: '拉取更新',
      cwd: '/kb',
      command: '',
      status: 'canceling',
      stage: 'canceling',
      stageLabel: '正在停止…',
      run: 1,
      startedAt: 0,
      finishedAt: null,
      error: null,
      logBytes: 0,
      truncatedBytes: 0
    } as CommandTaskDto
    expect(manager.isActive(dto.status)).toBe(true)
  })
})
