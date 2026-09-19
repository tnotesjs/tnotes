import { describe, expect, it } from 'vitest'

import { planFailureNotices, taskRunKey } from './failureNotice'

import type { CommandTaskDto } from '../../../shared/contracts'

let seq = 0

function task(overrides: Partial<CommandTaskDto> = {}): CommandTaskDto {
  seq += 1
  return {
    id: overrides.id ?? `task-${seq}`,
    knowledgeBaseId: 'kb',
    knowledgeBaseName: 'TNotes.a',
    kind: 'git-fetch',
    title: '获取远端更新',
    cwd: '/kb',
    command: 'git fetch --prune',
    status: 'failed',
    stage: 'finished',
    stageLabel: '失败',
    run: 1,
    startedAt: 1000,
    finishedAt: 2000,
    error: 'fatal: unable to access remote',
    logBytes: 0,
    truncatedBytes: 0,
    background: true,
    notify: true,
    ...overrides
  } as CommandTaskDto
}

describe('后台失败通知聚合', () => {
  it('单个后台失败：一条通知，带知识库名与「查看输出」目标', () => {
    const notices = planFailureNotices(
      [task({ id: 'a', knowledgeBaseName: 'TNotes.a' })],
      new Set()
    )
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      actionTaskId: 'a',
      count: 1,
      keys: ['a:1'],
      message: '获取远端更新失败：TNotes.a'
    })
  })

  it('多知识库同一时间窗内失败：聚合成一条，消息列出各库', () => {
    const tasks = [
      task({ id: 'a', knowledgeBaseName: 'TNotes.a', finishedAt: 2000 }),
      task({ id: 'b', knowledgeBaseName: 'TNotes.b', finishedAt: 2400 }),
      task({ id: 'c', knowledgeBaseName: 'TNotes.c', finishedAt: 2900 })
    ]
    const notices = planFailureNotices(tasks, new Set())
    expect(notices).toHaveLength(1)
    expect(notices[0].count).toBe(3)
    expect(notices[0].keys).toEqual(['a:1', 'b:1', 'c:1'])
    expect(notices[0].actionTaskId).toBe('a')
    expect(notices[0].message).toBe('获取远端更新失败：TNotes.a、TNotes.b、TNotes.c')
  })

  it('超过 3 个知识库时折叠为「等 N 个知识库」', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((name, index) =>
      task({
        id: name,
        knowledgeBaseName: `TNotes.${name}`,
        finishedAt: 2000 + index * 100
      })
    )
    const notices = planFailureNotices(tasks, new Set())
    expect(notices).toHaveLength(1)
    expect(notices[0].message).toBe('获取远端更新失败：TNotes.a、TNotes.b、TNotes.c 等 5 个知识库')
  })

  it('超出时间窗或不同种类的失败不聚合', () => {
    const farApart = [
      task({ id: 'a', knowledgeBaseName: 'TNotes.a', finishedAt: 2000 }),
      task({ id: 'b', knowledgeBaseName: 'TNotes.b', finishedAt: 2000 + 60_000 })
    ]
    expect(planFailureNotices(farApart, new Set())).toHaveLength(2)

    const mixed = [
      task({ id: 'a', knowledgeBaseName: 'TNotes.a', kind: 'git-fetch', finishedAt: 2000 }),
      task({ id: 'b', knowledgeBaseName: 'TNotes.b', kind: 'git-push', finishedAt: 2100 })
    ]
    const notices = planFailureNotices(mixed, new Set())
    expect(notices).toHaveLength(2)
    expect(notices.map((notice) => notice.message)).toEqual([
      '获取远端更新失败：TNotes.a',
      '获取远端更新失败：TNotes.b'
    ])
  })

  it('手动失败逐条通知，不与后台失败混在一起', () => {
    const notices = planFailureNotices(
      [
        task({ id: 'bg1', background: true, knowledgeBaseName: 'TNotes.a' }),
        task({ id: 'bg2', background: true, knowledgeBaseName: 'TNotes.b' }),
        task({ id: 'm1', background: false, knowledgeBaseName: 'TNotes.c' }),
        task({ id: 'm2', background: false, knowledgeBaseName: 'TNotes.d' })
      ],
      new Set()
    )
    expect(notices).toHaveLength(3)
    expect(notices.map((notice) => notice.count)).toEqual([1, 1, 2])
    expect(notices[2].message).toBe('获取远端更新失败：TNotes.a、TNotes.b')
  })

  it('已通知过的键、notify=false、未结算的任务都不再产生通知', () => {
    const tasks = [
      task({ id: 'a' }),
      task({ id: 'b', notify: false }),
      task({ id: 'c', finishedAt: null, status: 'running' })
    ]
    expect(planFailureNotices(tasks, new Set([taskRunKey(tasks[0])]))).toEqual([])
    // 只通知 a；b 被去抖、c 还没结算
    const raw = planFailureNotices(tasks, new Set())
    expect(raw).toHaveLength(1)
    expect(raw[0].keys).toEqual(['a:1'])
  })

  it('超时与失败同样进入聚合（都算后台失败）', () => {
    const notices = planFailureNotices(
      [
        task({ id: 'a', status: 'timeout', finishedAt: 2000 }),
        task({ id: 'b', status: 'failed', finishedAt: 2100 })
      ],
      new Set()
    )
    expect(notices).toHaveLength(1)
    expect(notices[0].count).toBe(2)
  })
})
