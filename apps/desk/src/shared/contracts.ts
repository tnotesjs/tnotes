export const IPC_CHANNELS = {
  bootstrap: 'desk:bootstrap',
  windowClose: 'window:close',
  appBeforeClose: 'app:before-close',
  appCloseReady: 'app:close-ready',
  tabShortcut: 'tab:shortcut',
  tabConfirmClose: 'tab:confirm-close',
  contextMenuShow: 'context-menu:show',
  knowledgeSidebarMenuShow: 'knowledge-sidebar-menu:show',
  navigatorSidebarMenuShow: 'navigator-sidebar-menu:show',
  workspaceChoose: 'workspace:choose',
  workspaceSet: 'workspace:set',
  workspaceRefresh: 'workspace:refresh',
  workspaceReveal: 'workspace:reveal',
  workspaceRevealKnowledgeBase: 'workspace:reveal-knowledge-base',
  knowledgeBaseCreate: 'knowledge-base:create',
  knowledgeBaseRead: 'knowledge-base:read',
  knowledgeBaseReadSettings: 'knowledge-base:read-settings',
  knowledgeBaseWriteSettings: 'knowledge-base:write-settings',
  knowledgeBaseWriteIcon: 'knowledge-base:write-icon',
  kbOpenAssetsRequested: 'kb:open-assets-requested',
  excalidrawCreate: 'excalidraw:create',
  excalidrawRead: 'excalidraw:read',
  excalidrawWrite: 'excalidraw:write',
  excalidrawCopy: 'excalidraw:copy',
  excalidrawWriteDerived: 'excalidraw:write-derived',
  excalidrawSourceForDerived: 'excalidraw:source-for-derived',
  historyList: 'history:list',
  historySnapshot: 'history:snapshot',
  historyReadNote: 'history:read-note',
  historyReadAsset: 'history:read-asset',
  historyPlan: 'history:plan',
  historyApply: 'history:apply',
  assetsScan: 'assets:scan',
  assetsScanCancel: 'assets:scan-cancel',
  assetsSummaries: 'assets:summaries',
  assetsScanProgress: 'assets:scan-progress',
  assetsPlanRename: 'assets:plan-rename',
  assetsPlanRecycle: 'assets:plan-recycle',
  assetsPlanMerge: 'assets:plan-merge',
  assetsPreviewOptimize: 'assets:preview-optimize',
  assetsPlanOptimize: 'assets:plan-optimize',
  assetsApply: 'assets:apply',
  assetsRestore: 'assets:restore',
  assetsHistory: 'assets:history',
  assetsGateQuery: 'assets:gate-query',
  assetsGateReply: 'assets:gate-reply',
  assetsPrepareApply: 'assets:prepare-apply',
  assetsApplied: 'assets:applied',
  assetsApplySettled: 'assets:apply-settled',
  settingsUpdate: 'settings:update',
  settingsExport: 'settings:export',
  settingsImport: 'settings:import',
  settingsReset: 'settings:reset',
  settingsReadRaw: 'settings:read-raw',
  settingsWriteRaw: 'settings:write-raw',
  noteRead: 'note:read',
  noteResolveTable: 'note:resolve-table',
  noteSave: 'note:save',
  noteCreate: 'note:create',
  noteRename: 'note:rename',
  noteUpdateConfig: 'note:update-config',
  noteCopyPath: 'note:copy-path',
  noteRevealInFileManager: 'note:reveal-in-file-manager',
  attachmentWriteLocal: 'attachment:write-local',
  attachmentUploadImage: 'attachment:upload-image',
  imageTokenStatus: 'image:token-status',
  imageTokenUpdate: 'image:token-update',
  imageSettingsValidate: 'image:settings-validate',
  imageOptimizePreview: 'image:optimize-preview',
  searchQuery: 'search:query',
  kbBuild: 'kb:build',
  kbFilesList: 'kb-files:list',
  kbFilesRead: 'kb-files:read',
  gitList: 'git:list',
  gitRefresh: 'git:refresh',
  gitFetch: 'git:fetch',
  gitPull: 'git:pull',
  gitPublish: 'git:publish',
  ideShowKnowledgeBaseMenu: 'ide:show-knowledge-base-menu',
  kbOpenSettingsRequested: 'kb:open-settings-requested',
  ideShowNoteMenu: 'ide:show-note-menu',
  ideShowFileMenu: 'ide:show-file-menu',
  ideOpenKnowledgeBase: 'ide:open-knowledge-base',
  ideOpenNote: 'ide:open-note',
  tocMove: 'toc:move',
  tocCreateGroup: 'toc:create-group',
  tocRenameGroup: 'toc:rename-group',
  tocPreviewDelete: 'toc:preview-delete',
  tocCommitBeforeDelete: 'toc:commit-before-delete',
  tocDelete: 'toc:delete',
  sessionRead: 'session:read',
  sessionSave: 'session:save',
  recoveryWrite: 'recovery:write',
  recoveryDelete: 'recovery:delete',
  webCreate: 'web:create',
  webLayout: 'web:layout',
  webHideAll: 'web:hide-all',
  webClose: 'web:close',
  webNavigate: 'web:navigate',
  webGoBack: 'web:go-back',
  webGoForward: 'web:go-forward',
  webReload: 'web:reload',
  webStop: 'web:stop',
  webSelectAll: 'web:select-all',
  webOpenExternal: 'web:open-external',
  webClearBrowsingData: 'web:clear-browsing-data',
  previewStart: 'preview:start',
  previewStop: 'preview:stop',
  previewList: 'preview:list',
  workspaceChanged: 'workspace:changed',
  noteExternalChanged: 'note:external-changed',
  webStateChanged: 'web:state-changed',
  webOpenRequested: 'web:open-requested',
  previewChanged: 'preview:changed',
  terminalCreate: 'terminal:create',
  terminalList: 'terminal:list',
  terminalRestart: 'terminal:restart',
  terminalRename: 'terminal:rename',
  terminalClose: 'terminal:close',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalAck: 'terminal:ack',
  terminalChanged: 'terminal:changed',
  terminalData: 'terminal:data',
  terminalClosed: 'terminal:closed',
  terminalOpenAt: 'terminal:open-at',
  commandTaskClaim: 'command-task:claim',
  commandTaskList: 'command-task:list',
  commandTaskClose: 'command-task:close',
  commandTaskCancel: 'command-task:cancel',
  commandTaskBegin: 'command-task:begin',
  commandTaskRetry: 'command-task:retry',
  commandTaskRetryRequested: 'command-task:retry-requested',
  commandTaskStage: 'command-task:stage',
  commandTaskFinish: 'command-task:finish',
  commandTaskChanged: 'command-task:changed',
  commandTaskClosed: 'command-task:closed',
  /** 后台操作因**底部面板容量已满**而没能建出可见任务：单独记一条，不占标签 */
  backgroundFailureList: 'background-failure:list',
  backgroundFailureChanged: 'background-failure:changed',
  backgroundFailureClear: 'background-failure:clear',
  /** 仅 E2E（`DESK_E2E_EXPOSE_INTERNALS=1`）可用：注入一条"没有可见任务"的后台失败 */
  backgroundFailureInject: 'background-failure:inject',
  /** 只把剪贴板的 `text/plain` 换成给定值，**保留** `text/html` 等其它 flavor */
  clipboardSetPlainText: 'clipboard:set-plain-text',
  commandTaskLog: 'command-task:log',
  commandTaskReveal: 'command-task:reveal',
  gitStateChanged: 'git:state-changed',
  updateStatus: 'update:status',
  updateCheck: 'update:check',
  updateOpenRelease: 'update:open-release',
  updateChanged: 'update:changed',
  log: 'desk:log',
  /** 渲染端上报"当前活动编辑器的选区"（快照的唯一来源） */
  selectionReport: 'selection:report',
  /** 渲染端显式清除（用户主动取消选区 / 关闭笔记等） */
  selectionClear: 'selection:clear',
  /** 本机 MCP 服务的状态查询与开关 */
  mcpStatus: 'mcp:status',
  mcpSetEnabled: 'mcp:set-enabled',
  mcpRotateToken: 'mcp:rotate-token',
  mcpChanged: 'mcp:changed'
} as const

export interface DeskError {
  code: string
  message: string
  diagnosticId?: string
  details?: Record<string, unknown>
}

export type DeskResult<T> = { ok: true; value: T } | { ok: false; error: DeskError }

export interface WorkspaceDiagnosticDto {
  code: string
  message: string
  severity: 'error' | 'warning' | 'info'
  path?: string
}

export interface KnowledgeBaseIconDto {
  src?: string
  svg?: string
  letter?: string
}

