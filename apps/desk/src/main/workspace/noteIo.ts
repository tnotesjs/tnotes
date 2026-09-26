import path from 'node:path'
import fs from 'node:fs/promises'
import prettier from 'prettier'

import {
  KbError,
  parseNoteContent,
  serializeNoteContent,
  type ChangedFile,
  type NoteFrontmatter,
  type Placement
} from '@tnotesjs/kb'
import { formatImageFileName, LOCAL_PASTED_ASSET_NAME_FORMAT } from '../imageBed'
import { loadSettings } from '../settings'

import type {
  AttachmentWriteLocalRequest,
  AttachmentWriteLocalResult,
  NoteCreateManyRequest,
  NoteCreateManyResult,
  NoteCreateRequest,
  NoteDocumentDto,
  NoteMutationDto,
  NoteReindexRequest,
  NoteRenameRequest,
  NoteSaveRequest,
  NoteUpdateConfigRequest
} from '../../shared/contracts'

import { toDetail, toNoteDocument } from './dto'
import { applyNoteMutation, type MutationSideEffects } from './mutations'
import type { KnowledgeBaseHandle } from './types'

export type { MutationSideEffects as NoteMutationSideEffects }

/** Renderer-facing identity is the frontmatter uuid; resolve to the kb index. */
export function resolveNoteIndex(handle: KnowledgeBaseHandle, noteUuid: string): string {
  const note = handle.snapshot.notes.find(
    (item) => item.frontmatter.id === noteUuid || item.index === noteUuid
  )
  if (!note) throw new KbError('NOTE_NOT_FOUND', `笔记不存在: ${noteUuid}`, { noteUuid })
  return note.index
}

function toKbPlacement(
  handle: KnowledgeBaseHandle,
  placement: NoteCreateRequest['placement']
): Placement | undefined {
  if (!placement || placement.type === 'root') return placement
  if (placement.type === 'note') {
    return {
      type: 'note',
      targetIndex: resolveNoteIndex(handle, placement.targetNoteUuid),
      placement: placement.placement
    }
  }
  return { type: 'group', groupPath: placement.folderPath, placement: placement.placement }
}

export async function readNote(
  handle: KnowledgeBaseHandle,
  noteUuid: string
): Promise<NoteDocumentDto> {
  return toNoteDocument(
    handle,
    await handle.workspace.notes.read(resolveNoteIndex(handle, noteUuid))
  )
}

export function resolveNotesTable(
  handle: KnowledgeBaseHandle,
  ids: string[]
): {
  notes: Array<{
    id: string
    title: string
    description: string
    noteUuid: string | null
  }>
  missingIds: string[]
} {
  const byIndex = new Map(handle.snapshot.notes.map((note) => [note.index, note]))
  const missingIds: string[] = []
  const notes: Array<{
    id: string
    title: string
    description: string
    noteUuid: string | null
  }> = []

  for (const id of ids) {
    const note = byIndex.get(id)
    if (!note) {
      missingIds.push(id)
      continue
    }
    notes.push({
      id,
      title: note.title,
      description: note.frontmatter.description ?? '',
      noteUuid: note.frontmatter.id ?? note.index
    })
  }

  return { notes, missingIds }
}

/** Keep only whitelist keys; pin id from the snapshot so a lost atom cannot drop giscus mapping. */
function normalizeWhitelistedFrontmatter(content: string, existing?: NoteFrontmatter): string {
  const { frontmatter, body } = parseNoteContent(content)
  return serializeNoteContent(
    {
      id: existing?.id ?? frontmatter.id,
      description: frontmatter.description ?? existing?.description
    },
    body
  )
}

export async function saveNote(
  handle: KnowledgeBaseHandle,
  request: NoteSaveRequest,
  effects: MutationSideEffects
): Promise<NoteMutationDto> {
  const settings = loadSettings()
  // 生效链：单次请求 > 库级约定（tnotes.json）> desk 全局默认
  const usePrettier = request.prettier ?? handle.snapshot.config.prettier ?? settings.prettier
  let content = request.content
  if (usePrettier) {
    try {
      content = await prettier.format(request.content, { parser: 'markdown' })
    } catch {
      // 格式失败不阻塞保存（原文落盘）。
      content = request.content
    }
  }
  const index = resolveNoteIndex(handle, request.noteUuid)
  const existing = handle.snapshot.notes.find((note) => note.index === index)?.frontmatter
  content = normalizeWhitelistedFrontmatter(content, existing)
  const result = await handle.workspace.notes.save({
    index,
    content,
    expectedRevision: request.expectedRevision
  })
  return applyNoteMutation(handle, result, effects)
}

export async function createNote(
  handle: KnowledgeBaseHandle,
  request: NoteCreateRequest,
  effects: MutationSideEffects
): Promise<NoteMutationDto> {
  const result = await handle.workspace.notes.create({
    title: request.title,
    placement: toKbPlacement(handle, request.placement)
  })
  return applyNoteMutation(handle, result, effects)
}

