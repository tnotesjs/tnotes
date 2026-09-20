import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./log', () => ({ deskLog: vi.fn() }))
vi.mock('./workspaceManager', () => ({
  workspaceManager: {
    getLocation: (id: string) => {
      if (id === 'missing') throw new Error('unknown kb')
      return { name: `库-${id}`, rootPath: `/tmp/${id}` }
    }
  }
}))

import {
  BACKGROUND_FAILURE_LIMIT,
  clearBackgroundFailures,
  listBackgroundFailures,
  onBackgroundFailuresChanged,
  recordBackgroundFailureWithoutTask,
  resetBackgroundFailureLog
} from './backgroundFailureLog'

beforeEach(() => {
  resetBackgroundFailureLog()
})

describe('后台失败记录（不占面板标签）', () => {
  it('记录错误原文、原因、知识库名与时间', () => {
    const record = recordBackgroundFailureWithoutTask({
      knowledgeBaseId: 'kb1',
      kind: 'git-fetch',
      reason: '底部面板标签已达上限',
      message: 'fatal: could not read from remote',
      at: new Date('2026-01-02T03:04:05.000Z')
    })
    expect(record).toMatchObject({
      knowledgeBaseId: 'kb1',
      knowledgeBaseName: '库-kb1',
      kind: 'git-fetch',
      reason: '底部面板标签已达上限',
      message: 'fatal: could not read from remote',
      at: '2026-01-02T03:04:05.000Z',
      count: 1
    })
    expect(listBackgroundFailures()).toHaveLength(1)
  })

  it('同一 (库, 操作, 原因, 消息) 只累加计数，不产生新条目', () => {
    const event = {
      knowledgeBaseId: 'kb1',
      kind: 'git-fetch' as const,
      reason: '底部面板标签已达上限',
      message: 'boom'
    }
    recordBackgroundFailureWithoutTask(event)
    recordBackgroundFailureWithoutTask(event)
    recordBackgroundFailureWithoutTask(event)
    const items = listBackgroundFailures()
    expect(items).toHaveLength(1)
    expect(items[0].count).toBe(3)
  })

  it('同因连续失败三次只累加计数（一条 ×3），不新增记录', () => {
    const event = {
      knowledgeBaseId: 'kb1',
      kind: 'git-fetch' as const,
      reason: '底部面板标签已达上限，没有可见任务',
      message: 'fatal: unable to access remote'
    }
    recordBackgroundFailureWithoutTask(event)
    recordBackgroundFailureWithoutTask(event)
    recordBackgroundFailureWithoutTask(event)
    const items = listBackgroundFailures()
    // 关键：不能出现"一次失败显示 ×2"（旧实现先建占位再更新会 +1 两次）
    expect(items).toHaveLength(1)
    expect(items[0].count).toBe(3)
  })

  it('一次失败只记一次（不存在"先建占位再更新"的 ×2）', () => {
    recordBackgroundFailureWithoutTask({
      knowledgeBaseId: 'kb1',
      kind: 'git-fetch',
      reason: '底部面板标签已达上限，没有可见任务',
      message: 'fatal: unable to access remote'
    })
    expect(listBackgroundFailures()).toHaveLength(1)
    expect(listBackgroundFailures()[0].count).toBe(1)
  })

  it('原因或消息变了就是新条目（不吞新问题）', () => {
    recordBackgroundFailureWithoutTask({
      knowledgeBaseId: 'kb1',
      kind: 'git-fetch',
      reason: '底部面板标签已达上限',
      message: 'boom'
    })
    recordBackgroundFailureWithoutTask({
      knowledgeBaseId: 'kb1',
      kind: 'git-fetch',
      reason: '底部面板标签已达上限',
      message: 'different'
    })
    recordBackgroundFailureWithoutTask({
      knowledgeBaseId: 'kb1',
      kind: 'git-push',
      reason: '底部面板标签已达上限',
      message: 'boom'
    })
    expect(listBackgroundFailures()).toHaveLength(3)
  })

  it('知识库查不到时退回用 id 当名字，不抛异常', () => {
    const record = recordBackgroundFailureWithoutTask({
      knowledgeBaseId: 'missing',
      kind: 'git-fetch',
      reason: 'r',
      message: 'm'
    })
    expect(record.knowledgeBaseName).toBe('missing')
  })

  it('订阅者收到快照，取消订阅后不再收到', () => {
    const seen: number[] = []
    const off = onBackgroundFailuresChanged((items) => seen.push(items.length))
    recordBackgroundFailureWithoutTask({
      knowledgeBaseId: 'kb1',
      kind: 'git-fetch',
      reason: 'r',
      message: 'm'
    })
    off()
    recordBackgroundFailureWithoutTask({
      knowledgeBaseId: 'kb2',
      kind: 'git-fetch',
      reason: 'r',
      message: 'm'
    })
    expect(seen).toEqual([1])
  })

  it('清空会通知订阅者', () => {
    const seen: number[] = []
    onBackgroundFailuresChanged((items) => seen.push(items.length))
    recordBackgroundFailureWithoutTask({
      knowledgeBaseId: 'kb1',
      kind: 'git-fetch',
      reason: 'r',
      message: 'm'
    })
    clearBackgroundFailures()
    expect(seen).toEqual([1, 0])
    expect(listBackgroundFailures()).toHaveLength(0)
  })

  it('最多保留 BACKGROUND_FAILURE_LIMIT 条', () => {
    for (let i = 0; i < BACKGROUND_FAILURE_LIMIT + 5; i += 1) {
      recordBackgroundFailureWithoutTask({
        knowledgeBaseId: `kb${i}`,
        kind: 'git-fetch',
        reason: 'r',
        message: 'm'
      })
    }
    expect(listBackgroundFailures()).toHaveLength(BACKGROUND_FAILURE_LIMIT)
  })
})