export interface KnowledgeBaseDescriptor {
  id: string
  configId: string
  name: string
  rootPath: string
  displayName: string
  icon: KnowledgeBaseIconDto | null
  repositoryUrl?: string
  pageUrl?: string
  /** GitHub-style repo name from tnotes.json (`name`), when set. */
  configName?: string
  /** Site preview port from tnotes.json; defaults to 9193 when omitted. */
  port?: number
  rootUrl?: string
  statsEnabled?: boolean
  /** 库级约定（tnotes.json）：保存时格式化。undefined = 未设置，跟随 desk 全局。 */
  prettier?: boolean
  /** 库级约定（tnotes.json）：自动提交推送。 */
  autoPush?: { enabled: boolean; idleMinutes: number }
  /** 库级约定（tnotes.json）：标题编号层级上限（1-6）。 */
  headingNumberMaxDepth?: number
  health: 'ready' | 'invalid' | 'future-schema'
  diagnostics: WorkspaceDiagnosticDto[]
  noteCount: number
  snapshotRevision: string
}

/** Form payload for the knowledge-base settings tab. */
export interface KnowledgeBaseSettingsDto {
  knowledgeBaseId: string
  name: string
  title: string
  icon: KnowledgeBaseIconDto | null
  repositoryUrl: string
  rootUrl: string
  port: number
  pageUrl: string
  statsEnabled: boolean
  isGitRepo: boolean
  originUrl: string | null
  /** Suggested name when `name` is empty (origin / directory). */
  suggestedName: string | null
  /** 库级约定，null = 未设置（跟随 desk 全局）。 */
  prettier: boolean | null
  autoPush: { enabled: boolean; idleMinutes: number } | null
  headingNumberMaxDepth: number | null
}

export interface KnowledgeBaseSettingsWriteRequest {
  knowledgeBaseId: string
  name: string
  title: string
  repositoryUrl?: string
  rootUrl?: string
  port: number
  pageUrl?: string
  statsEnabled: boolean
  /** null = 从 tnotes.json 删除该键（跟随全局）。 */
  prettier?: boolean | null
  autoPush?: { enabled: boolean; idleMinutes: number } | null
  headingNumberMaxDepth?: number | null
}

export interface KnowledgeBaseCreateRequest {
  folderName: string
  title?: string
  /** Write package.json for CLI / local build. Implied by githubPages. */
  packageJson?: boolean
  /** Write GitHub Pages deploy.yml (also enables packageJson). */
  githubPages?: boolean
  /** Write root README.md. */
  readme?: boolean
  /** Run git init in the new knowledge-base folder. */
  gitInit?: boolean
}

export interface KnowledgeBaseCreateResult {
  overview: WorkspaceOverview
  knowledgeBaseId: string
}

export type AssetRecordStatusDto =
  'referenced' | 'idle-candidate' | 'uncertain-idle' | 'uncertain-affected' | 'protected'

export interface AssetReferenceDto {
  sourceRelPath: string
  startOffset: number
  endOffset: number
  line: number
  column: number
  rawUrl: string
  decodedPath: string
  targetRelPath: string | null
  syntax: string
  urlKind: string
  urlSuffix: string
  rewritable: boolean
  noteUuid?: string
  noteTitle?: string
}

export interface AssetRecordDto {
  relPath: string
  name: string
  size: number
  mtimeMs: number
  kind: string
  status: AssetRecordStatusDto
  references: AssetReferenceDto[]
  protection: string[]
  renameAllowed: boolean
  ownerNoteIndex?: string | null
  sha256?: string
  duplicateGroupId?: string
}

export interface AssetScanReportDto {
  generation: number
  coverageComplete: boolean
  batchCleanupAllowed: boolean
  sources: Array<{
    relPath: string
    role: string
    bytes: number
    error?: string
  }>
  assets: AssetRecordDto[]
  references: AssetReferenceDto[]
  brokenLinks: Array<{ reference: AssetReferenceDto; reason: string }>
  diagnostics: Array<{
    code: string
    message: string
    scope: string
    sourceRelPath?: string
    targetRelPath?: string
  }>
  adapters: Array<{ id: string; status: string; detail: string }>
  duplicateGroups: Array<{
    sha256: string
    ownerNoteIndex: string | null
    relPaths: string[]
    mergeable: boolean
  }>
  stats: {
    assetCount: number
    assetBytes: number
    determinedReferenceCount: number
    uncertainReferenceCount: number
    mergeableDuplicateCount: number
    crossNoteDuplicateCount: number
  }
}

export interface AssetScanProgressDto {
  knowledgeBaseId: string
  generation: number
  done: number
  total: number
  current?: string
}

export interface AssetKbSummaryDto {
  knowledgeBaseId: string
  displayName: string
  fileCount: number
  bytes: number
}

export interface AssetOperationPlanDto {
  id: string
  kind: 'rename' | 'recycle' | 'restore' | 'merge' | 'optimize'
  generation: number
  coverageComplete: boolean
  blockedReasons: string[]
  estimated: { filesTouched: number; bytesMoved: number; bytesSaved?: number }
  moves: Array<{ fromRelPath: string; toRelPath?: string }>
  sourceRelPaths: string[]
}

export interface AssetOperationResultDto {
  planId: string
  status: 'applied' | 'failed' | 'needs-recovery' | 'blocked'
  changedPaths: string[]
  recoveryId?: string
  error?: string
}

export interface AssetJournalDto {
  planId: string
  kind: 'rename' | 'recycle' | 'restore' | 'merge' | 'optimize'
  stage: string
  createdAt: string
  restorable: boolean
  estimated: { filesTouched: number; bytesMoved: number }
  moves: Array<{ fromRelPath: string; toRelPath?: string }>
}

export interface AssetGateQueryEvent {
  requestId: string
  knowledgeBaseId: string
}

export interface AssetEditorSnapshotDto {
  dirtyDocuments: Array<{ noteUuid: string; title: string; saving: boolean }>
  dirtyTabs: Array<{ type: string; title: string }>
  pendingRecoveries: Array<{ noteUuid: string; title: string }>
  pendingEdits: Array<{ noteUuid: string }>
  kbSettingsDirty: boolean
}

export interface AssetPrepareApplyEvent {
  knowledgeBaseId: string
  noteUuids: string[]
}

export interface AssetAppliedEvent {
  knowledgeBaseId: string
  noteUuids: string[]
  changedRelPaths: string[]
  revision: number
}

export interface AssetApplySettledEvent {
  knowledgeBaseId: string
  noteUuids: string[]
}

export type KnowledgeBaseIconWriteRequest =
  | {
      knowledgeBaseId: string
      kind: 'file'
      fileName: string
      data: Uint8Array
    }
  | {
      knowledgeBaseId: string
      kind: 'letter'
      letter: string
    }
  | {
      knowledgeBaseId: string
      kind: 'clear'
    }

export type DeskTocNode =
  | {
      type: 'group'
      title: string
      tocLineIndex: number
      nodeId: string
      folderPath: string[]
      children: DeskTocNode[]
    }
  | {
      type: 'note'
      uuid: string
      title: string
      dirName: string
      noteIndex: string
      tocLineIndex: number
      nodeId: string
      completed: boolean
      children: DeskTocNode[]
    }

export interface KnowledgeBaseDetail extends KnowledgeBaseDescriptor {
  toc: DeskTocNode[]
}

export interface WorkspaceOverview {
  path: string | null
  knowledgeBases: KnowledgeBaseDescriptor[]
  allKnowledgeBases: KnowledgeBaseDescriptor[]
}

export type NoteViewMode = 'visual' | 'readonly' | 'source'
export type NotePageWidth = 'standard' | 'wide'
export type NoteTocDisplay = 'hidden' | 'collapsed' | 'expanded'
export type TabCloseChoice = 'save' | 'discard' | 'cancel'
export type ContextMenuAction =
  | 'close'
  | 'close-saved'
  | 'close-all'
  | 'close-web'
  | 'copy-path'
  | 'reveal-file'
  | 'reveal-toc'
  | 'toggle-pin'
  | 'open-ide'
  | 'open-split'
  | 'show-history'
  | 'show-note-assets'
  | 'rename'
  | 'toggle-done'
  | 'add-before'
  | 'add-after'
  | 'request-delete'
export type ContextMenuRequest =
  | { kind: 'note'; pinned: boolean; completed: boolean }
  | { kind: 'group' }
  | {
      kind: 'tab'
      tabType:
        'note' | 'web' | 'kb-settings' | 'kb-assets' | 'excalidraw' | 'note-history' | 'text-file'
      pinned: boolean
    }
  | { kind: 'code-group-tab' }

export interface KnowledgeSidebarMenuRequest {
  hasWorkspace: boolean
  loading: boolean
}

export type KnowledgeSidebarMenuAction =
  'create' | 'refresh' | 'reveal-workspace' | 'choose-workspace'

export interface NavigatorSidebarMenuRequest {
  ready: boolean
  previewLabel: string
  buildBusy: boolean
}

export type NavigatorSidebarMenuAction =
  'create-note' | 'create-group' | 'preview' | 'build' | 'assets' | 'settings' | 'ide' | 'reveal'

