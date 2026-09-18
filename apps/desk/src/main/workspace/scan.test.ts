import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWorkspace } from '@tnotesjs/kb'

import {
  backfillMissingNoteIds,
  handleWatchedPath,
  markInternalWrites,
  type WorkspaceScanState
} from './scan'
import type { KnowledgeBaseHandle } from './types'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

async function makeHandleWithoutNoteId(): Promise<KnowledgeBaseHandle> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-scan-'))
  cleanups.push(async () => fs.rm(rootPath, { recursive: true, force: true }))
  await fs.mkdir(path.join(rootPath, 'notes'), { recursive: true })
  await fs.writeFile(path.join(rootPath, 'tnotes.json'), '{ "title": "测试库" }\n')
  await fs.writeFile(path.join(rootPath, 'TOC.md'), '- [ ] 0001. 手写笔记\n')
  await fs.writeFile(path.join(rootPath, 'notes', '0001. 手写笔记.md'), '# 手写笔记\n\n正文。\n')
  const workspace = createWorkspace({ rootPath })
  return {
    id: 'kb-test',
    name: 'TNotes.test',
    rootPath,
    workspace,
    snapshot: await workspace.scan()
  }
}

function makeState(): WorkspaceScanState {
  return { internalWriteUntil: new Map() } as unknown as WorkspaceScanState
}

describe('backfillMissingNoteIds', () => {
  it('回填缺失的笔记 id，并把这次写盘标记为内部写入', async () => {
    const handle = await makeHandleWithoutNoteId()
    const state = makeState()
    expect(handle.snapshot.notes[0]?.frontmatter.id).toBeFalsy()

    await backfillMissingNoteIds(state, handle)

    const notePath = path.normalize(path.join(handle.rootPath, 'notes', '0001. 手写笔记.md'))
    const until = state.internalWriteUntil.get(notePath) ?? 0
    // 不标记的话，fs.watch 会把这次回填当成外部修改
    expect(until).toBeGreaterThan(Date.now())
    expect(handle.snapshot.notes[0]?.frontmatter.id).toBeTruthy()
    expect(await fs.readFile(notePath, 'utf8')).toMatch(/^---\nid: /)
  })
})

describe('内部写入标记的过期清理', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('下一次标记时清掉已过期的条目，避免漏事件时永久累积', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'))
    const state = makeState()
    markInternalWrites(state, '/kb', [{ path: 'notes/a.md' }])
    expect(state.internalWriteUntil.size).toBe(1)

    // 窗口 1500ms 过后再标记另一个文件：旧条目应被清掉
    vi.setSystemTime(new Date('2026-09-11T00:00:10Z'))
    markInternalWrites(state, '/kb', [{ path: 'notes/b.md' }])

    expect(state.internalWriteUntil.size).toBe(1)
    expect([...state.internalWriteUntil.keys()]).toEqual([
      path.normalize(path.join('/kb', 'notes/b.md'))
    ])
  })

  it('同名文件的旧时间戳会被新写入覆盖', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'))
    const state = makeState()
    markInternalWrites(state, '/kb', [{ path: 'notes/a.md' }])
    const first = state.internalWriteUntil.get(path.normalize('/kb/notes/a.md')) ?? 0
    vi.setSystemTime(new Date('2026-09-11T00:00:01Z'))
    markInternalWrites(state, '/kb', [{ path: 'notes/a.md' }])
    const second = state.internalWriteUntil.get(path.normalize('/kb/notes/a.md')) ?? 0
    expect(second).toBeGreaterThan(first)
  })
})

describe('终端写入磁盘笔记（外部变更）', () => {
  function makeEventState(): { state: WorkspaceScanState; events: Array<Record<string, unknown>> } {
    const events: Array<Record<string, unknown>> = []
    const state = {
      internalWriteUntil: new Map<string, number>(),
      // 只用到 events / refresh 调度相关字段，其余按需替换
      refreshTimer: null,
      events: {
        emit: (name: string, payload: Record<string, unknown>) => events.push({ name, ...payload })
      },
      scanTail: Promise.resolve()
    } as unknown as WorkspaceScanState
    return { state, events }
  }

  it('终端直接改笔记 → 必须发出 noteExternalChanged（不能因为没有写入门禁记录就被忽略）', async () => {
    const handle = await makeHandleWithoutNoteId()
    const { state, events } = makeEventState()
    const changedNote = path.join(handle.rootPath, 'notes', '0001. 手写笔记.md')

    handleWatchedPath(state, handle, changedNote)

    const external = events.find((event) => event.name === 'noteExternalChanged')
    expect(external).toBeDefined()
    expect(external?.knowledgeBaseId).toBe(handle.id)
  })

  it('Desk 自己刚写过的路径被忽略（内部写入不当作外部变更）', async () => {
    const handle = await makeHandleWithoutNoteId()
    const { state, events } = makeEventState()
    const changedNote = path.join(handle.rootPath, 'notes', '0001. 手写笔记.md')
    markInternalWrites(state, handle.rootPath, [{ path: 'notes/0001. 手写笔记.md' }])

    handleWatchedPath(state, handle, changedNote)

    expect(events.find((event) => event.name === 'noteExternalChanged')).toBeUndefined()
  })
})
