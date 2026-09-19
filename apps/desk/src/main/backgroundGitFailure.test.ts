import { beforeEach, describe, expect, it, vi } from 'vitest'

import { commandTaskManager } from './commandTaskManager'
import { reportBackgroundGitFailure, resetBackgroundFailureDedupe } from './backgroundGitFailure'

import type { CommandTaskDto } from '../shared/contracts'

vi.mock('./workspaceManager', () => ({
  workspaceManager: {
    getLocation: () => ({ name: 'TNotes.a', rootPath: '/kb' }),
    getNoteLocation: () => '/kb'
  }
}))

const manager = commandTaskManager
const failedOf = (kind: CommandTaskDto['kind']) =>
  manager.list().filter((task) => task.kind === kind && task.status === 'failed')

beforeEach(() => {
  manager.dispose()
  resetBackgroundFailureDedupe()
})

describe('后台 Git 失败 → 可见的命令任务', () => {
  it('定时 fetch 失败会落成一条 failed 任务（面板据此弹「查看输出」）', () => {
    reportBackgroundGitFailure({
      knowledgeBaseId: 'kb1',
      kind: 'git-fetch',
      message: 'fatal: unable to access remote'
    })
    const failed = failedOf('git-fetch')
    expect(failed).toHaveLength(1)
    expect(failed[0].error).toContain('unable to access')
    // 必须有终态时间：通知只在任务结算之后才有意义
    expect(failed[0].finishedAt).not.toBeNull()
  })

  it('自动推送失败同样可见，且种类正确', () => {
    reportBackgroundGitFailure({
      knowledgeBaseId: 'kb1',
      kind: 'git-push',
      message: 'Git push 失败'
    })
    expect(failedOf('git-push')).toHaveLength(1)
  })

  it('同一失败在窗口内只落一次（否则定时 fetch 每个周期都新增一条）', () => {
    const event = { knowledgeBaseId: 'kb1', kind: 'git-fetch' as const, message: '同样的失败' }
    reportBackgroundGitFailure(event)
    const first = failedOf('git-fetch')[0]
    reportBackgroundGitFailure(event)
    reportBackgroundGitFailure(event)
    // 被去抖：没有产生新一轮运行
    const after = failedOf('git-fetch')
    expect(after).toHaveLength(1)
    expect(after[0].run).toBe(first.run)
  })

  it('失败原因变了就再落一条（不是永久静音）', () => {
    reportBackgroundGitFailure({
      knowledgeBaseId: 'kb1',
      kind: 'git-fetch',
      message: '第一次失败'
    })
    const first = failedOf('git-fetch')[0]
    reportBackgroundGitFailure({
      knowledgeBaseId: 'kb1',
      kind: 'git-fetch',
      message: '第二次不同的失败'
    })
    // 同一 (库, 种类) 共用一个标签：新一轮运行 = run 递增，且原因被更新。
    // 面板的失败通知按 `${id}:${run}` 去重，所以这仍会通知一次。
    const after = failedOf('git-fetch')
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(first.id)
    expect(after[0].run).toBe(first.run + 1)
    expect(after[0].error).toContain('第二次不同的失败')
  })

  it('不同知识库各自独立', () => {
    reportBackgroundGitFailure({
      knowledgeBaseId: 'kb1',
      kind: 'git-fetch',
      message: '失败'
    })
    reportBackgroundGitFailure({
      knowledgeBaseId: 'kb2',
      kind: 'git-fetch',
      message: '失败'
    })
    expect(failedOf('git-fetch')).toHaveLength(2)
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
