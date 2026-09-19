import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { useEditorStore } from '../editor'

import type {
  AppSettings,
  AssetEditorSnapshotDto,
  DeskTocNode,
  GitRepositoryStateDto,
  KnowledgeBaseDetail,
  NoteEditorTab,
  RecoveryRecord,
  SearchResultDto,
  WorkspaceOverview
} from '../../../../shared/contracts'
import type { SplitPlacement } from '../../editor-groups/layoutModel'

import { createDocuments } from './documents'
import { collectAssetEditorSnapshot } from './assetWriteSnapshot'
import { flushHistoryWriters } from '../../history/flushWriters'
import { createTabClosing, type ClosingResource } from './closeTabs'
import { createGit } from './git'
import {
  documentKey,
  replaceDescriptor,
  resultValue,
  type DocumentSession,
  type GitAttention
} from './helpers'
import { excalidrawCloseResource } from './excalidrawCloseRegistry'
import { kbSettingsCloseResource } from './kbSettingsCloseRegistry'
import { createSearch } from './search'
import { createSettings } from './settings'
import { createToc } from './toc'

function collectNoteUuids(nodes: DeskTocNode[]): Set<string> {
  const noteUuids = new Set<string>()
  const queue = [...nodes]
  while (queue.length > 0) {
    const node = queue.shift()!
    if (node.type === 'note') noteUuids.add(node.uuid)
    queue.unshift(...node.children)
  }
  return noteUuids
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const editor = useEditorStore()
  const overview = ref<WorkspaceOverview>({ path: null, knowledgeBases: [], allKnowledgeBases: [] })
  const settings = ref<AppSettings | null>(null)
  const runtimePlatform = ref<'darwin' | 'win32' | 'linux'>('darwin')
  const selectedKnowledgeBaseId = ref<string | null>(null)
  const knowledgeBase = ref<KnowledgeBaseDetail | null>(null)
  const documents = ref<Record<string, DocumentSession>>({})
  const pendingRecoveries = ref<RecoveryRecord[]>([])
  const searchResults = ref<SearchResultDto[]>([])
  const searchLoading = ref(false)
  const gitStates = ref<Record<string, GitRepositoryStateDto>>({})
  const gitAttention = ref<GitAttention | null>(null)
  const pendingGitPublishId = ref<string | null>(null)
  const assetRevisions = ref<Record<string, number>>({})
  const loading = ref(false)
  const error = ref<string | null>(null)
  const status = ref<string | null>(null)
  const tocFocusRequest = ref<{
    knowledgeBaseId: string
    noteUuid: string
    sequence: number
  } | null>(null)
  const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let unsubscribeWorkspace: (() => void) | null = null
  let unsubscribeExternal: (() => void) | null = null
  let unsubscribeGit: (() => void) | null = null
  let unsubscribeKbSettings: (() => void) | null = null
  let unsubscribeKbAssets: (() => void) | null = null
  let unsubscribeAssetGate: (() => void) | null = null
  let unsubscribeAssetPrepare: (() => void) | null = null
  let unsubscribeAssetApplied: (() => void) | null = null
  let unsubscribeAssetSettled: (() => void) | null = null
  let tocFocusSequence = 0
  const pausedForAssetWrite = new Map<string, () => void>()

  const activeDocumentKey = computed(() => {
    const tab = editor.activeTab
    return tab?.type === 'note' ? documentKey(tab.knowledgeBaseId, tab.noteUuid) : null
  })
  const activeDocumentSession = computed(() =>
    activeDocumentKey.value ? (documents.value[activeDocumentKey.value] ?? null) : null
  )
  const document = computed(() => activeDocumentSession.value?.document ?? null)
  const editorContent = computed(() => activeDocumentSession.value?.content ?? '')
  const dirty = computed(() => Boolean(activeDocumentSession.value?.dirty))
  const externalConflict = computed(() => Boolean(activeDocumentSession.value?.externalConflict))
  const saving = computed(() => Boolean(activeDocumentSession.value?.saving))
  const hasWorkspace = computed(() => Boolean(overview.value.path))
  const selectedKnowledgeBase = computed(() =>
    selectedKnowledgeBaseId.value
      ? (overview.value.knowledgeBases.find((item) => item.id === selectedKnowledgeBaseId.value) ??
        null)
      : null
  )

  function setDocumentSession(key: string, session: DocumentSession): void {
    documents.value = { ...documents.value, [key]: session }
  }

  function removeDocumentSession(key: string): void {
    const next = { ...documents.value }
    delete next[key]
    documents.value = next
    const timer = autosaveTimers.get(key)
    if (timer) clearTimeout(timer)
    autosaveTimers.delete(key)
    const recoveryTimer = recoveryTimers.get(key)
    if (recoveryTimer) clearTimeout(recoveryTimer)
    recoveryTimers.delete(key)
  }

  function applyDetail(detail: KnowledgeBaseDetail): void {
    if (selectedKnowledgeBaseId.value === detail.id) {
      knowledgeBase.value = detail
      editor.switchKnowledgeBase(detail.id, collectNoteUuids(detail.toc))
    }
    overview.value = replaceDescriptor(overview.value, detail)
  }

  async function selectKnowledgeBase(knowledgeBaseId: string): Promise<void> {
    if (knowledgeBaseId === selectedKnowledgeBaseId.value && knowledgeBase.value) return
    error.value = null
    try {
      const detail = resultValue(await window.desk.knowledgeBases.read(knowledgeBaseId))
      selectedKnowledgeBaseId.value = knowledgeBaseId
      applyDetail(detail)
      searchResults.value = []
      const gitState = gitStates.value[knowledgeBaseId]
      if (gitState?.behind) {
        gitAttention.value = {
          knowledgeBaseId,
          knowledgeBaseName: detail.displayName,
          kind: 'behind',
          message: `本地分支落后上游 ${gitState.behind} 个提交。建议先拉取最新版本，再开始编辑。`
        }
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function reloadKnowledgeBase(): Promise<void> {
    if (!selectedKnowledgeBaseId.value) return
    applyDetail(resultValue(await window.desk.knowledgeBases.read(selectedKnowledgeBaseId.value)))
  }

  async function refreshWorkspace(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      overview.value = resultValue(await window.desk.workspace.refresh())
      if (selectedKnowledgeBaseId.value) await reloadKnowledgeBase()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  const {
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
    waitForDocumentSave,
    writeLocalAttachment,
    uploadImage,
    copyNoteDirectoryPath,
    revealNoteInFileManager,
    saveCurrentDocument: saveCurrentNoteDocument,
    saveAllDocuments: saveAllNoteDocuments,
    reloadDocument,
    acceptRecovery,
    discardRecovery,
    reloadCurrentDocument,
    keepEditorAgainstDisk,
    getDocumentSession
  } = createDocuments({
    editor,
    documents,
    pendingRecoveries,
    overview,
    settings,
    error,
    status,
    activeDocumentKey,
    autosaveTimers,
    recoveryTimers,
    setDocumentSession,
    removeDocumentSession,
    applyDetail,
    selectKnowledgeBase
  })

  async function saveCurrentDocument(): Promise<void> {
    await saveCurrentNoteDocument()
  }

  const { requestCloseTab, requestCloseTabs, isTabDirty, closingTabs, prepareToQuit } =
    createTabClosing({
      editor,
      error,
      status,
      resourcesFor: (tab) => {
        if (tab.type === 'web') return []
        const resources: ClosingResource[] = []
        if (tab.type === 'note') {
          const key = documentKey(tab.knowledgeBaseId, tab.noteUuid)
          resources.push({
            key,
            title: tab.title,
            dirty: () => Boolean(documents.value[key]?.dirty),
            saving: () => Boolean(documents.value[key]?.saving),
            pauseAutosave: () => pauseDocumentAutosave(key),
            waitForSave: () => waitForDocumentSave(key),
            save: () => saveDocument(key),
            discard: () => discardDocumentChanges(key)
          })
        }
        if (tab.type === 'kb-settings') {
          const resource = kbSettingsCloseResource(tab.id)
          if (resource) resources.push(resource)
        }
        // 画布自动写盘：关闭时先 flush，失败才让用户选择重试或丢弃
        if (tab.type === 'excalidraw') {
          const resource = excalidrawCloseResource(tab.id)
          if (resource) resources.push(resource)
        }
        return resources
      }
    })

  async function saveAllDocuments(): Promise<void> {
    await saveAllNoteDocuments()
  }

  /** 历史恢复前的写者快照（与资源写入门禁共用同一套统计）。 */
  function collectWritersSnapshot(knowledgeBaseId: string): AssetEditorSnapshotDto {
    return collectAssetEditorSnapshot({
      knowledgeBaseId,
      editor,
      documents: documents.value,
      pendingRecoveries: pendingRecoveries.value
    })
  }

  /**
   * 历史恢复前受控 flush：settle 画布 → 保存笔记 → 返回写者快照。
   * 画布写不完会抛 `HistoryFlushError`，调用方必须停下而不是拿半份状态去备份。
   */
  async function flushForHistoryRestore(knowledgeBaseId: string): Promise<AssetEditorSnapshotDto> {
    return await flushHistoryWriters({
      knowledgeBaseId,
      saveDocuments: saveAllDocuments,
      snapshot: () => collectWritersSnapshot(knowledgeBaseId)
    })
  }

  /**
   * 历史恢复成功后让这篇笔记重新读盘：旧编辑缓冲/缓存不允许再 autosave 覆盖恢复结果。
   * 脏文档不静默丢弃，标记外部冲突交给用户决定。
   */
  async function reloadNoteFromDisk(knowledgeBaseId: string, noteUuid: string): Promise<void> {
    const key = documentKey(knowledgeBaseId, noteUuid)
    const session = documents.value[key]
    if (session?.dirty) {
      setDocumentSession(key, { ...session, externalConflict: true })
      return
    }
    if (session) await reloadDocument(key)
  }

  const { updateSettings, applySettings, setAppZoom, adjustAppZoom, zoomFeedbackSequence } =
    createSettings({
      editor,
      settings
    })

  const { searchNotes } = createSearch({
    searchResults,
    searchLoading,
    selectedKnowledgeBaseId,
    error
  })

  const {
    refreshGit,
    fetchGit,
    pullGit,
    confirmPull,
    requestGitPublish,
    publishGit,
    retryCommandTask,
    openKnowledgeBaseInIde
  } = createGit({
    gitStates,
    gitAttention,
    pendingGitPublishId,
    overview,
    settings,
    error,
    status,
    saveAllDocuments,
    refreshWorkspace
  })

  const {
    createNote,
    createTocGroup,
    renameNote,
    renameTocNode,
    moveTocNode,
    toggleDone,
    previewDeleteNode,
    commitDeleteScope,
    deleteNode
  } = createToc({
    editor,
    knowledgeBase,
    documents,
    settings,
    error,
    status,
    applyDetail,
    setDocumentSession,
    removeDocumentSession,
    ensureDocument,
    saveDocument,
    pauseDocumentAutosave,
    waitForDocumentSave,
    persistRecovery,
    deleteRecovery
  })

  async function initialize(): Promise<void> {
    loading.value = true
    error.value = null
    editor.initializeWebEvents()
    try {
      const payload = resultValue(await window.desk.bootstrap())
      overview.value = payload.workspace
      applySettings(payload.settings)
      runtimePlatform.value = payload.platform
      const initialGitStates = resultValue(await window.desk.git.list())
      gitStates.value = Object.fromEntries(
        initialGitStates.map((state) => [state.knowledgeBaseId, state])
      )
      unsubscribeGit = window.desk.git.onStateChanged((state) => {
        gitStates.value = { ...gitStates.value, [state.knowledgeBaseId]: state }
      })
      // 知识库列表右键菜单「知识库配置」（main 侧菜单 → 事件 → 打开设置页）
      unsubscribeKbSettings = window.desk.knowledgeBases.onOpenSettingsRequested(
        (knowledgeBaseId) => {
          const descriptor = overview.value.allKnowledgeBases.find(
            (item) => item.id === knowledgeBaseId
          )
          if (descriptor) editor.openKbSettings(descriptor)
        }
      )
      unsubscribeKbAssets = window.desk.knowledgeBases.onOpenAssetsRequested((knowledgeBaseId) => {
        const descriptor = overview.value.allKnowledgeBases.find(
          (item) => item.id === knowledgeBaseId
        )
        if (descriptor) editor.openKbAssets(descriptor)
      })
      editor.restore(
        payload.session,
        payload.workspace.allKnowledgeBases,
        new Set(payload.workspace.knowledgeBases.map((item) => item.id))
      )
      await prepareRecoveries(payload.recoveries)
      unsubscribeWorkspace = window.desk.workspace.onChanged((next) => {
        overview.value = next
        editor.retainKnowledgeBases(new Set(next.allKnowledgeBases.map((item) => item.id)))
        const selectedId = selectedKnowledgeBaseId.value
        if (selectedId && !next.allKnowledgeBases.some((item) => item.id === selectedId)) {
          selectedKnowledgeBaseId.value = null
          knowledgeBase.value = null
          return
        }
        if (selectedId) {
          void window.desk.knowledgeBases.read(selectedId).then((result) => {
            if (!result.ok || selectedKnowledgeBaseId.value !== selectedId) return
            applyDetail(result.value)
          })
        }
      })
      unsubscribeExternal = window.desk.notes.onExternalChanged((event) => {
        const key = documentKey(event.knowledgeBaseId, event.noteUuid)
        const session = documents.value[key]
        if (!session) return
        if (session.dirty) {
          setDocumentSession(key, { ...session, externalConflict: true })
          return
        }
        void reloadDocument(key)
      })
      unsubscribeAssetGate = window.desk.assets.onGateQuery((event) => {
        window.desk.assets.replyGate(
          event.requestId,
          event.knowledgeBaseId,
          collectAssetEditorSnapshot({
            knowledgeBaseId: event.knowledgeBaseId,
            editor,
            documents: documents.value,
            pendingRecoveries: pendingRecoveries.value
          })
        )
      })
      unsubscribeAssetPrepare = window.desk.assets.onPrepareApply((event) => {
        for (const noteUuid of event.noteUuids) {
          const key = documentKey(event.knowledgeBaseId, noteUuid)
          if (pausedForAssetWrite.has(key)) continue
          pausedForAssetWrite.set(key, pauseDocumentAutosave(key))
        }
      })
      unsubscribeAssetApplied = window.desk.assets.onApplied((event) => {
        assetRevisions.value = {
          ...assetRevisions.value,
          [event.knowledgeBaseId]: event.revision
        }
        for (const noteUuid of event.noteUuids) {
          const key = documentKey(event.knowledgeBaseId, noteUuid)
          const session = documents.value[key]
          if (session && !session.dirty) void reloadDocument(key)
        }
      })
      unsubscribeAssetSettled = window.desk.assets.onApplySettled((event) => {
        for (const noteUuid of event.noteUuids) {
          const key = documentKey(event.knowledgeBaseId, noteUuid)
          pausedForAssetWrite.get(key)?.()
          pausedForAssetWrite.delete(key)
        }
      })
      const initial = payload.workspace.knowledgeBases.find(
        (item) => item.id === payload.session?.selectedKnowledgeBaseId
      )
      const selected = initial ?? payload.workspace.knowledgeBases[0]
      if (selected) await selectKnowledgeBase(selected.id)
      const activeTab = editor.activeTab
      if (activeTab?.type === 'note') {
        await ensureDocument(activeTab.knowledgeBaseId, activeTab.noteUuid)
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  function dispose(): void {
    unsubscribeWorkspace?.()
    unsubscribeWorkspace = null
    unsubscribeExternal?.()
    unsubscribeExternal = null
    unsubscribeGit?.()
    unsubscribeGit = null
    unsubscribeKbSettings?.()
    unsubscribeKbSettings = null
    unsubscribeKbAssets?.()
    unsubscribeKbAssets = null
    unsubscribeAssetGate?.()
    unsubscribeAssetGate = null
    unsubscribeAssetPrepare?.()
    unsubscribeAssetPrepare = null
    unsubscribeAssetApplied?.()
    unsubscribeAssetApplied = null
    unsubscribeAssetSettled?.()
    unsubscribeAssetSettled = null
    for (const resume of pausedForAssetWrite.values()) resume()
    pausedForAssetWrite.clear()
    for (const timer of autosaveTimers.values()) clearTimeout(timer)
    autosaveTimers.clear()
    for (const timer of recoveryTimers.values()) clearTimeout(timer)
    recoveryTimers.clear()
    for (const [key, session] of Object.entries(documents.value)) {
      if (session.dirty) void persistRecovery(key)
    }
    editor.dispose()
  }

  async function chooseWorkspace(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      await saveAllDocuments()
      overview.value = resultValue(await window.desk.workspace.choose())
      editor.reset()
      documents.value = {}
      selectedKnowledgeBaseId.value = null
      knowledgeBase.value = null
      const first = overview.value.knowledgeBases[0]
      if (first) await selectKnowledgeBase(first.id)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  async function createKnowledgeBase(input: {
    folderName: string
    title?: string
    packageJson?: boolean
    githubPages?: boolean
    readme?: boolean
    gitInit?: boolean
  }): Promise<string> {
    loading.value = true
    error.value = null
    try {
      if (!overview.value.path) {
        await chooseWorkspace()
        if (!overview.value.path) throw new Error('请先选择工作区')
      }
      const result = resultValue(await window.desk.knowledgeBases.create(input))
      overview.value = result.overview
      await selectKnowledgeBase(result.knowledgeBaseId)
      status.value = `已创建知识库 ${input.folderName}`
      return result.knowledgeBaseId
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function syncToActiveTab(forceReveal = false): Promise<void> {
    const tab = editor.activeTab
    if (
      !tab ||
      tab.type === 'web' ||
      tab.type === 'kb-settings' ||
      tab.type === 'kb-assets' ||
      tab.type === 'excalidraw' ||
      tab.type === 'note-history'
    ) {
      return
    }
    if (tab.type === 'note') await ensureDocument(tab.knowledgeBaseId, tab.noteUuid)
    if (tab.type === 'text-file') return
    if (forceReveal || settings.value?.tabs.autoRevealInToc) {
      if (selectedKnowledgeBaseId.value !== tab.knowledgeBaseId) {
        await selectKnowledgeBase(tab.knowledgeBaseId)
      }
      tocFocusSequence += 1
      tocFocusRequest.value = {
        knowledgeBaseId: tab.knowledgeBaseId,
        noteUuid: tab.noteUuid,
        sequence: tocFocusSequence
      }
    }
  }

  async function acceptAnyRecovery(record: RecoveryRecord): Promise<void> {
    await acceptRecovery(record)
  }

  function discardAnyRecovery(record: RecoveryRecord): void {
    discardRecovery(record)
  }

  async function revealTabInToc(tab: NoteEditorTab): Promise<void> {
    const located = editor.groups
      .flatMap((group) => group.tabs)
      .find((candidate) => candidate.id === tab.id)
    if (!located || located.type !== 'note') return
    const group = editor.groups.find((candidate) =>
      candidate.tabs.some((item) => item.id === tab.id)
    )
    if (group) editor.activate(group.id, tab.id)
    await syncToActiveTab(true)
  }

  async function selectNote(
    node: Extract<DeskTocNode, { type: 'note' }>,
    split?: SplitPlacement,
    permanent = false
  ): Promise<void> {
    if (!selectedKnowledgeBaseId.value || !selectedKnowledgeBase.value) return
    error.value = null
    // Open the tab shell first so chrome can paint while notes.read runs.
    editor.openNote(
      selectedKnowledgeBase.value,
      node.uuid,
      node.title,
      settings.value?.defaultNoteView ?? 'visual',
      split,
      permanent ? 'permanent' : 'preview'
    )
    try {
      await ensureDocument(selectedKnowledgeBaseId.value, node.uuid)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      if (!documents.value[documentKey(selectedKnowledgeBaseId.value, node.uuid)]) {
        editor.closeNote(selectedKnowledgeBaseId.value, node.uuid)
      }
    }
  }

  async function openNoteByUuid(knowledgeBaseId: string, noteUuid: string): Promise<void> {
    const detail = resultValue(await window.desk.knowledgeBases.read(knowledgeBaseId))
    const stack = [...detail.toc]
    let target: Extract<DeskTocNode, { type: 'note' }> | null = null
    while (stack.length > 0) {
      const node = stack.shift()!
      if (node.type === 'note' && node.uuid === noteUuid) {
        target = node
        break
      }
      stack.unshift(...node.children)
    }
    if (!target) throw new Error(`关联笔记不存在：${noteUuid}`)
    editor.openNote(detail, noteUuid, target.title, settings.value?.defaultNoteView ?? 'visual')
    try {
      await ensureDocument(knowledgeBaseId, noteUuid)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      if (!documents.value[documentKey(knowledgeBaseId, noteUuid)]) {
        editor.closeNote(knowledgeBaseId, noteUuid)
      }
      throw cause
    }
    await syncToActiveTab()
  }

  return {
    overview,
    settings,
    runtimePlatform,
    selectedKnowledgeBaseId,
    selectedKnowledgeBase,
    knowledgeBase,
    documents,
    pendingRecoveries,
    searchResults,
    searchLoading,
    gitStates,
    gitAttention,
    pendingGitPublishId,
    assetRevisions,
    document,
    editorContent,
    dirty,
    externalConflict,
    loading,
    saving,
    error,
    status,
    tocFocusRequest,
    hasWorkspace,
    initialize,
    dispose,
    chooseWorkspace,
    createKnowledgeBase,
    refreshWorkspace,
    reloadKnowledgeBase,
    selectKnowledgeBase,
    searchNotes,
    refreshGit,
    fetchGit,
    pullGit,
    confirmPull,
    requestGitPublish,
    publishGit,
    retryCommandTask,
    openKnowledgeBaseInIde,
    syncToActiveTab,
    revealTabInToc,
    selectNote,
    openNoteByUuid,
    updateDocumentContent,
    updateEditorContent,
    setDocumentUnsavedDraft,
    saveDocument,
    saveCurrentDocument,
    requestCloseTab,
    requestCloseTabs,
    prepareToQuit,
    isTabDirty,
    closingTabs,
    saveAllDocuments,
    collectWritersSnapshot,
    flushForHistoryRestore,
    reloadNoteFromDisk,
    writeLocalAttachment,
    uploadImage,
    updateSettings,
    setAppZoom,
    adjustAppZoom,
    zoomFeedbackSequence,
    applySettings,
    copyNoteDirectoryPath,
    revealNoteInFileManager,
    reloadCurrentDocument,
    keepEditorAgainstDisk,
    acceptRecovery: acceptAnyRecovery,
    discardRecovery: discardAnyRecovery,
    createNote,
    createTocGroup,
    renameNote,
    renameTocNode,
    moveTocNode,
    toggleDone,
    previewDeleteNode,
    commitDeleteScope,
    deleteNode,
    ensureDocument,
    getDocumentSession
  }
})
