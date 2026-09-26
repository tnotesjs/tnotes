import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import {
  copyExcalidrawDocument,
  createExcalidrawDocument,
  createKnowledgeBase as createKbOnDisk,
  findExcalidrawSourceFor,
  listKbDirectory,
  readKbTextFile,
  isKnowledgeBaseRoot,
  listIncompleteJournals,
  readExcalidrawDocument,
  writeExcalidrawDerivedSvg,
  writeExcalidrawDocument
} from '@tnotesjs/kb'

import { deskLog } from './log'
import { assetWriteGate } from './assetWriteGate'
import { gitManager } from './gitManager'
import { loadSettings, settingsForKnowledgeBase } from './settings'
import { loadWorkspace, saveWorkspace } from './workspace'
import { recoverHistoryRestore } from './history/restoreApply'
import { historyRestoreJournalDir, listRestoreJournals } from './history/restoreJournal'
import { knowledgeBaseAssetHashCache, knowledgeBaseAssetStore } from './workspace/assetStore'
import { descriptor, toDetail, toSettingsDto } from './workspace/dto'
import * as noteIo from './workspace/noteIo'
import {
  disposeHandles,
  enqueueScan,
  markInternalWrites,
  scan,
  startWatchers,
  stopWatcher,
  type WorkspaceScanState
} from './workspace/scan'
import * as toc from './workspace/toc'
import type {
  GitRepositoryDescriptor,
  KnowledgeBaseHandle,
  WorkspaceChangeHint,
  WorkspaceManagerEvents
} from './workspace/types'

import type { SearchIndexDocument } from './searchModel'
import type {
  DeletePreviewDto,
  KbFilesListResultDto,
  KbTextFileDto,
  ExcalidrawDerivedRefDto,
  ExcalidrawDocumentDto,
  ExcalidrawDocumentRefDto,
  ExcalidrawSourceProbeDto,
  AssetKbSummaryDto,
  AssetScanProgressDto,
  AssetScanReportDto,
  AttachmentWriteLocalRequest,
  AttachmentWriteLocalResult,
  ExternalNoteChangeEvent,
  KbBuildResult,
  KnowledgeBaseCreateRequest,
  KnowledgeBaseCreateResult,
  KnowledgeBaseDetail,
  NoteCreateManyRequest,
  NoteCreateManyResult,
  NoteCreateRequest,
  NoteDocumentDto,
  NoteMutationDto,
  NoteReindexRequest,
  NoteRenameRequest,
  NoteSaveRequest,
  NoteUpdateConfigRequest,
  KnowledgeBaseIconWriteRequest,
  KnowledgeBaseSettingsDto,
  KnowledgeBaseSettingsWriteRequest,
  TocCreateGroupRequest,
  DeleteTargetDto,
  TocDeleteRequest,
  TocMoveRequest,
  TocRenameGroupRequest,
  WorkspaceOverview
} from '../shared/contracts'

export type { GitRepositoryDescriptor } from './workspace/types'

export class WorkspaceManager {
  private readonly events = new EventEmitter<WorkspaceManagerEvents>()
  private disposed = false
  private readonly scanState: WorkspaceScanState = {
    handles: new Map(),
    workspacePath: null,
    watchers: new Map(),
    refreshTimer: null,
    scanTail: Promise.resolve(),
    internalWriteUntil: new Map(),
    lastWatcherError: '',
    lastWatcherErrorAt: 0,
    events: this.events,
    emitChanged: () => this.emitChanged()
  }
  private readonly assetScans = new Map<string, AbortController>()

  private bindAssetUserData(): void {
    try {
      this.scanState.userDataDir = app.getPath('userData')
    } catch {
      // app not ready in some unit tests; recover/apply stay unavailable.
    }
  }

  private mutationEffects(): {
    markInternalWrites: (
      rootPath: string,
      changedFiles: Array<{ path: string; previousPath?: string }>
    ) => void
    emitChanged: (hint?: WorkspaceChangeHint) => void
  } {
    return {
      markInternalWrites: (
        rootPath: string,
        changedFiles: Array<{ path: string; previousPath?: string }>
      ) => markInternalWrites(this.scanState, rootPath, changedFiles),
      emitChanged: (hint?: WorkspaceChangeHint) => this.emitChanged(hint)
    }
  }

