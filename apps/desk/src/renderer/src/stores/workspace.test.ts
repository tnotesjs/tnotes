// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPendingEdits, registerPendingEdit } from '../editor/markdown/pendingEdits'
import { useEditorStore } from './editor'
import { registerExcalidrawCloseHandler } from './workspace/excalidrawCloseRegistry'
import { useWorkspaceStore } from './workspace'

import type { ClosingResource } from './workspace/closeTabs'
import type {
  AppSettings,
  DeskApi,
  DeskResult,
  KnowledgeBaseDetail,
  NoteDocumentDto,
  NoteMutationDto,
  NoteRenameRequest,
  NoteSaveRequest
} from '../../../shared/contracts'

const autosaveSettings: AppSettings = {
  version: 1,
  theme: 'system',
  density: 'comfortable',
  defaultNoteView: 'visual',
  defaultNotePageWidth: 'standard',
  noteTocDisplay: 'expanded',
  appZoomPercent: 100,
  autosave: { enabled: true, delayMs: 50 },
  createNotePosition: 'top',
  workspaceLayout: 'kb-dir-content',
  prettier: true,
  ide: 'vscode',
  gitPath: null,
  nodePath: null,
  confirmBeforeCommit: false,
  tabs: { maxOpenCount: 10, wrap: true, autoRevealInToc: true },
  toc: {
    showNoteIndex: true,
    showNoteStatus: true,
    changesCollapsedByDefault: true
  },
  imageUpload: {
    defaultTarget: 'local',
    github: {
      repository: '',
      branch: 'main',
      path: '/',
      cdnTemplate: '',
      fileNameFormat: '${YY}-${MM}-${DD}-${HH}-${mm}-${ss}'
    },
    optimize: {
      encoder: 'sharp',
      strength: 'medium',
      maxDimension: null,
      outputFormat: 'keep'
    }
  },
  updates: { autoCheck: true },
  hiddenKnowledgeBases: [],
  knowledgeBases: {}
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const knowledgeBase: KnowledgeBaseDetail = {
  id: 'kb-a',
  configId: 'TNotes.docs',
  name: 'TNotes.docs',
  rootPath: '/tmp/TNotes.docs',
  displayName: 'docs',
  icon: null,
  health: 'ready',
  diagnostics: [],
  noteCount: 1,
  snapshotRevision: 'snapshot-1',
  toc: []
}

function note(content: string, revision: string): NoteDocumentDto {
  return {
    knowledgeBaseId: knowledgeBase.id,
    uuid: 'note-a',
    index: '0001',
    title: 'A',
    dirName: '0001',
    fileName: '0001. A.md',
    relPath: 'notes/0001. A.md',
    filePath: '/tmp/TNotes.docs/notes/0001. A.md',
    content,
    revision,
    config: { done: false },
    readOnly: false
  }
}

function mutation(content: string, revision: string): DeskResult<NoteMutationDto> {
  return {
    ok: true,
    value: {
      note: note(content, revision),
      knowledgeBase: { ...knowledgeBase, snapshotRevision: `snapshot-${revision}` },
      changedFiles: []
    }
  }
}

describe('inline note rename', () => {
  const save = vi.fn()
  const rename = vi.fn()
  const recoveryWrite = vi.fn()
  const key = 'kb-a:note-a'

  function renamed(title = 'Renamed'): DeskResult<NoteMutationDto> {
    return {
      ok: true,
      value: {
        note: { ...note('renamed Markdown', 'v3'), title },
        knowledgeBase,
        changedFiles: []
      }
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    save
      .mockReset()
      .mockImplementation(async (request: NoteSaveRequest) => mutation(request.content, 'v2'))
    rename
      .mockReset()
      .mockImplementation(async (request: NoteRenameRequest) => renamed(request.title))
    recoveryWrite.mockReset().mockResolvedValue({ ok: true, value: undefined })
    Object.defineProperty(window, 'desk', {
      configurable: true,
      value: {
        notes: {
          read: vi.fn(async () => ({ ok: true, value: note('disk note', 'v1') })),
          save,
          rename
        },
        recovery: {
          write: recoveryWrite,
          delete: vi.fn(async () => ({ ok: true, value: undefined }))
        }
      }
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'desk')
  })

  async function setup(): Promise<{
    workspace: ReturnType<typeof useWorkspaceStore>
    editor: ReturnType<typeof useEditorStore>
  }> {
    const workspace = useWorkspaceStore()
    workspace.applySettings({ ...autosaveSettings, autosave: { enabled: false, delayMs: 50 } })
    await workspace.ensureDocument('kb-a', 'note-a')
    const editor = useEditorStore()
    editor.openNote(knowledgeBase, 'note-a', 'A', 'visual', undefined, 'permanent')
    return { workspace, editor }
  }

  it('saves existing drafts, keeps the index immutable and synchronizes note tab titles', async () => {
    const { workspace, editor } = await setup()
    workspace.updateDocumentContent(key, 'unsaved draft')
    await workspace.renameNote('kb-a', 'note-a', '  Renamed  ')
    expect(save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: 'unsaved draft', expectedRevision: 'v1' })
    )
    expect(rename).toHaveBeenCalledExactlyOnceWith({
      knowledgeBaseId: 'kb-a',
      noteUuid: 'note-a',
      title: 'Renamed',
      expectedRevision: 'v2'
    })
    expect(workspace.documents[key]).toMatchObject({
      document: { title: 'Renamed', index: '0001' },
      content: 'renamed Markdown',
      dirty: false
    })
    expect(editor.activeGroup?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'note', title: 'Renamed', dirty: false })
      ])
    )
  })

  it('preserves edits made during rename and resumes autosave using the new revision', async () => {
    const { workspace } = await setup()
    workspace.applySettings(autosaveSettings)
    const result = deferred<DeskResult<NoteMutationDto>>()
    rename.mockReturnValue(result.promise)
    const pending = workspace.renameNote('kb-a', 'note-a', 'Renamed')
    await vi.advanceTimersByTimeAsync(0)
    workspace.updateDocumentContent(key, 'typed during rename', true)
    await vi.advanceTimersByTimeAsync(100)
    expect(save).not.toHaveBeenCalled()
    result.resolve(renamed())
    await pending
    expect(workspace.documents[key]).toMatchObject({
      content: 'typed during rename',
      dirty: true,
      document: { title: 'Renamed', revision: 'v3' }
    })
    expect(recoveryWrite).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Renamed', content: 'typed during rename', revision: 'v3' })
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'typed during rename',
        expectedRevision: 'v3',
        prettier: false
      })
    )
  })

  it('still renames the original note when the user changes knowledge bases during the request', async () => {
    const { workspace } = await setup()
    const result = deferred<DeskResult<NoteMutationDto>>()
    rename.mockReturnValue(result.promise)
    const pending = workspace.renameNote('kb-a', 'note-a', 'Renamed')
    await vi.advanceTimersByTimeAsync(0)
    workspace.selectedKnowledgeBaseId = 'kb-b'
    workspace.knowledgeBase = { ...knowledgeBase, id: 'kb-b' }
    result.resolve(renamed())
    await pending
    expect(workspace.knowledgeBase.id).toBe('kb-b')
    expect(workspace.documents[key].document.title).toBe('Renamed')
  })

  it('does not rename if saving the draft fails', async () => {
    const { workspace } = await setup()
    workspace.updateDocumentContent(key, 'unsaved draft')
    save.mockRejectedValue(new Error('保存失败'))
    await expect(workspace.renameNote('kb-a', 'note-a', 'Renamed')).rejects.toThrow('保存失败')
    expect(rename).not.toHaveBeenCalled()
    expect(workspace.documents[key]).toMatchObject({
      document: { title: 'A' },
      content: 'unsaved draft',
      dirty: true
    })
  })
})

