<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import TocNodeList from './TocNodeList.vue'
import UiTooltip from './UiTooltip.vue'
import { batchTargetIds, collectNoteIds, toggleBatchIds } from './batchDeleteSelection'
import { classifyChangePath } from './changeCategory'
import { mergeRenameChanges } from './mergeRenameChanges'
import { noteFileName } from '../commands/noteFileName'
import { showNoteIndex, toggleShowNoteIndex } from './tocNoteIndex'
import { navigatorView, setNavigatorView, type NavigatorView } from './navigatorView'
import { isConfiguredIde } from './configuredIde'
import { flatPinnedNotes, listsEqual, prunePinIds } from '../../../shared/pinList'
import { isTocDrag, noteFromTocDrag } from '../../../shared/tocDrag'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'

import type {
  DeskTocNode,
  KbDemoEntryDto,
  NavigatorSidebarMenuAction
} from '../../../shared/contracts'

const emit = defineEmits<{
  createNote: [node?: DeskTocNode, placement?: 'before' | 'after' | 'inside']
  createNotes: []
  createGroup: []
  requestRename: [node: DeskTocNode]
  requestReindex: [node: Extract<DeskTocNode, { type: 'note' }>]
  requestDelete: [node: DeskTocNode]
  requestBatchDelete: [noteUuids: string[]]
  openSettings: []
}>()

const store = useWorkspaceStore()
const editor = useEditorStore()
const query = ref('')
const tocExpanded = ref(true)
const noteFileExpanded = ref(true)
const configFileExpanded = ref(true)
const otherFileExpanded = ref(true)
const tocListRef = ref<InstanceType<typeof TocNodeList> | null>(null)
const batchDeleting = ref(false)
const batchSelected = ref(new Set<string>())
const previewBusy = ref(false)
const dismissedPreviewError = ref('')
const menuBusy = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

const tocNodes = computed(() => store.knowledgeBase?.toc ?? [])
const searchInputRef = ref<HTMLInputElement | null>(null)
const sidebarExtras = ref({ hasAssets: false, hasDemos: false })
const demosMode = ref<'closed' | 'need-ide' | 'list'>('closed')
const demos = ref<KbDemoEntryDto[]>([])
const demosError = ref('')
let extrasSequence = 0

const assetsTabActive = computed(() => {
  const tab = editor.activeTab
  return tab?.type === 'kb-assets' && tab.knowledgeBaseId === store.selectedKnowledgeBaseId
})

async function refreshSidebarExtras(): Promise<void> {
  const knowledgeBaseId = store.selectedKnowledgeBaseId
  const sequence = ++extrasSequence
  if (!knowledgeBaseId) {
    sidebarExtras.value = { hasAssets: false, hasDemos: false }
    demosMode.value = 'closed'
    return
  }
  const result = await window.desk.sidebar.extras({ knowledgeBaseId })
  if (sequence !== extrasSequence) return
  if (!result.ok) {
    sidebarExtras.value = { hasAssets: false, hasDemos: false }
    return
  }
  sidebarExtras.value = result.value
  if (!result.value.hasDemos) demosMode.value = 'closed'
  else if (demosMode.value === 'list') await loadDemos(knowledgeBaseId)
}

async function loadDemos(knowledgeBaseId: string): Promise<void> {
  const result = await window.desk.demos.list({ knowledgeBaseId })
  if (store.selectedKnowledgeBaseId !== knowledgeBaseId || demosMode.value !== 'list') return
  if (!result.ok) {
    demos.value = []
    demosError.value = result.error.message
    return
  }
  demos.value = result.value
  demosError.value = ''
}

function openAssets(): void {
  const knowledgeBase = store.knowledgeBase
  if (knowledgeBase) editor.openKbAssets(knowledgeBase)
}

async function toggleDemos(): Promise<void> {
  if (demosMode.value === 'list') {
    demosMode.value = 'closed'
    return
  }
  if (!isConfiguredIde(store.settings?.ide)) {
    demosMode.value = 'need-ide'
    return
  }
  exitBatchDelete()
  demosMode.value = 'list'
  demos.value = []
  demosError.value = ''
  const knowledgeBaseId = store.selectedKnowledgeBaseId
  if (knowledgeBaseId) await loadDemos(knowledgeBaseId)
}

async function openDemo(folder: string): Promise<void> {
  const knowledgeBaseId = store.selectedKnowledgeBaseId
  if (!knowledgeBaseId) return
  const result = await window.desk.ide.openDemo({ knowledgeBaseId, folder })
  if (!result.ok) store.error = result.error.message
}

watch(
  () => [store.selectedKnowledgeBaseId, store.knowledgeBase?.snapshotRevision] as const,
  () => {
    void refreshSidebarExtras()
  },
  { immediate: true }
)

const viewTabs: ReadonlyArray<{ view: NavigatorView; label: string; icon: string }> = [
  {
    view: 'toc',
    label: '笔记目录',
    icon: 'M2.5 3.5h1M6 3.5h7.5M2.5 8h1M6 8h7.5M2.5 12.5h1M6 12.5h7.5'
  },
  {
    view: 'search',
    label: '搜索',
    icon: 'M7 2.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 0 1 0-9zM10.3 10.3l3.2 3.2'
  },
  {
    view: 'git',
    label: 'Git',
    icon: 'M3 3.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M3 12.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10 4.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M4.5 5v6M11.5 6c0 3-7 2-7 5'
  }
]

function selectView(view: NavigatorView): void {
  demosMode.value = 'closed'
  if (view !== 'toc') exitBatchDelete()
  setNavigatorView(view)
  if (view === 'search') void nextTick(() => searchInputRef.value?.focus())
}

const batchSelectedCount = computed(() => batchSelected.value.size)

function exitBatchDelete(): void {
  batchDeleting.value = false
  batchSelected.value = new Set()
}

function toggleBatchDelete(): void {
  if (batchDeleting.value) {
    exitBatchDelete()
    return
  }
  const kb = store.knowledgeBase
  if (!kb || kb.health !== 'ready' || kb.noteCount === 0) return
  setNavigatorView('toc')
  batchDeleting.value = true
  tocExpanded.value = true
}

function findTocNode(nodes: readonly DeskTocNode[], noteUuid: string): DeskTocNode | null {
  for (const node of nodes) {
    if (node.type === 'note' && node.uuid === noteUuid) return node
    const found = findTocNode(node.children, noteUuid)
    if (found) return found
  }
  return null
}

