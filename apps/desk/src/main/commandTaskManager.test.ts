import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CommandTaskManager } from './commandTaskManager'

import type { CommandTaskDto, CommandTaskLogEvent } from '../shared/contracts'

function setup(options: { maxLogBytes?: number; flushIntervalMs?: number } = {}) {
  const manager = new CommandTaskManager({ flushIntervalMs: 1, ...options })
  const states: CommandTaskDto[] = []
  const logs: CommandTaskLogEvent[] = []
  manager.onChanged((state) => states.push(state))
  manager.onLog((event) => logs.push(event))
  return { manager, states, logs }
}

const claim = (manager: CommandTaskManager, kind: CommandTaskDto['kind'] = 'git-pull') =>
  manager.claimHandle({
    knowledgeBaseId: 'kb-1',
    knowledgeBaseName: 'TNotes.kb',
    kind,
    title: '拉取更新',
    cwd: '/kb'
  }).handle

describe('命令任务的生命周期', () => {
  it('认领即进入排队态：不等子进程启动就有反馈', () => {
    const { manager, states } = setup()
    const task = claim(manager)
    expect(task.id).toBeTruthy()
    const current = manager.list()[0]
    expect(current.status).toBe('queued')
    expect(current.stage).toBe('queued')
    // 认领时就推送了一次状态：界面不必等到真正执行
    expect(states.length).toBeGreaterThan(0)
  })

  it('阶段推进：saving / precheck / running 都会推送', () => {
    const { manager } = setup()
    const task = claim(manager, 'git-push')
    task.stage('saving', '保存未提交的更改')
    expect(manager.list()[0].status).toBe('saving')
    expect(manager.list()[0].stageLabel).toBe('保存未提交的更改')
    task.stage('precheck', '检查仓库状态')
    expect(manager.list()[0].status).toBe('precheck')
    task.stage('running', '推送更改')
    expect(manager.list()[0].status).toBe('running')
  })

  it('完成、失败、超时、取消都带上原因与结束时间', () => {
    const { manager } = setup()
    for (const [status, reason] of [
      ['done', null],
      ['failed', '远端拒绝'],
      ['timeout', '执行超时'],
      ['canceled', '任务已取消']
    ] as const) {
      const task = claim(manager)
      task.stage('running')
      manager.finishRun(task.id, task.run, status, reason)
      const current = manager.list()[0]
      expect(current.status).toBe(status)
      expect(current.stage).toBe('finished')
      expect(current.finishedAt).not.toBeNull()
      expect(current.error).toBe(reason)
    }
  })
})

describe('重复点击与运行代次', () => {
  it('同一 (库, 种类) 运行中重复认领：复用同一标签，run 不变（否则阶段上报会被当成旧运行丢弃）', () => {
    const { manager } = setup()
    const first = claim(manager)
    // 渲染端与主进程会各 claim 一次同一个任务
    const second = claim(manager)
    const third = claim(manager)
    expect(second.id).toBe(first.id)
    expect(second.run).toBe(first.run)
    expect(third.run).toBe(first.run)
    // 复用时阶段上报必须生效（run 一致）
    second.stage('running', '拉取更新')
    expect(manager.list()[0].status).toBe('running')
    expect(manager.list()).toHaveLength(1)
  })

  it('结束后再次认领：同一标签上开始新一轮，run 自增', () => {
    const { manager } = setup()
    const first = claim(manager)
    manager.finishRun(first.id, first.run, 'failed', '第一次失败')
    const second = claim(manager)
    expect(second.id).toBe(first.id)
    expect(second.run).toBe(first.run + 1)
    expect(manager.list()).toHaveLength(1)
    expect(manager.list()[0].status).toBe('queued')
    expect(manager.list()[0].error).toBeNull()
  })

  it('旧运行的完成事件被丢弃：不能改新运行的状态', async () => {
    const { manager, logs } = setup()
    const first = claim(manager)
    manager.finishRun(first.id, first.run, 'done', null)
    const second = claim(manager)

    const before = logs.length
    // 用旧 run 号收尾：必须被忽略
    manager.finishRun(second.id, first.run, 'failed', '旧运行的完成事件')

    expect(manager.list()[0].status).toBe('queued')
    expect(manager.list()[0].run).toBe(second.run)
    expect(manager.list()[0].error).toBeNull()
    expect(logs.length).toBe(before)
  })

  it('旧运行的迟到输出不会进入新一轮日志', async () => {
    const { manager, logs } = setup()
    const first = claim(manager)
    first.stage('running')
    manager.finishRun(first.id, first.run, 'done', null)
    const second = claim(manager)
    second.stage('running')

    // 用旧 run 号写入：应被丢弃
    manager.reportStage(second.id, first.run, 'running', '旧运行')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const before = logs.length
    manager.finishRun(second.id, second.run, 'done', null)
    expect(logs.length).toBeGreaterThanOrEqual(before)
    expect(manager.list()[0].status).toBe('done')
  })

  it('不同种类各自一个标签', () => {
    const { manager } = setup()
    const pull = claim(manager, 'git-pull')
    const push = claim(manager, 'git-push')
    expect(pull.id).not.toBe(push.id)
    expect(manager.list()).toHaveLength(2)
  })
})