  onChanged(
    listener: (overview: WorkspaceOverview, hint?: WorkspaceChangeHint) => void
  ): () => void {
    this.events.on('changed', listener)
    return () => this.events.off('changed', listener)
  }

  onNoteExternalChanged(listener: (event: ExternalNoteChangeEvent) => void): () => void {
    this.events.on('noteExternalChanged', listener)
    return () => this.events.off('noteExternalChanged', listener)
  }

  async initialize(): Promise<WorkspaceOverview> {
    return this.setWorkspace(loadWorkspace().path, false)
  }

  async setWorkspace(nextPath: string | null, persist = true): Promise<WorkspaceOverview> {
    this.assertActive()
    const normalized = nextPath ? path.resolve(nextPath) : null
    if (normalized) {
      const stat = await fs.stat(normalized).catch(() => null)
      if (!stat?.isDirectory()) throw new Error(`工作区目录不存在：${normalized}`)
    }

    await stopWatcher(this.scanState)
    await disposeHandles(this.scanState)
    this.scanState.workspacePath = normalized
    if (persist) saveWorkspace(normalized)
    if (normalized) {
      this.bindAssetUserData()
      await scan(this.scanState)
      await this.syncAssetWriteHolds()
      startWatchers(this.scanState, normalized)
    }
    const overview = this.getOverview()
    this.events.emit('changed', overview)
    return overview
  }

  async refresh(): Promise<WorkspaceOverview> {
    this.bindAssetUserData()
    await enqueueScan(this.scanState)
    await this.syncAssetWriteHolds()
    return this.getOverview()
  }

  async createKnowledgeBase(
    request: KnowledgeBaseCreateRequest
  ): Promise<KnowledgeBaseCreateResult> {
    this.assertActive()
    const workspacePath = this.scanState.workspacePath
    if (!workspacePath) throw new Error('请先选择工作区')
    if (await isKnowledgeBaseRoot(workspacePath)) {
      throw new Error('当前工作区本身就是知识库，请打开包含多个知识库的父目录后再新建')
    }

    const created = await createKbOnDisk({
      parentDir: workspacePath,
      folderName: request.folderName,
      title: request.title,
      options: {
        packageJson: request.packageJson,
        githubPages: request.githubPages,
        readme: request.readme,
        gitInit: request.gitInit
      }
    })
    this.mutationEffects().markInternalWrites(created.rootPath, [
      { path: 'tnotes.json' },
      { path: 'TOC.md' },
      { path: created.starterNoteRelPath },
      { path: '.gitignore' },
      { path: '.gitattributes' },
      ...created.extras.map((path) => ({ path }))
    ])
    this.bindAssetUserData()
    await enqueueScan(this.scanState)
    await this.syncAssetWriteHolds()
    const overview = this.getOverview()
    this.events.emit('changed', overview)

    const match = overview.knowledgeBases.find((item) => item.rootPath === created.rootPath)
    if (!match) {
      throw new Error(`知识库已创建但未扫描到：${created.folderName}`)
    }
    deskLog('workspace', 'created knowledge base', { rootPath: created.rootPath })
    return { overview, knowledgeBaseId: match.id }
  }

  getOverview(): WorkspaceOverview {
    const allKnowledgeBases = [...this.scanState.handles.values()]
      .map(descriptor)
      .sort((left, right) => left.name.localeCompare(right.name))
    const settings = loadSettings()
    const hidden = new Set(settings.hiddenKnowledgeBases)
    const knowledgeBases = allKnowledgeBases.filter((item) => {
      const override = settingsForKnowledgeBase(settings, item.configId)
      return !override.hidden && !hidden.has(item.configId) && !hidden.has(item.name)
    })
    return { path: this.scanState.workspacePath, knowledgeBases, allKnowledgeBases }
  }

