import { clipboard, shell } from 'electron'
import { z } from 'zod'

import { gitManager } from '../gitManager'
import { commitDeleteScope } from '../workspace/deleteScope'
import { imageBedManager } from '../imageBed'
import { maybeOptimizeUploadRequest } from '../imageUploadOptimize'
import { workspaceManager } from '../workspaceManager'
import { IPC_CHANNELS } from '../../shared/contracts'
import {
  attachmentWriteLocalSchema,
  deleteTargetSchema,
  noteCreateManySchema,
  noteCreateSchema,
  noteReindexSchema,
  noteRenameSchema,
  noteSaveSchema,
  noteUpdateConfigSchema,
  tocCreateGroupSchema,
  tocDeleteSchema,
  tocMoveSchema,
  tocRenameGroupSchema
} from './schemas'
import { handle, type GetWindow } from './shared'

/**
 * 给删除预览补上 Git 后果信息；Git 状态没就绪时用 `gitReady: false` 明确表示
 * 「读不到」，而不是谎称「都已提交」。
 */
function withDeleteGitInfo(knowledgeBaseId: string, preview: DeletePreviewDto): DeletePreviewDto {
  const targets = [...preview.filePaths, ...preview.directoryPaths]
  return {
    ...preview,
    untrackedFilePaths: gitManager.untrackedFilesInside(knowledgeBaseId, targets),
    uncommittedFilePaths: gitManager.uncommittedFilesInside(knowledgeBaseId, targets),
    gitReady: gitManager.isReady(knowledgeBaseId)
  }
}

import type {
  AttachmentWriteLocalRequest,
  DeletePreviewDto,
  DeleteTargetDto,
  ImageUploadRequest,
  NoteCreateManyRequest,
  NoteCreateRequest,
  NoteReindexRequest,
  NoteRenameRequest,
  NoteSaveRequest,
  NoteUpdateConfigRequest,
  TocCreateGroupRequest,
  TocDeleteRequest,
  TocMoveRequest,
  TocRenameGroupRequest
} from '../../shared/contracts'

export function registerNotes(getWindow: GetWindow): void {
  handle(
    IPC_CHANNELS.noteRead,
    getWindow,
    z.object({
      knowledgeBaseId: z.string().min(1),
      noteUuid: z.string().min(1)
    }),
    ({ knowledgeBaseId, noteUuid }) => workspaceManager.readNote(knowledgeBaseId, noteUuid)
  )
  handle(
    IPC_CHANNELS.noteResolveTable,
    getWindow,
    z.object({
      knowledgeBaseId: z.string().min(1),
      ids: z.array(z.string())
    }),
    ({ knowledgeBaseId, ids }) => workspaceManager.resolveNotesTable(knowledgeBaseId, ids)
  )
  handle(IPC_CHANNELS.noteSave, getWindow, noteSaveSchema, (input) =>
    workspaceManager.saveNote(input as NoteSaveRequest)
  )
  handle(IPC_CHANNELS.noteCreate, getWindow, noteCreateSchema, (input) =>
    workspaceManager.createNote(input as NoteCreateRequest)
  )
  handle(IPC_CHANNELS.noteCreateMany, getWindow, noteCreateManySchema, (input) =>
    workspaceManager.createNotes(input as NoteCreateManyRequest)
  )
  handle(IPC_CHANNELS.noteRename, getWindow, noteRenameSchema, (input) =>
    workspaceManager.renameNote(input as NoteRenameRequest)
  )
  handle(IPC_CHANNELS.noteReindex, getWindow, noteReindexSchema, (input) =>
    workspaceManager.reindexNote(input as NoteReindexRequest)
  )
  handle(IPC_CHANNELS.noteUpdateConfig, getWindow, noteUpdateConfigSchema, (input) =>
    workspaceManager.updateNoteConfig(input as NoteUpdateConfigRequest)
  )
  handle(
    IPC_CHANNELS.noteCopyPath,
    getWindow,
    z.object({ knowledgeBaseId: z.string().min(1), noteUuid: z.string().min(1) }),
    ({ knowledgeBaseId, noteUuid }) => {
      const filePath = workspaceManager.getNoteLocation(knowledgeBaseId, noteUuid)
      clipboard.writeText(filePath)
      return filePath
    }
  )
  handle(
    IPC_CHANNELS.noteRevealInFileManager,
    getWindow,
    z.object({ knowledgeBaseId: z.string().min(1), noteUuid: z.string().min(1) }),
    async ({ knowledgeBaseId, noteUuid }) => {
      const note = await workspaceManager.readNote(knowledgeBaseId, noteUuid)
      shell.showItemInFolder(note.filePath)
    }
  )
  // Same optimize defaults as paste/target upload: this channel is a parallel
  // local-assets entry point, so it must not write an uncompressed original.
  handle(IPC_CHANNELS.attachmentWriteLocal, getWindow, attachmentWriteLocalSchema, async (input) =>
    workspaceManager.writeLocalAttachment(
      await maybeOptimizeUploadRequest(input as AttachmentWriteLocalRequest)
    )
  )
  handle(IPC_CHANNELS.attachmentUploadImage, getWindow, attachmentWriteLocalSchema, (input) =>
    imageBedManager.upload(input as ImageUploadRequest)
  )

  handle(IPC_CHANNELS.tocMove, getWindow, tocMoveSchema, (input) =>
    workspaceManager.moveToc(input as TocMoveRequest)
  )
  handle(IPC_CHANNELS.tocCreateGroup, getWindow, tocCreateGroupSchema, (input) =>
    workspaceManager.createTocGroup(input as TocCreateGroupRequest)
  )
  handle(IPC_CHANNELS.tocRenameGroup, getWindow, tocRenameGroupSchema, (input) =>
    workspaceManager.renameTocGroup(input as TocRenameGroupRequest)
  )
  handle(
    IPC_CHANNELS.tocPreviewDelete,
    getWindow,
    z.object({
      knowledgeBaseId: z.string().min(1),
      entry: deleteTargetSchema
    }),
    async ({ knowledgeBaseId, entry }) =>
      await withDeleteGitInfo(
        knowledgeBaseId,
        await workspaceManager.previewDelete(knowledgeBaseId, entry as DeleteTargetDto)
      )
  )
  handle(
    IPC_CHANNELS.tocCommitBeforeDelete,
    getWindow,
    z.object({
      knowledgeBaseId: z.string().min(1),
      entry: deleteTargetSchema
    }),
    async ({ knowledgeBaseId, entry }) => {
      const preview = await withDeleteGitInfo(
        knowledgeBaseId,
        await workspaceManager.previewDelete(knowledgeBaseId, entry as DeleteTargetDto)
      )
      return await commitDeleteScope({
        knowledgeBaseId,
        rootPath: workspaceManager.getHandle(knowledgeBaseId).rootPath,
        preview,
        untrackedFilePaths: preview.untrackedFilePaths,
        uncommittedFilePaths: preview.uncommittedFilePaths
      })
    }
  )
  handle(IPC_CHANNELS.tocDelete, getWindow, tocDeleteSchema, (input) =>
    workspaceManager.deleteToc(input as TocDeleteRequest)
  )
}