export type TabShortcutCommand =
  | { type: 'activate-tab-by-number'; number: number; sourceTabId?: string }
  /**
   * 全选。带 `sourceTabId` 时表示这次按键发生在某个**原生网页视图**里，
   * 渲染端必须把全选交给那个网页，而不是按"当前活动标签"猜。
   */
  | { type: 'select-all'; sourceTabId?: string }
  | 'close-active-tab-or-window'
  | 'close-saved-note-tabs'
  | 'close-all-tabs'
  | 'keep-active-tab-open'
  | 'toggle-pin-active-tab'
  | 'copy-active-note-path'
  | 'reveal-active-note-in-file-manager'
  | 'next-tab'
  | 'previous-tab'
  | 'increase-app-zoom'
  | 'decrease-app-zoom'
  | 'reset-app-zoom'
  | 'open-quick-open'
  | 'open-command-palette'
export type ThemeMode = 'system' | 'light' | 'dark'
export type InterfaceDensity = 'compact' | 'comfortable'
export type IdeKind = 'vscode' | 'cursor'
export type ImageDefaultTarget = 'local' | 'github'

export interface GitHubImageSettings {
  repository: string
  branch: string
  path: string
  cdnTemplate: string
  fileNameFormat: string
}

export interface ImageUploadSettings {
  defaultTarget: ImageDefaultTarget
  github: GitHubImageSettings
  optimize: AssetOptimizeSettings
}

export type AssetOptimizeEncoder = 'sharp' | 'oxipng'
export type AssetOptimizeOutputFormat = 'keep' | 'webp' | 'jpeg'
/** 压缩强度：低=少压偏清晰，中=默认，高=多压偏体积。 */
export type AssetOptimizeStrength = 'low' | 'medium' | 'high'

export interface AssetOptimizeSettings {
  /** Default encoder. oxipng is the lossless PNG backend (slower, PNG-only). */
  encoder: AssetOptimizeEncoder
  /** Shared low/medium/high tier for sharp quality and oxipng level. */
  strength: AssetOptimizeStrength
  maxDimension: number | null
  outputFormat: AssetOptimizeOutputFormat
}

export interface AssetOptimizePreviewItemDto {
  fromRelPath: string
  toRelPath: string
  bytesBefore: number
  bytesAfter?: number
  width?: number
  height?: number
  ms: number
  skipped?: string
  lossy: boolean
  encoder: AssetOptimizeEncoder
  format?: string
  previewDataUrl?: string
}

export interface AssetOptimizePreviewDto {
  items: AssetOptimizePreviewItemDto[]
  bytesBefore: number
  bytesAfter: number
  skippedCount: number
}

/**
 * 设置页「压缩效果测试」入参：临时上传一张图，只做本地编码预览。
 * 不写文件、不碰任何知识库，渲染进程关闭面板即丢弃。
 */
export interface ImageOptimizePreviewRequest {
  fileName: string
  data: Uint8Array
  options: AssetOptimizeSettings
}

export interface ImageOptimizePreviewResult {
  bytesBefore: number
  bytesAfter?: number
  width?: number
  height?: number
  ms: number
  lossy: boolean
  encoder: 'sharp' | 'oxipng'
  format?: string
  outputExt?: string
  /** 命中跳过规则时的原因（如「优化后没有变小」）；此时不返回 output。 */
  skipped?: string
  /** 编码结果，仅供渲染进程做对比预览，不落盘。 */
  output?: Uint8Array
}

export interface KnowledgeBaseSettings {
  hidden?: boolean
}

export interface AppSettings {
  version: 1
  theme: ThemeMode
  density: InterfaceDensity
  defaultNoteView: NoteViewMode
  defaultNotePageWidth: NotePageWidth
  noteTocDisplay: NoteTocDisplay
  /** 标题编号层级上限（1-6）：1. 与 1.1. 允许出现的最大段数。 */
  headingNumberMaxDepth: number
  appZoomPercent: number
  autosave: {
    enabled: boolean
    delayMs: number
  }
  createNotePosition: 'top' | 'end'
  workspaceLayout: 'kb-dir-content' | 'content-dir-kb'
  prettier: boolean
  ide: IdeKind
  gitPath: string | null
  nodePath: string | null
  confirmBeforeCommit: boolean
  /**
   * Git 后台行为。
   *
   * `autoFetch` 默认 **false**：Desk 不会在后台自动联网抓取远端状态，只有用户
   * 明确打开后才会在打开知识库时与每 5 分钟定时抓取。手动 fetch / pull 不受影响。
   */
  git: {
    autoFetch: boolean
  }
  tabs: {
    maxOpenCount: number
    wrap: boolean
    autoRevealInToc: boolean
  }
  /**
   * 底部面板（终端会话 + 命令任务标签）的容量。
   *
   * 上限是**两类标签的合计**；默认 10，上界 30（见 `main/settings.ts` 的 zod schema）。
   * 判定规则收在 `shared/bottomPanelTabs.ts`，主进程与渲染端共用。
   */
  bottomPanel: {
    maxTabs: number
  }
  toc: {
    showNoteIndex: boolean
    showNoteStatus: boolean
    changesCollapsedByDefault: boolean
  }
  /** 编辑器行为。`selectionToolbar` 默认关闭（选中文字不弹浮动格式条）。 */
  editor: {
    selectionToolbar: boolean
  }
  /**
   * 本机 MCP 选区上下文服务。
   *
   * 默认**关闭**；`port` 固定（默认 39217）——端口被占用时如实报错，不自动换端口，
   * 否则已经配好的客户端会失联。令牌单独存在系统凭据存储里，不写进这里。
   */
  mcp: {
    enabled: boolean
    port: number
  }
  imageUpload: ImageUploadSettings
  updates: {
    autoCheck: boolean
  }
  hiddenKnowledgeBases: string[]
  knowledgeBases: Record<string, KnowledgeBaseSettings>
}

export type UpdateStateKind = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error'

export interface UpdateStatusDto {
  state: UpdateStateKind
  currentVersion: string
  latestVersion?: string
  releaseUrl?: string
  checkedAt?: string
  message?: string
}

export interface BootstrapPayload {
  workspace: WorkspaceOverview
  settings: AppSettings
  platform: 'darwin' | 'win32' | 'linux'
  session: WorkspaceSession | null
  recoveries: RecoveryRecord[]
}

export interface RecoveryRecord {
  version: 1
  knowledgeBaseId: string
  noteUuid: string
  /** Missing for README.md recoveries created by older Desk releases. */
  path?: string
  title: string
  content: string
  revision: string
  updatedAt: string
}

export interface RecoveryWriteRequest {
  knowledgeBaseId: string
  noteUuid: string
  path?: string
  title: string
  content: string
  revision: string
}

export interface RecoveryDeleteRequest {
  knowledgeBaseId: string
  noteUuid: string
  path?: string
}

export interface NoteEditorTab {
  id: string
  type: 'note'
  knowledgeBaseId: string
  knowledgeBaseName: string
  noteUuid: string
  title: string
  icon: KnowledgeBaseIconDto | null
  viewMode: NoteViewMode
  pageWidth: NotePageWidth
  /** Side outline next to the visual editor. Default true. */
  outlineVisible?: boolean
  /** 右侧「本笔记资源」面板是否展开（默认收起） */
  noteAssetsVisible?: boolean
  preview?: boolean
  pinned?: boolean
  openedAt?: number
  dirty?: boolean
}

export interface WebEditorTab {
  id: string
  type: 'web'
  url: string
  title: string
  pinned?: boolean
  openedAt?: number
}

export interface KbSettingsEditorTab {
  id: string
  type: 'kb-settings'
  knowledgeBaseId: string
  knowledgeBaseName: string
  title: string
  icon: KnowledgeBaseIconDto | null
  pinned?: boolean
  openedAt?: number
  dirty?: boolean
}

export interface KbAssetsEditorTab {
  id: string
  type: 'kb-assets'
  knowledgeBaseId: string
  knowledgeBaseName: string
  title: string
  icon: KnowledgeBaseIconDto | null
  pinned?: boolean
  openedAt?: number
  dirty?: boolean
}

/**
 * 画布源文件的独立标签页。`relPath` 是 KB 相对路径（assets/*.excalidraw），
 * 归属由文件名四位前缀决定；文件缺失/损坏时 `invalid` 置位，只显示失效状态，
 * 不按旧路径自动重建。
 */
export interface HistoryRestorePlanRequest {
  knowledgeBaseId: string
  noteIndex: string
  /** 恢复来源（完整 40 位 OID） */
  commit: string
  /** 计划创建时的 HEAD；不一致说明外部动过仓库 */
  expectedHead?: string
  /** 渲染端 flush 之后的写者快照；有未完成写入时主进程拒绝创建计划 */
  writers?: AssetEditorSnapshotDto
}

export interface HistoryRestorePlanDto {
  planId: string
  revision: number
  knowledgeBaseId: string
  sourceCommit: string
  head: string
  noteIndex: string
  note: { relPath: string; bytes: number }
  resources: Array<{ relPath: string; bytes: number }>
  /** 当前版本里较新、恢复时保留的资源 */
  preserved: Array<{ relPath: string; bytes: number }>
  writeCount: number
  totalBytes: number
  backupMessage: string
  backupRequired: boolean
  limitations: Array<{ code: string; message: string }>
}

