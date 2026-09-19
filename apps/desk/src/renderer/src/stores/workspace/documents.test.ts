// @vitest-environment happy-dom

import { ref } from 'vue'

import { describe, expect, it, vi } from 'vitest'

import type { RecoveryRecord } from '../../../../shared/contracts'

import { createDocuments, type DocumentsContext } from './documents'
import type { DocumentSession } from './helpers'

function makeSession(overrides: Partial<DocumentSession> = {}): DocumentSession {
  return {
    document: {
      uuid: 'note-1',
      title: '笔记',
      content: '# 原文\n',
      revision: 'r1',
      knowledgeBaseId: 'kb'
    },
    content: '# 原文\n',
    dirty: false,
    preserveSourceOnSave: false,
    externalConflict: false,
    saving: false,
    unsavedDraft: false,
    ...overrides
  } as unknown as DocumentSession
}

function makeContext(session: DocumentSession = makeSession()) {
  const documents = ref<Record<string, DocumentSession>>({ 'kb:note-1': session })
  const error = ref<string | null>(null)
  const status = ref<string | null>(null)
  const pendingRecoveries = ref<RecoveryRecord[]>([])
  const deleteRecoveryApi = vi.fn(async () => ({ ok: true, value: undefined }) as const)
  Object.defineProperty(window, 'desk', {
    configurable: true,
    value: {
      recovery: { delete: deleteRecoveryApi },
      notes: {
        read: vi.fn(async () => ({ ok: true, value: { content: '# 磁盘内容\n' } }) as const)
      }
    }
  })
  const ctx = {
    editor: { setNoteDirty: vi.fn() },
    documents,
    activeDocumentKey: ref('kb:note-1'),
    settings: ref({ autosave: { enabled: false, delayMs: 1000 } }),
    autosaveTimers: new Map<string, NodeJS.Timeout>(),
    recoveryTimers: new Map<string, NodeJS.Timeout>(),
    error,
    status,
    setDocumentSession: (key: string, next: DocumentSession) => {
      documents.value = { ...documents.value, [key]: next }
    },
    pendingRecoveries,
    applyDetail: vi.fn(),
    deleteRecovery: vi.fn()
  } as unknown as DocumentsContext
  return {
    ctx,
    documents,
    error,
    status,
    pendingRecoveries,
    recoveryDelete: deleteRecoveryApi,
    editor: ctx.editor as { setNoteDirty: ReturnType<typeof vi.fn> }
  }
}

function recoveryRecord(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    version: 1,
    knowledgeBaseId: 'kb',
    noteUuid: 'note-1',
    title: '笔记',
    content: '# 草稿\n',
    revision: 'r1',
    updatedAt: new Date(0).toISOString(),
    ...overrides
  }
}

describe('外部冲突标记', () => {
  it('用户继续输入不会清掉外部冲突标记（需要显式选择载入磁盘/保留编辑）', () => {
    const session = makeSession({ dirty: true, externalConflict: true })
    const { ctx, documents } = makeContext(session)
    const docs = createDocuments(ctx)

    docs.updateDocumentContent('kb:note-1', '# 原文\n\n继续编辑\n', true)

    expect(documents.value['kb:note-1']?.content).toBe('# 原文\n\n继续编辑\n')
    expect(documents.value['kb:note-1']?.externalConflict).toBe(true)
  })

  it('没有冲突时保持无冲突，不会凭空出现横幅', () => {
    const { ctx, documents } = makeContext(makeSession())
    const docs = createDocuments(ctx)

    docs.updateDocumentContent('kb:note-1', '# 原文\n\n编辑\n', true)

    expect(documents.value['kb:note-1']?.externalConflict).toBe(false)
  })
})

describe('恢复快照的 path 记录', () => {
  it('旧版带 path 的记录不会被静默丢弃：给出提示且不删除', async () => {
    const { ctx, error, pendingRecoveries, recoveryDelete } = makeContext()
    const docs = createDocuments(ctx)

    await docs.prepareRecoveries([
      recoveryRecord({ path: 'README.md', title: 'README' }),
      recoveryRecord({ noteUuid: 'note-1' })
    ])

    expect(pendingRecoveries.value).toHaveLength(1)
    expect(pendingRecoveries.value[0]?.noteUuid).toBe('note-1')
    expect(error.value).toMatch(/README/)
    // 不删：用户至少还能在磁盘上找到这份快照
    expect(recoveryDelete).not.toHaveBeenCalledWith({
      knowledgeBaseId: 'kb',
      noteUuid: 'note-1'
    })
  })

  it('磁盘内容与快照一致时清理该条记录', async () => {
    const { ctx, pendingRecoveries, recoveryDelete } = makeContext()
    const docs = createDocuments(ctx)

    await docs.prepareRecoveries([recoveryRecord({ content: '# 磁盘内容\n' })])

    expect(pendingRecoveries.value).toHaveLength(0)
    expect(recoveryDelete).toHaveBeenCalledOnce()
  })
})

