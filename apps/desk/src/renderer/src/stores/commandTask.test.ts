import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useCommandTaskStore } from './commandTask'
import { useTerminalStore } from './terminal'

import type { CommandTaskDto } from '../../../shared/contracts'

function task(overrides: Partial<CommandTaskDto> = {}): CommandTaskDto {
  return {
    id: 'task-1',
    knowledgeBaseId: 'kb-1',
    knowledgeBaseName: 'KB',
    kind: 'git-pull',
    title: '拉取更新',
    cwd: '/kb',
    command: '',
    status: 'running',
    stage: 'running',
    stageLabel: '拉取更新',
    run: 1,
    startedAt: 1,
    finishedAt: null,
    error: null,
    logBytes: 0,
    truncatedBytes: 0,
    background: false,
    notify: true,
    ...overrides
  }
}

beforeEach(() => {
  const values = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    desk: {
      commandTask: {
        list: async () => ({ ok: true, value: [task()] })
      }
    }
  }
  setActivePinia(createPinia())
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage
})

describe('命令任务只出现在「输出」视图', () => {
  it('reveal 选中任务并切到输出视图', async () => {
    const tasks = useCommandTaskStore()
    const terminal = useTerminalStore()
    await tasks.load()
    expect(terminal.view).toBe('terminal')
    tasks.reveal('task-1')
    expect(tasks.activeTaskId).toBe('task-1')
    expect(terminal.view).toBe('output')
  })

  it('revealByKind 找到任务时同样切到输出视图，找不到时不动', async () => {
    const tasks = useCommandTaskStore()
    const terminal = useTerminalStore()
    await tasks.load()
    expect(tasks.revealByKind('kb-1', 'git-push')).toBe(false)
    expect(terminal.view).toBe('terminal')
    expect(tasks.revealByKind('kb-1', 'git-pull')).toBe(true)
    expect(terminal.view).toBe('output')
  })
})
