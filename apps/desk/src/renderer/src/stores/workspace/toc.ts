import type { Ref } from 'vue'

import type { useEditorStore } from '../editor'
import { flushPendingEdits, hasPendingEdits } from '../../editor/markdown/pendingEdits'

import type {
  AppSettings,
  DeleteCommitResultDto,
  DeletePreviewDto,
  DeskTocNode,
  KnowledgeBaseDetail,
  NoteCreateRequest
} from '../../../../shared/contracts'

import {
  documentDirty,
  documentKey,
  ipcPlain,
  notePlacement,
  resultValue,
  tocEntry,
  type DocumentSession
} from './helpers'

export interface TocContext {
  editor: ReturnType<typeof useEditorStore>
  knowledgeBase: Ref<KnowledgeBaseDetail | null>
  documents: Ref<Record<string, DocumentSession>>
  settings: Ref<AppSettings | null>
  error: Ref<string | null>
  status: Ref<string | null>
  applyDetail: (detail: KnowledgeBaseDetail) => void
  setDocumentSession: (key: string, session: DocumentSession) => void
  removeDocumentSession: (key: string) => void
  ensureDocument: (knowledgeBaseId: string, noteUuid: string) => Promise<DocumentSession>
  saveDocument: (key: string) => Promise<void>
  pauseDocumentAutosave: (key: string) => () => void
  waitForDocumentSave: (key: string) => Promise<void>
  persistRecovery: (key: string) => Promise<void>
  deleteRecovery: (knowledgeBaseId: string, noteUuid: string) => void
}