  async createExcalidraw(
    knowledgeBaseId: string,
    noteUuid: string,
    content?: string
  ): Promise<ExcalidrawDocumentRefDto> {
    this.assertWritable(knowledgeBaseId)
    const handle = this.getHandle(knowledgeBaseId)
    const ownerNoteIndex = noteIo.resolveNoteIndex(handle, noteUuid)
    const created = await createExcalidrawDocument(handle.rootPath, { ownerNoteIndex, content })
    this.markInternal(handle, [created.relPath])
    this.emitChanged()
    return { knowledgeBaseId, ...created }
  }

  async readExcalidraw(knowledgeBaseId: string, relPath: string): Promise<ExcalidrawDocumentDto> {
    const handle = this.getHandle(knowledgeBaseId)
    const document = await readExcalidrawDocument(handle.rootPath, relPath)
    return {
      knowledgeBaseId,
      relPath: document.relPath,
      ownerNoteIndex: document.ownerNoteIndex,
      revision: document.revision,
      content: document.content,
      valid: document.valid,
      bytes: document.bytes
    }
  }

  async writeExcalidraw(
    knowledgeBaseId: string,
    input: { relPath: string; content: string; expectedRevision: string }
  ): Promise<ExcalidrawDocumentRefDto> {
    this.assertWritable(knowledgeBaseId)
    const handle = this.getHandle(knowledgeBaseId)
    const written = await writeExcalidrawDocument(handle.rootPath, input)
    this.markInternal(handle, [written.relPath])
    this.emitChanged()
    return { knowledgeBaseId, ...written }
  }

  async copyExcalidraw(
    knowledgeBaseId: string,
    fromRelPath: string,
    toNoteUuid: string
  ): Promise<ExcalidrawDocumentRefDto> {
    this.assertWritable(knowledgeBaseId)
    const handle = this.getHandle(knowledgeBaseId)
    const toOwnerNoteIndex = noteIo.resolveNoteIndex(handle, toNoteUuid)
    const copy = await copyExcalidrawDocument(handle.rootPath, {
      fromRelPath,
      toOwnerNoteIndex
    })
    this.markInternal(handle, [copy.relPath])
    this.emitChanged()
    return { knowledgeBaseId, ...copy }
  }

  /** 写派生 SVG（笔记里引用那张图）：目标路径由源画布推导，渲染端指定不了 */
  async writeExcalidrawDerivedSvg(
    knowledgeBaseId: string,
    input: { sourceRelPath: string; content: string }
  ): Promise<ExcalidrawDerivedRefDto> {
    this.assertWritable(knowledgeBaseId)
    const handle = this.getHandle(knowledgeBaseId)
    const written = await writeExcalidrawDerivedSvg(handle.rootPath, input)
    this.markInternal(handle, [written.relPath])
    this.emitChanged()
    return { knowledgeBaseId, ...written }
  }

  /** 列一层知识库目录（拒绝名单与文本线索都在 kb 层裁定） */
  async listKbFiles(knowledgeBaseId: string, relPath: string): Promise<KbFilesListResultDto> {
    const handle = this.getHandle(knowledgeBaseId)
    return { relPath, entries: await listKbDirectory(handle.rootPath, relPath) }
  }

  /** 读一个文本文件：二进制 / 超限 / 拒绝名单都由 kb 层抛错 */
  async readKbTextFile(knowledgeBaseId: string, relPath: string): Promise<KbTextFileDto> {
    const handle = this.getHandle(knowledgeBaseId)
    const file = await readKbTextFile(handle.rootPath, relPath)
    return {
      ...file,
      writable: false,
      writableReason: '当前只支持查看，编辑能力在后续版本开放'
    }
  }

  /** 「这张 .svg 能不能编辑」：同名 `.excalidraw` 在不在（探测，不抛错） */
  async findExcalidrawSourceFor(
    knowledgeBaseId: string,
    relPath: string
  ): Promise<ExcalidrawSourceProbeDto> {
    const handle = this.getHandle(knowledgeBaseId)
    return { source: await findExcalidrawSourceFor(handle.rootPath, relPath) }
  }

