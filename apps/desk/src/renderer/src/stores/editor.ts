import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export const KNOWLEDGE_SIDEBAR_MIN = 52
export const KNOWLEDGE_SIDEBAR_DEFAULT = 218
export const KNOWLEDGE_SIDEBAR_MAX = 380
export const KNOWLEDGE_SIDEBAR_COMPACT = 104
export const NAVIGATOR_SIDEBAR_MIN = 200
export const NAVIGATOR_SIDEBAR_DEFAULT = 292
export const NAVIGATOR_SIDEBAR_MAX = 480

export function clampSidebarWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

import {
  activateTab as activateTabInLayout,
  collapseEmptyGroups,
  createGroup,
  createId,
  cycleTab,
  findGroup,
  findTab,
  insertTab,
  listGroups,
  removeTab,
  setSplitRatio,
  splitGroupWithTab,
  updateGroup
} from '../editor-groups/layoutModel'

import type {
  AppSettings,
  EditorLayoutNode,
  EditorTab,
  KnowledgeBaseEditorSession,
  KnowledgeBaseDescriptor,
  KnowledgeBaseIconDto,
  KbSettingsEditorTab,
  KbAssetsEditorTab,
  ExcalidrawEditorTab,
  NoteHistoryEditorTab,
  TextFileEditorTab,
  NoteEditorTab,
  NotePageWidth,
  NoteViewMode,
  PreviewStateDto,
  WebEditorTab,
  WebTabState,
  WorkspaceSession
} from '../../../shared/contracts'
import type { SplitPlacement } from '../editor-groups/layoutModel'

const DEFAULT_WEB_URL = 'https://github.com/tnotesjs'

function cloneTab(tab: EditorTab): EditorTab {
  return {
    ...tab,
    id: createId(tab.type),
    openedAt: Date.now(),
    pinned: false,
    ...(tab.type === 'note' ? { preview: false } : {})
  }
}

function sanitizeLayout(
  node: EditorLayoutNode,
  knowledgeBaseIds: Set<string>,
  defaultNotePageWidth: NotePageWidth,
  scopedKnowledgeBaseId?: string,
  validNoteUuids?: ReadonlySet<string>
): EditorLayoutNode {
  if (node.type === 'group') {
    const tabs = node.tabs
      .filter((tab) => {
        if (tab.type === 'web') {
          try {
            const url = new URL(tab.url)
            return url.protocol === 'http:' || url.protocol === 'https:'
          } catch {
            return false
          }
        }
        if (
          tab.type === 'kb-settings' ||
          tab.type === 'kb-assets' ||
          tab.type === 'excalidraw' ||
          tab.type === 'text-file' ||
          tab.type === 'note-history'
        ) {
          return (
            knowledgeBaseIds.has(tab.knowledgeBaseId) &&
            (!scopedKnowledgeBaseId || tab.knowledgeBaseId === scopedKnowledgeBaseId)
          )
        }
        return (
          knowledgeBaseIds.has(tab.knowledgeBaseId) &&
          (!scopedKnowledgeBaseId || tab.knowledgeBaseId === scopedKnowledgeBaseId) &&
          (!validNoteUuids || validNoteUuids.has(tab.noteUuid))
        )
      })
      .map((tab, index) => ({
        ...tab,
        pinned: Boolean(tab.pinned),
        openedAt: tab.openedAt ?? Date.now() + index,
        ...(tab.type === 'note'
          ? {
              preview: Boolean(tab.preview),
              dirty: Boolean(tab.dirty),
              pageWidth:
                tab.pageWidth === 'standard' || tab.pageWidth === 'wide'
                  ? tab.pageWidth
                  : defaultNotePageWidth,
              outlineVisible: tab.outlineVisible !== false,
              noteAssetsVisible: tab.noteAssetsVisible === true
            }
          : tab.type === 'kb-settings' || tab.type === 'kb-assets'
            ? { dirty: Boolean(tab.dirty) }
            : tab.type === 'excalidraw'
              ? { dirty: Boolean(tab.dirty), invalid: Boolean(tab.invalid) }
              : tab.type === 'note-history'
                ? { commit: /^[0-9a-f]{40}$/.test(tab.commit) ? tab.commit : '' }
                : {})
      }))
    return {
      ...node,
      tabs,
      activeTabId: tabs.some((tab) => tab.id === node.activeTabId)
        ? node.activeTabId
        : (tabs[0]?.id ?? null)
    }
  }
  return collapseEmptyGroups({
    ...node,
    ratio: Math.max(0.15, Math.min(0.85, node.ratio)),
    first: sanitizeLayout(
      node.first,
      knowledgeBaseIds,
      defaultNotePageWidth,
      scopedKnowledgeBaseId,
      validNoteUuids
    ),
    second: sanitizeLayout(
      node.second,
      knowledgeBaseIds,
      defaultNotePageWidth,
      scopedKnowledgeBaseId,
      validNoteUuids
    )
  })
}

function normalizeEditorSession(
  session: KnowledgeBaseEditorSession,
  knowledgeBaseIds: Set<string>,
  defaultNotePageWidth: NotePageWidth,
  knowledgeBaseId: string,
  validNoteUuids?: ReadonlySet<string>
): KnowledgeBaseEditorSession {
  const layout = sanitizeLayout(
    session.layout,
    knowledgeBaseIds,
    defaultNotePageWidth,
    knowledgeBaseId,
    validNoteUuids
  )
  const groups = listGroups(layout)
  const validGroupIds = new Set(groups.map((group) => group.id))
  const lastNoteByGroup = Object.fromEntries(
    Object.entries(session.lastNoteByGroup ?? {}).filter(
      ([groupId, scope]) =>
        validGroupIds.has(groupId) && (!validNoteUuids || validNoteUuids.has(scope.noteUuid))
    )
  )
  return {
    layout,
    activeGroupId: groups.some((group) => group.id === session.activeGroupId)
      ? session.activeGroupId
      : groups[0].id,
    lastNoteByGroup
  }
}

function emptyEditorSession(): KnowledgeBaseEditorSession {
  const group = createGroup()
  return { layout: group, activeGroupId: group.id, lastNoteByGroup: {} }
}

