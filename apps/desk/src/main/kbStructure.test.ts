import { describe, expect, it, vi } from 'vitest'

import { runKbStructure, type KbStructureDeps, type StructureNote } from './kbStructure'

import type { KnowledgeBaseDetail } from '../shared/contracts'

const detail = { id: 'kb' } as KnowledgeBaseDetail

function note(index: string, title: string): StructureNote {
  return { uuid: `id-${index}`, index, title, relPath: `notes/${index}. ${title}.md` }
}

function deps(partial: Partial<KbStructureDeps> = {}): KbStructureDeps {
  return {
    createNotes: vi.fn(async () => ({ knowledgeBase: detail, notes: [note('0004', 'new')] })),
    renameNote: vi.fn(async () => ({ knowledgeBase: detail, note: note('0001', '新标题') })),
    deleteNotes: vi.fn(async () => ({ knowledgeBase: detail, notes: [note('0001', '旧')] })),
    moveNote: vi.fn(async () => ({ knowledgeBase: detail })),
    setDone: vi.fn(async () => ({ knowledgeBase: detail, note: note('0001', '旧') })),
    git: vi.fn(async () => ({ knowledgeBase: detail, message: 'ok' })),
    ...partial
  }
}

describe('runKbStructure', () => {
  it('creates from a title list or from a placeholder count', async () => {
    const titled = deps()
    await runKbStructure({ op: 'create', knowledgeBaseId: 'kb', titles: ['甲', ' 乙 '] }, titled)
    expect(titled.createNotes).toHaveBeenCalledWith({ knowledgeBaseId: 'kb', titles: ['甲', '乙'] })

    const counted = deps()
    await runKbStructure({ op: 'create', knowledgeBaseId: 'kb', count: 2 }, counted)
    expect(counted.createNotes).toHaveBeenCalledWith({
      knowledgeBaseId: 'kb',
      title: 'new',
      count: 2
    })
  })

  it('rejects a create that has neither titles nor a count', async () => {
    await expect(runKbStructure({ op: 'create', knowledgeBaseId: 'kb' }, deps())).rejects.toThrow(
      'titles'
    )
  })

  it('renames, deletes, moves, toggles done, and pushes through the same deps', async () => {
    const api = deps()
    await runKbStructure(
      { op: 'rename', knowledgeBaseId: 'kb', note: '0001', title: '新标题' },
      api
    )
    await runKbStructure({ op: 'delete', knowledgeBaseId: 'kb', notes: ['0001'] }, api)
    await runKbStructure(
      { op: 'move', knowledgeBaseId: 'kb', note: '0001', target: '0002', placement: 'after' },
      api
    )
    await runKbStructure({ op: 'set-done', knowledgeBaseId: 'kb', note: '0001', done: true }, api)
    const pushed = await runKbStructure({ op: 'git', knowledgeBaseId: 'kb', action: 'push' }, api)
    expect(api.renameNote).toHaveBeenCalledOnce()
    expect(api.deleteNotes).toHaveBeenCalledOnce()
    expect(api.moveNote).toHaveBeenCalledOnce()
    expect(api.setDone).toHaveBeenCalledOnce()
    expect(api.git).toHaveBeenCalledWith({ knowledgeBaseId: 'kb', action: 'push' })
    expect(pushed.summary).toBe('已推送')
  })
})