export interface HistoryApplyRequest {
  planId: string
  revision: number
}

export interface HistoryApplyResultDto {
  operationId: string
  backupCommit: string | null
  restoreCommit: string | null
  writtenPaths: string[]
  /** 计划创建后 HEAD 已被外部改动（备份仍然保留） */
  headDrift: boolean
}

/**
 * 知识库里的普通文本文件（`.gitignore`、README、JSON/YAML 配置…）。
 *
 * 与笔记标签的区别：没有 noteUuid、不走笔记会话；本阶段**只读**，
 * 所以没有 dirty，也不参与笔记的保存/关闭确认流程。
 */
export interface TextFileEditorTab {
  id: string
  type: 'text-file'
  knowledgeBaseId: string
  knowledgeBaseName: string
  /** 库根相对路径（posix） */
  relPath: string
  title: string
  icon: KnowledgeBaseIconDto | null
  pinned?: boolean
  openedAt?: number
  /** 本阶段只读，恒为 false；可写文件会话接进来时复用同一字段 */
  dirty?: boolean
}

export interface ExcalidrawEditorTab {
  id: string
  type: 'excalidraw'
  knowledgeBaseId: string
  knowledgeBaseName: string
  relPath: string
  ownerNoteIndex: string | null
  title: string
  icon: KnowledgeBaseIconDto | null
  pinned?: boolean
  openedAt?: number
  dirty?: boolean
  invalid?: boolean
}

/**
 * 笔记历史标签页（计划 H3 会补齐列表/分页/恢复门禁）。
 * 同一 KB + 同一编号只保留一个历史标签页，切换 commit 只更新该页内的选中版本。
 */
export interface NoteHistoryEditorTab {
  id: string
  type: 'note-history'
  knowledgeBaseId: string
  knowledgeBaseName: string
  noteIndex: string
  noteUuid?: string
  /** 当前选中的历史 commit（完整 40 位 OID） */
  commit: string
  title: string
  icon: KnowledgeBaseIconDto | null
  pinned?: boolean
  openedAt?: number
}

export interface HistoryListRequest {
  knowledgeBaseId: string
  /** 只看与该四位编号相关的提交（笔记文件 + 同编号资源） */
  noteIndex?: string
  head?: string
  skip?: number
  limit?: number
}

export interface HistoryCommitSummaryDto {
  oid: string
  shortOid: string
  committedAt: number
  authorName: string
  subject: string
  parents: string[]
  changedPaths: string[]
  isMerge: boolean
  touchesIndex: boolean
}

export interface HistoryListResultDto {
  head: string
  commits: HistoryCommitSummaryDto[]
  hasMore: boolean
  /** 浅克隆：历史只到克隆深度，更早版本不在本地 */
  shallow: boolean
  /** 命中扫描上限：更早的相关提交没有被全部读出 */
  truncated: boolean
}

export interface HistorySnapshotRequest {
  knowledgeBaseId: string
  commit: string
  noteIndex: string
  noteUuid?: string
}

export interface HistoryTreeEntryDto {
  relPath: string
  oid: string
  mode: string
  size: number
}

export interface HistorySnapshotDto {
  commit: string
  noteIndex: string
  note: { relPath: string; oid: string; noteUuid: string | null } | null
  ambiguousNotePaths: string[]
  assets: HistoryTreeEntryDto[]
  noteCandidates: HistoryTreeEntryDto[]
  limitations: Array<{ code: string; message: string }>
}

export interface HistoryNoteDto {
  commit: string
  relPath: string
  oid: string
  bytes: number
  text: string | null
  snapshot: HistorySnapshotDto
}

export interface HistoryAssetRequest {
  knowledgeBaseId: string
  commit: string
  relPath: string
}

export interface HistoryAssetDto {
  oid: string
  bytes: number
  /** 供渲染端拼 data URL / 缓存用；实际字节走 tnotes-asset://history 协议 */
  url: string
  contentType: string
}

export type EditorTab =
  | NoteEditorTab
  | WebEditorTab
  | KbSettingsEditorTab
  | KbAssetsEditorTab
  | ExcalidrawEditorTab
  | TextFileEditorTab
  | NoteHistoryEditorTab

export interface EditorGroupNode {
  type: 'group'
  id: string
  tabs: EditorTab[]
  activeTabId: string | null
}

export interface EditorSplitNode {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  ratio: number
  first: EditorLayoutNode
  second: EditorLayoutNode
}

export type EditorLayoutNode = EditorGroupNode | EditorSplitNode

export interface KnowledgeBaseEditorSession {
  layout: EditorLayoutNode
  activeGroupId: string
  lastNoteByGroup?: Record<string, { noteUuid: string; noteTitle: string }>
}

export interface WorkspaceSession {
  version: 1
  selectedKnowledgeBaseId: string | null
  layout: EditorLayoutNode
  activeGroupId: string
  knowledgeBaseEditors: Record<string, KnowledgeBaseEditorSession>
  knowledgeSidebarWidth: number
  navigatorSidebarWidth: number
  knowledgeSidebarCollapsed: boolean
  navigatorSidebarCollapsed: boolean
  expandedTocNodes: Record<string, string[]>
}

export interface WebBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WebCreateRequest {
  tabId: string
  url: string
}

export interface WebLayoutRequest {
  tabId: string
  visible: boolean
  bounds?: WebBounds
}

export interface WebNavigateRequest {
  tabId: string
  url: string
}

export interface WebTabState {
  tabId: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  faviconUrl?: string
  error?: string
}

export interface WebOpenRequestedEvent {
  sourceTabId: string
  url: string
}

export interface PreviewStateDto {
  knowledgeBaseId: string
  knowledgeBaseName: string
  status: 'idle' | 'starting' | 'ready' | 'error'
  port: number | null
  baseUrl: string | null
  error: string | null
}

export interface PreviewStartRequest {
  knowledgeBaseId: string
  noteDirName?: string
}

export interface PreviewStartResult {
  state: PreviewStateDto
  url: string | null
}

/**
 * 一个终端会话。`status` 是进程状态，`title` 是用户可改的标签名。
 *
 * 目录归属（`cwd`）在会话创建时就固定：切换知识库**不会**改变已有会话的工作目录，
 * 避免命令跑到别的库里执行；新会话才用当前库的根目录。
 */
export interface TerminalSessionDto {
  id: string
  /**
   * 运行代次：每次 spawn（含重启）自增。
   *
   * 重启会复用 sessionId，但**旧进程的输入、输出与回执都不能作用于新进程**：
   * 渲染端用 `sessionId + generation` 做消费端归属，主进程按代次校验 write/ack，
   * 于是 50ms 延迟回执、未发完的粘贴、以及残留的 xterm 写回调都会被自然丢弃。
   */
  generation: number
  /** 创建时的所属知识库；仅用于归属展示与退出清理，切换库不改它 */
  knowledgeBaseId: string
  knowledgeBaseName: string
  title: string
  /** 会话创建时固定的工作目录 */
  cwd: string
  shell: string
  status: 'running' | 'exited'
  pid: number | null
  cols: number
  rows: number
  exitCode: number | null
  exitSignal: number | null
  /** 创建失败或进程异常时的原因，供标签页展示 */
  error: string | null
  createdAt: number
}

export interface TerminalCreateRequest {
  knowledgeBaseId: string
  /** 不传则用该知识库根目录 */
  cwd?: string
  cols?: number
  rows?: number
}

/**
 * 主进程请求「在这个目录开一个终端」（来自目录右键菜单）。
 * 渲染端只负责建会话，不参与路径解析——路径在主进程已经校验过在库内。
 */
/**
 * 命令任务的种类。
 * `launch-*` 只管理**启动器**，不代表 IDE 本身的生命周期。
 */
export type CommandTaskKind = 'git-pull' | 'git-push' | 'git-fetch' | 'launch-ide'

/**
 * 执行阶段。`queued` 起就有反馈——不等真正的子进程启动才显示。
 * `saving` 是推送前的受控保存，`precheck` 是门禁/业务检查。
 */
export type CommandTaskStage =
  | 'queued'
  | 'saving'
  | 'precheck'
  | 'running'
  /** 已发出终止信号、等待进程真正退出。此时不允许重试。 */
  | 'canceling'
  | 'finished'

export type CommandTaskStatus =
  | 'queued'
  | 'saving'
  | 'precheck'
  | 'running'
  /** 取消中：进程尚未确认退出 */
  | 'canceling'
  | 'done'
  | 'failed'
  | 'timeout'
  | 'canceled'

