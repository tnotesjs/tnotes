// @vitest-environment happy-dom

import { ref } from 'vue'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createToc, type TocContext } from './toc'
import type { DocumentSession } from './helpers'

const preview = {
  knowledgeBaseId: 'kb-a',
  entry: { type: 'note', noteUuid: 'note-1' } as const,
  notes: [{ noteUuid: 'note-1', index: '0001', title: '第一篇', directoryPath: '/kb/0001' }],
  filePaths: ['/kb/0001'],
  directoryPaths: [],
  untrackedFilePaths: [],
  snapshotRevision: 'rev-1'
}

function session(overrides: Partial<DocumentSession> = {}): DocumentSession {
  return {
    document: { uuid: 'note-1', title: '第一篇', content: '# 第一篇\n', revision: 'r1' },
    content: '# 第一篇\n',
    dirty: false,
    externalConflict: false,
    saving: false,
    ...overrides
  } as unknown as DocumentSession
}

function setupDesk() {
  const remove = vi.fn(async () => ({
    ok: true,
    value: { id: 'kb-a', name: 'kb-a', toc: [] }
  }))
  Object.defineProperty(window, 'desk', {
    configurable: true,
    value: { toc: { delete: remove } }
  })
  return { remove }
}

function makeContext(documents: Record<string, DocumentSession>): {
  ctx: TocContext
  closeNote: ReturnType<typeof vi.fn>
  removeDocumentSession: ReturnType<typeof vi.fn>
  deleteRecovery: ReturnType<typeof vi.fn>
  error: ReturnType<typeof ref<string | null>>
} {
  const closeNote = vi.fn()
  const removeDocumentSession = vi.fn()
  const deleteRecovery = vi.fn()
  const error = ref<string | null>(null)
  const ctx = {
    editor: { closeNote },
    knowledgeBase: ref(null),
    documents: ref(documents),
    settings: ref(null),
    error,
    status: ref(null),
    applyDetail: vi.fn(),
    setDocumentSession: vi.fn(),
    removeDocumentSession,
    ensureDocument: vi.fn(),
    saveDocument: vi.fn(),
    pauseDocumentAutosave: vi.fn(),
    waitForDocumentSave: vi.fn(),
    persistRecovery: vi.fn(),
    deleteRecovery
  } as unknown as TocContext
  return { ctx, closeNote, removeDocumentSession, deleteRecovery, error }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'desk')
})

describe('删除笔记前的未保存编辑保护', () => {
  it('目标笔记有未保存更改时拒绝删除，并说明是哪一篇', async () => {
    const { remove } = setupDesk()
    const { ctx, error, removeDocumentSession } = makeContext({
      'kb-a:note-1': session({ dirty: true })
    })
    const toc = createToc(ctx)

    await expect(toc.deleteNode(preview)).rejects.toThrow(/第一篇.*未保存/)
    expect(remove).not.toHaveBeenCalled()
    expect(removeDocumentSession).not.toHaveBeenCalled()
    expect(error.value).toMatch(/未保存/)
  })

  it('保存进行中同样拒绝，避免删掉正在写盘的会话', async () => {
    const { remove } = setupDesk()
    const { ctx } = makeContext({ 'kb-a:note-1': session({ saving: true }) })
    const toc = createToc(ctx)

    await expect(toc.deleteNode(preview)).rejects.toThrow(/未保存/)
    expect(remove).not.toHaveBeenCalled()
  })

  it('没有未保存更改时照常删除并清理会话与恢复快照', async () => {
    const { remove } = setupDesk()
    const { ctx, removeDocumentSession, deleteRecovery } = makeContext({
      'kb-a:note-1': session()
    })
    const toc = createToc(ctx)

    await toc.deleteNode(preview)
    expect(remove).toHaveBeenCalledOnce()
    expect(removeDocumentSession).toHaveBeenCalledWith('kb-a:note-1')
    expect(deleteRecovery).toHaveBeenCalledWith('kb-a', 'note-1')
  })
})
