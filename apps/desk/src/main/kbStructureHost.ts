import type { NoteMeta } from '@tnotesjs/kb'

import { gitManager } from './gitManager'
import { runKbStructure, type StructureNote } from './kbStructure'
import { workspaceManager } from './workspaceManager'

import type { KbStructureRequest, KbStructureResult } from '../shared/contracts'

function noteRef(meta: NoteMeta): StructureNote {
  return {
    uuid: meta.frontmatter.id ?? meta.index,
    index: meta.index,
    title: meta.title,
    relPath: meta.relPath
  }
}

function findNote(knowledgeBaseId: string, raw: string): StructureNote {
  const needle = raw.trim()
  const padded = /^\d{1,4}$/.test(needle) ? needle.padStart(4, '0') : ''
  const notes = workspaceManager.getHandle(knowledgeBaseId).snapshot.notes
  const byIdentity = notes.find(
    (note) => note.frontmatter.id === needle || note.index === needle || note.index === padded
  )
  if (byIdentity) return noteRef(byIdentity)
  const byTitle = notes.filter((note) => note.title === needle)
  if (byTitle.length === 1) return noteRef(byTitle[0]!)
  if (byTitle.length > 1) throw new Error(`有多篇笔记叫「${needle}」，请改用编号`)
  throw new Error(`笔记不存在: ${needle}`)
}

export function performKbStructure(request: KbStructureRequest): Promise<KbStructureResult> {
  return runKbStructure(request, {
    async createNotes(input) {
      const created = await workspaceManager.createNotes({
        knowledgeBaseId: input.knowledgeBaseId,
        titles: input.titles,
        title: input.title,
        count: input.count,
        placement: { type: 'root', placement: 'end' }
      })
      return {
        knowledgeBase: created.knowledgeBase,
        notes: created.notes.map((note) => ({
          uuid: note.uuid,
          index: note.index,
          title: note.title,
          relPath: note.relPath
        }))
      }
    },
    async renameNote(input) {
      const current = findNote(input.knowledgeBaseId, input.note)
      const doc = await workspaceManager.readNote(input.knowledgeBaseId, current.uuid)
      const renamed = await workspaceManager.renameNote({
        knowledgeBaseId: input.knowledgeBaseId,
        noteUuid: current.uuid,
        title: input.title,
        expectedRevision: doc.revision
      })
      return {
        knowledgeBase: renamed.knowledgeBase,
        note: {
          uuid: renamed.note.uuid,
          index: renamed.note.index,
          title: renamed.note.title,
          relPath: renamed.note.relPath
        }
      }
    },
    async deleteNotes(input) {
      const notes = input.notes.map((note) => findNote(input.knowledgeBaseId, note))
      const revision = workspaceManager.getHandle(input.knowledgeBaseId).snapshot.revision
      const knowledgeBase = await workspaceManager.deleteToc({
        knowledgeBaseId: input.knowledgeBaseId,
        entry: { type: 'notes', noteUuids: notes.map((note) => note.uuid) },
        expectedSnapshotRevision: revision
      })
      return { knowledgeBase, notes }
    },
    async moveNote(input) {
      const source = findNote(input.knowledgeBaseId, input.note)
      const target = input.folderPath?.length
        ? { type: 'folder' as const, folderPath: input.folderPath }
        : {
            type: 'note' as const,
            noteUuid: findNote(input.knowledgeBaseId, input.target ?? '').uuid
          }
      const revision = workspaceManager.getHandle(input.knowledgeBaseId).snapshot.revision
      const knowledgeBase = await workspaceManager.moveToc({
        knowledgeBaseId: input.knowledgeBaseId,
        source: { type: 'note', noteUuid: source.uuid },
        target,
        placement: input.placement,
        expectedSnapshotRevision: revision
      })
      return { knowledgeBase }
    },
    async setDone(input) {
      const current = findNote(input.knowledgeBaseId, input.note)
      const doc = await workspaceManager.readNote(input.knowledgeBaseId, current.uuid)
      const updated = await workspaceManager.updateNoteConfig({
        knowledgeBaseId: input.knowledgeBaseId,
        noteUuid: current.uuid,
        expectedRevision: doc.revision,
        updates: { done: input.done }
      })
      return {
        knowledgeBase: updated.knowledgeBase,
        note: {
          uuid: updated.note.uuid,
          index: updated.note.index,
          title: updated.note.title,
          relPath: updated.note.relPath
        }
      }
    },
    async git(input) {
      const result =
        input.action === 'pull'
          ? await gitManager.pull(input.knowledgeBaseId)
          : await gitManager.publish(input.knowledgeBaseId)
      if (result.conflict) throw new Error(result.message || 'Git 没有完成')
      return {
        knowledgeBase: workspaceManager.getDetail(input.knowledgeBaseId),
        message: result.message
      }
    }
  })
}