describe('workspace unsaved tab close integration', () => {
  const confirm = vi.fn()
  const save = vi.fn()
  const recoveryWrite = vi.fn(async () => ({ ok: true, value: undefined }))
  const recoveryDelete = vi.fn(async () => ({ ok: true, value: undefined }))
  const key = `${knowledgeBase.id}:note-a`

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    confirm.mockReset().mockResolvedValue({ ok: true, value: 'cancel' })
    save
      .mockReset()
      .mockImplementation(async (request: NoteSaveRequest) => mutation(request.content, 'v2'))
    recoveryWrite.mockClear()
    recoveryDelete.mockClear()
    Object.defineProperty(window, 'desk', {
      configurable: true,
      value: {
        app: { confirmTabClose: confirm },
        notes: { read: vi.fn(async () => ({ ok: true, value: note('disk note', 'v1') })), save },
        recovery: { write: recoveryWrite, delete: recoveryDelete }
      }
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'desk')
  })

  async function openDraft(autosave = true): Promise<{
    workspace: ReturnType<typeof useWorkspaceStore>
    editor: ReturnType<typeof useEditorStore>
    tab: string
  }> {
    const workspace = useWorkspaceStore()
    workspace.applySettings({ ...autosaveSettings, autosave: { enabled: autosave, delayMs: 50 } })
    await workspace.ensureDocument(knowledgeBase.id, 'note-a')
    const editor = useEditorStore()
    const tab = editor.openNote(knowledgeBase, 'note-a', 'A', 'visual', undefined, 'permanent')
    workspace.updateDocumentContent(key, 'unsaved draft')
    return { workspace, editor, tab }
  }

  it('discards the document and pending snapshots without an autosave writing it back', async () => {
    const { workspace, editor, tab } = await openDraft()
    confirm.mockResolvedValue({ ok: true, value: 'discard' })
    expect(await workspace.requestCloseTab(tab)).toBe(true)
    await vi.runAllTimersAsync()
    expect(editor.activeTab).toBeNull()
    expect(workspace.getDocumentSession(knowledgeBase.id, 'note-a')).toMatchObject({
      content: 'disk note',
      dirty: false
    })
    expect(save).not.toHaveBeenCalled()
    expect(recoveryWrite).not.toHaveBeenCalled()
    expect(recoveryDelete).toHaveBeenCalledWith({
      knowledgeBaseId: knowledgeBase.id,
      noteUuid: 'note-a'
    })
    await workspace.ensureDocument(knowledgeBase.id, 'note-a')
    expect(workspace.getDocumentSession(knowledgeBase.id, 'note-a')?.content).toBe('disk note')
  })

  it('pauses autosave while deciding and resumes it after cancel', async () => {
    const { workspace, editor, tab } = await openDraft()
    const decision = deferred<DeskResult<'cancel'>>()
    confirm.mockReturnValue(decision.promise)
    const closing = workspace.requestCloseTab(tab)
    await vi.advanceTimersByTimeAsync(100)
    expect(confirm).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
    decision.resolve({ ok: true, value: 'cancel' })
    expect(await closing).toBe(false)
    expect(editor.activeTab).toMatchObject({ id: tab, dirty: true })
    await vi.advanceTimersByTimeAsync(50)
    expect(save).toHaveBeenCalledOnce()
    expect(editor.activeTab).toMatchObject({ id: tab, dirty: false })
  })

  it('awaits a pending save instead of treating a skipped duplicate save as success', async () => {
    const { workspace, editor, tab } = await openDraft(false)
    const pending = deferred<DeskResult<NoteMutationDto>>()
    save.mockReturnValue(pending.promise)
    const saving = workspace.saveDocument(key)
    const closing = workspace.requestCloseTab(tab)
    await vi.advanceTimersByTimeAsync(0)
    expect(editor.activeTab?.id).toBe(tab)
    expect(confirm).not.toHaveBeenCalled()
    pending.resolve(mutation('unsaved draft', 'v2'))
    await saving
    expect(await closing).toBe(true)
    expect(save).toHaveBeenCalledOnce()
    expect(editor.activeTab).toBeNull()
  })
})