describe('未 emit 的草稿状态', () => {
  it('置位时把文档标成「有未保存修改」，关闭标签/窗口就会提示', () => {
    const { ctx, documents, editor } = makeContext()
    const store = createDocuments(ctx)

    store.setDocumentUnsavedDraft('kb:note-1', true)

    expect(documents.value['kb:note-1']?.unsavedDraft).toBe(true)
    // dirty 是关闭守卫（ClosingResource.dirty）看的标志：必须是 true
    expect(documents.value['kb:note-1']?.dirty).toBe(true)
    expect(editor.setNoteDirty).toHaveBeenLastCalledWith('kb', 'note-1', true)
  })

  it('标记清除后，dirty 回到「内容 vs 磁盘」的真实状态', () => {
    const { ctx, documents } = makeContext()
    const store = createDocuments(ctx)
    store.setDocumentUnsavedDraft('kb:note-1', true)

    store.setDocumentUnsavedDraft('kb:note-1', false)

    expect(documents.value['kb:note-1']?.unsavedDraft).toBe(false)
    // 内容仍等于磁盘内容 → 不再算未保存
    expect(documents.value['kb:note-1']?.dirty).toBe(false)
  })

  it('丢弃修改时一并清掉草稿标记', async () => {
    const { ctx, documents } = makeContext(makeSession({ unsavedDraft: true, dirty: true }))
    const store = createDocuments(ctx)

    await store.discardDocumentChanges('kb:note-1')

    expect(documents.value['kb:note-1']?.unsavedDraft).toBe(false)
    expect(documents.value['kb:note-1']?.dirty).toBe(false)
  })
})

describe('外部修改与未保存冲突', () => {
  it('磁盘上被外部改过时保存会检测到冲突：标冲突、保留本地编辑、不改 revision', async () => {
    const session = makeSession({ content: '# 本地编辑\n', dirty: true })
    const { ctx, documents, error } = makeContext(session)
    const notesSave = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'REVISION_CONFLICT',
        message: '磁盘上的笔记已被其他程序修改',
        diagnosticId: 'd1'
      }
    }))
    Object.defineProperty(window, 'desk', {
      configurable: true,
      value: {
        recovery: { delete: vi.fn(async () => ({ ok: true, value: undefined })) },
        notes: {
          read: vi.fn(async () => ({ ok: true, value: { content: '# 磁盘内容\n' } })),
          save: notesSave
        }
      }
    })
    const store = createDocuments(ctx)

    await expect(store.saveDocument('kb:note-1')).rejects.toThrow(/其他程序修改/)
    // 保存用的是**打开时拿到的** revision：外部改动就是靠它被检测出来的
    expect(notesSave).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 'r1', content: '# 本地编辑\n' })
    )
    // 冲突标记供界面弹横幅；本地编辑不能被丢掉（用户还没选保留还是载入磁盘）
    expect(documents.value['kb:note-1']?.externalConflict).toBe(true)
    expect(documents.value['kb:note-1']?.content).toBe('# 本地编辑\n')
    expect(documents.value['kb:note-1']?.dirty).toBe(true)
    expect(String(error.value)).toContain('其他程序修改')
  })

  it('冲突标记不会被后续输入清掉，也不会误判成已保存', async () => {
    const session = makeSession({ content: '# 本地编辑\n', dirty: true, externalConflict: true })
    const { ctx, documents } = makeContext(session)
    Object.defineProperty(window, 'desk', {
      configurable: true,
      value: {
        recovery: { delete: vi.fn(async () => ({ ok: true, value: undefined })) },
        notes: { save: vi.fn(), read: vi.fn() }
      }
    })
    const store = createDocuments(ctx)

    store.updateDocumentContent('kb:note-1', '# 本地编辑\n继续写\n', true)

    expect(documents.value['kb:note-1']?.externalConflict).toBe(true)
    expect(documents.value['kb:note-1']?.dirty).toBe(true)
  })
})