function toggleBatchNote(noteUuid: string): void {
  const node = findTocNode(store.knowledgeBase?.toc ?? [], noteUuid)
  batchSelected.value = toggleBatchIds(
    batchSelected.value,
    node ? batchTargetIds(node) : [noteUuid]
  )
}

function toggleBatchGroup(node: DeskTocNode): void {
  batchSelected.value = toggleBatchIds(batchSelected.value, batchTargetIds(node))
}

function selectedNoteUuids(): string[] {
  const selected = batchSelected.value
  return collectNoteIds(store.knowledgeBase?.toc ?? []).filter((id) => selected.has(id))
}

function confirmBatchDelete(): void {
  const noteUuids = selectedNoteUuids()
  if (noteUuids.length === 0) return
  emit('requestBatchDelete', noteUuids)
}

const sectionMenu = ref<'git' | 'toc' | null>(null)
const sectionMenuPos = ref({ top: 0, left: 0 })

function toggleSectionMenu(kind: 'git' | 'toc', event: MouseEvent): void {
  const button = event.currentTarget
  if (!(button instanceof HTMLElement)) return
  if (sectionMenu.value === kind) {
    sectionMenu.value = null
    return
  }
  const rect = button.getBoundingClientRect()
  sectionMenuPos.value = { top: rect.bottom + 4, left: Math.max(8, rect.right - 168) }
  sectionMenu.value = kind
}

function closeSectionMenu(): void {
  sectionMenu.value = null
}

function onSectionMenuPointerDown(event: PointerEvent): void {
  if (!sectionMenu.value) return
  const target = event.target
  if (target instanceof Element && target.closest('.section-menu, .heading-menu-button')) return
  sectionMenu.value = null
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (sectionMenu.value && event.key === 'Escape') {
    event.preventDefault()
    sectionMenu.value = null
    return
  }
  onBatchEscape(event)
}

function onBatchEscape(event: KeyboardEvent): void {
  if (!batchDeleting.value || event.key !== 'Escape') return
  if (document.querySelector('.dialog-backdrop')) return
  const target = event.target
  if (
    target instanceof HTMLElement &&
    target.closest('input, textarea, [contenteditable="true"], .cm-editor')
  ) {
    return
  }
  event.preventDefault()
  exitBatchDelete()
}

watch(
  () => store.selectedKnowledgeBaseId,
  () => exitBatchDelete()
)

watch(
  () => store.knowledgeBase?.toc,
  (toc) => {
    if (!batchDeleting.value || !toc) return
    const live = new Set(collectNoteIds(toc))
    const next = new Set([...batchSelected.value].filter((id) => live.has(id)))
    if (next.size !== batchSelected.value.size) batchSelected.value = next
  }
)

function onNoteDragPointerUp(): void {
  if (!draggingNote.value) return
  setTimeout(() => {
    if (draggingNote.value) endNoteDrag()
  }, 0)
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('pointerdown', onSectionMenuPointerDown, true)
  window.addEventListener('dragend', endNoteDrag, true)
  window.addEventListener('pointerup', onNoteDragPointerUp, true)
})

watch([() => query.value, () => store.selectedKnowledgeBaseId], () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    void store.searchNotes(query.value)
  }, 180)
})

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('pointerdown', onSectionMenuPointerDown, true)
  window.removeEventListener('dragend', endNoteDrag, true)
  window.removeEventListener('pointerup', onNoteDragPointerUp, true)
})

defineExpose({ exitBatchDelete })

const previewState = computed(() =>
  store.selectedKnowledgeBaseId
    ? (editor.previewStates[store.selectedKnowledgeBaseId] ?? null)
    : null
)
const previewErrorKey = computed(
  () => `${store.selectedKnowledgeBaseId ?? ''}:${previewState.value?.error ?? ''}`
)
function dismissPreviewError(): void {
  dismissedPreviewError.value = previewErrorKey.value
}

const gitState = computed(() =>
  store.selectedKnowledgeBaseId ? (store.gitStates[store.selectedKnowledgeBaseId] ?? null) : null
)
const tocShowIndex = showNoteIndex

function toggleNoteIndex(): void {
  toggleShowNoteIndex()
}

const pinnedNotes = computed(() => {
  const knowledgeBase = store.knowledgeBase
  if (!knowledgeBase) return []
  const ids = store.settings?.pinnedNoteUuids?.[knowledgeBase.id] ?? []
  return flatPinnedNotes(knowledgeBase.toc, ids)
})

const draggingNote = ref(false)
const pinDropHover = ref(false)
// 拖动开始时如果用 v-if 插入置顶区，目录行会被重新挂载，macOS 上这次拖放就无法结束。
let noteDragEpoch = 0

function endNoteDrag(): void {
  noteDragEpoch += 1
  draggingNote.value = false
  pinDropHover.value = false
}

function onTocDrag(node: DeskTocNode | null): void {
  const epoch = ++noteDragEpoch
  if (node?.type !== 'note') {
    draggingNote.value = false
    pinDropHover.value = false
    return
  }
  requestAnimationFrame(() => {
    if (noteDragEpoch !== epoch) return
    draggingNote.value = true
  })
}

function overPinGroup(event: DragEvent): boolean {
  const target = event.target
  return target instanceof Element && Boolean(target.closest('[data-pin-group="notes"]'))
}