describe('workspace 画布标签关闭集成（E4）', () => {
  const confirm = vi.fn()
  const canvasPath = 'assets/0042-26-09-11-10-20-30.excalidraw'

  beforeEach(() => {
    setActivePinia(createPinia())
    confirm.mockReset().mockResolvedValue({ ok: true, value: 'cancel' })
    Object.defineProperty(window, 'desk', {
      configurable: true,
      value: { app: { confirmTabClose: confirm }, web: { close: vi.fn() } }
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'desk')
  })

  function openCanvas() {
    const workspace = useWorkspaceStore()
    workspace.applySettings(autosaveSettings)
    const editor = useEditorStore()
    const tab = editor.openExcalidraw(knowledgeBase, canvasPath)
    editor.updateExcalidrawTabMeta(tab, { dirty: true })
    return { workspace, editor, tab }
  }

  function canvasResource(options: { fail?: boolean } = {}) {
    let pending = true
    const flush = vi.fn(async () => {
      if (options.fail) throw new Error('磁盘已被外部修改')
      pending = false
    })
    return {
      pending: () => pending,
      flush,
      entry: {
        key: `excalidraw:${canvasPath}`,
        title: canvasPath,
        dirty: () => pending,
        saving: () => false,
        pauseAutosave: () => () => undefined,
        waitForSave: flush,
        save: flush,
        discard: vi.fn(async () => {
          pending = false
        })
      } as ClosingResource
    }
  }

  it('未写完的自动保存先 flush，成功后不再弹保存确认', async () => {
    const { workspace, editor, tab } = openCanvas()
    const resource = canvasResource()
    registerExcalidrawCloseHandler(tab, resource.entry)

    expect(await workspace.requestCloseTab(tab)).toBe(true)
    expect(resource.flush).toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(editor.activeTab).toBeNull()
  })

  it('写入失败时保留标签并给出确认，丢弃后才关闭', async () => {
    const { workspace, editor, tab } = openCanvas()
    const resource = canvasResource({ fail: true })
    registerExcalidrawCloseHandler(tab, resource.entry)

    expect(await workspace.requestCloseTab(tab)).toBe(false)
    expect(confirm).toHaveBeenCalledOnce()
    expect(editor.activeTab).toMatchObject({ id: tab })

    confirm.mockResolvedValue({ ok: true, value: 'discard' })
    expect(await workspace.requestCloseTab(tab)).toBe(true)
    expect(resource.entry.discard).toHaveBeenCalledOnce()
    expect(editor.activeTab).toBeNull()
  })

  it('取消关闭时把恢复自动保存交还给会话', async () => {
    const { workspace, editor, tab } = openCanvas()
    const resource = canvasResource({ fail: true })
    const resume = vi.fn()
    registerExcalidrawCloseHandler(tab, {
      ...resource.entry,
      pauseAutosave: () => resume
    })

    expect(await workspace.requestCloseTab(tab)).toBe(false)
    expect(resume).toHaveBeenCalledOnce()
    expect(editor.activeTab).toMatchObject({ id: tab, dirty: true })
  })
})

describe('workspace app zoom', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useWorkspaceStore().applySettings({ ...autosaveSettings, appZoomPercent: 100 })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'desk')
  })

  it('keeps rapid steps visible and saves them in order despite slow responses', async () => {
    const first = deferred<DeskResult<AppSettings>>()
    const update = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (next: Partial<AppSettings>) => ({
        ok: true,
        value: { ...autosaveSettings, ...next }
      }))
    Object.defineProperty(window, 'desk', { configurable: true, value: { settings: { update } } })
    const workspace = useWorkspaceStore()
    const changes = [
      workspace.adjustAppZoom(1),
      workspace.adjustAppZoom(1),
      workspace.adjustAppZoom(1)
    ]
    expect(workspace.settings?.appZoomPercent).toBe(130)
    first.resolve({ ok: true, value: { ...autosaveSettings, appZoomPercent: 110 } })
    await changes[0]
    expect(workspace.settings?.appZoomPercent).toBe(130)
    await Promise.all(changes)
    expect(update.mock.calls.map(([patch]) => patch)).toEqual([
      { appZoomPercent: 110 },
      { appZoomPercent: 120 },
      { appZoomPercent: 130 }
    ])
    expect(workspace.settings?.appZoomPercent).toBe(130)
  })

  it('clamps steps and ignores nonfinite values', async () => {
    const update = vi.fn(async (next: Partial<AppSettings>) => ({
      ok: true,
      value: { ...autosaveSettings, ...next }
    }))
    Object.defineProperty(window, 'desk', { configurable: true, value: { settings: { update } } })
    const workspace = useWorkspaceStore()
    await workspace.setAppZoom(195)
    await workspace.adjustAppZoom(1)
    expect(workspace.settings?.appZoomPercent).toBe(200)
    await workspace.adjustAppZoom(1)
    await workspace.setAppZoom(55)
    await workspace.adjustAppZoom(-1)
    expect(workspace.settings?.appZoomPercent).toBe(50)
    await workspace.adjustAppZoom(-1)
    await workspace.setAppZoom(NaN)
    await workspace.setAppZoom(Infinity)
    expect(update).toHaveBeenCalledTimes(4)
  })

  it('rolls back a failed save and allows a later retry', async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce({ ok: true, value: { ...autosaveSettings, appZoomPercent: 130 } })
    Object.defineProperty(window, 'desk', { configurable: true, value: { settings: { update } } })
    const workspace = useWorkspaceStore()
    workspace.applySettings({ ...autosaveSettings, appZoomPercent: 120 })
    await expect(workspace.adjustAppZoom(1)).rejects.toThrow('disk unavailable')
    expect(workspace.settings?.appZoomPercent).toBe(120)
    await workspace.adjustAppZoom(1)
    expect(workspace.settings?.appZoomPercent).toBe(130)
  })
})

