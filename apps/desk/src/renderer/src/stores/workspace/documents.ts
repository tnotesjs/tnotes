import { nextTick, type ComputedRef, type Ref } from 'vue'

import type { useEditorStore } from '../editor'

import type {
  AppSettings,
  AttachmentWriteLocalResult,
  ImageUploadResult,
  KnowledgeBaseDetail,
  NoteEditorTab,
  RecoveryRecord,
  WorkspaceOverview
} from '../../../../shared/contracts'

import { flushPendingEdits } from '../../editor/markdown/pendingEdits'
import { documentDirty, documentKey, resultValue, type DocumentSession } from './helpers'
import { createPendingSaves } from './pendingSaves'

interface SaveOptions {
  silent?: boolean
}

export interface DocumentsContext {
  editor: ReturnType<typeof useEditorStore>
  documents: Ref<Record<string, DocumentSession>>
  pendingRecoveries: Ref<RecoveryRecord[]>
  overview: Ref<WorkspaceOverview>
  settings: Ref<AppSettings | null>
  error: Ref<string | null>
  status: Ref<string | null>
  activeDocumentKey: ComputedRef<string | null>
  autosaveTimers: Map<string, ReturnType<typeof setTimeout>>
  recoveryTimers: Map<string, ReturnType<typeof setTimeout>>
  setDocumentSession: (key: string, session: DocumentSession) => void
  removeDocumentSession: (key: string) => void
  applyDetail: (detail: KnowledgeBaseDetail) => void
  selectKnowledgeBase: (knowledgeBaseId: string) => Promise<void>
}