function onNavigatorDragOver(event: DragEvent): void {
  if (!draggingNote.value) {
    pinDropHover.value = false
    return
  }
  const overPin = overPinGroup(event)
  if (pinDropHover.value !== overPin) pinDropHover.value = overPin
  if (!overPin || !isTocDrag(event.dataTransfer)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function onNavigatorDrop(event: DragEvent): void {
  if (!draggingNote.value || !overPinGroup(event)) return
  event.preventDefault()
  event.stopPropagation()
  pinDropHover.value = false
  const note = noteFromTocDrag(event.dataTransfer)
  const knowledgeBaseId = store.knowledgeBase?.id
  if (!note || !knowledgeBaseId || batchDeleting.value) return
  store.pinNote(knowledgeBaseId, note.uuid)
}

watch(
  () => {
    const knowledgeBase = store.knowledgeBase
    const settings = store.settings
    if (!knowledgeBase || knowledgeBase.health !== 'ready' || !settings) return ''
    const current = settings.pinnedNoteUuids?.[knowledgeBase.id] ?? []
    const next = prunePinIds(current, new Set(collectNoteIds(knowledgeBase.toc)))
    if (listsEqual(current, next)) return ''
    return `prune:${knowledgeBase.id}\n${next.join('\n')}`
  },
  (encoded) => {
    if (!encoded.startsWith('prune:') || !store.settings) return
    const newline = encoded.indexOf('\n')
    const knowledgeBaseId = encoded.slice('prune:'.length, newline)
    const body = encoded.slice(newline + 1)
    const next = body ? body.split('\n') : []
    const map = { ...(store.settings.pinnedNoteUuids ?? {}) }
    if (next.length === 0) delete map[knowledgeBaseId]
    else map[knowledgeBaseId] = next
    void store.updateSettings({ pinnedNoteUuids: map })
  }
)

const noteFileChanges = computed(() =>
  (gitState.value?.changes ?? []).filter((change) => classifyChangePath(change.path) === 'noteFile')
)
const configFileChanges = computed(() =>
  (gitState.value?.changes ?? []).filter(
    (change) => classifyChangePath(change.path) === 'configFile'
  )
)
const otherFileChanges = computed(() =>
  (gitState.value?.changes ?? []).filter(
    (change) => classifyChangePath(change.path) === 'otherFile'
  )
)
// Display-level rename merge: counts stay the true raw git counts above.
const displayNoteFileChanges = computed(() => mergeRenameChanges(noteFileChanges.value))
const displayConfigFileChanges = computed(() => mergeRenameChanges(configFileChanges.value))
const displayOtherFileChanges = computed(() => mergeRenameChanges(otherFileChanges.value))
const readmeActive = computed(() => {
  const tab = editor.activeTab
  return (
    tab?.type === 'text-file' &&
    tab.relPath === 'README.md' &&
    tab.knowledgeBaseId === store.selectedKnowledgeBaseId
  )
})

/** 打开库根 README.md；文件不存在时由 README 页在读取时建一份空文件。 */
function openReadme(): void {
  const knowledgeBase = store.selectedKnowledgeBase
  if (!knowledgeBase) return
  editor.openTextFile(knowledgeBase, 'README.md')
}

const selectedTocNoteUuid = computed(() => {
  const tab = editor.activeTab
  return tab?.type === 'note' && tab.knowledgeBaseId === store.selectedKnowledgeBaseId
    ? tab.noteUuid
    : null
})
const tocFocusRequestId = computed(() => {
  const request = store.tocFocusRequest
  return request?.knowledgeBaseId === store.selectedKnowledgeBaseId &&
    request.noteUuid === selectedTocNoteUuid.value
    ? request.sequence
    : undefined
})

// 显式「在目录中定位」切回笔记目录；同步切换，目录行在滚动定位前就已可见
watch(
  tocFocusRequestId,
  (requestId) => {
    if (requestId && store.tocFocusRequest?.forced) setNavigatorView('toc')
  },
  { flush: 'sync' }
)

const statusSymbol: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: '!'
}

function showNoteMenu(noteUuid: string): void {
  if (!store.selectedKnowledgeBaseId) return
  void window.desk.ide.showNoteMenu(store.selectedKnowledgeBaseId, noteUuid)
}

function showFilePathMenu(path: string): void {
  if (!store.selectedKnowledgeBaseId) return
  void window.desk.ide.showFileMenu(store.selectedKnowledgeBaseId, path)
}

function toggleTocBatch(): void {
  tocListRef.value?.toggleAllCollapsed()
}

async function revealKnowledgeBase(): Promise<void> {
  if (!store.knowledgeBase) return
  const result = await window.desk.workspace.revealKnowledgeBase(store.knowledgeBase.id)
  if (!result.ok) store.error = result.error.message
}

function showKnowledgeBaseMenu(): void {
  if (store.knowledgeBase) void window.desk.ide.showKnowledgeBaseMenu(store.knowledgeBase.id)
}

async function togglePreview(): Promise<void> {
  if (!store.selectedKnowledgeBaseId || previewBusy.value) return
  previewBusy.value = true
  try {
    if (previewState.value?.status === 'ready' || previewState.value?.status === 'starting') {
      await editor.stopPreview(store.selectedKnowledgeBaseId)
    } else {
      const currentNote =
        store.document?.knowledgeBaseId === store.selectedKnowledgeBaseId
          ? store.document.dirName
          : undefined
      await editor.startPreview(store.selectedKnowledgeBaseId, currentNote)
    }
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    previewBusy.value = false
  }
}

const buildBusy = ref(false)

async function buildSite(): Promise<void> {
  if (!store.selectedKnowledgeBaseId || buildBusy.value) return
  buildBusy.value = true
  try {
    const result = await window.desk.build(store.selectedKnowledgeBaseId)
    if (!result.ok) {
      store.error = result.error.message
      return
    }
    store.status = `构建完成：${result.value.pageCount} 页 → ${result.value.outDir}`
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    buildBusy.value = false
  }
}

const previewLabel = computed(() => {
  if (previewBusy.value || previewState.value?.status === 'starting') return '正在启动站点预览'
  if (previewState.value?.status === 'ready') return '停止站点预览'
  if (previewState.value?.status === 'error') return '重新启动站点预览'
  return '启动站点预览'
})

const previewRunningLabel = computed(() => {
  const port = previewState.value?.port
  if (port) return `localhost:${port}`
  return previewState.value?.baseUrl ?? ''
})

function openPreviewTab(): void {
  const url = previewState.value?.baseUrl
  if (url) editor.openWeb(url)
}

const kbReady = computed(
  () => Boolean(store.knowledgeBase) && store.knowledgeBase?.health === 'ready'
)

function applyMenuAction(action: NavigatorSidebarMenuAction): void {
  if (action === 'create-note') emit('createNote')
  else if (action === 'create-notes') emit('createNotes')
  else if (action === 'create-group') emit('createGroup')
  else if (action === 'batch-delete') toggleBatchDelete()
  else if (action === 'preview') void togglePreview()
  else if (action === 'build') void buildSite()
  else if (action === 'reveal') void revealKnowledgeBase()
  else if (action === 'settings') {
    if (store.knowledgeBase) editor.openKbSettings(store.knowledgeBase)
  } else if (action === 'assets') {
    if (store.knowledgeBase) editor.openKbAssets(store.knowledgeBase)
  } else showKnowledgeBaseMenu()
}

async function openHeaderMenu(): Promise<void> {
  if (menuBusy.value || !kbReady.value) return
  menuBusy.value = true
  try {
    const result = await window.desk.app.showNavigatorSidebarMenu({
      ready: kbReady.value,
      previewLabel: previewLabel.value,
      buildBusy: buildBusy.value,
      noteCount: store.knowledgeBase?.noteCount ?? 0
    })
    if (!result.ok) {
      store.error = result.error.message
      return
    }
    if (result.value) applyMenuAction(result.value)
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    menuBusy.value = false
  }
}
</script>

<template>
  <aside class="navigator-sidebar">
    <div class="navigator-top">
      <div class="view-tabs" role="tablist" aria-label="侧栏视图">
        <UiTooltip v-for="item in viewTabs" :key="item.view" :label="item.label">
          <button
            type="button"
            role="tab"
            class="view-tab"
            :class="{ active: navigatorView === item.view }"
            :aria-selected="navigatorView === item.view"
            :aria-label="item.label"
            :data-view="item.view"
            @click="selectView(item.view)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                :d="item.icon"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <em v-if="item.view === 'git' && gitState?.changes.length" class="view-badge">{{
              gitState.changes.length > 99 ? '99+' : gitState.changes.length
            }}</em>
          </button>
        </UiTooltip>
      </div>
      <div class="header-actions">
        <UiTooltip v-if="sidebarExtras.hasAssets" label="资源" align="end">
          <button
            type="button"
            class="menu-button"
            :class="{ active: assetsTabActive }"
            aria-label="资源"
            @click="openAssets"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M22 19V9a2 2 0 0 0-2-2h-6.764a2 2 0 0 1-1.789-1.106l-.894-1.788A2 2 0 0 0 8.763 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
              />
            </svg>
          </button>
        </UiTooltip>
        <UiTooltip v-if="sidebarExtras.hasDemos" label="demos" align="end">
          <button
            type="button"
            class="menu-button"
            :class="{ active: demosMode !== 'closed' }"
            aria-label="demos"
            :aria-pressed="demosMode !== 'closed'"
            @click="toggleDemos"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M13 15a1 1 0 1 0 0 2a1 1 0 0 0 0-2m-3 2a1 1 0 1 0 0 2a1 1 0 0 0 0-2"
              />
              <path
                fill="currentColor"
                fill-rule="evenodd"
                d="M14.493 3.25H8.5a.75.75 0 1 0 0 1.5h.26v5.087a7.25 7.25 0 0 1-1.256 4.078l-3.093 4.548a1.855 1.855 0 0 0 1.326 2.887c4.162.468 8.364.468 12.526 0a1.855 1.855 0 0 0 1.326-2.887l-3.093-4.548a7.25 7.25 0 0 1-1.256-4.078V4.75h.26a.75.75 0 0 0 0-1.5zM5.905 19.86c4.05.455 8.14.455 12.19 0a.355.355 0 0 0 .254-.553l-3.094-4.549a9 9 0 0 1-.591-1.008H9.336a9 9 0 0 1-.591 1.008L5.65 19.307a.355.355 0 0 0 .254.553m4.015-7.61h4.16a8.8 8.8 0 0 1-.34-2.413V4.75h-3.48v5.087a8.8 8.8 0 0 1-.34 2.413"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </UiTooltip>
        <UiTooltip label="更多笔记操作" align="end">
          <button
            type="button"
            class="menu-button"
            aria-label="更多笔记操作"
            :disabled="!kbReady || menuBusy"
            @click="openHeaderMenu"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <g fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="4" cy="12" r="1" />
                <circle cx="12" cy="12" r="1" />
                <circle cx="20" cy="12" r="1" />
              </g>
            </svg>
          </button>
        </UiTooltip>
      </div>
    </div>

    <div
      v-if="
        previewBusy ||
        previewState?.status === 'starting' ||
        previewState?.status === 'ready' ||
        (previewState?.status === 'error' && dismissedPreviewError !== previewErrorKey)
      "
      class="preview-feedback"
      :class="previewState?.status"
    >
      <span v-if="previewBusy && previewState?.status === 'ready'">正在停止站点预览…</span>
      <span v-else-if="previewBusy || previewState?.status === 'starting'">
        正在启动 {{ store.selectedKnowledgeBase?.displayName }} 站点预览…
      </span>
      <template v-else-if="previewState?.status === 'ready'">
        <button
          v-if="previewRunningLabel"
          type="button"
          class="preview-link"
          :title="previewState.baseUrl ?? previewRunningLabel"
          @click="openPreviewTab"
        >
          {{ previewRunningLabel }}
        </button>
        <button type="button" @click="togglePreview">停止</button>
      </template>
      <template v-else>
        <span>预览启动失败：{{ previewState?.error ?? '未知错误' }}</span>
        <button type="button" @click="togglePreview">重试</button>
        <button type="button" @click="dismissPreviewError">关闭</button>
      </template>
    </div>

    <template v-if="store.knowledgeBase">
      <div
        v-show="demosMode === 'closed' && navigatorView === 'toc'"
        class="navigator-view toc-view"
      >
        <button
          type="button"
          class="readme-entry"
          :class="{ active: readmeActive }"
          aria-label="打开知识库根目录的 README.md"
          @click="openReadme"
        >
          <svg viewBox="0 0 1024 1024" aria-hidden="true">
            <path
              fill="currentColor"
              d="M854.6 288.6L639.4 73.4c-6-6-14.1-9.4-22.6-9.4H192c-17.7 0-32 14.3-32 32v832c0 17.7 14.3 32 32 32h640c17.7 0 32-14.3 32-32V311.3c0-8.5-3.4-16.7-9.4-22.7M790.2 326H602V137.8zm1.8 562H232V136h302v216a42 42 0 0 0 42 42h216z"
            />
          </svg>
          <strong>README</strong>
        </button>
        <section
          v-show="pinnedNotes.length > 0 || draggingNote"
          class="pin-section"
          data-pin-group="notes"
          @dragover.capture="onNavigatorDragOver"
          @drop.capture="onNavigatorDrop"
        >
          <div
            v-if="draggingNote && pinnedNotes.length === 0"
            class="pin-drop-slot"
            :class="{ 'is-drop': pinDropHover }"
          />
          <TocNodeList
            v-show="pinnedNotes.length > 0"
            class="pin-notes"
            :nodes="pinnedNotes"
            :selected-note-uuid="selectedTocNoteUuid"
            :allow-reorder="false"
            :pin-reorder="pinnedNotes.length > 1"
            :pin-drop-active="pinDropHover"
            :batch-deleting="batchDeleting"
            :batch-selected="batchSelected"
            @select="store.selectNote"
            @select-permanent="store.selectNote($event, undefined, true)"
            @select-split="store.selectNote($event, 'right')"
            @toggle-done="store.toggleDone"
            @request-create="(node, placement) => emit('createNote', node, placement)"
            @request-rename="emit('requestRename', $event)"
            @request-reindex="emit('requestReindex', $event)"
            @request-delete="emit('requestDelete', $event)"
            @toggle-batch-note="toggleBatchNote"
            @toggle-batch-group="toggleBatchGroup"
          />
        </section>
        <div
          class="navigator-body"
          @dragover.capture="onNavigatorDragOver"
          @drop.capture="onNavigatorDrop"
          @scroll="closeSectionMenu"
        >
          <section v-if="store.knowledgeBase.health !== 'ready'" class="diagnostics">
            <strong>配置异常，当前知识库只读</strong>
            <ul>
              <li
                v-for="diagnostic in store.knowledgeBase.diagnostics"
                :key="`${diagnostic.code}:${diagnostic.path ?? ''}`"
              >
                {{ diagnostic.message }}
              </li>
            </ul>
            <div class="diagnostic-actions">
              <button type="button" @click="store.refreshWorkspace">重新检查</button>
              <button type="button" @click="revealKnowledgeBase">打开目录</button>
              <button type="button" @click="showKnowledgeBaseMenu">用 IDE 查看</button>
            </div>
          </section>

          <section class="toc-section">
            <div class="section-heading toc-heading">
              <button
                type="button"
                class="section-toggle"
                :aria-expanded="tocExpanded"
                :aria-label="tocExpanded ? '折叠目录' : '展开目录'"
                @click="tocExpanded = !tocExpanded"
              >
                <svg
                  class="chevron"
                  :class="{ collapsed: !tocExpanded }"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path
                    d="M4 6l4 4 4-4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <strong>目录</strong>
                <em>{{ store.knowledgeBase.noteCount }}</em>
              </button>
              <button
                type="button"
                class="menu-button heading-menu-button"
                aria-label="目录操作"
                aria-haspopup="menu"
                :aria-expanded="sectionMenu === 'toc'"
                @click="toggleSectionMenu('toc', $event)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <g fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="4" cy="12" r="1" />
                    <circle cx="12" cy="12" r="1" />
                    <circle cx="20" cy="12" r="1" />
                  </g>
                </svg>
              </button>
            </div>
            <div v-show="tocExpanded" class="toc-list">
              <TocNodeList
                v-if="tocNodes.length"
                ref="tocListRef"
                :nodes="tocNodes"
                :selected-note-uuid="selectedTocNoteUuid"
                :focus-request-id="tocFocusRequestId"
                :persist-collapse="true"
                :batch-deleting="batchDeleting"
                :batch-selected="batchSelected"
                @select="store.selectNote"
                @select-permanent="store.selectNote($event, undefined, true)"
                @select-split="store.selectNote($event, 'right')"
                @toggle-done="store.toggleDone"
                @request-create="(node, placement) => emit('createNote', node, placement)"
                @request-rename="emit('requestRename', $event)"
                @request-reindex="emit('requestReindex', $event)"
                @request-delete="emit('requestDelete', $event)"
                @toggle-batch-note="toggleBatchNote"
                @toggle-batch-group="toggleBatchGroup"
                @move="store.moveTocNode"
                @drag-note="onTocDrag"
              />
              <div v-else class="toc-empty">TOC.md 中没有条目</div>
            </div>
          </section>
        </div>
        <div v-if="batchDeleting" class="batch-delete-bar" data-batch-delete-bar>
          <span>已选 {{ batchSelectedCount }} 篇</span>
          <button type="button" @click="exitBatchDelete">取消</button>
          <button
            type="button"
            class="danger"
            data-batch-delete-confirm
            :disabled="batchSelectedCount === 0"
            @click="confirmBatchDelete"
          >
            删除
          </button>
        </div>
      </div>

      <div v-if="demosMode === 'need-ide'" class="navigator-view demos-view">
        <p class="demos-notice">请先在设置的「外部工具」里选择 Cursor 或 VS Code，再打开实验。</p>
        <button type="button" class="demos-settings" @click="emit('openSettings')">打开设置</button>
      </div>

      <div v-else-if="demosMode === 'list'" class="navigator-view demos-view">
        <div class="tree-heading">
          <strong>demos</strong>
        </div>
        <div class="navigator-body">
          <button type="button" class="demo-row" data-demo-root @click="openDemo('')">
            打开 demos
          </button>
          <p v-if="demosError" class="demos-notice is-error">{{ demosError }}</p>
          <button
            v-for="entry in demos"
            :key="entry.folder"
            type="button"
            class="demo-row"
            :data-demo="entry.folder"
            @click="openDemo(entry.folder)"
          >
            {{ entry.folder }}
          </button>
        </div>
      </div>

      <div v-else-if="navigatorView === 'search'" class="navigator-view search-view">
        <div class="search-wrap">
          <span>⌕</span>
          <input ref="searchInputRef" v-model="query" type="search" placeholder="搜索标题和正文" />
        </div>
        <div class="navigator-body">
          <section class="search-results-section">
            <div class="section-heading static">
              <span>⌕</span>
              <strong>搜索结果</strong>
              <em>{{ store.searchResults.length }}</em>
            </div>
            <div v-if="!query.trim()" class="changes-empty">输入关键字，搜索笔记标题和正文</div>
            <div v-else-if="store.searchLoading" class="changes-empty">正在查询后台索引…</div>
            <button
              v-for="result in query.trim() ? store.searchResults : []"
              v-else
              :key="`${result.knowledgeBaseId}:${result.noteUuid}`"
              type="button"
              class="search-result"
              @click="store.openNoteByUuid(result.knowledgeBaseId, result.noteUuid)"
            >
              <span
                ><strong>{{ noteFileName(result) }}</strong></span
              >
              <small>{{ result.snippet }}</small>
            </button>
            <div
              v-if="query.trim() && !store.searchLoading && !store.searchResults.length"
              class="toc-empty"
            >
              没有匹配标题或正文的笔记
            </div>
          </section>
        </div>
      </div>

      <div v-else-if="navigatorView === 'git'" class="navigator-view git-view">
        <div class="navigator-body" @scroll="closeSectionMenu">
          <section class="changes-section">
            <div class="section-heading git-heading">
              <span class="section-toggle static">
                <strong>变更</strong>
                <em>{{ gitState?.changes.length ?? 0 }}</em>
                <span v-if="gitState?.behind" class="behind-state">↓{{ gitState.behind }}</span>
              </span>
              <button
                type="button"
                class="menu-button heading-menu-button"
                aria-label="变更操作"
                aria-haspopup="menu"
                :aria-expanded="sectionMenu === 'git'"
                @click="toggleSectionMenu('git', $event)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <g fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="4" cy="12" r="1" />
                    <circle cx="12" cy="12" r="1" />
                    <circle cx="20" cy="12" r="1" />
                  </g>
                </svg>
              </button>
            </div>
            <template v-if="noteFileChanges.length">
              <button
                type="button"
                class="change-group-toggle"
                :aria-expanded="noteFileExpanded"
                :aria-label="noteFileExpanded ? '折叠笔记文件' : '展开笔记文件'"
                @click="noteFileExpanded = !noteFileExpanded"
              >
                <svg
                  class="chevron"
                  :class="{ collapsed: !noteFileExpanded }"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path
                    d="M4 6l4 4 4-4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <strong>笔记文件</strong>
                <em>{{ noteFileChanges.length }}</em>
              </button>
              <div v-show="noteFileExpanded">
                <button
                  v-for="change in displayNoteFileChanges"
                  :key="`note-file:${change.status}:${change.path}`"
                  type="button"
                  class="change-item"
                  :class="change.status"
                  :disabled="!change.noteUuid"
                  @click="store.openNoteByUuid(store.selectedKnowledgeBaseId!, change.noteUuid!)"
                  @contextmenu.prevent="showNoteMenu(change.noteUuid!)"
                >
                  <span class="change-item__label">
                    <strong v-if="change.noteUuid"
                      ><template v-if="tocShowIndex">{{ change.noteIndex }} </template
                      >{{ change.noteTitle }}</strong
                    >
                    <strong v-else>{{ change.path }}</strong>
                    <small v-if="change.noteUuid">{{
                      change.status === 'renamed' && change.previousPath
                        ? `${change.previousPath} → ${change.path}`
                        : change.path
                    }}</small>
                  </span>
                  <span class="change-item__status">{{ statusSymbol[change.status] }}</span>
                </button>
              </div>
            </template>

            <template v-if="configFileChanges.length">
              <button
                type="button"
                class="change-group-toggle"
                :aria-expanded="configFileExpanded"
                :aria-label="configFileExpanded ? '折叠笔记配置' : '展开笔记配置'"
                @click="configFileExpanded = !configFileExpanded"
              >
                <svg
                  class="chevron"
                  :class="{ collapsed: !configFileExpanded }"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path
                    d="M4 6l4 4 4-4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <strong>笔记配置</strong>
                <em>{{ configFileChanges.length }}</em>
              </button>
              <div v-show="configFileExpanded">
                <button
                  v-for="change in displayConfigFileChanges"
                  :key="`config:${change.status}:${change.path}`"
                  type="button"
                  class="change-item"
                  :class="change.status"
                  @contextmenu.prevent="showFilePathMenu(change.path)"
                >
                  <span class="change-item__label">
                    <strong>{{ change.path }}</strong>
                  </span>
                  <span class="change-item__status">{{ statusSymbol[change.status] }}</span>
                </button>
              </div>
            </template>

            <template v-if="otherFileChanges.length">
              <button
                type="button"
                class="change-group-toggle"
                :aria-expanded="otherFileExpanded"
                :aria-label="otherFileExpanded ? '折叠其它文件' : '展开其它文件'"
                @click="otherFileExpanded = !otherFileExpanded"
              >
                <svg
                  class="chevron"
                  :class="{ collapsed: !otherFileExpanded }"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path
                    d="M4 6l4 4 4-4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <strong>其它文件</strong>
                <em>{{ otherFileChanges.length }}</em>
              </button>
              <div v-show="otherFileExpanded">
                <button
                  v-for="change in displayOtherFileChanges"
                  :key="`other:${change.status}:${change.path}`"
                  type="button"
                  class="change-item"
                  :class="change.status"
                  @contextmenu.prevent="showFilePathMenu(change.path)"
                >
                  <span class="change-item__label">
                    <strong>{{ change.path }}</strong>
                  </span>
                  <span class="change-item__status">{{ statusSymbol[change.status] }}</span>
                </button>
              </div>
            </template>

            <div v-if="gitState?.busy" class="changes-empty">
              {{
                gitState.busy === 'publish'
                  ? '正在提交并推送…'
                  : gitState.busy === 'pull'
                    ? '正在拉取…'
                    : '正在获取远端状态…'
              }}
            </div>
            <div v-else-if="gitState?.error" class="changes-empty git-error">
              {{ gitState.error }}
            </div>
            <div v-else-if="!gitState?.initialized" class="changes-empty">
              当前目录不是 Git 仓库
            </div>
            <div v-else-if="!gitState.changes.length" class="changes-empty">工作区干净</div>
          </section>
        </div>
      </div>
    </template>

    <div v-else class="column-empty">从左侧选择一个知识库</div>
    <Teleport to="body">
      <div
        v-if="sectionMenu"
        class="section-menu"
        role="menu"
        :style="{ top: `${sectionMenuPos.top}px`, left: `${sectionMenuPos.left}px` }"
      >
        <template v-if="sectionMenu === 'git'">
          <button
            type="button"
            role="menuitem"
            :disabled="Boolean(gitState?.busy)"
            @click="
              () => {
                closeSectionMenu()
                store.refreshGit(store.selectedKnowledgeBaseId ?? undefined)
              }
            "
          >
            刷新 Git 状态
          </button>
          <button
            type="button"
            role="menuitem"
            :disabled="!gitState?.initialized || Boolean(gitState?.busy)"
            @click="
              () => {
                closeSectionMenu()
                store.pullGit(store.selectedKnowledgeBaseId!)
              }
            "
          >
            拉取远端更新
          </button>
          <button
            type="button"
            role="menuitem"
            :disabled="!gitState?.initialized || Boolean(gitState?.busy)"
            @click="
              () => {
                closeSectionMenu()
                store.requestGitPublish(store.selectedKnowledgeBaseId!)
              }
            "
          >
            提交并推送
          </button>
        </template>
        <template v-else>
          <button
            type="button"
            role="menuitem"
            :disabled="store.loading"
            @click="
              () => {
                closeSectionMenu()
                store.reloadKnowledgeBase()
              }
            "
          >
            手动刷新目录
          </button>
          <button
            type="button"
            role="menuitem"
            @click="
              () => {
                closeSectionMenu()
                toggleNoteIndex()
              }
            "
          >
            {{ tocShowIndex ? '隐藏笔记编号' : '显示笔记编号' }}
          </button>
          <button
            type="button"
            role="menuitem"
            @click="
              () => {
                closeSectionMenu()
                toggleTocBatch()
              }
            "
          >
            折叠/展开全部
          </button>
        </template>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.navigator-sidebar {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-right: 1px solid var(--border);
}