export interface CommandTaskDto {
  id: string
  knowledgeBaseId: string
  knowledgeBaseName: string
  kind: CommandTaskKind
  title: string
  /** 工作目录（知识库根或启动器目标路径） */
  cwd: string
  /** 实际执行的命令行；启动器场景是启动命令 */
  command: string
  status: CommandTaskStatus
  stage: CommandTaskStage
  stageLabel: string
  /** 每次运行自增：界面据此丢弃上一轮的迟到输出 */
  run: number
  startedAt: number
  finishedAt: number | null
  /** 失败/超时/取消的原因；与已保留的输出并存，不覆盖输出 */
  error: string | null
  /** 已推送的日志字节数 */
  logBytes: number
  /** 因上限被丢弃的字节数（>0 时界面显示截断提示） */
  truncatedBytes: number
  /**
   * 是否由后台调度（定时 fetch / 自动推送）发起。
   *
   * 后台失败要**聚合**成一条通知（多个知识库同时失败不刷屏）；手动操作仍逐条提示。
   */
  background: boolean
  /**
   * 这一轮是否应触发失败通知。
   *
   * 后台同一知识库的相同失败在去抖窗口内重复发生时置 false：任务明细照常保留
   * （面板里能翻到、能看输出），只是不再弹一次通知。
   */
  notify: boolean
}

/** 分批推送的日志片段。`data` 里 `\u0000stderr\u0001` 前缀标记 stderr。 */
export interface CommandTaskLogEvent {
  taskId: string
  run: number
  data: string
  bytes: number
  truncatedBytes: number
}

export interface CommandTaskClaimRequest {
  knowledgeBaseId: string
  kind: CommandTaskKind
  title: string
  cwd: string
  command?: string
}

export interface TerminalOpenAtEvent {
  knowledgeBaseId: string
  cwd: string
}

/** PTY 输出分片。`bytes` 是 `data` 的 UTF-8 字节数，渲染端按此累加回执。 */
export interface TerminalDataEvent {
  sessionId: string
  /** 产出这段数据的运行代次；渲染端回执时必须原样带回 */
  generation: number
  data: string
  bytes: number
}

export interface NoteDocumentDto {
  knowledgeBaseId: string
  uuid: string
  index: string
  title: string
  /** File stem, e.g. "0001. 标题" (kept for display/preview URLs). */
  dirName: string
  /** File name inside notes/, e.g. "0001. 标题.md". */
  fileName: string
  /** POSIX path relative to the kb root. */
  relPath: string
  /** Absolute path of the single note file. */
  filePath: string
  content: string
  revision: string
  config: NoteConfigDto
  readOnly: boolean
}

/** Slimmed note config: description from frontmatter, done from TOC. */
export interface NoteConfigDto {
  done: boolean
  description?: string
}

/** Rows for `<NotesTable>` preview — Desk adapter over workspace snapshot. */
export interface NotesTableResolveRowDto {
  id: string
  title: string
  description: string
  /** Present when the id maps to a note in this knowledge base. */
  noteUuid: string | null
}

export interface NotesTableResolveRequest {
  knowledgeBaseId: string
  ids: string[]
}

export interface NotesTableResolveResult {
  notes: NotesTableResolveRowDto[]
  missingIds: string[]
}

export interface NoteMutationDto {
  note: NoteDocumentDto
  knowledgeBase: KnowledgeBaseDetail
  changedFiles: Array<{
    path: string
    kind: 'created' | 'updated' | 'deleted' | 'renamed' | 'trashed'
    previousPath?: string
  }>
}

export interface NoteSaveRequest {
  knowledgeBaseId: string
  noteUuid: string
  content: string
  expectedRevision: string
  prettier?: boolean
}

export interface NoteCreateRequest {
  knowledgeBaseId: string
  title: string
  placement?:
    | { type: 'root'; placement?: 'start' | 'end' }
    | {
        type: 'note'
        targetNoteUuid: string
        placement: 'before' | 'after' | 'inside'
      }
    | {
        type: 'folder'
        folderPath: string[]
        placement: 'before' | 'after' | 'inside'
      }
  expectedSnapshotRevision?: string
}

export interface NoteRenameRequest {
  knowledgeBaseId: string
  noteUuid: string
  title: string
  expectedRevision: string
}

export interface NoteUpdateConfigRequest {
  knowledgeBaseId: string
  noteUuid: string
  expectedRevision: string
  updates: {
    done?: boolean
    description?: string
  }
}

export interface AttachmentWriteLocalRequest {
  knowledgeBaseId: string
  /** Owning note — local paste names start with this note's 4-digit index. */
  noteUuid: string
  fileName: string
  data: Uint8Array
}

export interface AttachmentWriteLocalResult {
  absolutePath: string
  markdownPath: string
  reused?: boolean
}

export interface ImageUploadRequest extends AttachmentWriteLocalRequest {}

export interface ImageUploadResult {
  markdownPath: string
  target: ImageDefaultTarget
  fallback: boolean
  absolutePath?: string
  remotePath?: string
  warning?: string
}

export interface ImageTokenStatus {
  configured: boolean
  encryptionAvailable: boolean
}

export interface ImageTokenUpdateRequest {
  token?: string
  clear: boolean
}

export interface ImageSettingsValidateRequest {
  github: GitHubImageSettings
  token?: string
}

export interface ImageSettingsValidateResult {
  repository: string
  branch: string
  message: string
}

export interface SearchRequest {
  query: string
  knowledgeBaseId: string | null
  limit?: number
}

export interface SearchResultDto {
  knowledgeBaseId: string
  knowledgeBaseName: string
  noteUuid: string
  noteIndex: string
  /** Real note folder / file stem, e.g. "0001. 标题". */
  fileName: string
  title: string
  snippet: string
  score: number
}

export type GitFileStatus =
  'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

export interface DeleteCommitResultDto {
  /** null 表示该范围相对 HEAD 没有变化，未产生提交 */
  commit: string | null
  /** 提交后重新预览的结果（未跟踪/未提交计数应为 0） */
  preview: DeletePreviewDto
}

export interface GitFileChangeDto {
  path: string
  previousPath?: string
  status: GitFileStatus
  staged: boolean
  worktree: boolean
  noteUuid?: string
  noteIndex?: string
  noteTitle?: string
}

export interface GitRepositoryStateDto {
  knowledgeBaseId: string
  knowledgeBaseName: string
  initialized: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  changes: GitFileChangeDto[]
  conflict: boolean
  busy: 'fetch' | 'pull' | 'publish' | null
  lastFetchedAt: string | null
  error: string | null
}

/**
 * 后台操作**没能建出可见任务**时的失败记录（当前只有一种成因：底部面板标签已达上限）。
 *
 * 这类失败不能只写日志：面板里没有它的任务、也就没有「查看输出」入口。这里保留
 * 真实错误原文与发生时间，由设置里的「Git 与远端」分组展示，**不占用面板标签**。
 */
export interface BackgroundFailureDto {
  id: string
  knowledgeBaseId: string
  knowledgeBaseName: string
  kind: 'git-fetch' | 'git-push'
  /** 失败原因（主进程给出的原文，不加工） */
  message: string
  /** 为什么没有可见任务（例如"底部面板标签已达上限"） */
  reason: string
  at: string
  /** 同一 (库, 操作, 原因, 消息) 重复发生的次数（重复只累加计数，不刷多条） */
  count: number
}

export interface GitOperationResult {
  state: GitRepositoryStateDto
  message: string
  conflict: boolean
}

export interface KbBuildResult {
  outDir: string
  pageCount: number
}

export type TocEntryRefDto =
  | { type: 'note'; noteUuid: string }
  | { type: 'folder'; folderPath: string[] }
  | { type: 'line'; tocLineIndex: number }

export interface TocMoveRequest {
  knowledgeBaseId: string
  source: TocEntryRefDto
  target: TocEntryRefDto
  placement: 'before' | 'after' | 'inside'
  expectedSnapshotRevision: string
}

export interface TocCreateGroupRequest {
  knowledgeBaseId: string
  title: string
  placement?: NoteCreateRequest['placement']
  expectedSnapshotRevision: string
}

export interface TocRenameGroupRequest {
  knowledgeBaseId: string
  folderPath: string[]
  title: string
  expectedSnapshotRevision: string
}

export interface TocDeleteRequest {
  knowledgeBaseId: string
  entry: TocEntryRefDto
  expectedSnapshotRevision: string
}

/** 画布源文件（`.excalidraw`）的受限读写结果。 */
export interface ExcalidrawDocumentRefDto {
  knowledgeBaseId: string
  relPath: string
  ownerNoteIndex: string
  revision: string
}

export interface ExcalidrawDocumentDto extends ExcalidrawDocumentRefDto {
  content: string
  /** JSON/type 校验是否通过；false 时宿主只报错，不得写回 */
  valid: boolean
  bytes: number
}

export interface ExcalidrawCreateRequest {
  knowledgeBaseId: string
  /** 归属笔记：主进程据此解析四位编号前缀 */
  noteUuid: string
  content?: string
}

export interface ExcalidrawReadRequest {
  knowledgeBaseId: string
  relPath: string
}

export interface ExcalidrawWriteRequest {
  knowledgeBaseId: string
  relPath: string
  content: string
  expectedRevision: string
}

export interface ExcalidrawCopyRequest {
  knowledgeBaseId: string
  fromRelPath: string
  /** 目标笔记：复制后必须换前缀 */
  toNoteUuid: string
}

/**
 * 派生 SVG：笔记里引用的那张图。
 *
 * 路径由主进程从源画布推出（同目录同名），渲染端指定不了 —— 否则等于开了一条
 * 往 assets/ 里写任意 `.svg` 的口子。
 */
