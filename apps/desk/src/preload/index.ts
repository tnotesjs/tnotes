import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS } from '../shared/contracts'

import type {
  AppSettings,
  AttachmentWriteLocalRequest,
  AttachmentWriteLocalResult,
  ExcalidrawDerivedRefDto,
  KbFilesListResultDto,
  KbTextFileDto,
  ExcalidrawDocumentDto,
  ExcalidrawDocumentRefDto,
  ExcalidrawSourceProbeDto,
  HistoryAssetDto,
  HistoryListResultDto,
  HistoryApplyResultDto,
  HistoryNoteDto,
  HistoryRestorePlanDto,
  HistorySnapshotDto,
  ImageSettingsValidateResult,
  ImageOptimizePreviewResult,
  ImageTokenStatus,
  ImageUploadResult,
  GitOperationResult,
  GitRepositoryStateDto,
  BootstrapPayload,
  DeleteCommitResultDto,
  DeletePreviewDto,
  DeskApi,
  DeskResult,
  ExternalNoteChangeEvent,
  KbBuildResult,
  KnowledgeBaseDetail,
  KnowledgeBaseCreateRequest,
  KnowledgeBaseCreateResult,
  KnowledgeBaseSettingsDto,
  AssetKbSummaryDto,
  AssetScanProgressDto,
  AssetScanReportDto,
  AssetJournalDto,
  AssetOperationPlanDto,
  AssetOperationResultDto,
  AssetOptimizePreviewDto,
  AssetGateQueryEvent,
  AssetPrepareApplyEvent,
  AssetAppliedEvent,
  AssetApplySettledEvent,
  NoteCreateRequest,
  NoteDocumentDto,
  NotesTableResolveRequest,
  NotesTableResolveResult,
  NoteMutationDto,
  NoteRenameRequest,
  NoteSaveRequest,
  NoteUpdateConfigRequest,
  PreviewStartResult,
  PreviewStateDto,
  TerminalCreateRequest,
  TerminalDataEvent,
  TerminalOpenAtEvent,
  TerminalSessionDto,
  RecoveryDeleteRequest,
  RecoveryWriteRequest,
  SearchResultDto,
  TabShortcutCommand,
  TabCloseChoice,
  ContextMenuAction,
  KnowledgeSidebarMenuAction,
  KnowledgeSidebarMenuRequest,
  NavigatorSidebarMenuAction,
  NavigatorSidebarMenuRequest,
  TocCreateGroupRequest,
  TocDeleteRequest,
  TocEntryRefDto,
  TocMoveRequest,
  TocRenameGroupRequest,
  UpdateStatusDto,
  WebOpenRequestedEvent,
  WebTabState,
  WorkspaceSession,
  WorkspaceOverview
} from '../shared/contracts'

function invoke<T>(channel: string, input?: unknown): Promise<DeskResult<T>> {
  return ipcRenderer.invoke(channel, input) as Promise<DeskResult<T>>
}