describe('workspace document saving', () => {
  const saveRequests: NoteSaveRequest[] = []
  const pendingSaves: Array<Deferred<DeskResult<NoteMutationDto>>> = []
  const deleteRecovery = vi.fn(async () => ({ ok: true, value: undefined }) as const)

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    saveRequests.length = 0
    pendingSaves.length = 0
    deleteRecovery.mockClear()

    const desk = {
      notes: {
        read: vi.fn(async () => ({ ok: true, value: note('original', 'revision-1') }) as const),
        save: vi.fn((request: NoteSaveRequest) => {
          saveRequests.push(request)
          const pending = deferred<DeskResult<NoteMutationDto>>()
          pendingSaves.push(pending)
          return pending.promise
        })
      },
      app: {
        confirmTabClose: vi.fn(async () => ({ ok: true, value: 'save' }) as const)
      },
      recovery: { delete: deleteRecovery }
    } as unknown as DeskApi
    Object.defineProperty(window, 'desk', { configurable: true, value: desk })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'desk')
  })

  it('retains edits made during an in-flight save and saves them against the new revision', async () => {
    const workspace = useWorkspaceStore()
    const editor = useEditorStore()
    const key = `${knowledgeBase.id}:note-a`
    await workspace.ensureDocument(knowledgeBase.id, 'note-a')
    editor.openNote(knowledgeBase, 'note-a', 'A', 'visual', undefined, 'permanent')

    workspace.updateDocumentContent(key, 'first edit', true)
    const firstSave = workspace.saveDocument(key)

    expect(saveRequests).toEqual([
      {
        knowledgeBaseId: knowledgeBase.id,
        noteUuid: 'note-a',
        content: 'first edit',
        expectedRevision: 'revision-1',
        prettier: false
      }
    ])

    workspace.updateDocumentContent(key, 'second edit', true)
    pendingSaves[0].resolve(mutation('first edit', 'revision-2'))
    await firstSave

    expect(workspace.getDocumentSession(knowledgeBase.id, 'note-a')).toMatchObject({
      document: { revision: 'revision-2', content: 'first edit' },
      content: 'second edit',
      dirty: true,
      saving: false
    })
    expect(editor.activeTab).toMatchObject({ noteUuid: 'note-a', dirty: true })
    expect(workspace.status).toBe('已保存先前修改，仍有未保存内容')
    expect(deleteRecovery).not.toHaveBeenCalled()

    const secondSave = workspace.saveDocument(key)
    expect(saveRequests[1]).toEqual({
      knowledgeBaseId: knowledgeBase.id,
      noteUuid: 'note-a',
      content: 'second edit',
      expectedRevision: 'revision-2',
      prettier: false
    })

    pendingSaves[1].resolve(mutation('second edit', 'revision-3'))
    await secondSave

    expect(workspace.getDocumentSession(knowledgeBase.id, 'note-a')).toMatchObject({
      document: { revision: 'revision-3', content: 'second edit' },
      content: 'second edit',
      dirty: false,
      saving: false
    })
    expect(editor.activeTab).toMatchObject({ noteUuid: 'note-a', dirty: false })
    expect(workspace.status).toBe('已保存')
    expect(deleteRecovery).toHaveBeenCalledOnce()
    expect(deleteRecovery).toHaveBeenCalledWith({
      knowledgeBaseId: knowledgeBase.id,
      noteUuid: 'note-a'
    })
  })

  it('leaves the configured Core formatter in control for source-mode edits', async () => {
    const workspace = useWorkspaceStore()
    const key = `${knowledgeBase.id}:note-a`
    await workspace.ensureDocument(knowledgeBase.id, 'note-a')

    workspace.updateDocumentContent(key, 'source edit')
    const saving = workspace.saveDocument(key)

    expect(saveRequests[0]).toEqual({
      knowledgeBaseId: knowledgeBase.id,
      noteUuid: 'note-a',
      content: 'source edit',
      expectedRevision: 'revision-1'
    })

    pendingSaves[0].resolve(mutation('source edit', 'revision-2'))
    await saving
  })

  it('退出前把未保存内容交给确认对话框，选「保存」后才允许退出', async () => {
    const workspace = useWorkspaceStore()
    const editor = useEditorStore()
    const key = `${knowledgeBase.id}:note-a`
    await workspace.ensureDocument(knowledgeBase.id, 'note-a')
    editor.openNote(knowledgeBase, 'note-a', 'A', 'visual', undefined, 'permanent')
    workspace.updateDocumentContent(key, '未保存内容', true)

    const confirmTabClose = vi.mocked(window.desk.app.confirmTabClose)
    const quitting = workspace.prepareToQuit()
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve()

    expect(confirmTabClose).toHaveBeenCalledWith(['A'])
    expect(saveRequests[0]).toMatchObject({ content: '未保存内容' })

    pendingSaves[0].resolve(mutation('未保存内容', 'revision-2'))
    await expect(quitting).resolves.toBe(true)
  })

  it('用户在退出确认里取消时不允许退出，也不落盘', async () => {
    const workspace = useWorkspaceStore()
    const editor = useEditorStore()
    const key = `${knowledgeBase.id}:note-a`
    await workspace.ensureDocument(knowledgeBase.id, 'note-a')
    editor.openNote(knowledgeBase, 'note-a', 'A', 'visual', undefined, 'permanent')
    workspace.updateDocumentContent(key, '未保存内容', true)
    vi.mocked(window.desk.app.confirmTabClose).mockResolvedValueOnce({
      ok: true,
      value: 'cancel'
    } as never)

    await expect(workspace.prepareToQuit()).resolves.toBe(false)
    expect(saveRequests).toHaveLength(0)
    expect(workspace.status).toBe('已取消退出：请先处理未保存的更改')
  })

  it('自动保存成功后不再弹「已保存」', async () => {
    const workspace = useWorkspaceStore()
    const key = `${knowledgeBase.id}:note-a`
    workspace.settings = autosaveSettings
    await workspace.ensureDocument(knowledgeBase.id, 'note-a')

    workspace.updateDocumentContent(key, '自动保存内容', true)
    await vi.advanceTimersByTimeAsync(50)
    expect(saveRequests).toHaveLength(1)
    pendingSaves[0].resolve(mutation('自动保存内容', 'revision-2'))
    await vi.runAllTimersAsync()

    expect(workspace.status).toBeNull()
    expect(workspace.getDocumentSession(knowledgeBase.id, 'note-a')?.dirty).toBe(false)
  })

  it('手动保存仍会提示「已保存」', async () => {
    const workspace = useWorkspaceStore()
    const key = `${knowledgeBase.id}:note-a`
    await workspace.ensureDocument(knowledgeBase.id, 'note-a')

    workspace.updateDocumentContent(key, '手动保存内容', true)
    const saving = workspace.saveAllDocuments()
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
    pendingSaves[0].resolve(mutation('手动保存内容', 'revision-2'))
    await saving

    expect(workspace.status).toBe('已保存')
  })

  it('⌘S（保存全部）会先提交块内草稿再落盘', async () => {
    const workspace = useWorkspaceStore()
    const editor = useEditorStore()
    const key = `${knowledgeBase.id}:note-a`
    await workspace.ensureDocument(knowledgeBase.id, 'note-a')
    editor.openNote(knowledgeBase, 'note-a', 'A', 'visual', undefined, 'permanent')

    // 模拟某个 raw 块的 Edit 面板里还有未提交的草稿
    const registration = registerPendingEdit({
      knowledgeBaseId: () => knowledgeBase.id,
      noteUuid: () => 'note-a',
      dirty: () => true,
      flush: () => {
        workspace.updateDocumentContent(key, '块内草稿已提交', true)
        registration.dispose()
      }
    })
    expect(hasPendingEdits(knowledgeBase.id, 'note-a')).toBe(true)

    const saving = workspace.saveAllDocuments()
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve()

    expect(saveRequests[0]).toMatchObject({ content: '块内草稿已提交', noteUuid: 'note-a' })
    expect(hasPendingEdits(knowledgeBase.id, 'note-a')).toBe(false)

    pendingSaves[0].resolve(mutation('块内草稿已提交', 'revision-2'))
    await saving
  })

  it('requeues autosave when a timer fires while an earlier save is still running', async () => {
    const workspace = useWorkspaceStore()
    const key = `${knowledgeBase.id}:note-a`
    workspace.settings = autosaveSettings
    await workspace.ensureDocument(knowledgeBase.id, 'note-a')

    workspace.updateDocumentContent(key, 'first edit', true)
    const firstSave = workspace.saveDocument(key)
    workspace.updateDocumentContent(key, 'second edit', true)

    await vi.advanceTimersByTimeAsync(50)
    expect(saveRequests).toHaveLength(1)

    pendingSaves[0].resolve(mutation('first edit', 'revision-2'))
    await firstSave
    await vi.advanceTimersByTimeAsync(50)

    expect(saveRequests[1]).toMatchObject({
      content: 'second edit',
      expectedRevision: 'revision-2',
      prettier: false
    })

    pendingSaves[1].resolve(mutation('second edit', 'revision-3'))
    await vi.runAllTimersAsync()
  })
})