export const useEditorStore = defineStore('editor', () => {
  const firstGroup = createGroup()
  const layout = ref<EditorLayoutNode>(firstGroup)
  const activeGroupId = ref(firstGroup.id)
  const webStates = ref<Record<string, WebTabState>>({})
  const webViewsSuspended = ref(false)
  const previewStates = ref<Record<string, PreviewStateDto>>({})
  const knowledgeSidebarWidth = ref(KNOWLEDGE_SIDEBAR_DEFAULT)
  const navigatorSidebarWidth = ref(NAVIGATOR_SIDEBAR_DEFAULT)
  const knowledgeSidebarCollapsed = ref(false)
  const navigatorSidebarCollapsed = ref(false)
  const expandedTocNodes = ref<Record<string, string[]>>({})
  const maxOpenTabCount = ref(10)
  const wrapTabs = ref(true)
  const defaultNotePageWidth = ref<NotePageWidth>('standard')
  const activeKnowledgeBaseId = ref<string | null>(null)
  const knowledgeBaseEditors = ref<Record<string, KnowledgeBaseEditorSession>>({})
  const lastNoteByGroup = ref<Record<string, { noteUuid: string; noteTitle: string }>>({})
  let unsubscribeWebState: (() => void) | null = null
  let unsubscribeWebOpen: (() => void) | null = null
  let unsubscribePreview: (() => void) | null = null
  let hasUnsavedChanges = (tab: EditorTab): boolean =>
    tab.type !== 'web' && tab.type !== 'note-history' && Boolean(tab.dirty)

  function setUnsavedChangesResolver(resolver: (tab: EditorTab) => boolean): void {
    hasUnsavedChanges = resolver
  }

  const groups = computed(() => listGroups(layout.value))
  const activeGroup = computed(
    () => findGroup(layout.value, activeGroupId.value) ?? groups.value[0] ?? null
  )
  const activeTab = computed(() => {
    const group = activeGroup.value
    return group?.tabs.find((tab) => tab.id === group.activeTabId) ?? null
  })
  const activeNoteScope = computed(() => {
    const tab = activeTab.value
    if (tab?.type === 'note') return { noteUuid: tab.noteUuid, noteTitle: tab.title }
    return lastNoteByGroup.value[activeGroupId.value] ?? null
  })
  const tabCount = computed(() =>
    groups.value.reduce((total, group) => total + group.tabs.length, 0)
  )

  function configure(settings: AppSettings): void {
    maxOpenTabCount.value = settings.tabs.maxOpenCount
    wrapTabs.value = settings.tabs.wrap
    const widthChanged = defaultNotePageWidth.value !== settings.defaultNotePageWidth
    defaultNotePageWidth.value = settings.defaultNotePageWidth
    // 改主题 / 自动保存等无关设置不应该重置每个标签的页宽覆盖
    if (widthChanged) applyDefaultNotePageWidth(settings.defaultNotePageWidth)
    trimToLimit()
  }

  function applyDefaultNotePageWidth(pageWidth: NotePageWidth): void {
    const applyToLayout = (node: EditorLayoutNode): EditorLayoutNode => {
      if (node.type === 'group') {
        return {
          ...node,
          tabs: node.tabs.map((tab) => (tab.type === 'note' ? { ...tab, pageWidth } : tab))
        }
      }
      return {
        ...node,
        first: applyToLayout(node.first),
        second: applyToLayout(node.second)
      }
    }
    layout.value = applyToLayout(layout.value)
    const nextEditors: Record<string, KnowledgeBaseEditorSession> = {}
    for (const [knowledgeBaseId, session] of Object.entries(knowledgeBaseEditors.value)) {
      nextEditors[knowledgeBaseId] = {
        ...session,
        layout: applyToLayout(session.layout)
      }
    }
    knowledgeBaseEditors.value = nextEditors
  }

  function initializeWebEvents(): void {
    if (!unsubscribeWebState) {
      unsubscribeWebState = window.desk.web.onStateChanged((state) => {
        webStates.value = { ...webStates.value, [state.tabId]: state }
        const located = findTab(layout.value, state.tabId)
        if (located?.tab.type === 'web') {
          located.tab.url = state.url
          located.tab.title = state.title || state.url
          layout.value = { ...layout.value }
          return
        }
        let storedChanged = false
        for (const [knowledgeBaseId, session] of Object.entries(knowledgeBaseEditors.value)) {
          if (knowledgeBaseId === activeKnowledgeBaseId.value) continue
          const stored = findTab(session.layout, state.tabId)
          if (stored?.tab.type !== 'web') continue
          stored.tab.url = state.url
          stored.tab.title = state.title || state.url
          storedChanged = true
          break
        }
        if (storedChanged) knowledgeBaseEditors.value = { ...knowledgeBaseEditors.value }
      })
    }
    if (!unsubscribeWebOpen) {
      unsubscribeWebOpen = window.desk.web.onOpenRequested((event) => {
        const source = findTab(layout.value, event.sourceTabId)
        openWeb(event.url, source?.group.id)
      })
    }
    if (!unsubscribePreview) {
      unsubscribePreview = window.desk.preview.onChanged((state) => {
        previewStates.value = { ...previewStates.value, [state.knowledgeBaseId]: state }
      })
      void window.desk.preview.list().then((result) => {
        if (!result.ok) return
        previewStates.value = Object.fromEntries(
          result.value.map((state) => [state.knowledgeBaseId, state])
        )
      })
    }
  }

  function dispose(): void {
    unsubscribeWebState?.()
    unsubscribeWebState = null
    unsubscribeWebOpen?.()
    unsubscribeWebOpen = null
    unsubscribePreview?.()
    unsubscribePreview = null
  }

  function snapshotCurrentEditor(): void {
    if (!activeKnowledgeBaseId.value) return
    knowledgeBaseEditors.value = {
      ...knowledgeBaseEditors.value,
      [activeKnowledgeBaseId.value]: {
        layout: layout.value,
        activeGroupId: activeGroupId.value,
        lastNoteByGroup: lastNoteByGroup.value
      }
    }
  }

  function switchKnowledgeBase(
    knowledgeBaseId: string,
    validNoteUuids?: ReadonlySet<string>
  ): void {
    const switching = activeKnowledgeBaseId.value !== knowledgeBaseId
    if (switching) snapshotCurrentEditor()
    const source = switching
      ? (knowledgeBaseEditors.value[knowledgeBaseId] ?? emptyEditorSession())
      : {
          layout: layout.value,
          activeGroupId: activeGroupId.value,
          lastNoteByGroup: lastNoteByGroup.value
        }
    const next = normalizeEditorSession(
      source,
      new Set([knowledgeBaseId]),
      defaultNotePageWidth.value,
      knowledgeBaseId,
      validNoteUuids
    )
    activeKnowledgeBaseId.value = knowledgeBaseId
    layout.value = next.layout
    activeGroupId.value = next.activeGroupId
    lastNoteByGroup.value = next.lastNoteByGroup ?? {}
    knowledgeBaseEditors.value = { ...knowledgeBaseEditors.value, [knowledgeBaseId]: next }
    trimToLimit()
  }

  function retainKnowledgeBases(validKnowledgeBaseIds: ReadonlySet<string>): void {
    snapshotCurrentEditor()
    const retained: Record<string, KnowledgeBaseEditorSession> = {}
    for (const [knowledgeBaseId, session] of Object.entries(knowledgeBaseEditors.value)) {
      if (validKnowledgeBaseIds.has(knowledgeBaseId)) {
        retained[knowledgeBaseId] = session
        continue
      }
      for (const group of listGroups(session.layout)) {
        for (const tab of group.tabs) {
          if (tab.type === 'web') void window.desk.web.close(tab.id)
        }
      }
    }
    knowledgeBaseEditors.value = retained
    if (activeKnowledgeBaseId.value && !validKnowledgeBaseIds.has(activeKnowledgeBaseId.value)) {
      const empty = emptyEditorSession()
      activeKnowledgeBaseId.value = null
      layout.value = empty.layout
      activeGroupId.value = empty.activeGroupId
      lastNoteByGroup.value = {}
    }
  }

  function restore(
    session: WorkspaceSession | null,
    knowledgeBases: KnowledgeBaseDescriptor[],
    selectableKnowledgeBaseIds = new Set(knowledgeBases.map((item) => item.id))
  ): void {
    const knowledgeBaseIds = new Set(knowledgeBases.map((item) => item.id))
    if (!session) {
      const empty = emptyEditorSession()
      layout.value = empty.layout
      activeGroupId.value = empty.activeGroupId
      activeKnowledgeBaseId.value = null
      knowledgeBaseEditors.value = {}
      return
    }
    const restoredEditors: Record<string, KnowledgeBaseEditorSession> = {}
    for (const [knowledgeBaseId, editorSession] of Object.entries(
      session.knowledgeBaseEditors ?? {}
    )) {
      if (!knowledgeBaseIds.has(knowledgeBaseId)) continue
      restoredEditors[knowledgeBaseId] = normalizeEditorSession(
        editorSession,
        knowledgeBaseIds,
        defaultNotePageWidth.value,
        knowledgeBaseId
      )
    }
    knowledgeBaseEditors.value = restoredEditors
    const selectedKnowledgeBaseId =
      session.selectedKnowledgeBaseId &&
      selectableKnowledgeBaseIds.has(session.selectedKnowledgeBaseId)
        ? session.selectedKnowledgeBaseId
        : null
    const restored = selectedKnowledgeBaseId
      ? (restoredEditors[selectedKnowledgeBaseId] ?? emptyEditorSession())
      : emptyEditorSession()
    activeKnowledgeBaseId.value = selectedKnowledgeBaseId
    layout.value = restored.layout
    activeGroupId.value = restored.activeGroupId
    lastNoteByGroup.value = restored.lastNoteByGroup ?? {}
    knowledgeSidebarWidth.value = session.knowledgeSidebarWidth
    navigatorSidebarWidth.value = session.navigatorSidebarWidth
    knowledgeSidebarCollapsed.value = session.knowledgeSidebarCollapsed
    navigatorSidebarCollapsed.value = session.navigatorSidebarCollapsed
    expandedTocNodes.value = session.expandedTocNodes
    trimToLimit()
  }

  function reset(): void {
    const webTabIds = new Set<string>()
    for (const editorLayout of [
      layout.value,
      ...Object.values(knowledgeBaseEditors.value).map((session) => session.layout)
    ]) {
      for (const group of listGroups(editorLayout)) {
        for (const tab of group.tabs) {
          if (tab.type === 'web') webTabIds.add(tab.id)
        }
      }
    }
    for (const tabId of webTabIds) void window.desk.web.close(tabId)
    const empty = emptyEditorSession()
    layout.value = empty.layout
    activeGroupId.value = empty.activeGroupId
    activeKnowledgeBaseId.value = null
    knowledgeBaseEditors.value = {}
    lastNoteByGroup.value = {}
    webStates.value = {}
  }

  function activate(groupId: string, tabId: string): void {
    const beforeGroup = findGroup(layout.value, groupId)
    const before = beforeGroup?.tabs.find((tab) => tab.id === beforeGroup.activeTabId)
    if (before?.type === 'note') {
      lastNoteByGroup.value = {
        ...lastNoteByGroup.value,
        [groupId]: { noteUuid: before.noteUuid, noteTitle: before.title }
      }
    }
    activeGroupId.value = groupId
    layout.value = activateTabInLayout(layout.value, groupId, tabId)
    const tab = findTab(layout.value, tabId)?.tab
    if (tab?.type === 'note') {
      const scope = { noteUuid: tab.noteUuid, noteTitle: tab.title }
      lastNoteByGroup.value = { ...lastNoteByGroup.value, [groupId]: scope }
    }
  }

  function cycleActiveTab(direction: 'next' | 'previous'): void {
    const group = activeGroup.value
    if (!group) return
    layout.value = cycleTab(layout.value, group.id, direction)
    const next = findGroup(layout.value, group.id)?.tabs.find(
      (tab) => tab.id === findGroup(layout.value, group.id)?.activeTabId
    )
    if (next?.type === 'note') {
      lastNoteByGroup.value = {
        ...lastNoteByGroup.value,
        [group.id]: { noteUuid: next.noteUuid, noteTitle: next.title }
      }
    }
  }

  function closableTabs(
    excludedIds = new Set<string>()
  ): Array<{ groupId: string; tab: EditorTab }> {
    return groups.value
      .flatMap((group) => group.tabs.map((tab) => ({ groupId: group.id, tab })))
      .filter(({ tab }) => !tab.pinned && !excludedIds.has(tab.id) && !hasUnsavedChanges(tab))
      .sort((left, right) => (left.tab.openedAt ?? 0) - (right.tab.openedAt ?? 0))
  }

  function ensureRoomForTab(excludedIds = new Set<string>()): void {
    while (tabCount.value >= maxOpenTabCount.value) {
      const oldest = closableTabs(excludedIds)[0]
      if (!oldest) {
        throw new Error(
          `标签数量已达到上限 ${maxOpenTabCount.value}，请先解除固定或保存并关闭一个标签。`
        )
      }
      close(oldest.groupId, oldest.tab.id)
    }
  }

  function trimToLimit(): void {
    while (tabCount.value > maxOpenTabCount.value) {
      const oldest = closableTabs()[0]
      if (!oldest) return
      close(oldest.groupId, oldest.tab.id)
    }
  }

  function keepOpen(tabId: string): void {
    const located = findTab(layout.value, tabId)
    if (located?.tab.type !== 'note' || !located.tab.preview) return
    located.tab.preview = false
    layout.value = { ...layout.value }
  }

  function setPinned(tabId: string, pinned: boolean): void {
    const located = findTab(layout.value, tabId)
    if (!located) return
    located.tab.pinned = pinned
    if (located.tab.type === 'note' && pinned) located.tab.preview = false
    layout.value = { ...layout.value }
  }

  function togglePinned(tabId: string): void {
    const located = findTab(layout.value, tabId)
    if (located) setPinned(tabId, !located.tab.pinned)
  }

  function setNoteDirty(knowledgeBaseId: string, noteUuid: string, dirty: boolean): void {
    const updateLayout = (editorLayout: EditorLayoutNode): boolean => {
      let changed = false
      for (const group of listGroups(editorLayout)) {
        for (const tab of group.tabs) {
          if (
            tab.type === 'note' &&
            tab.knowledgeBaseId === knowledgeBaseId &&
            tab.noteUuid === noteUuid
          ) {
            tab.dirty = dirty
            if (dirty) tab.preview = false
            changed = true
          }
        }
      }
      return changed
    }
    if (updateLayout(layout.value)) layout.value = { ...layout.value }
    let storedChanged = false
    for (const [storedKnowledgeBaseId, session] of Object.entries(knowledgeBaseEditors.value)) {
      if (storedKnowledgeBaseId === activeKnowledgeBaseId.value) continue
      if (updateLayout(session.layout)) storedChanged = true
    }
    if (storedChanged) knowledgeBaseEditors.value = { ...knowledgeBaseEditors.value }
  }

  function renameNote(knowledgeBaseId: string, noteUuid: string, title: string): void {
    const updateLayout = (editorLayout: EditorLayoutNode): boolean => {
      let changed = false
      for (const group of listGroups(editorLayout)) {
        for (const tab of group.tabs) {
          if (
            tab.type === 'note' &&
            tab.knowledgeBaseId === knowledgeBaseId &&
            tab.noteUuid === noteUuid
          ) {
            tab.title = title
            changed = true
          }
        }
      }
      return changed
    }
    if (updateLayout(layout.value)) layout.value = { ...layout.value }
    let storedChanged = false
    for (const [storedKnowledgeBaseId, session] of Object.entries(knowledgeBaseEditors.value)) {
      if (storedKnowledgeBaseId === activeKnowledgeBaseId.value) continue
      if (updateLayout(session.layout)) storedChanged = true
    }
    if (storedChanged) knowledgeBaseEditors.value = { ...knowledgeBaseEditors.value }
  }

  function removeNoteFromStoredEditors(knowledgeBaseId: string, noteUuid: string): void {
    const session = knowledgeBaseEditors.value[knowledgeBaseId]
    if (!session || knowledgeBaseId === activeKnowledgeBaseId.value) return
    let next = session.layout
    let changed = false
    for (const group of listGroups(session.layout)) {
      for (const tab of group.tabs) {
        if (
          tab.type === 'note' &&
          tab.knowledgeBaseId === knowledgeBaseId &&
          tab.noteUuid === noteUuid
        ) {
          next = removeTab(next, group.id, tab.id)
          changed = true
        }
      }
    }
    if (!changed) return
    next = collapseEmptyGroups(next)
    const remainingGroups = listGroups(next)
    knowledgeBaseEditors.value = {
      ...knowledgeBaseEditors.value,
      [knowledgeBaseId]: {
        layout: next,
        activeGroupId: remainingGroups.some((group) => group.id === session.activeGroupId)
          ? session.activeGroupId
          : remainingGroups[0].id,
        lastNoteByGroup: Object.fromEntries(
          Object.entries(session.lastNoteByGroup ?? {}).filter(
            ([, scope]) => scope.noteUuid !== noteUuid
          )
        )
      }
    }
  }

  function openNote(
    knowledgeBase: KnowledgeBaseDescriptor,
    noteUuid: string,
    title: string,
    viewMode: NoteViewMode,
    split?: SplitPlacement,
    openBehavior: 'preview' | 'permanent' = 'preview'
  ): string {
    if (activeKnowledgeBaseId.value !== knowledgeBase.id) switchKnowledgeBase(knowledgeBase.id)
    const targetGroup = activeGroup.value
    if (!split && targetGroup) {
      const existing = targetGroup.tabs.find(
        (tab) =>
          tab.type === 'note' &&
          tab.knowledgeBaseId === knowledgeBase.id &&
          tab.noteUuid === noteUuid
      )
      if (existing) {
        activate(targetGroup.id, existing.id)
        if (openBehavior === 'permanent') keepOpen(existing.id)
        return existing.id
      }
    }

    const tab: NoteEditorTab = {
      id: createId('note'),
      type: 'note',
      knowledgeBaseId: knowledgeBase.id,
      knowledgeBaseName: knowledgeBase.displayName,
      noteUuid,
      title,
      icon: knowledgeBase.icon,
      viewMode,
      pageWidth: defaultNotePageWidth.value,
      outlineVisible: true,
      noteAssetsVisible: false,
      preview: openBehavior === 'preview',
      pinned: false,
      openedAt: Date.now(),
      dirty: false
    }
    if (split) {
      const currentGroupId = activeGroupId.value
      const excluded = new Set(activeTab.value ? [activeTab.value.id] : [])
      ensureRoomForTab(excluded)
      const targetGroupId = findGroup(layout.value, currentGroupId)
        ? currentGroupId
        : activeGroupId.value
      const result = splitGroupWithTab(layout.value, targetGroupId, split, tab)
      layout.value = result.layout
      activeGroupId.value = result.groupId
    } else {
      const previewTab = activeGroup.value?.tabs.find(
        (candidate) =>
          candidate.type === 'note' &&
          candidate.preview &&
          !candidate.pinned &&
          !hasUnsavedChanges(candidate)
      )
      if (openBehavior === 'preview' && previewTab && activeGroup.value) {
        // Reuse the preview tab id so Vue keeps the pane mounted across note swaps
        // (EditorGroup keys panes by tab.id). Milkdown still remounts via noteUuid/content.
        const reused: NoteEditorTab = { ...tab, id: previewTab.id }
        const groupId = activeGroup.value.id
        layout.value = updateGroup(layout.value, groupId, (group) => ({
          ...group,
          tabs: group.tabs.map((candidate) =>
            candidate.id === previewTab.id ? reused : candidate
          ),
          activeTabId: reused.id
        }))
        lastNoteByGroup.value = {
          ...lastNoteByGroup.value,
          [groupId]: { noteUuid, noteTitle: title }
        }
        return reused.id
      }
      ensureRoomForTab()
      layout.value = insertTab(layout.value, activeGroupId.value, tab)
    }
    lastNoteByGroup.value = {
      ...lastNoteByGroup.value,
      [activeGroupId.value]: { noteUuid, noteTitle: title }
    }
    return tab.id
  }

  function openWeb(url = DEFAULT_WEB_URL, targetGroupId?: string): string {
    const groupId = targetGroupId ?? activeGroupId.value
    const current = findGroup(layout.value, groupId)?.tabs.find(
      (tab) => tab.id === findGroup(layout.value, groupId)?.activeTabId
    )
    if (current?.type === 'note') {
      lastNoteByGroup.value = {
        ...lastNoteByGroup.value,
        [groupId]: { noteUuid: current.noteUuid, noteTitle: current.title }
      }
    }
    ensureRoomForTab()
    const tab: WebEditorTab = {
      id: createId('web'),
      type: 'web',
      url,
      title: url,
      pinned: false,
      openedAt: Date.now()
    }
    layout.value = insertTab(layout.value, groupId, tab)
    activeGroupId.value = groupId
    return tab.id
  }

  function openKbSettings(knowledgeBase: KnowledgeBaseDescriptor): string {
    if (activeKnowledgeBaseId.value !== knowledgeBase.id) switchKnowledgeBase(knowledgeBase.id)
    const tabId = `kb-settings:${knowledgeBase.id}`
    for (const group of groups.value) {
      const existing = group.tabs.find(
        (tab) => tab.type === 'kb-settings' && tab.knowledgeBaseId === knowledgeBase.id
      )
      if (existing) {
        activate(group.id, existing.id)
        return existing.id
      }
    }
    ensureRoomForTab()
    const tab: KbSettingsEditorTab = {
      id: tabId,
      type: 'kb-settings',
      knowledgeBaseId: knowledgeBase.id,
      knowledgeBaseName: knowledgeBase.displayName,
      title: `配置 · ${knowledgeBase.displayName}`,
      icon: knowledgeBase.icon,
      pinned: false,
      openedAt: Date.now(),
      dirty: false
    }
    layout.value = insertTab(layout.value, activeGroupId.value, tab)
    return tab.id
  }

  function openKbAssets(knowledgeBase: KnowledgeBaseDescriptor): string {
    if (activeKnowledgeBaseId.value !== knowledgeBase.id) switchKnowledgeBase(knowledgeBase.id)
    const tabId = `kb-assets:${knowledgeBase.id}`
    for (const group of groups.value) {
      const existing = group.tabs.find(
        (tab) => tab.type === 'kb-assets' && tab.knowledgeBaseId === knowledgeBase.id
      )
      if (existing) {
        activate(group.id, existing.id)
        return existing.id
      }
    }
    ensureRoomForTab()
    const tab: KbAssetsEditorTab = {
      id: tabId,
      type: 'kb-assets',
      knowledgeBaseId: knowledgeBase.id,
      knowledgeBaseName: knowledgeBase.displayName,
      title: `资源 · ${knowledgeBase.displayName}`,
      icon: knowledgeBase.icon,
      pinned: false,
      openedAt: Date.now()
    }
    layout.value = insertTab(layout.value, activeGroupId.value, tab)
    return tab.id
  }

  /** 文件名四位前缀即归属笔记编号；与 kb 层同一规则，这里只做展示用解析。 */
  function ownerIndexFromPath(relPath: string): string | null {
    const name = relPath.split('/').pop() ?? ''
    return /^(\d{4})-/.exec(name)?.[1] ?? null
  }

  /**
   * 该文件是否已经在某个标签页里打开（含后台 KB 的布局）。
   *
   * 笔记内嵌卡片用它保证「单文件单写者」：文件已在标签页里编辑时，卡片只跳转不过去
   * 再开第二个会话。
   */
  function excalidrawTabIdFor(knowledgeBaseId: string, relPath: string): string | null {
    let found: string | null = null
    const search = (editorLayout: EditorLayoutNode): void => {
      if (found) return
      for (const group of listGroups(editorLayout)) {
        const tab = group.tabs.find(
          (item) =>
            item.type === 'excalidraw' &&
            item.knowledgeBaseId === knowledgeBaseId &&
            item.relPath === relPath
        )
        if (tab) {
          found = tab.id
          return
        }
      }
    }
    search(layout.value)
    for (const [storedKnowledgeBaseId, session] of Object.entries(knowledgeBaseEditors.value)) {
      if (storedKnowledgeBaseId === activeKnowledgeBaseId.value) continue
      search(session.layout)
      if (found) break
    }
    return found
  }

  /**
   * 打开笔记历史标签页。同一 KB + 同一编号只保留一个标签页：
   * 切换 commit 只更新该页选中版本，不会打开大量标签页（计划 5）。
   */
  function openNoteHistory(
    knowledgeBase: KnowledgeBaseDescriptor,
    input: { noteIndex: string; commit: string; noteUuid?: string; title?: string }
  ): string {
    if (activeKnowledgeBaseId.value !== knowledgeBase.id) switchKnowledgeBase(knowledgeBase.id)
    for (const group of groups.value) {
      const existing = group.tabs.find(
        (tab) =>
          tab.type === 'note-history' &&
          tab.knowledgeBaseId === knowledgeBase.id &&
          tab.noteIndex === input.noteIndex
      )
      if (existing?.type === 'note-history') {
        existing.commit = input.commit
        if (input.noteUuid !== undefined) existing.noteUuid = input.noteUuid
        layout.value = { ...layout.value }
        activate(group.id, existing.id)
        return existing.id
      }
    }
    ensureRoomForTab()
    const tab: NoteHistoryEditorTab = {
      id: `note-history:${knowledgeBase.id}:${input.noteIndex}`,
      type: 'note-history',
      knowledgeBaseId: knowledgeBase.id,
      knowledgeBaseName: knowledgeBase.displayName,
      noteIndex: input.noteIndex,
      noteUuid: input.noteUuid,
      commit: input.commit,
      title: input.title ?? `历史 · ${input.noteIndex}`,
      icon: knowledgeBase.icon,
      pinned: false,
      openedAt: Date.now()
    }
    layout.value = insertTab(layout.value, activeGroupId.value, tab)
    return tab.id
  }

  /** 历史标签页切换选中 commit（只影响显示，不写任何文件）。 */
  function selectHistoryCommit(tabId: string, commit: string): void {
    const located = findTab(layout.value, tabId)
    if (located?.tab.type !== 'note-history') return
    located.tab.commit = commit
    layout.value = { ...layout.value }
  }

  /**
   * 打开画布源文件。同一文件只保留一个标签页：再次打开定位到已有实例，
   * 避免出现第二个编辑会话（计划 2.3 单文件单写者）。
   */
  function openExcalidraw(
    knowledgeBase: KnowledgeBaseDescriptor,
    relPath: string,
    meta: { title?: string; ownerNoteIndex?: string | null } = {}
  ): string {
    if (activeKnowledgeBaseId.value !== knowledgeBase.id) switchKnowledgeBase(knowledgeBase.id)
    for (const group of groups.value) {
      const existing = group.tabs.find(
        (tab) =>
          tab.type === 'excalidraw' &&
          tab.knowledgeBaseId === knowledgeBase.id &&
          tab.relPath === relPath
      )
      if (existing) {
        activate(group.id, existing.id)
        return existing.id
      }
    }
    ensureRoomForTab()
    const fileName = relPath.split('/').pop() ?? relPath
    const tab: ExcalidrawEditorTab = {
      id: `excalidraw:${knowledgeBase.id}:${relPath}`,
      type: 'excalidraw',
      knowledgeBaseId: knowledgeBase.id,
      knowledgeBaseName: knowledgeBase.displayName,
      relPath,
      ownerNoteIndex: meta.ownerNoteIndex ?? ownerIndexFromPath(relPath),
      title: meta.title ?? fileName,
      icon: knowledgeBase.icon,
      pinned: false,
      openedAt: Date.now()
    }
    layout.value = insertTab(layout.value, activeGroupId.value, tab)
    return tab.id
  }

  /**
   * 打开知识库里的普通文本文件（只读）。
   *
   * 同一 KB + 同一路径只有一个标签：从笔记目录和面包屑打开同一份文件必须复用同一页，
   * 不能出现两份互相覆盖的视图。
   */
  function openTextFile(knowledgeBase: KnowledgeBaseDescriptor, relPath: string): string {
    if (activeKnowledgeBaseId.value !== knowledgeBase.id) switchKnowledgeBase(knowledgeBase.id)
    for (const group of groups.value) {
      const existing = group.tabs.find(
        (tab) =>
          tab.type === 'text-file' &&
          tab.knowledgeBaseId === knowledgeBase.id &&
          tab.relPath === relPath
      )
      if (existing) {
        activate(group.id, existing.id)
        return existing.id
      }
    }
    ensureRoomForTab()
    const fileName = relPath.split('/').pop() ?? relPath
    const tab: TextFileEditorTab = {
      id: `text-file:${knowledgeBase.id}:${relPath}`,
      type: 'text-file',
      knowledgeBaseId: knowledgeBase.id,
      knowledgeBaseName: knowledgeBase.displayName,
      relPath,
      title: fileName,
      icon: knowledgeBase.icon,
      pinned: false,
      openedAt: Date.now()
    }
    layout.value = insertTab(layout.value, activeGroupId.value, tab)
    return tab.id
  }

  /** 该文件是否已经打开（面包屑据此高亮/复用） */
  function textFileTabIdFor(knowledgeBaseId: string, relPath: string): string | null {
    for (const group of groups.value) {
      const tab = group.tabs.find(
        (item) =>
          item.type === 'text-file' &&
          item.knowledgeBaseId === knowledgeBaseId &&
          item.relPath === relPath
      )
      if (tab) return tab.id
    }
    return null
  }

  /** 重命名/外部变更后更新标签身份；文件失效时置 invalid 而不是重建。 */
  function updateExcalidrawTabMeta(
    tabId: string,
    meta: {
      relPath?: string
      title?: string
      ownerNoteIndex?: string | null
      dirty?: boolean
      invalid?: boolean
    }
  ): void {
    const located = findTab(layout.value, tabId)
    if (located?.tab.type !== 'excalidraw') return
    const tab = located.tab
    if (meta.relPath !== undefined) tab.relPath = meta.relPath
    if (meta.title !== undefined) tab.title = meta.title
    if (meta.ownerNoteIndex !== undefined) tab.ownerNoteIndex = meta.ownerNoteIndex
    if (meta.dirty !== undefined) tab.dirty = meta.dirty
    if (meta.invalid !== undefined) tab.invalid = meta.invalid
    layout.value = { ...layout.value }
  }

  /**
   * 资源面板完成重命名/回收后同步画布标签身份。
   *
   * - 改名：跟随新路径（内容未变，会话与撤销历史继续有效），并刷新标题与归属前缀
   * - 回收/合并（`toRelPath` 为空）：文件已离开原路径，只置失效，**不按旧路径重建**
   */
  function repathExcalidrawTab(
    knowledgeBaseId: string,
    fromRelPath: string,
    toRelPath: string | null
  ): void {
    const updateLayout = (editorLayout: EditorLayoutNode): boolean => {
      let changed = false
      for (const group of listGroups(editorLayout)) {
        for (const tab of group.tabs) {
          if (
            tab.type !== 'excalidraw' ||
            tab.knowledgeBaseId !== knowledgeBaseId ||
            tab.relPath !== fromRelPath
          ) {
            continue
          }
          if (toRelPath) {
            tab.relPath = toRelPath
            tab.title = toRelPath.split('/').pop() ?? toRelPath
            tab.ownerNoteIndex = ownerIndexFromPath(toRelPath)
            tab.invalid = false
          } else {
            tab.invalid = true
          }
          changed = true
        }
      }
      return changed
    }
    if (updateLayout(layout.value)) layout.value = { ...layout.value }
    let storedChanged = false
    for (const [storedKnowledgeBaseId, session] of Object.entries(knowledgeBaseEditors.value)) {
      if (storedKnowledgeBaseId === activeKnowledgeBaseId.value) continue
      if (updateLayout(session.layout)) storedChanged = true
    }
    if (storedChanged) knowledgeBaseEditors.value = { ...knowledgeBaseEditors.value }
  }

  function setKbSettingsDirty(tabId: string, dirty: boolean): void {
    const located = findTab(layout.value, tabId)
    if (located?.tab.type !== 'kb-settings') return
    if (Boolean(located.tab.dirty) === dirty) return
    located.tab.dirty = dirty
    layout.value = { ...layout.value }
  }

  function updateKbSettingsTabMeta(
    tabId: string,
    meta: { knowledgeBaseName?: string; icon?: KnowledgeBaseIconDto | null }
  ): void {
    const located = findTab(layout.value, tabId)
    if (located?.tab.type !== 'kb-settings') return
    if (meta.knowledgeBaseName !== undefined) {
      located.tab.knowledgeBaseName = meta.knowledgeBaseName
      located.tab.title = `配置 · ${meta.knowledgeBaseName}`
    }
    if (meta.icon !== undefined) located.tab.icon = meta.icon
    layout.value = { ...layout.value }
  }

  async function startPreview(knowledgeBaseId: string, noteDirName?: string): Promise<void> {
    const result = await window.desk.preview.start({ knowledgeBaseId, noteDirName })
    if (!result.ok) throw new Error(result.error.message)
    previewStates.value = {
      ...previewStates.value,
      [knowledgeBaseId]: result.value.state
    }
    if (result.value.url) openWeb(result.value.url)
  }

  async function stopPreview(knowledgeBaseId: string): Promise<void> {
    const result = await window.desk.preview.stop(knowledgeBaseId)
    if (!result.ok) throw new Error(result.error.message)
    previewStates.value = {
      ...previewStates.value,
      [knowledgeBaseId]: result.value
    }
  }

  function close(groupId: string, tabId: string): boolean {
    const located = findTab(layout.value, tabId)
    if (!located || located.tab.pinned) return false
    if (located?.tab.type === 'web') {
      void window.desk.web.close(tabId)
      const nextStates = { ...webStates.value }
      delete nextStates[tabId]
      webStates.value = nextStates
    }
    layout.value = collapseEmptyGroups(removeTab(layout.value, groupId, tabId))
    const remainingGroups = listGroups(layout.value)
    if (!remainingGroups.some((group) => group.id === activeGroupId.value)) {
      activeGroupId.value = remainingGroups[0].id
    }
    return true
  }

  function closeSavedNotes(): void {
    const targets = groups.value.flatMap((group) =>
      group.tabs
        .filter(
          (tab) => tab.type !== 'web' && tab.type !== 'note-history' && !tab.dirty && !tab.pinned
        )
        .map((tab) => ({ groupId: group.id, tabId: tab.id }))
    )
    for (const target of targets) close(target.groupId, target.tabId)
  }

  function closeAllTabs(): void {
    const targets = groups.value.flatMap((group) =>
      group.tabs.filter((tab) => !tab.pinned).map((tab) => ({ groupId: group.id, tabId: tab.id }))
    )
    for (const target of targets) close(target.groupId, target.tabId)
  }

  function closeAllWebTabs(): void {
    const targets = groups.value.flatMap((group) =>
      group.tabs
        .filter((tab) => tab.type === 'web' && !tab.pinned)
        .map((tab) => ({ groupId: group.id, tabId: tab.id }))
    )
    for (const target of targets) close(target.groupId, target.tabId)
  }

  function closeNote(knowledgeBaseId: string, noteUuid: string): void {
    removeNoteFromStoredEditors(knowledgeBaseId, noteUuid)
    for (const group of [...groups.value]) {
      for (const tab of [...group.tabs]) {
        if (
          tab.type === 'note' &&
          tab.knowledgeBaseId === knowledgeBaseId &&
          tab.noteUuid === noteUuid
        ) {
          close(group.id, tab.id)
        }
      }
    }
    if (knowledgeBaseId === activeKnowledgeBaseId.value) {
      lastNoteByGroup.value = Object.fromEntries(
        Object.entries(lastNoteByGroup.value).filter(([, scope]) => scope.noteUuid !== noteUuid)
      )
    }
  }

  function setNoteViewMode(tabId: string, viewMode: NoteViewMode): void {
    const located = findTab(layout.value, tabId)
    if (located?.tab.type !== 'note') return
    located.tab.viewMode = viewMode
    layout.value = { ...layout.value }
  }

  function setNotePageWidth(tabId: string, pageWidth: NotePageWidth): void {
    const located = findTab(layout.value, tabId)
    if (located?.tab.type !== 'note') return
    located.tab.pageWidth = pageWidth
    layout.value = { ...layout.value }
  }

  function toggleNotePageWidth(tabId: string): void {
    const located = findTab(layout.value, tabId)
    if (located?.tab.type !== 'note') return
    setNotePageWidth(tabId, located.tab.pageWidth === 'wide' ? 'standard' : 'wide')
  }

  function toggleNoteOutlineVisible(tabId: string): void {
    const located = findTab(layout.value, tabId)
    if (located?.tab.type !== 'note') return
    const outlineVisible = located.tab.outlineVisible === false
    layout.value = updateGroup(layout.value, located.group.id, (group) => ({
      ...group,
      tabs: group.tabs.map((tab) =>
        tab.id === tabId && tab.type === 'note' ? { ...tab, outlineVisible } : tab
      )
    }))
  }

  /**
   * 显示 / 隐藏某标签页的「本笔记资源」面板。
   *
   * 做成「设成某个值」而不是只有 toggle：右键菜单里的「显示本笔记资源」是**命令**，
   * 面板已经开着时再点一次不该把它关掉（toggle 只服务于工具栏那个图标按钮）。
   */
  function setNoteAssetsVisible(tabId: string, visible: boolean): void {
    const located = findTab(layout.value, tabId)
    if (located?.tab.type !== 'note') return
    if ((located.tab.noteAssetsVisible === true) === visible) return
    layout.value = updateGroup(layout.value, located.group.id, (group) => ({
      ...group,
      tabs: group.tabs.map((tab) =>
        tab.id === tabId && tab.type === 'note' ? { ...tab, noteAssetsVisible: visible } : tab
      )
    }))
  }

  function toggleNoteAssetsVisible(tabId: string): void {
    const located = findTab(layout.value, tabId)
    if (located?.tab.type !== 'note') return
    setNoteAssetsVisible(tabId, located.tab.noteAssetsVisible !== true)
  }

  function moveTab(tabId: string, targetGroupId: string, targetIndex?: number): void {
    const located = findTab(layout.value, tabId)
    if (!located) return
    let next = removeTab(layout.value, located.group.id, tabId)
    next = insertTab(next, targetGroupId, located.tab, targetIndex)
    layout.value = collapseEmptyGroups(next)
    activeGroupId.value = targetGroupId
  }

  function splitTab(
    tabId: string,
    targetGroupId: string,
    placement: SplitPlacement,
    behavior: 'auto' | 'move' = 'auto'
  ): void {
    const located = findTab(layout.value, tabId)
    if (!located) return
    const sameGroup = located.group.id === targetGroupId
    // 画布是单文件单写者：拆分只能搬走标签，复制会出现两个会话同时写一个文件
    const duplicate = sameGroup && behavior !== 'move' && located.tab.type !== 'excalidraw'
    if (sameGroup && !duplicate && located.group.tabs.length === 1) return
    if (duplicate) ensureRoomForTab(new Set([tabId]))
    const resolvedTargetGroupId = findGroup(layout.value, targetGroupId)
      ? targetGroupId
      : activeGroupId.value
    const tab = duplicate ? cloneTab(located.tab) : located.tab
    let next = layout.value
    if (!duplicate) next = removeTab(next, located.group.id, tabId)
    const result = splitGroupWithTab(next, resolvedTargetGroupId, placement, tab)
    layout.value = collapseEmptyGroups(result.layout)
    activeGroupId.value = result.groupId
  }

  function splitActive(placement: SplitPlacement): void {
    if (!activeTab.value) return
    splitTab(activeTab.value.id, activeGroupId.value, placement)
  }

  function resizeSplit(splitId: string, ratio: number): void {
    layout.value = setSplitRatio(layout.value, splitId, ratio)
  }

  function toSession(selectedKnowledgeBaseId: string | null): WorkspaceSession {
    const serializedLayout = JSON.parse(JSON.stringify(layout.value)) as EditorLayoutNode
    const editors = activeKnowledgeBaseId.value
      ? {
          ...knowledgeBaseEditors.value,
          [activeKnowledgeBaseId.value]: {
            layout: layout.value,
            activeGroupId: activeGroupId.value,
            lastNoteByGroup: lastNoteByGroup.value
          }
        }
      : knowledgeBaseEditors.value
    const serializedKnowledgeBaseEditors = JSON.parse(JSON.stringify(editors)) as Record<
      string,
      KnowledgeBaseEditorSession
    >
    const serializedExpandedNodes = JSON.parse(JSON.stringify(expandedTocNodes.value)) as Record<
      string,
      string[]
    >
    return {
      version: 1,
      selectedKnowledgeBaseId,
      layout: serializedLayout,
      activeGroupId: activeGroupId.value,
      knowledgeBaseEditors: serializedKnowledgeBaseEditors,
      knowledgeSidebarWidth: knowledgeSidebarWidth.value,
      navigatorSidebarWidth: navigatorSidebarWidth.value,
      knowledgeSidebarCollapsed: knowledgeSidebarCollapsed.value,
      navigatorSidebarCollapsed: navigatorSidebarCollapsed.value,
      expandedTocNodes: serializedExpandedNodes
    }
  }

  return {
    layout,
    activeGroupId,
    activeGroup,
    activeTab,
    activeNoteScope,
    tabCount,
    groups,
    webStates,
    webViewsSuspended,
    previewStates,
    knowledgeSidebarWidth,
    navigatorSidebarWidth,
    knowledgeSidebarCollapsed,
    navigatorSidebarCollapsed,
    expandedTocNodes,
    maxOpenTabCount,
    wrapTabs,
    defaultNotePageWidth,
    activeKnowledgeBaseId,
    knowledgeBaseEditors,
    lastNoteByGroup,
    configure,
    setUnsavedChangesResolver,
    initializeWebEvents,
    dispose,
    restore,
    reset,
    switchKnowledgeBase,
    retainKnowledgeBases,
    activate,
    cycleActiveTab,
    openNote,
    openWeb,
    openKbSettings,
    openKbAssets,
    openExcalidraw,
    openNoteHistory,
    selectHistoryCommit,
    excalidrawTabIdFor,
    openTextFile,
    textFileTabIdFor,
    updateExcalidrawTabMeta,
    repathExcalidrawTab,
    setKbSettingsDirty,
    updateKbSettingsTabMeta,
    startPreview,
    stopPreview,
    close,
    closeSavedNotes,
    closeAllTabs,
    closeAllWebTabs,
    closeNote,
    renameNote,
    setNoteViewMode,
    setNotePageWidth,
    toggleNotePageWidth,
    toggleNoteOutlineVisible,
    setNoteAssetsVisible,
    toggleNoteAssetsVisible,
    setNoteDirty,
    keepOpen,
    setPinned,
    togglePinned,
    moveTab,
    splitTab,
    splitActive,
    resizeSplit,
    toSession
  }
})
