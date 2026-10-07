import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWorkspace } from '@tnotesjs/kb'

import { applyNoteMutation } from './mutations'
import { markInternalWrites, type WorkspaceScanState } from './scan'
import { readNote, saveNote } from './noteIo'
import type { KnowledgeBaseHandle } from './types'
import type { WorkspaceChangeHint } from './types'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

async function makeHandle(): Promise<KnowledgeBaseHandle> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-mutations-'))
  cleanups.push(async () => fs.rm(rootPath, { recursive: true, force: true }))
  await fs.mkdir(path.join(rootPath, 'notes'), { recursive: true })
  await fs.writeFile(path.join(rootPath, 'tnotes.json'), '{ "title": "测试库" }\n')
  await fs.writeFile(path.join(rootPath, 'TOC.md'), '- [ ] 0001. 第一篇\n')
  await fs.writeFile(path.join(rootPath, 'notes', '0001. 第一篇.md'), '# 第一篇\n\n正文。\n')
  const workspace = createWorkspace({ rootPath })
  return {
    id: 'kb-test',
    name: 'TNotes.test',
    rootPath,
    workspace,
    snapshot: await workspace.scan(),
    lastCommitAt: null
  }
}

describe('applyNoteMutation', () => {
  it('patches the snapshot in place for content-only saves (no full rescan)', async () => {
    const handle = await makeHandle()
    const hints: Array<WorkspaceChangeHint | undefined> = []
    const effects = {
      markInternalWrites: () => {},
      emitChanged: (hint?: WorkspaceChangeHint) => {
        hints.push(hint)
      }
    }
    const doc = await readNote(handle, '0001')
    const saved = await saveNote(
      handle,
      {
        knowledgeBaseId: handle.id,
        noteUuid: '0001',
        content: '# 第一篇\n\n新正文。\n',
        expectedRevision: doc.revision
      },
      effects
    )

    const scanSpy = vi.spyOn(handle.workspace, 'scan')
    const result = {
      value: {
        ...handle.snapshot.notes[0]!,
        frontmatter: { id: 'note-uuid-1', description: '新描述' },
        body: '',
        content: saved.note.content,
        revision: saved.note.revision
      },
      changedFiles: [{ path: 'notes/0001. 第一篇.md', kind: 'updated' as const }]
    }
    await applyNoteMutation(handle, result, effects)

    expect(scanSpy).not.toHaveBeenCalled()
    expect(hints.at(-1)).toEqual({
      kind: 'content',
      knowledgeBaseId: 'kb-test',
      noteUuid: 'note-uuid-1'
    })
    expect(handle.snapshot.notes).toHaveLength(1)
    expect(handle.snapshot.notes[0]?.frontmatter.description).toBe('新描述')
  })

  it('rescans when files were created or deleted', async () => {
    const handle = await makeHandle()
    const effects = { markInternalWrites: () => {}, emitChanged: () => {} }
    const result = {
      value: {
        ...handle.snapshot.notes[0]!,
        body: '',
        content: '',
        revision: 'x'
      },
      changedFiles: [{ path: 'notes/0002. 新篇.md', kind: 'created' as const }]
    }
    const scanSpy = vi.spyOn(handle.workspace, 'scan')
    await applyNoteMutation(handle, result, effects)
    expect(scanSpy).toHaveBeenCalledTimes(1)
  })
})

describe('markInternalWrites', () => {
  it('stores absolute normalized paths so watcher events match', () => {
    const state = {
      internalWriteUntil: new Map<string, number>(),
      internalWriteBaseline: new Map(),
      reconcileTimers: new Map(),
      handles: new Map()
    } as unknown as WorkspaceScanState
    markInternalWrites(state, '/kb/root', [
      { path: 'notes/0001. 第一篇.md', previousPath: 'notes/0000. 旧.md' }
    ])
    const keys = [...state.internalWriteUntil.keys()]
    expect(keys).toContain(path.normalize('/kb/root/notes/0001. 第一篇.md'))
    expect(keys).toContain(path.normalize('/kb/root/notes/0000. 旧.md'))
  })
})