export function createToc(ctx: TocContext) {
  async function createNote(
    title: string,
    placement: NoteCreateRequest['placement'] = { type: 'root', placement: 'end' }
  ): Promise<void> {
    if (!ctx.knowledgeBase.value || ctx.knowledgeBase.value.health !== 'ready') return
    const mutation = resultValue(
      await window.desk.notes.create(
        ipcPlain({
          knowledgeBaseId: ctx.knowledgeBase.value.id,
          title,
          placement: notePlacement(placement),
          expectedSnapshotRevision: ctx.knowledgeBase.value.snapshotRevision
        })
      )
    )
    ctx.applyDetail(mutation.knowledgeBase)
    const key = documentKey(mutation.note.knowledgeBaseId, mutation.note.uuid)
    ctx.setDocumentSession(key, {
      document: mutation.note,
      content: mutation.note.content,
      dirty: false,
      unsavedDraft: false,
      preserveSourceOnSave: false,
      externalConflict: false,
      saving: false
    })
    ctx.editor.openNote(
      mutation.knowledgeBase,
      mutation.note.uuid,
      mutation.note.title,
      ctx.settings.value?.defaultNoteView ?? 'visual',
      undefined,
      'permanent'
    )
  }

  async function createTocGroup(title: string): Promise<void> {
    if (!ctx.knowledgeBase.value || ctx.knowledgeBase.value.health !== 'ready') return
    try {
      const detail = resultValue(
        await window.desk.toc.createGroup(
          ipcPlain({
            knowledgeBaseId: ctx.knowledgeBase.value.id,
            title,
            placement: { type: 'root', placement: 'end' },
            expectedSnapshotRevision: ctx.knowledgeBase.value.snapshotRevision
          })
        )
      )
      ctx.applyDetail(detail)
      ctx.status.value = '分组已创建'
    } catch (cause) {
      ctx.error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    }
  }

  async function renameNote(
    knowledgeBaseId: string,
    noteUuid: string,
    title: string
  ): Promise<void> {
    const key = documentKey(knowledgeBaseId, noteUuid)
    const resumeAutosave = ctx.pauseDocumentAutosave(key)
    try {
      const loaded =
        ctx.documents.value[key] ?? (await ctx.ensureDocument(knowledgeBaseId, noteUuid))
      const nextTitle = title.trim()
      if (!nextTitle || nextTitle === loaded.document.title || loaded.document.readOnly) return
      ctx.error.value = null
      flushPendingEdits(knowledgeBaseId, noteUuid)
      await ctx.waitForDocumentSave(key)
      if (ctx.documents.value[key]?.dirty) await ctx.saveDocument(key)
      const beforeRename = ctx.documents.value[key] ?? loaded
      const mutation = resultValue(
        await window.desk.notes.rename({
          knowledgeBaseId,
          noteUuid,
          title: nextTitle,
          expectedRevision: beforeRename.document.revision
        })
      )
      // Rename does not rewrite the note body. Keep in-progress edits if the
      // session went dirty while the request was in flight.
      const current = ctx.documents.value[key] ?? beforeRename
      const content = current.dirty ? current.content : mutation.note.content
      const dirty = documentDirty(content, mutation.note.content, current.unsavedDraft)
      ctx.setDocumentSession(key, {
        document: mutation.note,
        content,
        dirty,
        unsavedDraft: current.unsavedDraft,
        preserveSourceOnSave: dirty && current.preserveSourceOnSave,
        externalConflict: false,
        saving: false
      })
      ctx.applyDetail(mutation.knowledgeBase)
      ctx.editor.renameNote(knowledgeBaseId, noteUuid, mutation.note.title)
      ctx.editor.setNoteDirty(knowledgeBaseId, noteUuid, dirty)
      if (dirty) await ctx.persistRecovery(key)
      else ctx.deleteRecovery(knowledgeBaseId, noteUuid)
      ctx.status.value = '名称已更新'
    } catch (cause) {
      ctx.error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      resumeAutosave()
    }
  }

  async function renameTocNode(node: DeskTocNode, title: string): Promise<void> {
    if (!ctx.knowledgeBase.value || ctx.knowledgeBase.value.health !== 'ready') return
    try {
      if (node.type === 'group') {
        const detail = resultValue(
          await window.desk.toc.renameGroup(
            ipcPlain({
              knowledgeBaseId: ctx.knowledgeBase.value.id,
              folderPath: [...node.folderPath],
              title,
              expectedSnapshotRevision: ctx.knowledgeBase.value.snapshotRevision
            })
          )
        )
        ctx.applyDetail(detail)
      } else {
        await renameNote(ctx.knowledgeBase.value.id, node.uuid, title)
      }
      ctx.status.value = '名称已更新'
    } catch (cause) {
      ctx.error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    }
  }

  async function moveTocNode(
    source: DeskTocNode,
    target: DeskTocNode,
    placement: 'before' | 'after' | 'inside'
  ): Promise<void> {
    if (!ctx.knowledgeBase.value || ctx.knowledgeBase.value.health !== 'ready') return
    if (source.nodeId === target.nodeId) return
    try {
      const detail = resultValue(
        await window.desk.toc.move(
          ipcPlain({
            knowledgeBaseId: ctx.knowledgeBase.value.id,
            source: tocEntry(source),
            target: tocEntry(target),
            placement,
            expectedSnapshotRevision: ctx.knowledgeBase.value.snapshotRevision
          })
        )
      )
      ctx.applyDetail(detail)
      ctx.status.value = '目录顺序已更新'
    } catch (cause) {
      ctx.error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    }
  }

  /**
   * 切换笔记的完成状态。
   *
   * 参数只取真正用到的两件事（`uuid` + 当前状态），而不是整个 TOC 节点：
   * 目录树直接传节点，笔记头部传 `{ uuid, completed }`（它的当前状态来自会话里的
   * `document.config.done`，与 TOC 同源，不必再遍历一遍树找节点）。
   */
  async function toggleDone(note: { uuid: string; completed: boolean }): Promise<void> {
    if (!ctx.knowledgeBase.value || ctx.knowledgeBase.value.health !== 'ready') return
    const key = documentKey(ctx.knowledgeBase.value.id, note.uuid)
    const loaded =
      ctx.documents.value[key] ?? (await ctx.ensureDocument(ctx.knowledgeBase.value.id, note.uuid))
    if (loaded.dirty) await ctx.saveDocument(key)
    const current = ctx.documents.value[key] ?? loaded
    const mutation = resultValue(
      await window.desk.notes.updateConfig({
        knowledgeBaseId: ctx.knowledgeBase.value.id,
        noteUuid: note.uuid,
        expectedRevision: current.document.revision,
        updates: { done: !note.completed }
      })
    )
    ctx.applyDetail(mutation.knowledgeBase)
    ctx.setDocumentSession(key, {
      document: mutation.note,
      content: mutation.note.content,
      dirty: false,
      unsavedDraft: false,
      preserveSourceOnSave: false,
      externalConflict: false,
      saving: false
    })
  }

  async function previewDeleteNode(node: DeskTocNode): Promise<DeletePreviewDto> {
    if (!ctx.knowledgeBase.value) throw new Error('未选择知识库')
    return resultValue(
      await window.desk.toc.previewDelete(
        ctx.knowledgeBase.value.id,
        ipcPlain(
          node.type === 'note'
            ? { type: 'note', noteUuid: node.uuid }
            : { type: 'folder', folderPath: [...node.folderPath] }
        )
      )
    )
  }

  /** 删除前把该范围的当前版本提交一次（用户显式点按钮才发生）。 */
  async function commitDeleteScope(preview: DeletePreviewDto): Promise<DeleteCommitResultDto> {
    // preview 来自 ref，直接传会把 Vue 响应式代理丢给 IPC（structured clone 会失败）
    return resultValue(
      await window.desk.toc.commitBeforeDelete(
        ipcPlain({
          knowledgeBaseId: preview.knowledgeBaseId,
          entry: preview.entry
        })
      )
    )
  }

  async function deleteNode(preview: DeletePreviewDto): Promise<void> {
    // 删除会连同会话与恢复快照一起移除，未保存的编辑再也拿不回来：
    // 先拒绝并说明是哪些笔记，用户保存或撤销后重试。
    const dirtyTitles = preview.notes
      .filter((note) => {
        const key = documentKey(preview.knowledgeBaseId, note.noteUuid)
        const session = ctx.documents.value[key]
        return (
          Boolean(session?.dirty) ||
          Boolean(session?.saving) ||
          hasPendingEdits(preview.knowledgeBaseId, note.noteUuid)
        )
      })
      .map((note) => note.title)
    if (dirtyTitles.length > 0) {
      const message = `「${dirtyTitles.join('」「')}」有未保存的更改，请先保存或撤销后再删除`
      ctx.error.value = message
      throw new Error(message)
    }
    const detail = resultValue(
      await window.desk.toc.delete(
        ipcPlain({
          knowledgeBaseId: preview.knowledgeBaseId,
          entry: preview.entry,
          expectedSnapshotRevision: preview.snapshotRevision
        })
      )
    )
    ctx.applyDetail(detail)
    for (const note of preview.notes) {
      ctx.editor.closeNote(preview.knowledgeBaseId, note.noteUuid)
      ctx.removeDocumentSession(documentKey(preview.knowledgeBaseId, note.noteUuid))
      ctx.deleteRecovery(preview.knowledgeBaseId, note.noteUuid)
    }
  }

  return {
    createNote,
    createTocGroup,
    renameNote,
    renameTocNode,
    moveTocNode,
    toggleDone,
    previewDeleteNode,
    commitDeleteScope,
    deleteNode
  }
}

export type TocApi = ReturnType<typeof createToc>