export interface ExcalidrawDerivedWriteRequest {
  knowledgeBaseId: string
  /** 源画布（assets/*.excalidraw）；必须已存在 */
  sourceRelPath: string
  content: string
}

export interface ExcalidrawDerivedRefDto {
  knowledgeBaseId: string
  relPath: string
  sourceRelPath: string
  ownerNoteIndex: string
}

/** 「这张 `.svg` 能不能编辑」的唯一判据：同名 `.excalidraw` 在不在 */
export interface ExcalidrawSourceProbeRequest {
  knowledgeBaseId: string
  relPath: string
}

export interface ExcalidrawSourceProbeDto {
  /** 同名源画布；null = 就是一张普通图片 */
  source: { relPath: string; ownerNoteIndex: string } | null
}

/** 知识库文件浏览：只列一层，拒绝名单由主进程统一裁定 */
export interface KbFilesListRequest {
  knowledgeBaseId: string
  /** 库根相对路径；空串表示库根 */
  relPath: string
}

export interface KbFileEntryDto {
  name: string
  relPath: string
  kind: 'directory' | 'file'
  bytes: number | null
  textLike: boolean
}

export interface KbFilesListResultDto {
  /** 规范化后的目录路径（空串 = 库根） */
  relPath: string
  entries: KbFileEntryDto[]
}

export interface KbFilesReadRequest {
  knowledgeBaseId: string
  relPath: string
}

export interface KbTextFileDto {
  relPath: string
  content: string
  bytes: number
  /** 原始字节 hash：后续"可写 + 冲突保护"复用 */
  revision: string
  hasBom: boolean
  eol: 'lf' | 'crlf' | 'mixed' | 'none'
  language: string
  /** 本阶段一律 false */
  writable: boolean
  /** 不可写的说明，直接给 UI */
  writableReason: string
}

export interface DeletePreviewDto {
  knowledgeBaseId: string
  entry: TocEntryRefDto
  notes: Array<{
    noteUuid: string
    index: string
    title: string
    directoryPath: string
  }>
  filePaths: string[]
  directoryPaths: string[]
  untrackedFilePaths: string[]
  /** 已跟踪但有未提交改动的文件（这些内容删除后 git 里没有） */
  uncommittedFilePaths: string[]
  /** Git 状态是否已就绪；未就绪时不能声称「都已提交」 */
  gitReady: boolean
  snapshotRevision: string
}

export interface ExternalNoteChangeEvent {
  knowledgeBaseId: string
  noteUuid: string
}

/* ------------------------------------------------------------------ */
/* 本机 MCP 选区上下文服务（只读）                                     */
/* ------------------------------------------------------------------ */

/**
 * 快照状态。**没有选区 / 不支持 / 已失效 / 超出上限都是结构化结果**，
 * 不作为服务器异常，也不回退成"整篇笔记"或"上一次别的笔记的内容"。
 */
export type SelectionStatus =
  'ok' | 'no_selection' | 'unsupported_selection' | 'selection_invalidated' | 'context_too_large'

/** 采集来源：源码视图（Monaco）/ 可视化视图（ProseMirror）/ 只读视图。 */
export type SelectionCollector = 'source' | 'visual' | 'readonly'

/** 内容来自编辑器草稿还是磁盘上已保存的版本。 */
export type SelectionContentSource = 'draft' | 'disk'

/**
 * 选区坐标。**计数规则**：行列 1-based；offset 0-based、按 UTF-16 code unit 计
 * （与 JS 字符串一致，emoji 等代理对按 2 计）；结束边界**不含**。
 * `source` 标明这份坐标对应草稿还是磁盘内容 —— 两者可能不同，不能混用。
 */
export interface SelectionRangeDto {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  startOffset: number
  endOffset: number
  lineBase: 1
  columnBase: 1
  endExclusive: true
  source: SelectionContentSource
}

/** 选区涉及的相关块（只含涉及的块，不附带整篇笔记）。 */
export interface SelectionBlockDto {
  /** 块类型：paragraph / heading / code / blockquote / list / container / raw-block … */
  kind: string
  /** 该块的 Markdown */
  markdown: string
  /**
   * `raw`：与编辑器里的原文逐字一致（源码视图）；
   * `reserialized`：编辑器重新序列化得到的，**未必**与原文件逐字相同（可视化视图）。
   */
  source: 'raw' | 'reserialized'
  /** 块在源码里的行范围（能可靠给出时才给） */
  sourceRange?: { startLine: number; endLine: number }
}

export interface SelectionContextSnapshotDto {
  status: SelectionStatus
  /** 每次有效快照一个 id；失效 / 清除后不再提供旧内容 */
  snapshotId: string | null
  /** ISO 时间戳，只用于展示，**不是**版本标识 */
  capturedAt: string | null
  /** status 不是 ok 时的人类可读原因 */
  message?: string
  knowledgeBase?: { id: string; name: string; rootPath: string }
  note?: { id: string; title: string; absolutePath: string }
  editor?: {
    viewMode: NoteViewMode
    collector: SelectionCollector
    contentSource: SelectionContentSource
    hasUnsavedChanges: boolean
    /** 内容版本（笔记文档 revision，草稿变动时递增），**不是**时间戳 */
    revision: string
  }
  selection?: {
    selectedText: string
    /** `source-range`：能精确映射到源码；`block`：只有块级上下文 */
    mapping: 'source-range' | 'block'
    sourceRange?: SelectionRangeDto
    blocks: SelectionBlockDto[]
  }
  /** 上限（超限时给出，便于 Agent 提示用户缩小选区） */
  limits: { maxSelectedChars: number; maxBlockChars: number; maxBlocks: number }
}

/** 渲染端上报的选区（编辑器层：只描述"选了什么"） */
export interface SelectionCaptureDto {
  collector: SelectionCollector
  /** 空选区 = 用户取消了选区 */
  empty: boolean
  selectedText?: string
  sourceRange?: SelectionRangeDto
  blocks?: SelectionBlockDto[]
  /** 不支持的原因（多选区 / 无法可靠映射 …） */
  unsupportedReason?: string
  /** 选区超出上限时由渲染端先算好 */
  selectedChars?: number
}

/**
 * 渲染端上报的完整快照（笔记身份 + 编辑器状态 + 选区）。
 *
 * **原子性**：这些字段必须来自同一次读取，主进程按整包替换，不会出现
 * "笔记来自 A、选区文字来自 B"。
 */
export interface SelectionReportRequest {
  knowledgeBase: { id: string; name: string; rootPath: string }
  note: { id: string; title: string; absolutePath: string }
  editor: {
    viewMode: NoteViewMode
    contentSource: SelectionContentSource
    hasUnsavedChanges: boolean
    revision: string
  }
  capture: SelectionCaptureDto
}

export interface SelectionClearRequest {
  /** 便于诊断：为什么清除（用户取消 / 关闭笔记 / 切走 …） */
  reason: string
  /** 只清除"确实是这个笔记"的快照，避免竞态把新快照清掉 */
  noteId?: string
}

/** 本机 MCP 服务默认端口：固定值，客户端配置可以长期不变 */
export const DEFAULT_MCP_PORT = 39217

/** 本机 MCP 服务的 Streamable HTTP 路径 */
export const MCP_PATH = '/mcp'

export interface McpServerStatusDto {
  /** 设置里的开关（用户意图） */
  enabled: boolean
  /** 进程内实际是否在监听 */
  running: boolean
  /** 实际连接地址（Streamable HTTP endpoint），未运行时为 null */
  url: string | null
  /** 连接令牌（明文只给渲染端设置界面展示 / 复制；不写日志） */
  token: string
  /** 启动失败原因（端口占用等），成功时为 null */
  error: string | null
  /** 当前保持中的客户端会话数 */
  sessions: number
  /** 最近一次工具调用时间（ISO） */
  lastCallAt: string | null
}

export interface McpRotateTokenResult {
  status: McpServerStatusDto
}