export function createDocuments(ctx: DocumentsContext) {
  // 重叠保存只留最新一次；但只要被合并的请求里有一次是手动（非 silent），
  // 后续那一轮就按手动保存跑（提示「已保存」等），不让较晚的 autosave 把手动意图冲掉
  const pendingSaves = createPendingSaves<SaveOptions>((queued, next) => ({
    ...next,
    silent: Boolean(queued.silent && next.silent)
  }))
  const pausedAutosave = new Set<string>()

  function pauseDocumentAutosave(key: string): () => void {
    pausedAutosave.add(key)
    const timer = ctx.autosaveTimers.get(key)
    if (timer) clearTimeout(timer)
    ctx.autosaveTimers.delete(key)
    return () => {
      pausedAutosave.delete(key)
      if (ctx.documents.value[key]?.dirty && ctx.settings.value?.autosave.enabled) {
        ctx.autosaveTimers.set(
          key,
          setTimeout(() => {
            ctx.autosaveTimers.delete(key)
            void saveDocument(key, { silent: true }).catch(() => undefined)
          }, ctx.settings.value.autosave.delayMs)
        )
      }
    }
  }

  async function discardDocumentChanges(key: string): Promise<void> {
    const session = ctx.documents.value[key]
    if (!session) return
    const document = resultValue(
      await window.desk.notes.read(session.document.knowledgeBaseId, session.document.uuid)
    )
    const timer = ctx.recoveryTimers.get(key)
    if (timer) clearTimeout(timer)
    ctx.recoveryTimers.delete(key)
    resultValue(
      await window.desk.recovery.delete({
        knowledgeBaseId: document.knowledgeBaseId,
        noteUuid: document.uuid
      })
    )
    ctx.setDocumentSession(key, {
      document,
      content: document.content,
      dirty: false,
      saving: false,
      externalConflict: false,
      unsavedDraft: false
    })
    ctx.editor.setNoteDirty(document.knowledgeBaseId, document.uuid, false)
  }

  function deleteRecovery(knowledgeBaseId: string, noteUuid: string): void {
    void window.desk.recovery.delete({ knowledgeBaseId, noteUuid })
  }

  async function persistRecovery(key: string): Promise<void> {
    const session = ctx.documents.value[key]
    if (!session?.dirty) return
    const result = await window.desk.recovery.write({
      knowledgeBaseId: session.document.knowledgeBaseId,
      noteUuid: session.document.uuid,
      title: session.document.title,
      content: session.content,
      revision: session.document.revision
    })
    if (!result.ok) ctx.error.value = `无法保存恢复快照：${result.error.message}`
  }

  async function prepareRecoveries(records: RecoveryRecord[]): Promise<void> {
    // 旧版 Desk 为 README.md 写过恢复快照（带 path）。本版本只能恢复笔记，
    // 直接丢掉会让用户以为「没有草稿」；这里明确提示，并且**不删除**这些记录。
    const unsupported = records.filter((item) => item.path)
    if (unsupported.length > 0) {
      const titles = unsupported.map((item) => item.path ?? item.title).join('、')
      ctx.error.value = `有 ${unsupported.length} 个旧版 README 恢复快照无法在当前版本恢复（已保留）：${titles}`
    }

    const candidates: RecoveryRecord[] = []
    for (const record of records.filter((item) => !item.path)) {
      try {
        const disk = resultValue(
          await window.desk.notes.read(record.knowledgeBaseId, record.noteUuid)
        )
        if (disk.content === record.content) {
          deleteRecovery(record.knowledgeBaseId, record.noteUuid)
        } else {
          candidates.push(record)
        }
      } catch {
        deleteRecovery(record.knowledgeBaseId, record.noteUuid)
      }
    }
    ctx.pendingRecoveries.value = candidates
  }

  async function ensureDocument(
    knowledgeBaseId: string,
    noteUuid: string
  ): Promise<DocumentSession> {
    const key = documentKey(knowledgeBaseId, noteUuid)
    const existing = ctx.documents.value[key]
    if (existing) {
      // Dirty / saving / conflict: keep the in-memory session (user must choose).
      // Clean: re-check disk revision so reopen after a swallowed external write
      // (or a missed watcher event) cannot forever serve a behind-disk cache.
      if (existing.dirty || existing.saving || existing.externalConflict) return existing
      try {
        const next = resultValue(await window.desk.notes.read(knowledgeBaseId, noteUuid))
        if (next.revision === existing.document.revision) return existing
        const session: DocumentSession = {
          document: next,
          content: next.content,
          dirty: false,
          unsavedDraft: false,
          externalConflict: false,
          saving: false
        }
        ctx.setDocumentSession(key, session)
        ctx.editor.setNoteDirty(next.knowledgeBaseId, next.uuid, false)
        return session
      } catch {
        return existing
      }
    }
    const next = resultValue(await window.desk.notes.read(knowledgeBaseId, noteUuid))
    const session: DocumentSession = {
      document: next,
      content: next.content,
      dirty: false,
      unsavedDraft: false,
      externalConflict: false,
      saving: false
    }
    ctx.setDocumentSession(key, session)
    return session
  }

  function updateDocumentContent(key: string, content: string): void {
    const session = ctx.documents.value[key]
    if (!session || session.document.readOnly) return
    // 草稿标记只由编辑器上报（setDocumentUnsavedDraft）翻转：内容同步不动它，
    // 否则「内容刚好回到磁盘内容」会把仍存在的草稿误判成已保存
    const unsavedDraft = session.unsavedDraft
    const dirty = documentDirty(content, session.document.content, unsavedDraft)
    ctx.setDocumentSession(key, {
      ...session,
      content,
      dirty,
      unsavedDraft,
      // 外部冲突标记要保留到用户显式选择「载入磁盘 / 保留编辑」为止：
      // 之前任何一次击键都会清掉它，冲突横幅消失，用户失去选择权
      externalConflict: session.externalConflict
    })
    ctx.editor.setNoteDirty(session.document.knowledgeBaseId, session.document.uuid, dirty)
    const currentTimer = ctx.autosaveTimers.get(key)
    if (currentTimer) clearTimeout(currentTimer)
    ctx.autosaveTimers.delete(key)
    const currentRecoveryTimer = ctx.recoveryTimers.get(key)
    if (currentRecoveryTimer) clearTimeout(currentRecoveryTimer)
    ctx.recoveryTimers.delete(key)
    if (dirty) {
      ctx.recoveryTimers.set(
        key,
        setTimeout(() => {
          ctx.recoveryTimers.delete(key)
          void persistRecovery(key)
        }, 250)
      )
    } else {
      deleteRecovery(session.document.knowledgeBaseId, session.document.uuid)
    }
    if (dirty && !pausedAutosave.has(key) && ctx.settings.value?.autosave.enabled) {
      const timer = setTimeout(() => {
        ctx.autosaveTimers.delete(key)
        void saveDocument(key, { silent: true }).catch(() => undefined)
      }, ctx.settings.value.autosave.delayMs)
      ctx.autosaveTimers.set(key, timer)
    }
  }

  /**
   * 编辑器报告「有尚未 emit 的修改」（保存被拦下）。
   *
   * 这类修改 `content` 里没有，但用户认为「我刚写的东西」：必须
   * ① 让文档显示为有未保存修改（关闭标签/窗口会提示）；
   * ② 不触发 autosave（写盘路径本来就被拦着，硬存会丢内容）。
   */
  function setDocumentUnsavedDraft(key: string, hasDraft: boolean): void {
    const session = ctx.documents.value[key]
    if (!session) return
    if (session.unsavedDraft === hasDraft) return
    // dirty 用与内容同步同一套口径重算：草稿只是额外的一个「未落盘」来源
    const dirty = documentDirty(session.content, session.document.content, hasDraft)
    ctx.setDocumentSession(key, { ...session, unsavedDraft: hasDraft, dirty })
    ctx.editor.setNoteDirty(session.document.knowledgeBaseId, session.document.uuid, dirty)
    if (hasDraft) {
      // 排队中的自动保存会写「旧 content」并把状态清干净 —— 直接取消它
      const pending = ctx.autosaveTimers.get(key)
      if (pending) clearTimeout(pending)
      ctx.autosaveTimers.delete(key)
    }
  }

  function updateEditorContent(content: string): void {
    if (ctx.activeDocumentKey.value) updateDocumentContent(ctx.activeDocumentKey.value, content)
  }

  /**
   * 同 key 保存 coalesce：在途保存不打断；期间的重叠请求只保留最新一次（含 options），
   * 在途结束后再跑一轮 performSaveDocument（不 dirty 时它会直接返回）。
   */
  function saveDocument(key: string, options: SaveOptions = {}): Promise<void> {
    return pendingSaves.run(key, options, (merged) => performSaveDocument(key, merged))
  }

  async function performSaveDocument(key: string, options: SaveOptions = {}): Promise<void> {
    const session = ctx.documents.value[key]
    if (!session || !session.dirty || session.document.readOnly || session.saving) return
    // 编辑器里还有没写回 store 的修改：此刻 content 是**旧内容**。写下去会把用户的
    // 新修改连标记一起抹掉（关闭流程里就是「保存的是旧内容 → 允许关闭」）。
    // 拒绝这次保存并保持 dirty，让关闭流程停在「仍有未保存的更改」。
    if (session.unsavedDraft) {
      if (!options.silent) {
        ctx.status.value = '当前修改尚未保存：编辑器里还有未写回的修改，已取消这次保存'
      }
      return
    }
    const contentToSave = session.content
    ctx.setDocumentSession(key, { ...session, saving: true })
    const recoveryTimer = ctx.recoveryTimers.get(key)
    if (recoveryTimer) clearTimeout(recoveryTimer)
    ctx.recoveryTimers.delete(key)
    ctx.error.value = null
    try {
      const mutation = resultValue(
        await window.desk.notes.save({
          knowledgeBaseId: session.document.knowledgeBaseId,
          noteUuid: session.document.uuid,
          content: contentToSave,
          expectedRevision: session.document.revision
        })
      )
      const current = ctx.documents.value[key]
      // 保存期间又出现了未写回的草稿：也算「变了」，不能按保存成功清状态
      const draftAppeared = Boolean(current?.unsavedDraft)
      const changedWhileSaving = Boolean(
        current && (current.content !== contentToSave || draftAppeared)
      )
      if (changedWhileSaving && current) {
        const stillDirty = documentDirty(current.content, mutation.note.content, draftAppeared)
        ctx.setDocumentSession(key, {
          document: mutation.note,
          content: current.content,
          dirty: stillDirty,
          unsavedDraft: draftAppeared,
          externalConflict: false,
          saving: false
        })
        ctx.editor.setNoteDirty(mutation.note.knowledgeBaseId, mutation.note.uuid, stillDirty)
      } else {
        ctx.setDocumentSession(key, {
          document: mutation.note,
          content: mutation.note.content,
          dirty: false,
          unsavedDraft: false,
          externalConflict: false,
          saving: false
        })
        ctx.editor.setNoteDirty(mutation.note.knowledgeBaseId, mutation.note.uuid, false)
      }
      ctx.applyDetail(mutation.knowledgeBase)
      const remaining = ctx.documents.value[key]
      if (!remaining?.dirty) {
        deleteRecovery(mutation.note.knowledgeBaseId, mutation.note.uuid)
        // 自动保存默认 1s 一次：每次都弹「已保存」会把通知区刷满，只有手动保存才提示
        if (!options.silent) ctx.status.value = '已保存'
      } else {
        if (!options.silent) ctx.status.value = '已保存先前修改，仍有未保存内容'
        // 已有排队中的后续保存：本轮结束后会立即再存一次，不必再挂 autosave
        if (
          !pendingSaves.hasQueued(key) &&
          !pausedAutosave.has(key) &&
          ctx.settings.value?.autosave.enabled &&
          !ctx.autosaveTimers.has(key)
        ) {
          ctx.autosaveTimers.set(
            key,
            setTimeout(() => {
              ctx.autosaveTimers.delete(key)
              void saveDocument(key, { silent: true }).catch(() => undefined)
            }, ctx.settings.value.autosave.delayMs)
          )
        }
      }
    } catch (cause) {
      const current = ctx.documents.value[key] ?? session
      const isConflict = (cause as { code?: string }).code === 'REVISION_CONFLICT'
      ctx.setDocumentSession(key, {
        ...current,
        saving: false,
        externalConflict: current.externalConflict || isConflict
      })
      ctx.error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    }
  }

  async function writeLocalAttachment(
    knowledgeBaseId: string,
    noteUuid: string,
    file: File
  ): Promise<AttachmentWriteLocalResult> {
    const data = new Uint8Array(await file.arrayBuffer())
    return resultValue(
      await window.desk.attachments.writeLocal({
        knowledgeBaseId,
        noteUuid,
        fileName: file.name || `image-${Date.now()}.png`,
        data
      })
    )
  }

  async function uploadImage(
    knowledgeBaseId: string,
    noteUuid: string,
    file: File
  ): Promise<ImageUploadResult> {
    const data = new Uint8Array(await file.arrayBuffer())
    const result = resultValue(
      await window.desk.attachments.uploadImage({
        knowledgeBaseId,
        noteUuid,
        fileName: file.name || `image-${Date.now()}.png`,
        data
      })
    )
    ctx.status.value =
      result.warning ??
      (result.target === 'github' ? '图片已上传到 GitHub 图床' : '图片已保存到本地 assets')
    return result
  }

  async function copyNoteDirectoryPath(
    tab: Pick<NoteEditorTab, 'knowledgeBaseId' | 'noteUuid'>
  ): Promise<void> {
    const result = await window.desk.notes.copyPath(tab.knowledgeBaseId, tab.noteUuid)
    if (!result.ok) {
      ctx.error.value = result.error.message
      return
    }
    ctx.status.value = `已复制路径：${result.value}`
  }

  async function revealNoteInFileManager(
    tab: Pick<NoteEditorTab, 'knowledgeBaseId' | 'noteUuid'>
  ): Promise<void> {
    const result = await window.desk.notes.revealInFileManager(tab.knowledgeBaseId, tab.noteUuid)
    if (!result.ok) ctx.error.value = result.error.message
  }

  /**
   * 块内 Edit 面板里的草稿还不属于文档正文：⌘S 之前必须先 flush 并等一次
   * nextTick，否则落盘 / 提交的是不含该草稿的旧内容。
   */
  async function flushBlockDrafts(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    for (const key of keys) {
      const session = ctx.documents.value[key]
      if (session) flushPendingEdits(session.document.knowledgeBaseId, session.document.uuid)
    }
    await nextTick()
  }

  async function saveCurrentDocument(): Promise<void> {
    const key = ctx.activeDocumentKey.value
    if (!key) return
    await flushBlockDrafts([key])
    await saveDocument(key)
  }

  async function saveAllDocuments(): Promise<void> {
    await flushBlockDrafts(Object.keys(ctx.documents.value))
    for (const [key, session] of Object.entries(ctx.documents.value)) {
      if (session.dirty) await saveDocument(key)
    }
  }

  async function reloadDocument(key: string): Promise<void> {
    const session = ctx.documents.value[key]
    if (!session) return
    const next = resultValue(
      await window.desk.notes.read(session.document.knowledgeBaseId, session.document.uuid)
    )
    ctx.setDocumentSession(key, {
      document: next,
      content: next.content,
      dirty: false,
      unsavedDraft: false,
      externalConflict: false,
      saving: false
    })
    ctx.editor.setNoteDirty(next.knowledgeBaseId, next.uuid, false)
    deleteRecovery(next.knowledgeBaseId, next.uuid)
  }

  async function acceptRecovery(record: RecoveryRecord): Promise<void> {
    const loaded = await ensureDocument(record.knowledgeBaseId, record.noteUuid)
    const key = documentKey(record.knowledgeBaseId, record.noteUuid)
    ctx.setDocumentSession(key, {
      ...loaded,
      content: record.content,
      dirty: record.content !== loaded.document.content,
      unsavedDraft: false,
      externalConflict: false
    })
    ctx.editor.setNoteDirty(
      record.knowledgeBaseId,
      record.noteUuid,
      record.content !== loaded.document.content
    )
    const descriptor = ctx.overview.value.allKnowledgeBases.find(
      (item) => item.id === record.knowledgeBaseId
    )
    if (descriptor) {
      ctx.editor.openNote(
        descriptor,
        record.noteUuid,
        record.title,
        ctx.settings.value?.defaultNoteView ?? 'visual',
        undefined,
        'permanent'
      )
      await ctx.selectKnowledgeBase(record.knowledgeBaseId)
    }
    ctx.pendingRecoveries.value = ctx.pendingRecoveries.value.filter(
      (candidate) =>
        candidate.knowledgeBaseId !== record.knowledgeBaseId ||
        candidate.noteUuid !== record.noteUuid
    )
    await persistRecovery(key)
  }

  function discardRecovery(record: RecoveryRecord): void {
    deleteRecovery(record.knowledgeBaseId, record.noteUuid)
    ctx.pendingRecoveries.value = ctx.pendingRecoveries.value.filter(
      (candidate) =>
        candidate.knowledgeBaseId !== record.knowledgeBaseId ||
        candidate.noteUuid !== record.noteUuid
    )
  }

  async function reloadCurrentDocument(): Promise<void> {
    if (ctx.activeDocumentKey.value) await reloadDocument(ctx.activeDocumentKey.value)
  }

  async function keepEditorAgainstDisk(): Promise<void> {
    const key = ctx.activeDocumentKey.value
    if (!key) return
    const session = ctx.documents.value[key]
    if (!session) return
    const next = resultValue(
      await window.desk.notes.read(session.document.knowledgeBaseId, session.document.uuid)
    )
    ctx.setDocumentSession(key, {
      document: next,
      content: session.content,
      // 草稿还在就算未保存（口径见 helpers.documentDirty）——
      // 否则「保留编辑内容」点下去会把关闭保护一起关掉
      dirty: documentDirty(session.content, next.content, session.unsavedDraft),
      unsavedDraft: session.unsavedDraft,
      externalConflict: false,
      saving: false
    })
    ctx.editor.setNoteDirty(
      next.knowledgeBaseId,
      next.uuid,
      documentDirty(session.content, next.content, session.unsavedDraft)
    )
  }

  function getDocumentSession(knowledgeBaseId: string, noteUuid: string): DocumentSession | null {
    return ctx.documents.value[documentKey(knowledgeBaseId, noteUuid)] ?? null
  }

  return {
    deleteRecovery,
    persistRecovery,
    prepareRecoveries,
    ensureDocument,
    updateDocumentContent,
    updateEditorContent,
    setDocumentUnsavedDraft,
    saveDocument,
    pauseDocumentAutosave,
    discardDocumentChanges,
    waitForDocumentSave: pendingSaves.wait,
    writeLocalAttachment,
    uploadImage,
    copyNoteDirectoryPath,
    revealNoteInFileManager,
    saveCurrentDocument,
    saveAllDocuments,
    reloadDocument,
    acceptRecovery,
    discardRecovery,
    reloadCurrentDocument,
    keepEditorAgainstDisk,
    getDocumentSession
  }
}

export type DocumentsApi = ReturnType<typeof createDocuments>