  private markInternal(handle: KnowledgeBaseHandle, relPaths: string[]): void {
    // 我们自己写的盘：不标记的话 fs.watch 会当成外部修改，弹假冲突
    markInternalWrites(
      this.scanState,
      handle.rootPath,
      relPaths.map((relPath) => ({ path: relPath }))
    )
  }

  getDetail(knowledgeBaseId: string): KnowledgeBaseDetail {
    return toDetail(this.getHandle(knowledgeBaseId))
  }

  async readSettings(knowledgeBaseId: string): Promise<KnowledgeBaseSettingsDto> {
    return toSettingsDto(this.getHandle(knowledgeBaseId))
  }

  async writeSettings(request: KnowledgeBaseSettingsWriteRequest): Promise<KnowledgeBaseDetail> {
    this.assertWritable(request.knowledgeBaseId)
    const handle = this.getHandle(request.knowledgeBaseId)
    const existing = handle.snapshot.config
    const stats =
      request.statsEnabled === true
        ? { ...existing.stats, enabled: true }
        : existing.stats
          ? { ...existing.stats, enabled: false }
          : { enabled: false }

    const result = await handle.workspace.config.set({
      name: request.name.trim(),
      title: request.title.trim() || request.name.trim(),
      repositoryUrl: request.repositoryUrl?.trim() || undefined,
      rootUrl: request.rootUrl?.trim() || undefined,
      port: request.port,
      pageUrl: request.pageUrl?.trim() || undefined,
      stats,
      // 库级约定：null → 删键（跟随 desk 全局）；undefined → 不动
      ...(request.prettier !== undefined ? { prettier: request.prettier ?? undefined } : {}),
      ...(request.autoPush !== undefined ? { autoPush: request.autoPush ?? undefined } : {}),
      ...(request.headingNumberMaxDepth !== undefined
        ? { headingNumberMaxDepth: request.headingNumberMaxDepth ?? undefined }
        : {})
    })
    this.mutationEffects().markInternalWrites(handle.rootPath, result.changedFiles)
    handle.snapshot = await handle.workspace.scan()
    this.emitChanged()
    return toDetail(handle)
  }

  async writeIcon(request: KnowledgeBaseIconWriteRequest): Promise<KnowledgeBaseDetail> {
    this.assertWritable(request.knowledgeBaseId)
    const handle = this.getHandle(request.knowledgeBaseId)
    const changedFiles: Array<{ path: string }> = []

    if (request.kind === 'clear') {
      const cleared = await handle.workspace.assets.clearIcon()
      for (const deleted of cleared.deleted) changedFiles.push({ path: deleted })
      const result = await handle.workspace.config.set({ icon: undefined })
      changedFiles.push(...result.changedFiles)
    } else if (request.kind === 'letter') {
      const letter = request.letter.trim().slice(0, 1)
      if (!letter) throw new Error('单字符图标不能为空')
      const cleared = await handle.workspace.assets.clearIcon()
      for (const deleted of cleared.deleted) changedFiles.push({ path: deleted })
      const result = await handle.workspace.config.set({ icon: { letter } })
      changedFiles.push(...result.changedFiles)
    } else {
      const ext = path.extname(request.fileName) || '.png'
      const replaced = await handle.workspace.assets.replaceIcon({
        ext,
        data: request.data
      })
      for (const deleted of replaced.deleted) changedFiles.push({ path: deleted })
      changedFiles.push({ path: replaced.relPath })
      const result = await handle.workspace.config.set({ icon: replaced.icon })
      changedFiles.push(...result.changedFiles)
    }

    this.mutationEffects().markInternalWrites(handle.rootPath, changedFiles)
    handle.snapshot = await handle.workspace.scan()
    this.emitChanged()
    return toDetail(handle)
  }

  getLocation(knowledgeBaseId: string): { name: string; rootPath: string } {
    const handle = this.getHandle(knowledgeBaseId)
    return { name: handle.name, rootPath: handle.rootPath }
  }

  getNoteLocation(knowledgeBaseId: string, noteUuid: string): string {
    const handle = this.getHandle(knowledgeBaseId)
    const note = handle.snapshot.notes.find(
      (item) => item.frontmatter.id === noteUuid || item.index === noteUuid
    )
    if (!note) throw new Error(`笔记不存在：${noteUuid}`)
    return path.join(handle.rootPath, note.relPath)
  }