export interface DeskApi {
  bootstrap(): Promise<DeskResult<BootstrapPayload>>
  app: {
    closeWindow(): Promise<DeskResult<void>>
    /** 主进程在关窗 / 退出前请求渲染端 flush 未保存内容 */
    onBeforeClose(callback: () => void): () => void
    /** 渲染端回执：proceed=false 表示用户取消了退出 */
    confirmCloseReady(proceed: boolean): Promise<DeskResult<void>>
    confirmTabClose(titles: string[]): Promise<DeskResult<TabCloseChoice>>
    showContextMenu(request: ContextMenuRequest): Promise<DeskResult<ContextMenuAction | null>>
    showKnowledgeSidebarMenu(
      request: KnowledgeSidebarMenuRequest
    ): Promise<DeskResult<KnowledgeSidebarMenuAction | null>>
    showNavigatorSidebarMenu(
      request: NavigatorSidebarMenuRequest
    ): Promise<DeskResult<NavigatorSidebarMenuAction | null>>
    onTabShortcut(callback: (command: TabShortcutCommand) => void): () => void
  }
  updates: {
    status(): Promise<DeskResult<UpdateStatusDto>>
    check(): Promise<DeskResult<UpdateStatusDto>>
    openReleasePage(): Promise<DeskResult<void>>
    onChanged(callback: (status: UpdateStatusDto) => void): () => void
  }
  workspace: {
    choose(): Promise<DeskResult<WorkspaceOverview>>
    set(path: string | null): Promise<DeskResult<WorkspaceOverview>>
    refresh(): Promise<DeskResult<WorkspaceOverview>>
    /** Open the workspace folder in the system file manager. */
    reveal(): Promise<DeskResult<void>>
    revealKnowledgeBase(knowledgeBaseId: string): Promise<DeskResult<void>>
    onChanged(callback: (overview: WorkspaceOverview) => void): () => void
  }
  settings: {
    update(next: Partial<AppSettings>): Promise<DeskResult<AppSettings>>
    export(): Promise<DeskResult<void>>
    import(): Promise<DeskResult<AppSettings>>
    reset(): Promise<DeskResult<AppSettings>>
    readRaw(): Promise<DeskResult<string>>
    writeRaw(json: string): Promise<DeskResult<AppSettings>>
    imageTokenStatus(): Promise<DeskResult<ImageTokenStatus>>
    updateImageToken(request: ImageTokenUpdateRequest): Promise<DeskResult<ImageTokenStatus>>
    validateImageSettings(
      request: ImageSettingsValidateRequest
    ): Promise<DeskResult<ImageSettingsValidateResult>>
    /** 设置页测试用：临时编码一张图，仅返回对比数据，不落盘。 */
    previewOptimizeImage(
      request: ImageOptimizePreviewRequest
    ): Promise<DeskResult<ImageOptimizePreviewResult>>
  }
  knowledgeBases: {
    create(request: KnowledgeBaseCreateRequest): Promise<DeskResult<KnowledgeBaseCreateResult>>
    read(knowledgeBaseId: string): Promise<DeskResult<KnowledgeBaseDetail>>
    readSettings(knowledgeBaseId: string): Promise<DeskResult<KnowledgeBaseSettingsDto>>
    writeSettings(
      request: KnowledgeBaseSettingsWriteRequest
    ): Promise<DeskResult<KnowledgeBaseDetail>>
    writeIcon(request: KnowledgeBaseIconWriteRequest): Promise<DeskResult<KnowledgeBaseDetail>>
    /** main → renderer：右键菜单点了「知识库配置」。 */
    onOpenSettingsRequested(callback: (knowledgeBaseId: string) => void): () => void
    /** main → renderer：右键菜单点了「资源」。 */
    onOpenAssetsRequested(callback: (knowledgeBaseId: string) => void): () => void
  }
  kbFiles: {
    list(request: KbFilesListRequest): Promise<DeskResult<KbFilesListResultDto>>
    read(request: KbFilesReadRequest): Promise<DeskResult<KbTextFileDto>>
  }
  excalidraw: {
    create(request: ExcalidrawCreateRequest): Promise<DeskResult<ExcalidrawDocumentRefDto>>
    read(request: ExcalidrawReadRequest): Promise<DeskResult<ExcalidrawDocumentDto>>
    write(request: ExcalidrawWriteRequest): Promise<DeskResult<ExcalidrawDocumentRefDto>>
    copy(request: ExcalidrawCopyRequest): Promise<DeskResult<ExcalidrawDocumentRefDto>>
    writeDerived(
      request: ExcalidrawDerivedWriteRequest
    ): Promise<DeskResult<ExcalidrawDerivedRefDto>>
    sourceForDerived(
      request: ExcalidrawSourceProbeRequest
    ): Promise<DeskResult<ExcalidrawSourceProbeDto>>
  }
  /** 只读历史：列表 / 快照 / 正文与资源字节（全部限制在已校验的 commit + path） */
  history: {
    list(request: HistoryListRequest): Promise<DeskResult<HistoryListResultDto>>
    snapshot(request: HistorySnapshotRequest): Promise<DeskResult<HistorySnapshotDto>>
    readNote(request: HistorySnapshotRequest): Promise<DeskResult<HistoryNoteDto>>
    readAsset(request: HistoryAssetRequest): Promise<DeskResult<HistoryAssetDto>>
    plan(request: HistoryRestorePlanRequest): Promise<DeskResult<HistoryRestorePlanDto>>
    apply(request: HistoryApplyRequest): Promise<DeskResult<HistoryApplyResultDto>>
  }
  assets: {
    scan(knowledgeBaseId: string, generation: number): Promise<DeskResult<AssetScanReportDto>>
    cancel(knowledgeBaseId: string): Promise<DeskResult<void>>
    summaries(): Promise<DeskResult<AssetKbSummaryDto[]>>
    planRename(
      knowledgeBaseId: string,
      fromRelPath: string,
      toRelPath: string,
      generation?: number
    ): Promise<DeskResult<AssetOperationPlanDto>>
    planRecycle(
      knowledgeBaseId: string,
      relPaths: string[],
      generation?: number,
      /** 定向删除（笔记资源面板逐个确认）：允许删没被引用的画布源文件 */
      options?: { targeted?: boolean }
    ): Promise<DeskResult<AssetOperationPlanDto>>
    planMerge(
      knowledgeBaseId: string,
      keepRelPath: string,
      dropRelPaths: string[],
      generation?: number
    ): Promise<DeskResult<AssetOperationPlanDto>>
    previewOptimize(
      knowledgeBaseId: string,
      relPaths: string[],
      options: AssetOptimizeSettings,
      generation?: number
    ): Promise<DeskResult<AssetOptimizePreviewDto>>
    planOptimize(
      knowledgeBaseId: string,
      relPaths: string[],
      options: AssetOptimizeSettings,
      generation?: number
    ): Promise<DeskResult<AssetOperationPlanDto>>
    apply(knowledgeBaseId: string, planId: string): Promise<DeskResult<AssetOperationResultDto>>
    restore(knowledgeBaseId: string, planId: string): Promise<DeskResult<AssetOperationResultDto>>
    history(knowledgeBaseId: string): Promise<DeskResult<AssetJournalDto[]>>
    onScanProgress(callback: (progress: AssetScanProgressDto) => void): () => void
    onGateQuery(callback: (event: AssetGateQueryEvent) => void): () => void
    replyGate(requestId: string, knowledgeBaseId: string, snapshot: AssetEditorSnapshotDto): void
    onPrepareApply(callback: (event: AssetPrepareApplyEvent) => void): () => void
    onApplied(callback: (event: AssetAppliedEvent) => void): () => void
    onApplySettled(callback: (event: AssetApplySettledEvent) => void): () => void
  }
  notes: {
    read(knowledgeBaseId: string, noteUuid: string): Promise<DeskResult<NoteDocumentDto>>
    resolveTable(request: NotesTableResolveRequest): Promise<DeskResult<NotesTableResolveResult>>
    save(request: NoteSaveRequest): Promise<DeskResult<NoteMutationDto>>
    create(request: NoteCreateRequest): Promise<DeskResult<NoteMutationDto>>
    rename(request: NoteRenameRequest): Promise<DeskResult<NoteMutationDto>>
    updateConfig(request: NoteUpdateConfigRequest): Promise<DeskResult<NoteMutationDto>>
    copyPath(knowledgeBaseId: string, noteUuid: string): Promise<DeskResult<string>>
    revealInFileManager(knowledgeBaseId: string, noteUuid: string): Promise<DeskResult<void>>
    onExternalChanged(callback: (event: ExternalNoteChangeEvent) => void): () => void
  }
  attachments: {
    writeLocal(
      request: AttachmentWriteLocalRequest
    ): Promise<DeskResult<AttachmentWriteLocalResult>>
    uploadImage(request: ImageUploadRequest): Promise<DeskResult<ImageUploadResult>>
  }
  build(knowledgeBaseId: string): Promise<DeskResult<KbBuildResult>>
  search(request: SearchRequest): Promise<DeskResult<SearchResultDto[]>>
  git: {
    list(): Promise<DeskResult<GitRepositoryStateDto[]>>
    refresh(knowledgeBaseId?: string): Promise<DeskResult<GitRepositoryStateDto[]>>
    /**
     * 带 taskId 时由命令任务处理器执行：面板能拿到实时输出与取消能力。
     * 再带 `run` 时只认**那一轮**（推送带保存）：被取消或已被取代就收手，
     * 不认领、不复活。
     */
    fetch(
      knowledgeBaseId: string,
      taskId?: string,
      run?: number
    ): Promise<DeskResult<GitOperationResult>>
    pull(
      knowledgeBaseId: string,
      taskId?: string,
      run?: number
    ): Promise<DeskResult<GitOperationResult>>
    publish(
      knowledgeBaseId: string,
      taskId?: string,
      run?: number
    ): Promise<DeskResult<GitOperationResult>>
    onStateChanged(callback: (state: GitRepositoryStateDto) => void): () => void
  }
  ide: {
    showKnowledgeBaseMenu(knowledgeBaseId: string): Promise<DeskResult<void>>
    showNoteMenu(knowledgeBaseId: string, noteUuid: string): Promise<DeskResult<void>>
    showFileMenu(knowledgeBaseId: string, path: string): Promise<DeskResult<void>>
    openKnowledgeBase(knowledgeBaseId: string): Promise<DeskResult<void>>
    openNote(knowledgeBaseId: string, noteUuid: string): Promise<DeskResult<void>>
  }
  toc: {
    move(request: TocMoveRequest): Promise<DeskResult<KnowledgeBaseDetail>>
    createGroup(request: TocCreateGroupRequest): Promise<DeskResult<KnowledgeBaseDetail>>
    renameGroup(request: TocRenameGroupRequest): Promise<DeskResult<KnowledgeBaseDetail>>
    previewDelete(
      knowledgeBaseId: string,
      entry: TocEntryRefDto
    ): Promise<DeskResult<DeletePreviewDto>>
    delete(request: TocDeleteRequest): Promise<DeskResult<KnowledgeBaseDetail>>
    /** 删除前把该范围的当前版本提交一次（用户显式点按钮时才会发生） */
    commitBeforeDelete(request: {
      knowledgeBaseId: string
      entry: TocEntryRefDto
    }): Promise<DeskResult<DeleteCommitResultDto>>
  }
  session: {
    read(): Promise<DeskResult<WorkspaceSession | null>>
    save(session: WorkspaceSession): Promise<DeskResult<void>>
  }
  recovery: {
    write(request: RecoveryWriteRequest): Promise<DeskResult<void>>
    delete(request: RecoveryDeleteRequest): Promise<DeskResult<void>>
  }
  web: {
    create(request: WebCreateRequest): Promise<DeskResult<WebTabState>>
    layout(request: WebLayoutRequest): Promise<DeskResult<void>>
    hideAll(): Promise<DeskResult<void>>
    close(tabId: string): Promise<DeskResult<void>>
    navigate(request: WebNavigateRequest): Promise<DeskResult<WebTabState>>
    goBack(tabId: string): Promise<DeskResult<void>>
    goForward(tabId: string): Promise<DeskResult<void>>
    reload(tabId: string): Promise<DeskResult<void>>
    stop(tabId: string): Promise<DeskResult<void>>
    selectAll(tabId: string): Promise<DeskResult<void>>
    openExternal(url: string): Promise<DeskResult<void>>
    clearBrowsingData(): Promise<DeskResult<void>>
    onStateChanged(callback: (state: WebTabState) => void): () => void
    onOpenRequested(callback: (event: WebOpenRequestedEvent) => void): () => void
  }
  preview: {
    start(request: PreviewStartRequest): Promise<DeskResult<PreviewStartResult>>
    stop(knowledgeBaseId: string): Promise<DeskResult<PreviewStateDto>>
    list(): Promise<DeskResult<PreviewStateDto[]>>
    onChanged(callback: (state: PreviewStateDto) => void): () => void
  }
  /** 本机 MCP：选区快照上报 + 服务状态/开关/令牌 */
  selection: {
    report(request: SelectionReportRequest): Promise<DeskResult<{ accepted: boolean }>>
    clear(request: SelectionClearRequest): Promise<DeskResult<{ cleared: boolean }>>
  }
  mcp: {
    status(): Promise<DeskResult<McpServerStatusDto>>
    setEnabled(enabled: boolean): Promise<DeskResult<McpServerStatusDto>>
    rotateToken(): Promise<DeskResult<McpServerStatusDto>>
    onChanged(callback: (status: McpServerStatusDto) => void): () => void
  }
  clipboard: {
    /**
     * 只替换剪贴板里的 `text/plain`，其它 flavor（`text/html` 等）原样保留。
     *
     * 为什么必须在主进程做：实测 Electron 的 `clipboard.write({ text })` 会把
     * `text/html` 一起清掉，必须 `write({ text, html, ... })` 同时给全，所以只有
     * 主进程才能"读现状 → 连同 html 一起重写"。
     */
    setPlainText(text: string, html?: string): Promise<DeskResult<{ text: string; html: string }>>
  }
  backgroundFailures: {
    list(): Promise<DeskResult<BackgroundFailureDto[]>>
    clear(): Promise<DeskResult<void>>
    /** 仅 E2E 内部使用；生产构建里主进程会拒绝（见 backgroundFailureInject 门禁） */
    injectForTest(request: {
      knowledgeBaseId: string
      kind: 'git-fetch' | 'git-push'
      reason: string
      message: string
    }): Promise<DeskResult<BackgroundFailureDto>>
    onChanged(callback: (failures: BackgroundFailureDto[]) => void): () => void
  }
  commandTask: {
    /** 认领任务：同一 (知识库, 种类) 已有运行中的任务时返回它本身（不重复提交） */
    claim(request: CommandTaskClaimRequest): Promise<DeskResult<CommandTaskDto>>
    list(): Promise<DeskResult<CommandTaskDto[]>>
    /** 关闭输出标签（只关视图，不取消运行） */
    close(taskId: string): Promise<DeskResult<void>>
    /** 停止任务：排队中的直接取消，运行中的终止子进程 */
    cancel(taskId: string): Promise<DeskResult<void>>
    /**
     * 声明「这一轮运行已经开始」，在**进入 Git 之前**调用。
     *
     * 推送的完整流程是「受控保存 → Git」，保存期间任务还没进 Git 队列。
     * 有了这条声明，保存阶段收到的取消请求才有明确的归属，取消不必再去
     * 按知识库猜某个 Git 队列项（那会误伤同库其他排队任务）。
     * 返回这一轮是否**仍是当前运行**：false 表示已被取消/已被新运行取代，
     * 调用方不得再进入 Git，也不得因此重新认领。
     */
    begin(taskId: string, run: number): Promise<DeskResult<boolean>>
    /**
     * 重试：请渲染端重新走**完整业务流程**（推送要先保存），
     * 不在主进程直接调 Git——否则会把旧磁盘内容提交并推送。
     */
    retry(taskId: string): Promise<DeskResult<void>>
    /**
     * 渲染端在调用 Git 前报告自己的阶段（如推送前的保存）。
     * 返回 false 表示这一轮已不是当前运行：调用方不得继续执行 Git。
     */
    reportStage(
      taskId: string,
      run: number,
      stage: CommandTaskStage,
      label: string
    ): Promise<DeskResult<boolean>>
    /** 渲染端因前置失败结束任务（如保存失败、检查不通过） */
    finish(
      taskId: string,
      run: number,
      status: 'done' | 'failed' | 'timeout' | 'canceled',
      error: string | null
    ): Promise<DeskResult<void>>
    onChanged(callback: (state: CommandTaskDto) => void): () => void
    onLog(callback: (event: CommandTaskLogEvent) => void): () => void
    /**
     * 主进程移除了某个任务标签（用户关闭，或达到上限时被容量回收）。
     * 界面据此清掉本地残留的标签与日志，避免留下点不动的空标签。
     */
    onClosed(callback: (taskId: string) => void): () => void
    /** 主进程请求「展开面板并定位到这个任务」（手动 Git 操作、后台失败入口） */
    onReveal(callback: (taskId: string) => void): () => void
    /** 主进程请求渲染端重跑某任务（重试必须复用渲染端的完整流程） */
    onRetryRequested(callback: (taskId: string) => void): () => void
  }
  terminal: {
    create(request: TerminalCreateRequest): Promise<DeskResult<TerminalSessionDto>>
    list(): Promise<DeskResult<TerminalSessionDto[]>>
    restart(sessionId: string): Promise<DeskResult<TerminalSessionDto>>
    rename(sessionId: string, title: string): Promise<DeskResult<TerminalSessionDto>>
    close(sessionId: string): Promise<DeskResult<void>>
    /** generation 不符时拒绝：旧代次残留的输入不得进入新进程 */
    write(sessionId: string, data: string, generation: number): Promise<DeskResult<void>>
    resize(sessionId: string, cols: number, rows: number): Promise<DeskResult<void>>
    /**
     * 流控回执：渲染端已经消费掉 n 字节。主进程据此在高低水位之间 pause/resume
     * PTY，避免 xterm 的写入缓冲被高速输出打爆（xterm 有 50MB 硬上限，超出即丢数据）。
     */
    /** generation 不符时**静默忽略**：延迟回执属于旧代次，扣到新进程上会毁掉背压 */
    ack(sessionId: string, bytes: number, generation: number): Promise<DeskResult<void>>
    onChanged(callback: (state: TerminalSessionDto) => void): () => void
    onData(callback: (event: TerminalDataEvent) => void): () => void
    /**
     * 主进程移除了某个会话（用户关闭，或达到上限时被容量回收）。
     * 界面据此清掉本地残留的标签，避免 xterm 还挂着一个主进程已经不存在的会话。
     */
    onClosed(callback: (sessionId: string) => void): () => void
    onOpenAt(callback: (event: TerminalOpenAtEvent) => void): () => void
  }
  onLog(callback: (line: string) => void): () => void
}