const api: DeskApi = {
  bootstrap: () => invoke<BootstrapPayload>(IPC_CHANNELS.bootstrap),
  app: {
    closeWindow: () => invoke<void>(IPC_CHANNELS.windowClose),
    onBeforeClose: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on(IPC_CHANNELS.appBeforeClose, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.appBeforeClose, listener)
    },
    confirmCloseReady: (proceed) => invoke<void>(IPC_CHANNELS.appCloseReady, { proceed }),
    confirmTabClose: (titles) => invoke<TabCloseChoice>(IPC_CHANNELS.tabConfirmClose, titles),
    showContextMenu: (request) =>
      invoke<ContextMenuAction | null>(IPC_CHANNELS.contextMenuShow, request),
    showKnowledgeSidebarMenu: (request: KnowledgeSidebarMenuRequest) =>
      invoke<KnowledgeSidebarMenuAction | null>(IPC_CHANNELS.knowledgeSidebarMenuShow, request),
    showNavigatorSidebarMenu: (request: NavigatorSidebarMenuRequest) =>
      invoke<NavigatorSidebarMenuAction | null>(IPC_CHANNELS.navigatorSidebarMenuShow, request),
    onTabShortcut: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, command: TabShortcutCommand): void =>
        callback(command)
      ipcRenderer.on(IPC_CHANNELS.tabShortcut, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.tabShortcut, listener)
    }
  },
  updates: {
    status: () => invoke<UpdateStatusDto>(IPC_CHANNELS.updateStatus),
    check: () => invoke<UpdateStatusDto>(IPC_CHANNELS.updateCheck),
    openReleasePage: () => invoke<void>(IPC_CHANNELS.updateOpenRelease),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatusDto): void =>
        callback(status)
      ipcRenderer.on(IPC_CHANNELS.updateChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.updateChanged, listener)
    }
  },
  workspace: {
    choose: () => invoke<WorkspaceOverview>(IPC_CHANNELS.workspaceChoose),
    set: (path) => invoke<WorkspaceOverview>(IPC_CHANNELS.workspaceSet, path),
    refresh: () => invoke<WorkspaceOverview>(IPC_CHANNELS.workspaceRefresh),
    reveal: () => invoke<void>(IPC_CHANNELS.workspaceReveal),
    revealKnowledgeBase: (knowledgeBaseId) =>
      invoke<void>(IPC_CHANNELS.workspaceRevealKnowledgeBase, knowledgeBaseId),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, overview: WorkspaceOverview): void =>
        callback(overview)
      ipcRenderer.on(IPC_CHANNELS.workspaceChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.workspaceChanged, listener)
    }
  },
  settings: {
    update: (next) => invoke<AppSettings>(IPC_CHANNELS.settingsUpdate, next),
    export: () => invoke<void>(IPC_CHANNELS.settingsExport),
    import: () => invoke<AppSettings>(IPC_CHANNELS.settingsImport),
    reset: () => invoke<AppSettings>(IPC_CHANNELS.settingsReset),
    readRaw: () => invoke<string>(IPC_CHANNELS.settingsReadRaw),
    writeRaw: (json) => invoke<AppSettings>(IPC_CHANNELS.settingsWriteRaw, json),
    imageTokenStatus: () => invoke<ImageTokenStatus>(IPC_CHANNELS.imageTokenStatus),
    updateImageToken: (request) => invoke<ImageTokenStatus>(IPC_CHANNELS.imageTokenUpdate, request),
    validateImageSettings: (request) =>
      invoke<ImageSettingsValidateResult>(IPC_CHANNELS.imageSettingsValidate, request),
    previewOptimizeImage: (request) =>
      invoke<ImageOptimizePreviewResult>(IPC_CHANNELS.imageOptimizePreview, request)
  },
  knowledgeBases: {
    create: (request: KnowledgeBaseCreateRequest) =>
      invoke<KnowledgeBaseCreateResult>(IPC_CHANNELS.knowledgeBaseCreate, request),
    read: (knowledgeBaseId) =>
      invoke<KnowledgeBaseDetail>(IPC_CHANNELS.knowledgeBaseRead, knowledgeBaseId),
    readSettings: (knowledgeBaseId) =>
      invoke<KnowledgeBaseSettingsDto>(IPC_CHANNELS.knowledgeBaseReadSettings, knowledgeBaseId),
    writeSettings: (request) =>
      invoke<KnowledgeBaseDetail>(IPC_CHANNELS.knowledgeBaseWriteSettings, request),
    writeIcon: (request) =>
      invoke<KnowledgeBaseDetail>(IPC_CHANNELS.knowledgeBaseWriteIcon, request),
    onOpenSettingsRequested: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, knowledgeBaseId: string): void =>
        callback(knowledgeBaseId)
      ipcRenderer.on(IPC_CHANNELS.kbOpenSettingsRequested, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.kbOpenSettingsRequested, listener)
    },
    onOpenAssetsRequested: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, knowledgeBaseId: string): void =>
        callback(knowledgeBaseId)
      ipcRenderer.on(IPC_CHANNELS.kbOpenAssetsRequested, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.kbOpenAssetsRequested, listener)
    }
  },
  kbFiles: {
    list: (request) => invoke<KbFilesListResultDto>(IPC_CHANNELS.kbFilesList, request),
    read: (request) => invoke<KbTextFileDto>(IPC_CHANNELS.kbFilesRead, request)
  },
  excalidraw: {
    create: (request) => invoke<ExcalidrawDocumentRefDto>(IPC_CHANNELS.excalidrawCreate, request),
    read: (request) => invoke<ExcalidrawDocumentDto>(IPC_CHANNELS.excalidrawRead, request),
    write: (request) => invoke<ExcalidrawDocumentRefDto>(IPC_CHANNELS.excalidrawWrite, request),
    copy: (request) => invoke<ExcalidrawDocumentRefDto>(IPC_CHANNELS.excalidrawCopy, request),
    writeDerived: (request) =>
      invoke<ExcalidrawDerivedRefDto>(IPC_CHANNELS.excalidrawWriteDerived, request),
    sourceForDerived: (request) =>
      invoke<ExcalidrawSourceProbeDto>(IPC_CHANNELS.excalidrawSourceForDerived, request)
  },
  history: {
    list: (request) => invoke<HistoryListResultDto>(IPC_CHANNELS.historyList, request),
    snapshot: (request) => invoke<HistorySnapshotDto>(IPC_CHANNELS.historySnapshot, request),
    readNote: (request) => invoke<HistoryNoteDto>(IPC_CHANNELS.historyReadNote, request),
    readAsset: (request) => invoke<HistoryAssetDto>(IPC_CHANNELS.historyReadAsset, request),
    plan: (request) => invoke<HistoryRestorePlanDto>(IPC_CHANNELS.historyPlan, request),
    apply: (request) => invoke<HistoryApplyResultDto>(IPC_CHANNELS.historyApply, request)
  },
  assets: {
    scan: (knowledgeBaseId, generation) =>
      invoke<AssetScanReportDto>(IPC_CHANNELS.assetsScan, { knowledgeBaseId, generation }),
    cancel: (knowledgeBaseId) => invoke<void>(IPC_CHANNELS.assetsScanCancel, knowledgeBaseId),
    summaries: () => invoke<AssetKbSummaryDto[]>(IPC_CHANNELS.assetsSummaries),
    planRename: (knowledgeBaseId, fromRelPath, toRelPath, generation) =>
      invoke<AssetOperationPlanDto>(IPC_CHANNELS.assetsPlanRename, {
        knowledgeBaseId,
        fromRelPath,
        toRelPath,
        generation
      }),
    planRecycle: (knowledgeBaseId, relPaths, generation, options) =>
      invoke<AssetOperationPlanDto>(IPC_CHANNELS.assetsPlanRecycle, {
        knowledgeBaseId,
        relPaths,
        generation,
        targeted: options?.targeted
      }),
    planMerge: (knowledgeBaseId, keepRelPath, dropRelPaths, generation) =>
      invoke<AssetOperationPlanDto>(IPC_CHANNELS.assetsPlanMerge, {
        knowledgeBaseId,
        keepRelPath,
        dropRelPaths,
        generation
      }),
    previewOptimize: (knowledgeBaseId, relPaths, options, generation) =>
      invoke<AssetOptimizePreviewDto>(IPC_CHANNELS.assetsPreviewOptimize, {
        knowledgeBaseId,
        relPaths,
        options,
        generation
      }),
    planOptimize: (knowledgeBaseId, relPaths, options, generation) =>
      invoke<AssetOperationPlanDto>(IPC_CHANNELS.assetsPlanOptimize, {
        knowledgeBaseId,
        relPaths,
        options,
        generation
      }),
    apply: (knowledgeBaseId, planId) =>
      invoke<AssetOperationResultDto>(IPC_CHANNELS.assetsApply, { knowledgeBaseId, planId }),
    restore: (knowledgeBaseId, planId) =>
      invoke<AssetOperationResultDto>(IPC_CHANNELS.assetsRestore, { knowledgeBaseId, planId }),
    history: (knowledgeBaseId) =>
      invoke<AssetJournalDto[]>(IPC_CHANNELS.assetsHistory, knowledgeBaseId),
    onScanProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: AssetScanProgressDto): void =>
        callback(progress)
      ipcRenderer.on(IPC_CHANNELS.assetsScanProgress, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.assetsScanProgress, listener)
    },
    onGateQuery: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: AssetGateQueryEvent): void =>
        callback(event)
      ipcRenderer.on(IPC_CHANNELS.assetsGateQuery, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.assetsGateQuery, listener)
    },
    replyGate: (requestId, knowledgeBaseId, snapshot) => {
      ipcRenderer.send(IPC_CHANNELS.assetsGateReply, { requestId, knowledgeBaseId, snapshot })
    },
    onPrepareApply: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: AssetPrepareApplyEvent): void =>
        callback(event)
      ipcRenderer.on(IPC_CHANNELS.assetsPrepareApply, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.assetsPrepareApply, listener)
    },
    onApplied: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: AssetAppliedEvent): void =>
        callback(event)
      ipcRenderer.on(IPC_CHANNELS.assetsApplied, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.assetsApplied, listener)
    },
    onApplySettled: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: AssetApplySettledEvent): void =>
        callback(event)
      ipcRenderer.on(IPC_CHANNELS.assetsApplySettled, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.assetsApplySettled, listener)
    }
  },
  notes: {
    read: (knowledgeBaseId, noteUuid) =>
      invoke<NoteDocumentDto>(IPC_CHANNELS.noteRead, {
        knowledgeBaseId,
        noteUuid
      }),
    resolveTable: (request: NotesTableResolveRequest) =>
      invoke<NotesTableResolveResult>(IPC_CHANNELS.noteResolveTable, request),
    save: (request: NoteSaveRequest) => invoke<NoteMutationDto>(IPC_CHANNELS.noteSave, request),
    create: (request: NoteCreateRequest) =>
      invoke<NoteMutationDto>(IPC_CHANNELS.noteCreate, request),
    rename: (request: NoteRenameRequest) =>
      invoke<NoteMutationDto>(IPC_CHANNELS.noteRename, request),
    updateConfig: (request: NoteUpdateConfigRequest) =>
      invoke<NoteMutationDto>(IPC_CHANNELS.noteUpdateConfig, request),
    copyPath: (knowledgeBaseId, noteUuid) =>
      invoke<string>(IPC_CHANNELS.noteCopyPath, { knowledgeBaseId, noteUuid }),
    revealInFileManager: (knowledgeBaseId, noteUuid) =>
      invoke<void>(IPC_CHANNELS.noteRevealInFileManager, { knowledgeBaseId, noteUuid }),
    onExternalChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ExternalNoteChangeEvent
      ): void => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.noteExternalChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.noteExternalChanged, listener)
    }
  },
  attachments: {
    writeLocal: (request: AttachmentWriteLocalRequest) =>
      invoke<AttachmentWriteLocalResult>(IPC_CHANNELS.attachmentWriteLocal, request),
    uploadImage: (request) => invoke<ImageUploadResult>(IPC_CHANNELS.attachmentUploadImage, request)
  },
  build: (knowledgeBaseId) => invoke<KbBuildResult>(IPC_CHANNELS.kbBuild, knowledgeBaseId),
  search: (request) => invoke<SearchResultDto[]>(IPC_CHANNELS.searchQuery, request),
  git: {
    list: () => invoke<GitRepositoryStateDto[]>(IPC_CHANNELS.gitList),
    refresh: (knowledgeBaseId) =>
      invoke<GitRepositoryStateDto[]>(IPC_CHANNELS.gitRefresh, knowledgeBaseId),
    fetch: (knowledgeBaseId) => invoke<GitOperationResult>(IPC_CHANNELS.gitFetch, knowledgeBaseId),
    pull: (knowledgeBaseId) => invoke<GitOperationResult>(IPC_CHANNELS.gitPull, knowledgeBaseId),
    publish: (knowledgeBaseId) =>
      invoke<GitOperationResult>(IPC_CHANNELS.gitPublish, knowledgeBaseId),
    onStateChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: GitRepositoryStateDto): void =>
        callback(state)
      ipcRenderer.on(IPC_CHANNELS.gitStateChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.gitStateChanged, listener)
    }
  },
  ide: {
    showKnowledgeBaseMenu: (knowledgeBaseId) =>
      invoke<void>(IPC_CHANNELS.ideShowKnowledgeBaseMenu, knowledgeBaseId),
    showNoteMenu: (knowledgeBaseId, noteUuid) =>
      invoke<void>(IPC_CHANNELS.ideShowNoteMenu, { knowledgeBaseId, noteUuid }),
    showFileMenu: (knowledgeBaseId, path) =>
      invoke<void>(IPC_CHANNELS.ideShowFileMenu, { knowledgeBaseId, path }),
    openKnowledgeBase: (knowledgeBaseId) =>
      invoke<void>(IPC_CHANNELS.ideOpenKnowledgeBase, knowledgeBaseId),
    openNote: (knowledgeBaseId, noteUuid) =>
      invoke<void>(IPC_CHANNELS.ideOpenNote, { knowledgeBaseId, noteUuid })
  },
  toc: {
    move: (request: TocMoveRequest) => invoke<KnowledgeBaseDetail>(IPC_CHANNELS.tocMove, request),
    createGroup: (request: TocCreateGroupRequest) =>
      invoke<KnowledgeBaseDetail>(IPC_CHANNELS.tocCreateGroup, request),
    renameGroup: (request: TocRenameGroupRequest) =>
      invoke<KnowledgeBaseDetail>(IPC_CHANNELS.tocRenameGroup, request),
    previewDelete: (knowledgeBaseId, entry: TocEntryRefDto) =>
      invoke<DeletePreviewDto>(IPC_CHANNELS.tocPreviewDelete, {
        knowledgeBaseId,
        entry
      }),
    delete: (request: TocDeleteRequest) =>
      invoke<KnowledgeBaseDetail>(IPC_CHANNELS.tocDelete, request),
    commitBeforeDelete: (request) =>
      invoke<DeleteCommitResultDto>(IPC_CHANNELS.tocCommitBeforeDelete, request)
  },
  session: {
    read: () => invoke<WorkspaceSession | null>(IPC_CHANNELS.sessionRead),
    save: (session) => invoke<void>(IPC_CHANNELS.sessionSave, session)
  },
  recovery: {
    write: (request: RecoveryWriteRequest) => invoke<void>(IPC_CHANNELS.recoveryWrite, request),
    delete: (request: RecoveryDeleteRequest) => invoke<void>(IPC_CHANNELS.recoveryDelete, request)
  },
  web: {
    create: (request) => invoke<WebTabState>(IPC_CHANNELS.webCreate, request),
    layout: (request) => invoke<void>(IPC_CHANNELS.webLayout, request),
    hideAll: () => invoke<void>(IPC_CHANNELS.webHideAll),
    close: (tabId) => invoke<void>(IPC_CHANNELS.webClose, tabId),
    navigate: (request) => invoke<WebTabState>(IPC_CHANNELS.webNavigate, request),
    goBack: (tabId) => invoke<void>(IPC_CHANNELS.webGoBack, tabId),
    goForward: (tabId) => invoke<void>(IPC_CHANNELS.webGoForward, tabId),
    reload: (tabId) => invoke<void>(IPC_CHANNELS.webReload, tabId),
    stop: (tabId) => invoke<void>(IPC_CHANNELS.webStop, tabId),
    selectAll: (tabId) => invoke<void>(IPC_CHANNELS.webSelectAll, tabId),
    openExternal: (url) => invoke<void>(IPC_CHANNELS.webOpenExternal, url),
    clearBrowsingData: () => invoke<void>(IPC_CHANNELS.webClearBrowsingData),
    onStateChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: WebTabState): void =>
        callback(state)
      ipcRenderer.on(IPC_CHANNELS.webStateChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.webStateChanged, listener)
    },
    onOpenRequested: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: WebOpenRequestedEvent): void =>
        callback(payload)
      ipcRenderer.on(IPC_CHANNELS.webOpenRequested, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.webOpenRequested, listener)
    }
  },
  preview: {
    start: (request) => invoke<PreviewStartResult>(IPC_CHANNELS.previewStart, request),
    stop: (knowledgeBaseId) => invoke<PreviewStateDto>(IPC_CHANNELS.previewStop, knowledgeBaseId),
    list: () => invoke<PreviewStateDto[]>(IPC_CHANNELS.previewList),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: PreviewStateDto): void =>
        callback(state)
      ipcRenderer.on(IPC_CHANNELS.previewChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.previewChanged, listener)
    }
  },
  terminal: {
    create: (request: TerminalCreateRequest) =>
      invoke<TerminalSessionDto>(IPC_CHANNELS.terminalCreate, request),
    list: () => invoke<TerminalSessionDto[]>(IPC_CHANNELS.terminalList),
    restart: (sessionId: string) =>
      invoke<TerminalSessionDto>(IPC_CHANNELS.terminalRestart, { sessionId }),
    rename: (sessionId: string, title: string) =>
      invoke<TerminalSessionDto>(IPC_CHANNELS.terminalRename, { sessionId, title }),
    close: (sessionId: string) => invoke<void>(IPC_CHANNELS.terminalClose, { sessionId }),
    write: (sessionId: string, data: string) =>
      invoke<void>(IPC_CHANNELS.terminalWrite, { sessionId, data }),
    resize: (sessionId: string, cols: number, rows: number) =>
      invoke<void>(IPC_CHANNELS.terminalResize, { sessionId, cols, rows }),
    ack: (sessionId: string, bytes: number) =>
      invoke<void>(IPC_CHANNELS.terminalAck, { sessionId, bytes }),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: TerminalSessionDto): void =>
        callback(state)
      ipcRenderer.on(IPC_CHANNELS.terminalChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalChanged, listener)
    },
    onData: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: TerminalDataEvent): void =>
        callback(event)
      ipcRenderer.on(IPC_CHANNELS.terminalData, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalData, listener)
    },
    onOpenAt: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: TerminalOpenAtEvent): void =>
        callback(event)
      ipcRenderer.on(IPC_CHANNELS.terminalOpenAt, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalOpenAt, listener)
    }
  },
  onLog: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, line: string): void => callback(line)
    ipcRenderer.on(IPC_CHANNELS.log, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.log, listener)
  }
}

contextBridge.exposeInMainWorld('desk', api)