  getGitRepositories(): GitRepositoryDescriptor[] {
    return [...this.scanState.handles.values()].map((handle) => ({
      knowledgeBaseId: handle.id,
      knowledgeBaseName: handle.name,
      configId: handle.id,
      rootPath: handle.rootPath,
      autoPush: handle.snapshot.config.autoPush ?? undefined,
      notes: handle.snapshot.notes.map((note) => ({
        uuid: note.frontmatter.id ?? note.index,
        index: note.index,
        title: note.title,
        dirName: note.fileName.replace(/\.md$/i, ''),
        filePath: path.join(handle.rootPath, note.relPath)
      }))
    }))
  }

  async getSearchDocuments(): Promise<SearchIndexDocument[]> {
    const pending = [...this.scanState.handles.values()].flatMap((handle) =>
      handle.snapshot.notes.map((note) => ({ handle, note }))
    )
    const documents: SearchIndexDocument[] = []
    let cursor = 0
    const readNext = async (): Promise<void> => {
      while (cursor < pending.length) {
        const current = pending[cursor]
        cursor += 1
        const noteUuid = current.note.frontmatter.id ?? current.note.index
        const filePath = path.join(current.handle.rootPath, current.note.relPath)
        try {
          const content = await fs.readFile(filePath, 'utf8')
          documents.push({
            id: `${current.handle.id}:${noteUuid}`,
            knowledgeBaseId: current.handle.id,
            knowledgeBaseName: current.handle.name,
            noteUuid,
            noteIndex: current.note.index,
            fileName: current.note.fileName.replace(/\.md$/i, ''),
            title: current.note.title,
            content,
            revision: createHash('sha256').update(content).digest('hex')
          })
        } catch (error) {
          deskLog('search', 'note skipped', {
            path: filePath,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(12, pending.length) }, () => readNext()))
    return documents.sort((left, right) => left.id.localeCompare(right.id))
  }

  /** Single-note counterpart of getSearchDocuments for content-only saves. */
  async getSearchDocument(
    knowledgeBaseId: string,
    noteUuid: string
  ): Promise<SearchIndexDocument | null> {
    const handle = this.getHandle(knowledgeBaseId)
    const note = handle.snapshot.notes.find(
      (item) => (item.frontmatter.id ?? item.index) === noteUuid
    )
    if (!note) return null
    const filePath = path.join(handle.rootPath, note.relPath)
    const content = await fs.readFile(filePath, 'utf8')
    return {
      id: `${handle.id}:${noteUuid}`,
      knowledgeBaseId: handle.id,
      knowledgeBaseName: handle.name,
      noteUuid,
      noteIndex: note.index,
      fileName: note.fileName.replace(/\.md$/i, ''),
      title: note.title,
      content,
      revision: createHash('sha256').update(content).digest('hex')
    }
  }

  async readNote(knowledgeBaseId: string, noteUuid: string): Promise<NoteDocumentDto> {
    return noteIo.readNote(this.getHandle(knowledgeBaseId), noteUuid)
  }

  /**
   * Resolve NotesTable ids against the current knowledge-base snapshot
   * (title + frontmatter description).
   */
  resolveNotesTable(
    knowledgeBaseId: string,
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
    return noteIo.resolveNotesTable(this.getHandle(knowledgeBaseId), ids)
  }

  async saveNote(request: NoteSaveRequest): Promise<NoteMutationDto> {
    this.assertWritable(request.knowledgeBaseId)
    return noteIo.saveNote(this.getHandle(request.knowledgeBaseId), request, this.mutationEffects())
  }

  async createNote(request: NoteCreateRequest): Promise<NoteMutationDto> {
    this.assertWritable(request.knowledgeBaseId)
    return noteIo.createNote(
      this.getHandle(request.knowledgeBaseId),
      request,
      this.mutationEffects()
    )
  }

  async createNotes(request: NoteCreateManyRequest): Promise<NoteCreateManyResult> {
    this.assertWritable(request.knowledgeBaseId)
    return noteIo.createNotes(
      this.getHandle(request.knowledgeBaseId),
      request,
      this.mutationEffects()
    )
  }

  async renameNote(request: NoteRenameRequest): Promise<NoteMutationDto> {
    this.assertWritable(request.knowledgeBaseId)
    return noteIo.renameNote(
      this.getHandle(request.knowledgeBaseId),
      request,
      this.mutationEffects()
    )
  }

  async reindexNote(request: NoteReindexRequest): Promise<NoteMutationDto> {
    this.assertWritable(request.knowledgeBaseId)
    return noteIo.reindexNote(
      this.getHandle(request.knowledgeBaseId),
      request,
      this.mutationEffects()
    )
  }

  async updateNoteConfig(request: NoteUpdateConfigRequest): Promise<NoteMutationDto> {
    this.assertWritable(request.knowledgeBaseId)
    return noteIo.updateNoteConfig(
      this.getHandle(request.knowledgeBaseId),
      request,
      this.mutationEffects()
    )
  }

  async writeLocalAttachment(
    request: AttachmentWriteLocalRequest
  ): Promise<AttachmentWriteLocalResult> {
    this.assertWritable(request.knowledgeBaseId)
    assetWriteGate.beginAttachment(request.knowledgeBaseId)
    try {
      return await noteIo.writeLocalAttachment(
        this.getHandle(request.knowledgeBaseId),
        request,
        this.mutationEffects()
      )
    } finally {
      assetWriteGate.endAttachment(request.knowledgeBaseId)
    }
  }

  async resolveNoteAsset(knowledgeBaseId: string, requestedPath: string): Promise<string> {
    return noteIo.resolveNoteAsset(this.getHandle(knowledgeBaseId), requestedPath)
  }

  async buildKnowledgeBase(knowledgeBaseId: string): Promise<KbBuildResult> {
    const handle = this.getHandle(knowledgeBaseId)
    const { buildSite } = await import('@tnotesjs/ssg')
    const result = await buildSite(handle.rootPath)
    return { outDir: result.config.outDir, pageCount: result.pageCount }
  }

  async moveToc(request: TocMoveRequest): Promise<KnowledgeBaseDetail> {
    this.assertWritable(request.knowledgeBaseId)
    return toc.moveToc(this.getHandle(request.knowledgeBaseId), request, this.mutationEffects())
  }

  async createTocGroup(request: TocCreateGroupRequest): Promise<KnowledgeBaseDetail> {
    this.assertWritable(request.knowledgeBaseId)
    return toc.createTocGroup(
      this.getHandle(request.knowledgeBaseId),
      request,
      this.mutationEffects()
    )
  }

  async renameTocGroup(request: TocRenameGroupRequest): Promise<KnowledgeBaseDetail> {
    this.assertWritable(request.knowledgeBaseId)
    return toc.renameTocGroup(
      this.getHandle(request.knowledgeBaseId),
      request,
      this.mutationEffects()
    )
  }

  async previewDelete(knowledgeBaseId: string, entry: DeleteTargetDto): Promise<DeletePreviewDto> {
    return toc.previewDelete(this.getHandle(knowledgeBaseId), knowledgeBaseId, entry)
  }

  async deleteToc(request: TocDeleteRequest): Promise<KnowledgeBaseDetail> {
    this.assertWritable(request.knowledgeBaseId)
    return toc.deleteToc(this.getHandle(request.knowledgeBaseId), request, this.mutationEffects())
  }

  async scanAssets(knowledgeBaseId: string, generation: number): Promise<AssetScanReportDto> {
    const handle = this.getHandle(knowledgeBaseId)
    this.cancelAssetScan(knowledgeBaseId)
    const controller = new AbortController()
    this.assetScans.set(knowledgeBaseId, controller)
    try {
      return await handle.workspace.assets.analyze({
        generation,
        signal: controller.signal,
        includeHashes: true,
        hashCachePath: this.scanState.userDataDir
          ? knowledgeBaseAssetHashCache(this.scanState.userDataDir, handle.rootPath)
          : undefined,
        onProgress: (progress) => {
          this.events.emit('assetScanProgress', {
            knowledgeBaseId,
            generation,
            done: progress.done,
            total: progress.total,
            current: progress.current
          })
        }
      })
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        const aborted = new Error('ASSET_SCAN_ABORTED')
        aborted.name = 'AbortError'
        throw aborted
      }
      throw error
    } finally {
      if (this.assetScans.get(knowledgeBaseId) === controller)
        this.assetScans.delete(knowledgeBaseId)
    }
  }

  cancelAssetScan(knowledgeBaseId: string): void {
    this.assetScans.get(knowledgeBaseId)?.abort()
    this.assetScans.delete(knowledgeBaseId)
  }

  async listAssetSummaries(): Promise<AssetKbSummaryDto[]> {
    const summaries: AssetKbSummaryDto[] = []
    for (const handle of this.scanState.handles.values()) {
      const assets = await handle.workspace.assets.list()
      summaries.push({
        knowledgeBaseId: handle.id,
        displayName: handle.snapshot.config.title || handle.name,
        fileCount: assets.length,
        bytes: assets.reduce((sum, item) => sum + item.size, 0)
      })
    }
    return summaries.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'))
  }

  onAssetScanProgress(listener: (progress: AssetScanProgressDto) => void): () => void {
    this.events.on('assetScanProgress', listener)
    return () => this.events.off('assetScanProgress', listener)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.assetScans.values()) controller.abort()
    this.assetScans.clear()
    if (this.scanState.refreshTimer) clearTimeout(this.scanState.refreshTimer)
    await stopWatcher(this.scanState)
    await disposeHandles(this.scanState)
    this.events.removeAllListeners()
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('WorkspaceManager 已释放')
  }

