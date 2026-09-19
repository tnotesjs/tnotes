import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { commandTaskManager } from '../commandTaskManager'
import { ensureExecution, runGitTask } from './commandTask'

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

describe('命令任务的业务结果映射', () => {
  let handle: ReturnType<typeof manager.claimHandle>['handle']

  beforeEach(() => {
    // runGitTask 用的是模块单例：必须操作同一个实例，否则状态永远不变
    manager.dispose()
    vi.clearAllMocks()
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