describe('保存入口与受阻草稿（P1-1 回归）', () => {
  it('有未 emit 草稿时拒绝写盘：不保存旧内容，保持 dirty', async () => {
    const session = makeSession({ content: '# 旧内容\n', dirty: true, unsavedDraft: true })
    const { ctx, documents, status } = makeContext(session)
    const notesSave = vi.fn()
    Object.defineProperty(window, 'desk', {
      configurable: true,
      value: {
        recovery: { delete: vi.fn(async () => ({ ok: true, value: undefined })) },
        notes: {
          read: vi.fn(async () => ({ ok: true, value: { content: '# 磁盘内容\n' } })),
          save: notesSave
        }
      }
    })
    const store = createDocuments(ctx)

    await store.saveDocument('kb:note-1')

    // 一个字节都不该写出去：此刻 content 是旧的，写下去等于「保存旧内容」
    expect(notesSave).not.toHaveBeenCalled()
    expect(documents.value['kb:note-1']?.unsavedDraft).toBe(true)
    expect(documents.value['kb:note-1']?.dirty).toBe(true)
    expect(String(status.value)).toContain('编辑器里还有未写回的修改')
  })

  it('保存期间新产生草稿：不清标记，仍算有未保存内容', async () => {
    const session = makeSession({ content: '# 新内容\n', dirty: true })
    const { ctx, documents } = makeContext(session)
    const notesSave = vi.fn(async () => {
      // 保存飞行途中，编辑器报告出现了未写回的草稿
      documents.value = {
        ...documents.value,
        'kb:note-1': { ...documents.value['kb:note-1']!, unsavedDraft: true }
      }
      return {
        ok: true as const,
        value: {
          note: { ...session.document, content: '# 新内容\n', revision: 'r2' },
          knowledgeBase: {}
        }
      }
    })
    Object.defineProperty(window, 'desk', {
      configurable: true,
      value: {
        recovery: { delete: vi.fn(async () => ({ ok: true, value: undefined })) },
        notes: {
          read: vi.fn(async () => ({ ok: true, value: { content: '# 磁盘内容\n' } })),
          save: notesSave
        }
      }
    })
    const store = createDocuments(ctx)

    await store.saveDocument('kb:note-1')

    expect(notesSave).toHaveBeenCalledTimes(1)
    expect(documents.value['kb:note-1']?.unsavedDraft).toBe(true)
    expect(documents.value['kb:note-1']?.dirty).toBe(true)
  })

  it('普通内容同步回到磁盘内容时，仍存在的草稿照样算未保存（P1 回归）', () => {
    // 引用位置 documents.ts:159 附近：updateDocumentContent
    const session = makeSession({ content: '# 原文\n', dirty: true, unsavedDraft: true })
    const { ctx, documents, editor } = makeContext(session)
    const store = createDocuments(ctx)

    // 内容改回与磁盘一致：没有草稿时这里清 dirty 是对的，有草稿就不行
    store.updateDocumentContent('kb:note-1', '# 原文\n')

    expect(documents.value['kb:note-1']?.unsavedDraft).toBe(true)
    expect(documents.value['kb:note-1']?.dirty).toBe(true)
    expect(editor.setNoteDirty).toHaveBeenLastCalledWith('kb', 'note-1', true)
  })

  it('冲突处理「保留编辑内容」：内容与磁盘相同时草稿仍让其保持 dirty（P1 回归）', async () => {
    // 引用位置 documents.ts:509 附近：keepEditorAgainstDisk
    const session = makeSession({ content: '# 原文\n', dirty: true, unsavedDraft: true })
    const { ctx, documents, editor } = makeContext(session)
    Object.defineProperty(window, 'desk', {
      configurable: true,
      value: {
        recovery: { delete: vi.fn(async () => ({ ok: true, value: undefined })) },
        notes: {
          // 磁盘内容与编辑器内容相同（真实 IPC 返回完整文档，这里也带上 id）
          read: vi.fn(async () => ({
            ok: true,
            value: {
              uuid: 'note-1',
              title: '笔记',
              content: '# 原文\n',
              revision: 'r1',
              knowledgeBaseId: 'kb'
            }
          })),
          save: vi.fn()
        }
      }
    })
    const store = createDocuments(ctx)

    await store.keepEditorAgainstDisk()

    expect(documents.value['kb:note-1']?.unsavedDraft).toBe(true)
    expect(documents.value['kb:note-1']?.dirty).toBe(true)
    expect(editor.setNoteDirty).toHaveBeenLastCalledWith('kb', 'note-1', true)
  })
})