export async function createNotes(
  handle: KnowledgeBaseHandle,
  request: NoteCreateManyRequest,
  effects: MutationSideEffects
): Promise<NoteCreateManyResult> {
  const result = await handle.workspace.notes.createMany({
    title: request.title,
    count: request.count,
    placement: toKbPlacement(handle, request.placement)
  })
  effects.markInternalWrites(handle.rootPath, result.changedFiles)
  handle.snapshot = await handle.workspace.scan()
  effects.emitChanged()
  const note = result.value[0]
  if (!note) throw new Error('没有新建笔记')
  return {
    note: toNoteDocument(handle, note),
    createdCount: result.value.length,
    knowledgeBase: toDetail(handle),
    changedFiles: result.changedFiles
  }
}

export async function renameNote(
  handle: KnowledgeBaseHandle,
  request: NoteRenameRequest,
  effects: MutationSideEffects
): Promise<NoteMutationDto> {
  const result = await handle.workspace.notes.rename({
    index: resolveNoteIndex(handle, request.noteUuid),
    title: request.title
  })
  return applyNoteMutation(handle, result, effects)
}

export async function reindexNote(
  handle: KnowledgeBaseHandle,
  request: NoteReindexRequest,
  effects: MutationSideEffects
): Promise<NoteMutationDto> {
  const result = await handle.workspace.notes.reindex({
    index: resolveNoteIndex(handle, request.noteUuid),
    nextIndex: request.index
  })
  return applyNoteMutation(handle, result, effects)
}

export async function updateNoteConfig(
  handle: KnowledgeBaseHandle,
  request: NoteUpdateConfigRequest,
  effects: MutationSideEffects
): Promise<NoteMutationDto> {
  const index = resolveNoteIndex(handle, request.noteUuid)
  const { done, ...frontmatterUpdates } = request.updates
  let tocChangedFiles: ChangedFile[] = []

  // done 归 TOC 复选框所有；description 归 frontmatter。
  if (typeof done === 'boolean') {
    const doneResult = await handle.workspace.toc.setDone({ index, done })
    tocChangedFiles = doneResult.changedFiles
    // TOC 也是我们写的：标记内部写入，否则 watcher 会报外部修改
    effects.markInternalWrites(handle.rootPath, tocChangedFiles)
  }
  const result = await handle.workspace.notes.setFrontmatter({
    index,
    updates: frontmatterUpdates,
    expectedRevision: request.expectedRevision
  })
  if (typeof done === 'boolean') {
    // done 存在 TOC / NoteMeta 上，只打 frontmatter 补丁会让返回的快照仍是旧完成态。
    effects.markInternalWrites(handle.rootPath, result.changedFiles)
    handle.snapshot = await handle.workspace.scan()
    effects.emitChanged()
    return {
      note: toNoteDocument(handle, result.value),
      knowledgeBase: toDetail(handle),
      changedFiles: [...tocChangedFiles, ...result.changedFiles]
    }
  }
  return applyNoteMutation(handle, result, effects)
}

export async function writeLocalAttachment(
  handle: KnowledgeBaseHandle,
  request: AttachmentWriteLocalRequest,
  effects: MutationSideEffects
): Promise<AttachmentWriteLocalResult> {
  const noteIndex = resolveNoteIndex(handle, request.noteUuid)
  const fileName = formatImageFileName(
    LOCAL_PASTED_ASSET_NAME_FORMAT,
    request.fileName,
    new Date(),
    0,
    { index: noteIndex }
  )
  const result = await handle.workspace.assets.add({
    fileName,
    data: request.data
  })
  const absolutePath = path.join(handle.rootPath, result.relPath)
  if (!result.reused) {
    effects.markInternalWrites(handle.rootPath, [{ path: result.relPath }])
  }
  handle.snapshot = await handle.workspace.scan()
  effects.emitChanged()
  return { absolutePath, markdownPath: result.markdownPath, reused: result.reused }
}

const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp'
])

/**
 * Resolve an editor image reference to an absolute path. New-architecture
 * references are kb-level (`../assets/x.png`); resolution is confined to the
 * kb root.
 */
export async function resolveNoteAsset(
  handle: KnowledgeBaseHandle,
  requestedPath: string
): Promise<string> {
  const normalized = requestedPath.replaceAll('\\', '/')
  const match = normalized.match(/^(?:\.\.\/|\.\/)?(assets\/.+)$/)
  if (!match) throw new Error('不支持的资源路径')
  const root = path.resolve(handle.rootPath)
  // 先归一化再校验：`assets/../cover.png` 用 path.resolve 会落到库根下，
  // 只比 startsWith(root) 是拦不住的
  const relWithinAssets = path.normalize(match[1]).replaceAll('\\', '/')
  if (!relWithinAssets.startsWith('assets/')) throw new Error('资源路径越界')
  const absolutePath = path.resolve(root, relWithinAssets)
  if (!absolutePath.startsWith(root + path.sep)) {
    throw new Error('资源路径越界')
  }
  const extension = path.extname(absolutePath).toLocaleLowerCase()
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error('不支持的图片类型')
  const stat = await fs.stat(absolutePath)
  if (!stat.isFile()) throw new Error('图片不存在')
  // 符号链接可以指向库外：按真实路径再确认一次
  const realRoot = await fs.realpath(root)
  const realTarget = await fs.realpath(absolutePath)
  if (!realTarget.startsWith(realRoot + path.sep)) throw new Error('资源路径越界')
  return absolutePath
}