.navigator-sidebar.is-panel-collapsed {
  overflow: hidden;
  border-right-width: 0;
  visibility: hidden;
  pointer-events: none;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.preview-feedback {
  min-height: 30px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--accent) 8%, var(--panel));
  padding: 5px 10px;
  color: var(--muted);
  font-size: 9px;
}

.preview-feedback.error {
  background: var(--danger-soft);
  color: var(--danger);
}

.preview-feedback > span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  display: -webkit-box;
  overflow: hidden;
  line-height: 1.35;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.preview-feedback button {
  flex: none;
  border: 1px solid currentColor;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 3px 7px;
  font-size: 9px;
}

.preview-feedback button.preview-link {
  flex: 1;
  min-width: 0;
  border: 0;
  padding: 0;
  overflow: hidden;
  color: var(--accent);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.navigator-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--border);
  /* 给下方吸顶行留出上方间距：滚动容器顶部不能留 padding（那条带子盖不住、会透出内容），
     所以留白放在这里 —— 搜索栏在滚动容器之外，怎么留都不会被透视。 */
  margin-bottom: 7px;
}

.view-tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
}

.view-tab {
  position: relative;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.view-tab svg {
  width: 16px;
  height: 16px;
  display: block;
}

.view-tab:hover {
  background: var(--hover);
  color: var(--text);
}

.view-tab.active {
  background: var(--selected);
  color: var(--accent-strong);
}

.view-badge {
  position: absolute;
  top: 1px;
  right: 0;
  min-width: 12px;
  height: 12px;
  border-radius: 6px;
  background: var(--accent);
  color: white;
  padding: 0 3px;
  font-size: 8px;
  font-style: normal;
  font-weight: 700;
  line-height: 12px;
  text-align: center;
}

.navigator-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.search-view .search-wrap {
  height: auto;
  padding: 0 9px 7px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}

.search-view .search-wrap > span {
  left: 18px;
  bottom: 7px;
}

.header-actions {
  flex: none;
  position: relative;
  display: flex;
  gap: 6px;
}

.menu-button {
  height: 28px;
  width: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.menu-button svg {
  width: 16px;
  height: 16px;
  display: block;
}

.menu-button:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.menu-button:disabled {
  opacity: 0.4;
}

.menu-button.active {
  background: var(--selected);
  color: var(--accent-strong);
}

.demos-view {
  padding-top: 4px;
}

.demos-notice {
  margin: 8px 12px 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.demos-notice.is-error {
  color: var(--danger);
}

.demos-settings {
  margin: 8px 12px;
  align-self: flex-start;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  padding: 3px 8px;
  font: inherit;
  font-size: 12px;
}

.demo-row {
  width: 100%;
  height: 26px;
  display: block;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  padding: 0 8px;
  font: inherit;
  font-size: 12px;
  text-align: left;
}

.demo-row:hover {
  background: var(--hover);
}

.tree-heading {
  flex: none;
  height: 27px;
  display: flex;
  align-items: center;
  margin: 0 7px;
  padding: 0 5px;
  color: var(--muted);
  font-size: 10px;
  box-shadow: 0 1px 0 var(--border);
}

.tree-heading strong {
  font-weight: 700;
}

.heading-menu-button {
  flex: none;
  width: 22px;
  height: 22px;
  margin-left: auto;
  border-radius: 4px;
}

.search-wrap {
  position: relative;
  height: 43px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--border);
}

.search-wrap > span {
  position: absolute;
  z-index: 1;
  left: 9px;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  margin: 0;
  color: var(--muted);
  line-height: 1;
  pointer-events: none;
}

.search-wrap input {
  width: 100%;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 6px;
  outline: none;
  background: var(--input-bg);
  color: var(--text);
  padding: 0 9px 0 28px;
  font-size: 11px;
}

.search-wrap input:focus {
  border-color: var(--accent);
}

.readme-entry {
  flex: none;
  height: 27px;
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0 7px;
  padding: 0 5px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
  font-size: 10px;
  text-align: left;
}

.readme-entry svg {
  flex: none;
  /* 与下方折叠箭头同一列宽，图标在格子里居中，文字起点才能和「变更」对齐 */
  width: 18px;
  height: 14px;
}

.readme-entry strong {
  font-weight: 700;
}

.readme-entry:hover {
  background: var(--hover);
  color: var(--text);
}

.readme-entry.active {
  background: var(--selected);
  color: var(--accent-strong);
}

.navigator-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  /*
   * 顶部**不留 padding**：sticky 只能吸到滚动容器的内容盒上沿，padding-top 会在
   * 容器顶边与吸顶行之间留出一条带子，滚动上来的目录项从那里透出来
   * （实测：`padding-top: 7px` 时该带高 7px，打点命中 `node-label` / `note-index`）。
   * 吸顶行需要的上方留白改由搜索栏的下边距提供（见 `.navigator-top`）——
   * 那属于非滚动区域，不会被透视。
   */
  padding: 0 7px 7px;
}

/*
 * 第二列头部固定：滚动时「变更」「目录」标题栏始终可见可操作。
 * 视图切换栏（.navigator-top）本就在滚动容器之外，天然固定。
 *
 * `display: contents` 的关键作用：sticky 元素无法超出其父容器，而
 * `.changes-section` / `.toc-section` 在折叠时只有标题那么高，标题会跟着
 * 父容器一起滚走。让 section 不生成盒子，标题就按滚动容器的直接子级参与布局。
 */
.changes-section,
.toc-section {
  display: contents;
}

/* 置顶在滚动容器外面，高度跟内容走，自己不出现滚动条。 */
.pin-section {
  flex: none;
  overflow: visible;
  padding: 0 7px;
  background: var(--panel);
}

/* 选择器带上 .navigator-body 是有意的：`.section-heading`（下面那条共享基类规则）
   也设了 `background: transparent`，两条规则**同优先级**时靠后的那条会赢，
   于是吸顶行变成透明、滚动时下方的目录项会透出来（实测计算值 rgba(0,0,0,0)，
   枚举命中规则可见 `.section-heading` 覆盖了这里的 `var(--panel)`）。
   多一层限定把优先级提上去，而不是去删基类的 transparent —— 那是给
   非吸顶标题（如详情栏那种静态标题）用的。 */
.navigator-body .git-heading,
.navigator-body .toc-heading {
  position: sticky;
  top: 0;
  z-index: 3;
  /* 吸顶时必须不透明：否则下方滚动的目录项会透出来 */
  background: var(--panel);
  box-shadow: 0 1px 0 var(--border);
}

/* 变更的提示往下弹，要比目录栏高一层才不会被盖住。 */
.navigator-body .git-heading {
  z-index: 4;
}

.pin-notes {
  margin-top: 4px;
}

.pin-drop-slot {
  height: 28px;
  margin-top: 4px;
  border-radius: 6px;
}

.pin-drop-slot.is-drop {
  background: color-mix(in srgb, var(--accent) 18%, var(--panel));
}

/* 第一篇笔记贴着吸顶标题时，选中描边的上沿会被标题盖住。 */
.toc-list {
  margin-top: 4px;
}

.section-heading {
  width: 100%;
  height: 27px;
  display: flex;
  align-items: center;
  gap: 5px;
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 0 5px;
  text-align: left;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.section-heading strong {
  flex: 1;
  font-weight: 700;
}

.git-heading .section-toggle strong,
.toc-heading .section-toggle strong {
  flex: none;
}

.section-heading em {
  min-width: 18px;
  border-radius: 9px;
  background: var(--raised);
  padding: 1px 5px;
  text-align: center;
  font-style: normal;
  font-size: 9px;
}

.changes-empty,
.toc-empty {
  color: var(--muted);
  padding: 3px 25px 9px;
  font-size: 10px;
}

.git-heading {
  text-transform: none;
  letter-spacing: 0;
}

.section-toggle.static {
  cursor: default;
}

.section-toggle {
  align-self: stretch;
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}

.chevron {
  flex: none;
  width: 18px;
  height: 12px;
  transition: transform 120ms ease;
}

.chevron.collapsed {
  transform: rotate(-90deg);
}

.batch-delete-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  font-size: 12px;
}

.batch-delete-bar span {
  flex: 1;
  min-width: 0;
}

.batch-delete-bar button {
  flex: none;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  padding: 3px 8px;
  font-family: inherit;
  font-size: 12px;
}

.batch-delete-bar button.danger {
  border-color: transparent;
  background: var(--danger);
  color: white;
}

.batch-delete-bar button:disabled {
  opacity: 0.4;
  cursor: default;
}

button.section-heading {
  font-family: inherit;
  appearance: none;
  cursor: pointer;
}

.behind-state {
  color: var(--warning);
  font-size: 9px;
  font-weight: 700;
}

.change-group-toggle {
  align-self: stretch;
  width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px 3px 22px;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-align: left;
}

.change-group-toggle:hover {
  color: var(--text);
}

.change-group-toggle strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-menu {
  position: fixed;
  z-index: 40;
  min-width: 148px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--raised);
  box-shadow: 0 12px 32px rgb(0 0 0 / 28%);
}