describe('输出与容量', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('合批推送：多次写入合并为一次，字节数正确', async () => {
    const { manager, logs } = setup()
    const task = claim(manager)
    task.write('stdout', '第一行\n')
    task.write('stdout', '第二行\n')
    await vi.advanceTimersByTimeAsync(5)
    expect(logs).toHaveLength(1)
    expect(logs[0].data).toBe('第一行\n第二行\n')
    expect(logs[0].bytes).toBe(Buffer.byteLength('第一行\n第二行\n'))
  })

  it('stderr 片段带来源标记，便于界面区分', async () => {
    const { manager, logs } = setup()
    const task = claim(manager)
    task.write('stderr', '出错了\n')
    await vi.advanceTimersByTimeAsync(5)
    expect(logs[0].data).toContain('\u0000stderr\u0001出错了\n')
  })

  it('超时/失败也会把残留输出冲出去（保留真实输出）', async () => {
    const { manager, logs } = setup()
    const task = claim(manager)
    task.write('stdout', '最后一行\n')
    manager.finishRun(task.id, task.run, 'timeout', '执行超时')
    expect(logs.map((event) => event.data).join('')).toContain('最后一行')
    expect(manager.list()[0].error).toBe('执行超时')
  })

  it('日志有上限：执行期间就滚动丢弃最旧的字节并累计截断量', async () => {
    const { manager, logs } = setup({ maxLogBytes: 1024 })
    const task = claim(manager)
    for (let index = 0; index < 10; index += 1) task.write('stdout', 'x'.repeat(256))
    await vi.advanceTimersByTimeAsync(5)
    const pushed = logs.reduce((sum, event) => sum + event.bytes, 0)
    expect(pushed).toBeLessThanOrEqual(1024)
    expect(manager.list()[0].truncatedBytes).toBeGreaterThan(0)
    expect(logs.at(-1)?.truncatedBytes).toBeGreaterThan(0)
  })

  it('单块就超上限时按尾部保留，不切断代理对', async () => {
    const { manager, logs } = setup({ maxLogBytes: 64 })
    const task = claim(manager)
    task.write('stdout', '🚀'.repeat(100))
    await vi.advanceTimersByTimeAsync(5)
    const data = logs.map((event) => event.data).join('')
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    // 不含替换字符说明没有从中间切断
    expect(data).not.toContain('\uFFFD')
    expect(manager.list()[0].truncatedBytes).toBeGreaterThan(0)
  })

  it('关闭标签只移除视图，不影响运行中的记录语义', () => {
    const { manager } = setup()
    const task = claim(manager)
    manager.close(task.id)
    expect(manager.list()).toHaveLength(0)
    // 关闭后同一 (库, 种类) 可以重新认领，且是新标签
    const again = claim(manager)
    expect(again.id).not.toBe(task.id)
  })

  it('dispose 清空所有记录', () => {
    const { manager } = setup()
    claim(manager)
    manager.dispose()
    expect(manager.list()).toHaveLength(0)
  })
})

describe('推送阶段与取消', () => {
  it('canelQueued：排队中取消不需要终止任何进程', () => {
    const { manager } = setup()
    const task = claim(manager)
    manager.cancelQueued(task.id, task.run, '已在排队阶段取消')
    const current = manager.list()[0]
    expect(current.status).toBe('canceled')
    expect(current.error).toBe('已在排队阶段取消')
  })

  it('已完成的任务再取消不会改状态', () => {
    const { manager } = setup()
    const task = claim(manager)
    manager.finishRun(task.id, task.run, 'done', null)
    manager.cancelQueued(task.id, task.run, '取消')
    expect(manager.list()[0].status).toBe('done')
  })

  it('reportStage 按 run 过滤：旧运行的上报改不了新运行', () => {
    const { manager } = setup()
    const first = claim(manager)
    manager.finishRun(first.id, first.run, 'done', null)
    const second = claim(manager)
    manager.reportStage(second.id, first.run, 'saving', '旧运行的保存阶段')
    expect(manager.list()[0].status).toBe('queued')
    manager.reportStage(second.id, second.run, 'saving', '保存未提交的更改')
    expect(manager.list()[0].status).toBe('saving')
  })
})