  private assertWritable(knowledgeBaseId: string): void {
    assetWriteGate.assertCanMutate(knowledgeBaseId)
  }

  getHandle(knowledgeBaseId: string): KnowledgeBaseHandle {
    const handle = this.scanState.handles.get(knowledgeBaseId)
    if (!handle) throw new Error(`知识库不存在：${knowledgeBaseId}`)
    return handle
  }

  assetUserDataDir(): string | undefined {
    return this.scanState.userDataDir
  }

  markAssetMutation(rootPath: string, relPaths: string[]): void {
    markInternalWrites(
      this.scanState,
      rootPath,
      relPaths.map((relPath) => ({ path: relPath }))
    )
  }

  emitNoteExternalChanged(knowledgeBaseId: string, noteUuid: string): void {
    this.events.emit('noteExternalChanged', { knowledgeBaseId, noteUuid })
  }

  async syncAssetWriteHolds(): Promise<void> {
    const userDataDir = this.scanState.userDataDir
    if (!userDataDir) return
    for (const handle of this.scanState.handles.values()) {
      const store = knowledgeBaseAssetStore(userDataDir, handle.rootPath)
      const incomplete = await listIncompleteJournals(store)
      // 历史恢复的未完成事务：先按日志回滚/确认提交，再决定是否继续拦写入
      const historyJournalDir = historyRestoreJournalDir(userDataDir, handle.rootPath)
      try {
        await recoverHistoryRestore({ journalDir: historyJournalDir })
      } catch (error) {
        deskLog(
          'history-restore',
          `恢复未完成事务失败：${handle.rootPath}`,
          error instanceof Error ? error.message : String(error)
        )
      }
      const unfinishedHistory = (await listRestoreJournals(historyJournalDir)).filter(
        (journal) => journal.phase === 'failed'
      )
      if (incomplete.length > 0 || unfinishedHistory.length > 0) {
        assetWriteGate.setSticky(handle.id, 'incomplete-journal')
        gitManager.pauseForAssetWrite(handle.id)
      } else if (!assetWriteGate.inTransaction(handle.id)) {
        assetWriteGate.clearSticky(handle.id)
        gitManager.resumeAfterAssetWrite(handle.id)
      }
    }
  }

  private emitChanged(hint?: WorkspaceChangeHint): void {
    this.events.emit('changed', this.getOverview(), hint)
  }
}

export const workspaceManager = new WorkspaceManager()