.section-menu button {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.section-menu button:hover:not(:disabled) {
  background: var(--hover);
}

.section-menu button:disabled {
  opacity: 0.4;
  cursor: default;
}

.change-group-toggle em {
  min-width: 18px;
  border-radius: 9px;
  background: var(--raised);
  padding: 1px 5px;
  text-align: center;
  font-style: normal;
  font-size: 9px;
}

.change-item {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  padding: 5px 7px 5px 45px;
  text-align: left;
}

.change-item:not(:disabled) {
  cursor: pointer;
}

.change-item:not(:disabled):hover {
  background: var(--hover);
}

.change-item__label {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.change-item__status {
  flex: none;
  min-width: 18px;
  padding: 1px 5px;
  color: var(--warning);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 750;
  text-align: center;
}

.change-item.conflicted > .change-item__status {
  color: var(--danger);
}

.change-item__label strong,
.change-item__label small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-item__label strong {
  font-size: 10px;
  font-weight: 560;
}

.change-item__label small {
  color: var(--muted);
  font-size: 8px;
}

.git-error {
  color: var(--danger);
}

.toc-section {
  margin-top: 4px;
}

.search-results-section {
  margin-top: 4px;
}

.search-result {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  padding: 7px 8px;
  text-align: left;
  cursor: pointer;
}

.search-result:hover {
  background: var(--hover);
}

.search-result > span {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.search-result em {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 9px;
  font-style: normal;
}

.search-result strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 630;
}

.search-result small {
  display: -webkit-box;
  overflow: hidden;
  color: var(--muted);
  font-size: 9px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.diagnostics {
  margin: 7px 4px;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  border-radius: 7px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 10px;
}

.diagnostics strong {
  font-size: 11px;
}

.diagnostics ul {
  margin: 6px 0 0;
  padding-left: 15px;
}

.diagnostic-actions {
  display: flex;
  gap: 5px;
  margin-top: 8px;
}

.diagnostic-actions button {
  height: 25px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
  border-radius: 5px;
  background: transparent;
  color: var(--danger);
  cursor: pointer;
  padding: 0 7px;
  font-size: 9px;
}

.column-empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 11px;
}
</style>
