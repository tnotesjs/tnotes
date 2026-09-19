import { beforeEach, describe, expect, it, vi } from 'vitest'

import { commandTaskManager } from './commandTaskManager'
import {
  createBackgroundGitTask,
  resetBackgroundFailureDedupe,
  shouldNotifyBackgroundFailure,
  NOTIFY_DEDUPE_WINDOW_MS
} from './backgroundGitFailure'

import type { CommandTaskDto } from '../shared/contracts'

vi.mock('./workspaceManager', () => ({
  workspaceManager: {
    getLocation: () => ({ name: 'TNotes.a', rootPath: '/kb' }),
    getNoteLocation: () => '/kb'
  }
}))

const manager = commandTaskManager
const taskOf = (kind: CommandTaskDto['kind']) => manager.list().filter((task) => task.kind === kind)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  manager.dispose()
  resetBackgroundFailureDedupe()
})

describe('失败通知去抖（纯函数）', () => {
  const event = { knowledgeBaseId: 'kb1', kind: 'git-fetch' as const, message: 'fatal: 远端不可达' }

  it('同一库同一种类的相同失败在窗口内只通知一次', () => {
    const memory = new Map<string, { message: string; at: number }>()
    expect(shouldNotifyBackgroundFailure(memory, event, 1_000)).toBe(true)
    expect(shouldNotifyBackgroundFailure(memory, event, 2_000)).toBe(false)
    expect(shouldNotifyBackgroundFailure(memory, event, 1_000 + NOTIFY_DEDUPE_WINDOW_MS - 1)).toBe(
      false
    )
    // 窗口之外重新通知
    expect(shouldNotifyBackgroundFailure(memory, event, 1_000 + NOTIFY_DEDUPE_WINDOW_MS)).toBe(true)
  })

  it('失败原因变了要通知；不同知识库互不影响', () => {
    const memory = new Map<string, { message: string; at: number }>()
    expect(shouldNotifyBackgroundFailure(memory, event, 1_000)).toBe(true)
    expect(shouldNotifyBackgroundFailure(memory, { ...event, message: '第二种失败' }, 1_500)).toBe(
      true
    )
    // 不同库各自有独立的去抖键
    expect(shouldNotifyBackgroundFailure(memory, { ...event, knowledgeBaseId: 'kb2' }, 1_500)).toBe(
      true
    )
  })
})

describe('后台 Git 任务：真实时长与失败分类', () => {
  it('任务在开始时认领：时长是真实执行时间，不是 0ms', async () => {
    const task = createBackgroundGitTask({ knowledgeBaseId: 'kb1', kind: 'git-fetch' })
    expect(task).not.toBeNull()
    const started = taskOf('git-fetch')[0]
    expect(started.status).toBe('running')
    expect(started.background).toBe(true)
    expect(started.finishedAt).toBeNull()

    // 模拟一次真实的慢失败（远超 0ms）
    await sleep(40)
    task!.finish('timeout', 'Git 操作超时：git fetch（15000ms）')

    const finished = taskOf('git-fetch')[0]
    expect(finished.id).toBe(started.id)
    expect(finished.status).toBe('timeout')
    expect(finished.stage).toBe('finished')
    expect(finished.error).toContain('超时')
    expect(finished.finishedAt).not.toBeNull()
    // 关键断言：禁止出现 claimHandle 后立刻 finishRun 的假 0ms 时长
    expect(finished.finishedAt! - finished.startedAt).toBeGreaterThanOrEqual(30)
  })

  it('失败保留已有输出，分类如实记录', async () => {
    const task = createBackgroundGitTask({ knowledgeBaseId: 'kb1', kind: 'git-fetch' })!
    task.observer.commandLine?.('git fetch --prune')
    task.observer.output('stderr', 'fatal: unable to access remote\n')
    task.finish('failed', 'fatal: unable to access remote')

    const finished = taskOf('git-fetch')[0]
    expect(finished.status).toBe('failed')
    expect(finished.command).toContain('git fetch --prune')
    // 输出在结算时被冲刷，已经计入任务（面板「查看输出」据此展示）
    expect(finished.logBytes).toBeGreaterThan(0)
    expect(finished.truncatedBytes).toBe(0)
  })

  it('同一失败在窗口内重复发生时任务保留、但不再通知', async () => {
    const first = createBackgroundGitTask({ knowledgeBaseId: 'kb1', kind: 'git-fetch' })!
    first.finish('failed', '同样的失败')
    const second = createBackgroundGitTask({ knowledgeBaseId: 'kb1', kind: 'git-fetch' })!
    second.finish('failed', '同样的失败')

    const tasks = taskOf('git-fetch')
    // 明细两条运行都保留（run 递增），但第二次不再触发通知
    expect(tasks).toHaveLength(1)
    expect(tasks[0].run).toBe(2)
    expect(tasks[0].notify).toBe(false)
  })

  it('失败原因变了会重新通知；成功结算不参与去抖', () => {
    const first = createBackgroundGitTask({ knowledgeBaseId: 'kb1', kind: 'git-fetch' })!
    first.finish('failed', '第一次失败')
    const second = createBackgroundGitTask({ knowledgeBaseId: 'kb1', kind: 'git-fetch' })!
    second.finish('failed', '第二次不同的失败')
    expect(taskOf('git-fetch')[0].notify).toBe(true)

    const done = createBackgroundGitTask({ knowledgeBaseId: 'kb1', kind: 'git-fetch' })!
    done.finish('done', null)
    expect(taskOf('git-fetch')[0].status).toBe('done')
    expect(taskOf('git-fetch')[0].notify).toBe(true)
  })

  it('不同知识库各自独立', () => {
    const kb1 = createBackgroundGitTask({ knowledgeBaseId: 'kb1', kind: 'git-fetch' })!
    kb1.finish('failed', '失败')
    const kb2 = createBackgroundGitTask({ knowledgeBaseId: 'kb2', kind: 'git-fetch' })!
    kb2.finish('failed', '失败')
    expect(taskOf('git-fetch')).toHaveLength(2)
  })
})

describe('执行层输出截断的信息通路', () => {
  it('累加执行层丢弃的字节数，并进入任务 DTO（面板据此提示）', () => {
    manager.dispose()
    const handle = manager.claimHandle({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: 'TNotes.a',
      kind: 'git-fetch',
      title: '获取远端更新',
      cwd: '/kb'
    }).handle

    expect(manager.list()[0].truncatedBytes).toBe(0)
    handle.addTruncated(1024)
    handle.addTruncated(2048)
    // 非法值忽略（不因为一次坏上报把计数弄乱）
    handle.addTruncated(0)
    handle.addTruncated(-5)
    handle.addTruncated(Number.NaN)

    expect(manager.list()[0].truncatedBytes).toBe(3072)
  })
})
