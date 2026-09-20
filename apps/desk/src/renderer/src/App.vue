<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import ImagePreview from '@tnotesjs/ui/image-preview'

import EditorPane from './components/EditorPane.vue'
import KnowledgeSidebar from './components/KnowledgeSidebar.vue'
import NavigatorSidebar from './components/NavigatorSidebar.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ToastHost from './components/ToastHost.vue'
import AppZoomFeedback from './components/AppZoomFeedback.vue'
import CommandPalette from './commands/CommandPalette.vue'
import TerminalPanel from './terminal/TerminalPanel.vue'
import { useEditorStore } from './stores/editor'
import { findTab, tabAtNumber } from './editor-groups/layoutModel'
import {
  clampSidebarWidth,
  KNOWLEDGE_SIDEBAR_MAX,
  KNOWLEDGE_SIDEBAR_MIN,
  NAVIGATOR_SIDEBAR_MAX,
  NAVIGATOR_SIDEBAR_MIN
} from './stores/editor'
import { pushActionToast, pushToast } from './stores/toast'
import {
  dismissUpdateBanner,
  initUpdateWatcher,
  openReleasePage,
  updateBanner
} from './stores/update'
import { useCommandTaskStore } from './stores/commandTask'
import { planFailureNotices } from './stores/failureNotice'
import { useBackgroundFailureStore } from './stores/backgroundFailure'
import { useTerminalStore } from './stores/terminal'
import { useWorkspaceStore } from './stores/workspace'
import { selectAllInRenderer } from './selectAll'
import { APP_ZOOM_DEFAULT } from '../../shared/appZoom'

import type {
  DeletePreviewDto,
  DeskTocNode,
  NoteCreateRequest,
  TabShortcutCommand
} from '../../shared/contracts'
import { deleteConsequenceLines, isEmptyDeletePreview } from './deletePreview'
import { focusDialogInput } from './dialogInputFocus'

const store = useWorkspaceStore()
const editor = useEditorStore()
const terminalStore = useTerminalStore()
const commandTaskStore = useCommandTaskStore()
const backgroundFailureStore = useBackgroundFailureStore()
const createDialogOpen = ref(false)
const createKbDialogOpen = ref(false)
const createKbFolderName = ref('')
const createKbTitle = ref('')
const createKbPackageJson = ref(false)
const createKbGithubPages = ref(false)
const createKbReadme = ref(false)
const createKbGitInit = ref(false)
const settingsOpen = ref(false)
const paletteOpen = ref(false)
const commandPalette = ref<{
  openSearch: () => Promise<void>
  openCommands: () => Promise<void>
} | null>(null)
const terminalPanel = ref<{
  createOrFocus: () => Promise<void>
  openForKnowledgeBase: (knowledgeBaseId: string, cwd?: string) => Promise<void>
  focusActive: () => void
  showTask: (taskId: string) => void
} | null>(null)
const createTitle = ref('')
const createPlacement = ref<NoteCreateRequest['placement']>({ type: 'root', placement: 'end' })
const createRootPosition = ref<'top' | 'end'>('top')
const groupDialogOpen = ref(false)
const groupTitle = ref('')
const renameNode = ref<DeskTocNode | null>(null)
const renameTitle = ref('')
const renameInput = ref<HTMLInputElement | null>(null)
const deletePreview = ref<DeletePreviewDto | null>(null)
const recoveryCandidate = computed(() => store.pendingRecoveries[0] ?? null)
const pendingPublishState = computed(() =>
  store.pendingGitPublishId ? (store.gitStates[store.pendingGitPublishId] ?? null) : null
)
const dialogBusy = ref(false)
let sessionTimer: ReturnType<typeof setTimeout> | null = null
let statusTimer: ReturnType<typeof setTimeout> | null = null
let systemTheme: MediaQueryList | null = null
let unsubscribeTerminal: (() => void) | null = null
let unsubscribeTerminalOpen: (() => void) | null = null
let unsubscribeCommandTask: (() => void) | null = null
let unsubscribeBackgroundFailures: (() => void) | null = null
/** 已经通知过的运行，避免同类失败反复弹通知 */
const notifiedTaskRuns = new Set<string>()
/**
 * 失败通知的合批防抖。
 *
 * 多个知识库的后台 fetch 往往在几十毫秒内先后失败，逐次 watch 触发会各弹一条；
 * 先等一小段时间，让同一批失败一起交给 `planFailureNotices` 聚合成一条。
 */
let failureNoticeTimer: ReturnType<typeof setTimeout> | null = null
const FAILURE_NOTICE_DEBOUNCE_MS = 600
let unsubscribeCommandTaskReveal: (() => void) | null = null
let unsubscribeCommandTaskRetry: (() => void) | null = null
let unsubscribeTabShortcut: (() => void) | null = null
let unsubscribeBeforeClose: (() => void) | null = null
let unsubscribeUpdates: (() => void) | null = null

const workspaceColumns = computed(() => {
  const knowledgeWidth = editor.knowledgeSidebarCollapsed ? 48 : editor.knowledgeSidebarWidth
  const navigatorWidth = editor.navigatorSidebarCollapsed ? 0 : editor.navigatorSidebarWidth
  const reversed = store.settings?.workspaceLayout === 'content-dir-kb'
  return reversed
    ? `minmax(0, 1fr) 6px ${navigatorWidth}px 6px ${knowledgeWidth}px`
    : `${knowledgeWidth}px 6px ${navigatorWidth}px 6px minmax(0, 1fr)`
})

const workspaceAreas = computed(() =>
  store.settings?.workspaceLayout === 'content-dir-kb' ? '"i5 i4 i3 i2 i1"' : '"i1 i2 i3 i4 i5"'
)

let resizeTarget: 'knowledge' | 'navigator' | null = null
let resizeStartX = 0
let resizeStartWidth = 0

function startResize(target: 'knowledge' | 'navigator', event: MouseEvent): void {
  resizeTarget = target
  resizeStartX = event.clientX
  resizeStartWidth =
    target === 'knowledge' ? editor.knowledgeSidebarWidth : editor.navigatorSidebarWidth
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', onResizeEnd)
  document.body.classList.add('is-resizing')
}

function onResizeMove(event: MouseEvent): void {
  if (!resizeTarget) return
  const reversed = store.settings?.workspaceLayout === 'content-dir-kb'
  const delta = (event.clientX - resizeStartX) * (reversed ? -1 : 1)
  if (resizeTarget === 'knowledge') {
    editor.knowledgeSidebarWidth = clampSidebarWidth(
      resizeStartWidth + delta,
      KNOWLEDGE_SIDEBAR_MIN,
      KNOWLEDGE_SIDEBAR_MAX
    )
  } else {
    editor.navigatorSidebarWidth = clampSidebarWidth(
      resizeStartWidth + delta,
      NAVIGATOR_SIDEBAR_MIN,
      NAVIGATOR_SIDEBAR_MAX
    )
  }
}

function onResizeEnd(): void {
  resizeTarget = null
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', onResizeEnd)
  document.body.classList.remove('is-resizing')
  void persistSession()
}

async function persistSession(): Promise<void> {
  const result = await window.desk.session.save(editor.toSession(store.selectedKnowledgeBaseId))
  if (!result.ok) store.error = `无法保存工作区会话：${result.error.message}`
}

function onKeydown(event: KeyboardEvent): void {
  if (store.closingTabs) {
    event.preventDefault()
    return
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void store.saveCurrentDocument().catch(() => undefined)
    return
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'j') {
    // 面板获得焦点时它自己的 capture 处理器已经处理过（并阻止了冒泡）
    event.preventDefault()
    terminalStore.toggle()
    if (terminalStore.open) void terminalPanel.value?.createOrFocus()
    return
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    void (event.shiftKey
      ? commandPalette.value?.openCommands()
      : commandPalette.value?.openSearch())
  }
}

/** 面板开关：展开时确保有一个会话并聚焦，收起只隐藏（不结束进程）。 */
function toggleTerminalPanel(): void {
  terminalStore.toggle()
  if (terminalStore.open) void terminalPanel.value?.createOrFocus()
  else terminalPanel.value?.focusActive()
}

async function changeAppZoom(action: 'increase' | 'decrease' | 'reset'): Promise<void> {
  try {
    if (action === 'reset') await store.setAppZoom(APP_ZOOM_DEFAULT)
    else await store.adjustAppZoom(action === 'increase' ? 1 : -1)
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  }
}

async function handleTabShortcut(command: TabShortcutCommand): Promise<void> {
  if (store.closingTabs) return
  if (typeof command === 'object' && command.type === 'activate-tab-by-number') {
    const group = command.sourceTabId
      ? findTab(editor.layout, command.sourceTabId)?.group
      : editor.activeGroup
    const target = group && tabAtNumber(group, command.number)
    if (!group || !target) return
    const previous = group.tabs.find((tab) => tab.id === group.activeTabId)
    if (previous?.type === 'web' && previous.id !== target.id) {
      await window.desk.web.layout({ tabId: previous.id, visible: false })
    }
    // The layout may have changed while the native web view was being hidden.
    if (findTab(editor.layout, target.id)?.group.id === group.id) {
      editor.activate(group.id, target.id)
    }
    return
  }
  if (command === 'open-quick-open') {
    await commandPalette.value?.openSearch()
    return
  }
  if (command === 'open-command-palette') {
    await commandPalette.value?.openCommands()
    return
  }
  if (typeof command === 'object' && command.type === 'select-all') {
    // 优先用**来源**判断：原生网页视图里按 Cmd+A 时，渲染端的"活动标签"可能还停在
    // 上一次的分组/标签上（原生视图不冒泡焦点事件），按活动标签猜会误选笔记。
    const source = command.sourceTabId ? findTab(editor.layout, command.sourceTabId) : null
    if (source?.tab.type === 'web') {
      // 分屏时来源组可能不是当前活动组：先定位到它，再交给该网页全选
      editor.activate(source.group.id, source.tab.id)
      await window.desk.web.selectAll(source.tab.id)
      return
    }
    if (editor.activeTab?.type === 'web') {
      await window.desk.web.selectAll(editor.activeTab.id)
      return
    }
    selectAllInRenderer()
    return
  }

  if (
    command === 'increase-app-zoom' ||
    command === 'decrease-app-zoom' ||
    command === 'reset-app-zoom'
  ) {
    await changeAppZoom(
      command === 'reset-app-zoom'
        ? 'reset'
        : command === 'increase-app-zoom'
          ? 'increase'
          : 'decrease'
    )
    return
  }

  if (command === 'next-tab' || command === 'previous-tab') {
    const previous = editor.activeTab
    if (previous?.type === 'web') {
      await window.desk.web.layout({ tabId: previous.id, visible: false })
    }
    editor.cycleActiveTab(command === 'next-tab' ? 'next' : 'previous')
    return
  }

  if (command === 'close-saved-note-tabs') {
    await store.requestCloseTabs('saved')
    return
  }
  if (command === 'close-all-tabs') {
    await store.requestCloseTabs('all')
    return
  }
  if (command === 'keep-active-tab-open') {
    if (editor.activeTab) editor.keepOpen(editor.activeTab.id)
    return
  }
  if (command === 'toggle-pin-active-tab') {
    if (editor.activeTab) editor.togglePinned(editor.activeTab.id)
    return
  }
  if (command === 'copy-active-note-path') {
    if (editor.activeTab?.type === 'note') await store.copyNoteDirectoryPath(editor.activeTab)
    return
  }
  if (command === 'reveal-active-note-in-file-manager') {
    if (editor.activeTab?.type === 'note') await store.revealNoteInFileManager(editor.activeTab)
    return
  }

  const group = editor.activeGroup
  const tab = editor.activeTab
  if (group && tab) {
    await store.requestCloseTab(tab.id)
    return
  }

  if (store.hasWorkspace) await persistSession()
  await window.desk.app.closeWindow()
}

function applyAppearance(): void {
  const selected = store.settings?.theme ?? 'system'
  const theme = selected === 'system' ? (systemTheme?.matches ? 'dark' : 'light') : selected
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.density = store.settings?.density ?? 'comfortable'
}

function openCreateDialog(
  node?: DeskTocNode,
  placement: 'before' | 'after' | 'inside' = 'after'
): void {
  createTitle.value = ''
  if (!node) {
    createRootPosition.value = store.settings?.createNotePosition ?? 'top'
    createPlacement.value = {
      type: 'root',
      placement: createRootPosition.value === 'top' ? 'start' : 'end'
    }
  } else if (node.type === 'note') {
    createPlacement.value = { type: 'note', targetNoteUuid: node.uuid, placement }
  } else {
    createPlacement.value = { type: 'folder', folderPath: [...node.folderPath], placement }
  }
  createDialogOpen.value = true
}

async function confirmCreate(): Promise<void> {
  const title = createTitle.value.trim()
  if (!title || dialogBusy.value) return
  dialogBusy.value = true
  try {
    const placement =
      createPlacement.value?.type === 'root'
        ? ({
            type: 'root',
            placement: createRootPosition.value === 'top' ? 'start' : 'end'
          } as NoteCreateRequest['placement'])
        : createPlacement.value
    await store.createNote(title, placement)
    createDialogOpen.value = false
  } finally {
    dialogBusy.value = false
  }
}

function openCreateKbDialog(): void {
  createKbFolderName.value = ''
  createKbTitle.value = ''
  createKbPackageJson.value = false
  createKbGithubPages.value = false
  createKbReadme.value = false
  createKbGitInit.value = false
  createKbDialogOpen.value = true
}

watch(createKbGithubPages, (enabled) => {
  if (enabled) createKbPackageJson.value = true
})

const createKbFolderError = computed(() => {
  const value = createKbFolderName.value.trim()
  if (!value) return '文件夹名必填'
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(value)) return '须匹配 ^[A-Za-z0-9._-]{1,100}$'
  return null
})

async function confirmCreateKb(): Promise<void> {
  if (createKbFolderError.value || dialogBusy.value) return
  dialogBusy.value = true
  try {
    await store.createKnowledgeBase({
      folderName: createKbFolderName.value.trim(),
      title: createKbTitle.value.trim() || undefined,
      packageJson: createKbPackageJson.value,
      githubPages: createKbGithubPages.value,
      readme: createKbReadme.value,
      gitInit: createKbGitInit.value
    })
    createKbDialogOpen.value = false
  } catch {
    // store.createKnowledgeBase already sets error
  } finally {
    dialogBusy.value = false
  }
}

function openGroupDialog(): void {
  groupTitle.value = ''
  groupDialogOpen.value = true
}

async function confirmCreateGroup(): Promise<void> {
  const title = groupTitle.value.trim()
  if (!title || dialogBusy.value) return
  dialogBusy.value = true
  try {
    await store.createTocGroup(title)
    groupDialogOpen.value = false
  } finally {
    dialogBusy.value = false
  }
}

function openRenameDialog(node: DeskTocNode): void {
  renameNode.value = node
  renameTitle.value = node.title
  void focusDialogInput(() => renameInput.value)
}

async function confirmRename(): Promise<void> {
  const title = renameTitle.value.trim()
  if (!renameNode.value || !title || dialogBusy.value) return
  dialogBusy.value = true
  try {
    await store.renameTocNode(renameNode.value, title)
    renameNode.value = null
  } finally {
    dialogBusy.value = false
  }
}

async function requestDelete(node: DeskTocNode): Promise<void> {
  dialogBusy.value = true
  try {
    const preview = await store.previewDeleteNode(node)
    if (isEmptyDeletePreview(preview)) {
      await store.deleteNode(preview)
      return
    }
    deletePreview.value = preview
  } finally {
    dialogBusy.value = false
  }
}

const deleteConsequences = computed(() =>
  deletePreview.value ? deleteConsequenceLines(deletePreview.value) : []
)

/** 用户显式要求先记录当前版本：提交后对话框原地刷新，计数归零。 */
async function commitBeforeDelete(): Promise<void> {
  if (!deletePreview.value || dialogBusy.value) return
  dialogBusy.value = true
  try {
    const result = await store.commitDeleteScope(deletePreview.value)
    deletePreview.value = result.preview
    if (result.commit) {
      store.status = `已记录当前版本（${result.commit.slice(0, 7)}），现在删除也可以从历史找回`
    } else {
      store.status = '范围内的内容与上次提交一致，无需记录'
    }
    await store.refreshGit()
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    dialogBusy.value = false
  }
}

async function confirmDelete(): Promise<void> {
  if (!deletePreview.value || dialogBusy.value) return
  dialogBusy.value = true
  try {
    await store.deleteNode(deletePreview.value)
    deletePreview.value = null
  } finally {
    dialogBusy.value = false
  }
}

watch(
  () => editor.activeTab?.id,
  () => void store.syncToActiveTab()
)

watch(
  [
    () => editor.layout,
    () => editor.activeGroupId,
    () => editor.knowledgeBaseEditors,
    () => store.selectedKnowledgeBaseId,
    () => editor.knowledgeSidebarWidth,
    () => editor.navigatorSidebarWidth,
    () => editor.knowledgeSidebarCollapsed,
    () => editor.navigatorSidebarCollapsed,
    () => editor.expandedTocNodes,
    () => editor.lastNoteByGroup
  ],
  () => {
    if (!store.hasWorkspace) return
    if (sessionTimer) clearTimeout(sessionTimer)
    sessionTimer = setTimeout(() => {
      sessionTimer = null
      void persistSession()
    }, 450)
  },
  { deep: true }
)

watch(
  () =>
    createDialogOpen.value ||
    createKbDialogOpen.value ||
    groupDialogOpen.value ||
    Boolean(renameNode.value) ||
    settingsOpen.value ||
    paletteOpen.value ||
    Boolean(deletePreview.value) ||
    Boolean(recoveryCandidate.value) ||
    Boolean(store.gitAttention) ||
    Boolean(store.pendingGitPublishId) ||
    store.closingTabs,
  (modalOpen) => {
    editor.webViewsSuspended = modalOpen
    if (modalOpen) {
      void window.desk.web.hideAll()
    } else {
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    }
  }
)

watch(() => store.settings, applyAppearance, { deep: true })

watch(
  () => store.status,
  (status) => {
    if (status) pushToast(status, 'success')
    if (statusTimer) clearTimeout(statusTimer)
    statusTimer = status
      ? setTimeout(() => {
          statusTimer = null
          if (store.status === status) store.status = null
        }, 3600)
      : null
  }
)

/**
 * 命令任务收尾时的反馈。
 *
 * - **手动**操作已经在开始时展开面板，这里逐条提示；
 * - **后台**操作（定时 fetch、自动推送）失败会**聚合成一条**通知（多个知识库同时
 *   失败不刷屏），消息里列出涉及的库，「查看输出」定位到批次里的第一条；
 *   同一 (库, 种类) 的重复失败由主进程的 `notify` 标记去抖。
 */
watch(
  () => commandTaskStore.tasks.map((task) => `${task.id}:${task.run}:${task.status}`).join('|'),
  () => {
    if (failureNoticeTimer) clearTimeout(failureNoticeTimer)
    failureNoticeTimer = setTimeout(() => {
      failureNoticeTimer = null
      for (const notice of planFailureNotices(commandTaskStore.tasks, notifiedTaskRuns)) {
        for (const key of notice.keys) notifiedTaskRuns.add(key)
        pushActionToast(
          notice.message,
          '查看输出',
          () => {
            terminalStore.toggle(true)
            void nextTick(() => terminalPanel.value?.showTask(notice.actionTaskId))
          },
          'error'
        )
      }
    }, FAILURE_NOTICE_DEBOUNCE_MS)
  }
)

/**
 * 「后台操作没能建出可见任务」的失败也要让用户知道。
 *
 * 这类失败在面板里没有任务、因此没有「查看输出」入口；设置里的「Git 与远端」分组
 * 有完整明细。这里只在**新出现**一条时提示一次，重复累加（count>1）不再弹。
 */
watch(
  () => backgroundFailureStore.failures.length,
  (length, previous) => {
    const latest = backgroundFailureStore.latest
    if (!latest || length <= (previous ?? 0)) return
    if (latest.count > 1) return
    pushActionToast(
      `${latest.knowledgeBaseName}：后台勾取失败（未占用面板标签）`.replace('勾取', '抓取'),
      '查看详情',
      () => {
        settingsOpen.value = true
      },
      'error'
    )
  }
)

watch(
  () => store.error,
  (error) => {
    if (error) {
      pushToast(error, 'error')
      store.error = null
    }
  }
)

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  unsubscribeTabShortcut = window.desk.app.onTabShortcut((command) => {
    void handleTabShortcut(command)
  })
  // 红叉 / ⌘Q：主进程接管关闭，这里把未保存内容处理干净再回执
  unsubscribeBeforeClose = window.desk.app.onBeforeClose(() => {
    void (async () => {
      const proceed = await store.prepareToQuit()
      await window.desk.app.confirmCloseReady(proceed)
    })()
  })
  unsubscribeTerminal = terminalStore.subscribe()
  unsubscribeCommandTask = commandTaskStore.subscribe()
  unsubscribeCommandTaskRetry = window.desk.commandTask.onRetryRequested((taskId) => {
    // 重试复用渲染端的完整业务流程（推送会先保存）
    void store.retryCommandTask(taskId)
  })
  unsubscribeCommandTaskReveal = window.desk.commandTask.onReveal((taskId) => {
    // 手动 Git 操作：立即展开面板并定位到该任务
    terminalStore.toggle(true)
    void nextTick(() => terminalPanel.value?.showTask(taskId))
  })
  unsubscribeTerminalOpen = window.desk.terminal.onOpenAt((event) => {
    // 目录右键「在终端中打开」：路径已在主进程校验在库内，这里只负责建会话
    void terminalPanel.value?.openForKnowledgeBase(event.knowledgeBaseId, event.cwd)
  })
  unsubscribeUpdates = initUpdateWatcher()
  systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
  systemTheme.addEventListener('change', applyAppearance)
  await store.initialize()
  // 已有会话由主进程持有：收起面板/刷新渲染端之后仍然在跑，这里恢复列表
  await terminalStore.load()
  await commandTaskStore.load()
  await backgroundFailureStore.load()
  unsubscribeBackgroundFailures = backgroundFailureStore.subscribe()
  applyAppearance()
  await persistSession()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  unsubscribeTerminal?.()
  unsubscribeTerminal = null
  unsubscribeTerminalOpen?.()
  unsubscribeTerminalOpen = null
  unsubscribeCommandTask?.()
  unsubscribeCommandTask = null
  unsubscribeBackgroundFailures?.()
  unsubscribeBackgroundFailures = null
  unsubscribeCommandTaskReveal?.()
  unsubscribeCommandTaskReveal = null
  unsubscribeCommandTaskRetry?.()
  unsubscribeCommandTaskRetry = null
  unsubscribeTabShortcut?.()
  unsubscribeTabShortcut = null
  unsubscribeBeforeClose?.()
  unsubscribeBeforeClose = null
  unsubscribeUpdates?.()
  unsubscribeUpdates = null
  systemTheme?.removeEventListener('change', applyAppearance)
  systemTheme = null
  if (sessionTimer) clearTimeout(sessionTimer)
  if (statusTimer) clearTimeout(statusTimer)
  if (store.hasWorkspace) {
    void persistSession()
  }
  store.dispose()
})
</script>

<template>
  <div class="desk-shell">
    <header class="titlebar">
      <div class="traffic-space" />
      <div class="titlebar-center">
        <CommandPalette
          ref="commandPalette"
          v-model:open="paletteOpen"
          @open-settings="settingsOpen = true"
          @toggle-terminal="toggleTerminalPanel"
        />
      </div>
      <div class="titlebar-actions">
        <span v-if="store.saving" class="sync-state">正在保存</span>
        <span v-else-if="store.dirty" class="sync-state dirty">未保存</span>
        <button
          type="button"
          class="terminal-toggle"
          :class="{ active: terminalStore.open }"
          aria-label="切换终端面板"
          :data-tooltip="`终端面板（${terminalStore.runningCount} 个运行中）`"
          @click="toggleTerminalPanel"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="1em"
            height="1em"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5zm1.5-.5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5zM4.6 4.4a.75.75 0 0 1 1.06 0L7.9 6.63a.75.75 0 0 1 0 1.06L5.66 9.93A.75.75 0 0 1 4.6 8.87l1.7-1.7-1.7-1.7a.75.75 0 0 1 0-1.07M8 10.75a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75"
            />
          </svg>
        </button>
        <button
          type="button"
          aria-label="打开设置"
          data-tooltip="设置"
          @click="settingsOpen = true"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="1em"
            height="1em"
            viewBox="0 0 1024 1024"
            aria-hidden="true"
          >
            <path d="M0 0h1024v1024H0z" fill="none" />
            <path
              fill="currentColor"
              d="M600.7 64a32 32 0 0 1 30.5 22.2l35.2 109.4a348 348 0 0 1 42.4 24.5l112.4-24.2a32 32 0 0 1 34.4 15.4l88.7 153.5a32 32 0 0 1-4 37.5l-77.1 85.1a357 357 0 0 1 0 49l77 85.3a32 32 0 0 1 4.1 37.5l-88.7 153.6a32 32 0 0 1-34.4 15.3l-112.4-24.2q-20.2 13.6-42.4 24.5l-35.2 109.4a32 32 0 0 1-30.5 22.2H423.3a32 32 0 0 1-30.5-22.2l-35.1-109.3a352 352 0 0 1-42.6-24.7l-112.3 24.3a32 32 0 0 1-34.4-15.4L79.7 659.2a32 32 0 0 1 4-37.5l77.1-85.3a357 357 0 0 1 0-48.8l-77-85.3a32 32 0 0 1-4.1-37.5l88.7-153.6a32 32 0 0 1 34.4-15.3l112.3 24.3a355 355 0 0 1 42.6-24.7l35.2-109.3A32 32 0 0 1 423.2 64zm-23.4 64H446.7l-36.3 113l-24.5 12a294 294 0 0 0-34.9 20.2l-22.6 15.3l-116.2-25l-65.3 113l79.7 88.3l-2 27.1a293 293 0 0 0 0 40.2l2 27.1l-79.8 88.2L212 760.6l116.2-25l22.7 15.2a294 294 0 0 0 34.8 20.1l24.5 12L446.7 896h130.7L614 782.8l24.4-11.9a288 288 0 0 0 34.8-20l22.6-15.3l116.3 25l65.2-113.2l-79.7-88.2l2-27.1a293 293 0 0 0 0-40.3l-2-27.1l79.8-88.1L812 263.4l-116.3 25l-22.6-15.2a288 288 0 0 0-34.8-20.1L614 241zM512 320a192 192 0 1 1 0 384a192 192 0 0 1 0-384m0 64a128 128 0 1 0 0 256a128 128 0 0 0 0-256"
            />
          </svg>
        </button>
      </div>
    </header>

    <div v-if="updateBanner" class="global-banner status update-banner">
      <span
        >发现新版本 v{{ updateBanner.latestVersion }}（当前 v{{
          updateBanner.currentVersion
        }}）</span
      >
      <button type="button" class="update-download" @click="void openReleasePage()">
        前往下载
      </button>
      <button type="button" aria-label="忽略本次更新" @click="dismissUpdateBanner">×</button>
    </div>

    <main
      v-if="store.hasWorkspace"
      class="workspace-layout"
      :style="{ gridTemplateColumns: workspaceColumns, gridTemplateAreas: workspaceAreas }"
    >
      <KnowledgeSidebar style="grid-area: i1" @create-knowledge-base="openCreateKbDialog" />
      <div
        class="resize-handle"
        role="separator"
        aria-orientation="vertical"
        style="grid-area: i2"
        @mousedown="startResize('knowledge', $event)"
      />
      <NavigatorSidebar
        style="grid-area: i3"
        @create-note="openCreateDialog"
        @create-group="openGroupDialog"
        @request-rename="openRenameDialog"
        @request-delete="requestDelete"
      />
      <div
        class="resize-handle"
        role="separator"
        aria-orientation="vertical"
        style="grid-area: i4"
        @mousedown="startResize('navigator', $event)"
      />
      <EditorPane style="grid-area: i5" />
    </main>

    <TerminalPanel v-if="store.hasWorkspace" ref="terminalPanel" />

    <main v-else class="welcome">
      <div class="welcome-card">
        <span class="welcome-mark">T</span>
        <h1>打开你的 TNotes 工作区</h1>
        <p>
          Desk 会扫描所选目录：若根目录有 tnotes.json 则作为单库打开；否则扫描含 tnotes.json
          的直接子目录。
        </p>
        <button type="button" :disabled="store.loading" @click="store.chooseWorkspace">
          {{ store.loading ? '正在检查…' : '选择工作区' }}
        </button>
        <small>体验时请选择 desk/playground</small>
      </div>
    </main>

    <div v-if="createDialogOpen" class="dialog-backdrop" @mousedown.self="createDialogOpen = false">
      <form class="dialog" @submit.prevent="confirmCreate">
        <header>
          <strong>新增笔记</strong>
          <button type="button" @click="createDialogOpen = false">×</button>
        </header>
        <label>
          <input v-model="createTitle" autofocus placeholder="请输入笔记标题" />
        </label>
        <footer>
          <label v-if="createPlacement?.type === 'root'" class="position-field">
            <select v-model="createRootPosition">
              <option value="top">顶部新增</option>
              <option value="end">末尾追加</option>
            </select>
          </label>
          <button
            type="button"
            class="primary"
            :disabled="!createTitle.trim() || dialogBusy"
            @click="confirmCreate"
          >
            创建
          </button>
        </footer>
      </form>
    </div>

    <div
      v-if="createKbDialogOpen"
      class="dialog-backdrop"
      @mousedown.self="createKbDialogOpen = false"
    >
      <form class="dialog dialog-create-kb" @submit.prevent="confirmCreateKb">
        <header>
          <div>
            <span>新建知识库</span>
            <strong>在当前工作区下创建最小目录（含一篇引导笔记）</strong>
          </div>
          <button type="button" @click="createKbDialogOpen = false">×</button>
        </header>
        <label>
          <span>文件夹名</span>
          <input v-model="createKbFolderName" autofocus placeholder="例如 demo-kb 或 TNotes.demo" />
        </label>
        <p v-if="createKbFolderError" class="dialog-error">{{ createKbFolderError }}</p>
        <label>
          <span>显示名称</span>
          <input v-model="createKbTitle" placeholder="默认与文件夹名相同" />
        </label>
        <fieldset class="dialog-options">
          <legend>可选（默认全关；Desk 预览不需要）</legend>
          <label class="dialog-check">
            <input v-model="createKbPackageJson" type="checkbox" :disabled="createKbGithubPages" />
            <span>
              <strong>添加 CLI / package.json</strong>
              <small>本地 pnpm tn:dev / tn:build</small>
            </span>
          </label>
          <label class="dialog-check">
            <input v-model="createKbGithubPages" type="checkbox" />
            <span>
              <strong>添加 GitHub Pages 工作流</strong>
              <small>写入 deploy.yml，并附带 package.json</small>
            </span>
          </label>
          <label class="dialog-check">
            <input v-model="createKbReadme" type="checkbox" />
            <span>
              <strong>生成 README.md</strong>
              <small>仓库首页说明，与引导笔记无关</small>
            </span>
          </label>
          <label class="dialog-check">
            <input v-model="createKbGitInit" type="checkbox" />
            <span>
              <strong>初始化 Git 仓库</strong>
              <small>在知识库目录执行 git init</small>
            </span>
          </label>
        </fieldset>
        <footer>
          <button type="button" class="secondary" @click="createKbDialogOpen = false">取消</button>
          <button
            type="button"
            class="primary"
            :disabled="Boolean(createKbFolderError) || dialogBusy"
            @click="confirmCreateKb"
          >
            创建
          </button>
        </footer>
      </form>
    </div>

    <div v-if="groupDialogOpen" class="dialog-backdrop" @mousedown.self="groupDialogOpen = false">
      <form class="dialog" @submit.prevent="confirmCreateGroup">
        <header>
          <div>
            <span>新建分组</span>
            <strong>添加到目录根节点，不创建物理目录</strong>
          </div>
          <button type="button" @click="groupDialogOpen = false">×</button>
        </header>
        <label>
          <span>分组名称</span>
          <input v-model="groupTitle" autofocus placeholder="例如：前端基础" />
        </label>
        <footer>
          <button type="button" class="secondary" @click="groupDialogOpen = false">取消</button>
          <button
            type="button"
            class="primary"
            :disabled="!groupTitle.trim() || dialogBusy"
            @click="confirmCreateGroup"
          >
            创建
          </button>
        </footer>
      </form>
    </div>

    <div v-if="renameNode" class="dialog-backdrop" @mousedown.self="renameNode = null">
      <form class="dialog" @submit.prevent="confirmRename">
        <header>
          <div>
            <span>{{ renameNode.type === 'note' ? '重命名笔记' : '重命名分组' }}</span>
            <strong>{{ renameNode.title }}</strong>
          </div>
          <button type="button" @click="renameNode = null">×</button>
        </header>
        <label>
          <span>新名称</span>
          <input ref="renameInput" v-model="renameTitle" />
        </label>
        <footer>
          <button type="button" class="secondary" @click="renameNode = null">取消</button>
          <button
            type="button"
            class="primary"
            :disabled="!renameTitle.trim() || dialogBusy"
            @click="confirmRename"
          >
            保存
          </button>
        </footer>
      </form>
    </div>

    <div v-if="deletePreview" class="dialog-backdrop" @mousedown.self="deletePreview = null">
      <section class="dialog danger-dialog">
        <header>
          <div>
            <span>永久删除</span>
            <strong>这个操作无法通过 Desk 找回</strong>
          </div>
          <button type="button" @click="deletePreview = null">×</button>
        </header>
        <div class="delete-summary">
          <div>
            <strong>{{ deletePreview.notes.length }}</strong
            ><span>篇笔记</span>
          </div>
          <div>
            <strong>{{ deletePreview.filePaths.length }}</strong
            ><span>个文件</span>
          </div>
          <div>
            <strong>{{ deletePreview.directoryPaths.length }}</strong
            ><span>个目录</span>
          </div>
        </div>
        <p>
          文件将被直接永久删除，不进入系统废纸篓。
          <template v-if="deleteConsequences.length === 0">
            范围内内容都已提交，删除后仍可在 Git 历史里查看。
          </template>
        </p>
        <ul v-if="deleteConsequences.length" class="delete-consequences" data-delete-consequences>
          <li v-for="line in deleteConsequences" :key="line">{{ line }}</li>
        </ul>
        <div v-if="deletePreview.untrackedFilePaths.length" class="untracked-files">
          <span v-for="filePath in deletePreview.untrackedFilePaths.slice(0, 8)" :key="filePath">
            {{ filePath }}
          </span>
        </div>
        <footer>
          <button type="button" class="secondary" @click="deletePreview = null">取消</button>
          <button
            v-if="!deletePreview.gitReady || deleteConsequences.length > 0"
            type="button"
            class="secondary"
            data-delete-commit
            :disabled="dialogBusy"
            @click="commitBeforeDelete"
          >
            先记录当前版本
          </button>
          <button type="button" class="danger" :disabled="dialogBusy" @click="confirmDelete">
            确认永久删除
          </button>
        </footer>
      </section>
    </div>

    <div v-if="recoveryCandidate" class="dialog-backdrop">
      <section class="dialog recovery-dialog">
        <header>
          <div>
            <span>发现未保存的编辑</span>
            <strong>
              {{
                recoveryCandidate.path
                  ? `${recoveryCandidate.title} · ${recoveryCandidate.path}`
                  : recoveryCandidate.title
              }}
            </strong>
          </div>
        </header>
        <p>
          Desk 在上次异常结束前保存了恢复快照，时间为
          {{
            new Date(recoveryCandidate.updatedAt).toLocaleString()
          }}。它不是历史版本；处理后只会保留正常的 Git 历史。
        </p>
        <div class="recovery-preview">{{ recoveryCandidate.content.slice(0, 480) }}</div>
        <footer>
          <button type="button" class="secondary" @click="store.discardRecovery(recoveryCandidate)">
            丢弃快照
          </button>
          <button type="button" class="primary" @click="store.acceptRecovery(recoveryCandidate)">
            恢复到编辑器
          </button>
        </footer>
      </section>
    </div>

    <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />

    <div v-if="store.gitAttention" class="dialog-backdrop">
      <section class="dialog git-dialog">
        <header>
          <div>
            <span>{{
              store.gitAttention.kind === 'conflict' ? 'Git 需要处理' : '知识库落后'
            }}</span>
            <strong>{{ store.gitAttention.knowledgeBaseName }}</strong>
          </div>
          <button type="button" @click="store.gitAttention = null">×</button>
        </header>
        <p>{{ store.gitAttention.message }}</p>
        <footer>
          <button type="button" class="secondary" @click="store.gitAttention = null">
            稍后处理
          </button>
          <button
            v-if="store.gitAttention.kind === 'conflict'"
            type="button"
            class="primary"
            @click="store.openKnowledgeBaseInIde(store.gitAttention!.knowledgeBaseId)"
          >
            在 {{ store.settings?.ide === 'cursor' ? 'Cursor' : 'VSCode' }} 中打开
          </button>
          <button
            v-else
            type="button"
            class="primary"
            @click="store.confirmPull(store.gitAttention!.knowledgeBaseId)"
          >
            拉取最新版本
          </button>
        </footer>
      </section>
    </div>

    <div v-if="store.pendingGitPublishId && pendingPublishState" class="dialog-backdrop">
      <section class="dialog git-dialog">
        <header>
          <div>
            <span>提交前确认</span>
            <strong>{{ pendingPublishState.knowledgeBaseName }}</strong>
          </div>
          <button type="button" @click="store.pendingGitPublishId = null">×</button>
        </header>
        <p>
          本次将提交 {{ pendingPublishState.changes.length }} 个变更文件，并 push 到
          {{
            pendingPublishState.upstream ?? '当前分支的上游仓库'
          }}。变更明细已经显示在文章栏的“变更”分组中。
        </p>
        <footer>
          <button type="button" class="secondary" @click="store.pendingGitPublishId = null">
            取消
          </button>
          <button
            type="button"
            class="primary"
            @click="store.publishGit(store.pendingGitPublishId!)"
          >
            确认提交并推送
          </button>
        </footer>
      </section>
    </div>
  </div>

  <ToastHost />
  <ImagePreview />
  <div
    v-if="store.closingTabs"
    class="tab-close-blocker"
    aria-label="正在处理标签页"
    aria-busy="true"
  />
  <AppZoomFeedback
    v-if="store.settings"
    :percent="store.settings.appZoomPercent"
    :sequence="store.zoomFeedbackSequence"
    @decrease="changeAppZoom('decrease')"
    @increase="changeAppZoom('increase')"
    @reset="changeAppZoom('reset')"
  />
</template>

<style scoped>
.tab-close-blocker {
  position: fixed;
  inset: 0;
  z-index: 2000;
  cursor: progress;
  -webkit-app-region: no-drag;
}

.desk-shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--app-bg);
  color: var(--text);
}

.recovery-preview {
  max-height: 180px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--input-bg);
  padding: 10px;
  white-space: pre-wrap;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.55;
}

.titlebar .terminal-toggle.active {
  color: var(--accent);
}

.titlebar {
  position: relative;
  height: 42px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 0 9px;
  border-bottom: 1px solid var(--border);
  background: var(--titlebar-bg);
  -webkit-app-region: drag;
}

.traffic-space {
  width: 58px;
  flex: none;
}

.titlebar-center {
  position: absolute;
  left: 50%;
  z-index: 2;
  width: min(520px, calc(100% - 280px));
  display: flex;
  justify-content: center;
  transform: translateX(-50%);
  -webkit-app-region: no-drag;
}

.welcome-mark {
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: linear-gradient(145deg, #68a7ff, #8a72ff);
  color: white;
  font-weight: 800;
}

.titlebar-actions {
  width: 130px;
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.titlebar-actions button {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  padding: 0;
  font-size: 18px;
  line-height: 1;
  -webkit-app-region: no-drag;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.titlebar-actions button:hover {
  background: var(--hover);
  color: var(--text);
}

.titlebar-actions button svg {
  display: block;
  width: 1em;
  height: 1em;
}

.sync-state {
  color: var(--muted);
  font-size: 9px;
}

.sync-state.dirty {
  color: var(--warning);
}

.workspace-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 218px 292px minmax(0, 1fr);
}

.workspace-layout .resize-handle {
  position: relative;
  cursor: col-resize;
  background: transparent;
}

.workspace-layout .resize-handle::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  background: transparent;
  transition: background 120ms ease;
}

.workspace-layout .resize-handle:hover::before,
body.is-resizing .workspace-layout .resize-handle::before {
  background: var(--accent);
}

body.is-resizing {
  cursor: col-resize;
  user-select: none;
}

body.is-resizing-image {
  cursor: row-resize;
  user-select: none;
}

.global-banner {
  min-height: 31px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px 5px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 10px;
}

.global-banner span {
  flex: 1;
}

.global-banner button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.global-banner.error {
  background: var(--danger-soft);
  color: var(--danger);
}

.global-banner.status {
  background: var(--success-soft);
  color: var(--success);
}

.update-banner .update-download {
  font-weight: 600;
  text-decoration: underline;
}

.welcome {
  flex: 1;
  display: grid;
  place-items: center;
  background:
    radial-gradient(circle at 50% 30%, rgba(92, 129, 255, 0.09), transparent 36%), var(--app-bg);
}

.welcome-card {
  width: min(430px, calc(100% - 40px));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 11px;
  text-align: center;
}

.welcome-mark {
  width: 54px;
  height: 54px;
  margin-bottom: 7px;
  border-radius: 15px;
  font-size: 26px;
}

.welcome-card h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 680;
}

.welcome-card p {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.65;
}

.welcome-card > button {
  height: 34px;
  border: 0;
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  padding: 0 16px;
  cursor: pointer;
  font-weight: 650;
  font-size: 12px;
}

.welcome-card small {
  color: var(--muted);
  font-size: 9px;
}

.dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  background: rgba(3, 6, 12, 0.58);
  backdrop-filter: blur(3px);
}

.dialog {
  width: min(430px, calc(100% - 32px));
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  background: var(--raised);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.dialog.dialog-create-kb {
  width: min(460px, calc(100% - 32px));
}

.dialog header {
  display: flex;
  align-items: center;
  padding: 14px 15px;
  border-bottom: 1px solid var(--border);
}

.dialog header > div {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.dialog header span {
  color: var(--muted);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.dialog header strong {
  flex: 1;
  font-size: 13px;
  font-weight: 650;
}

.dialog header button {
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 18px;
}

.dialog label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 17px 15px;
  color: var(--muted);
  font-size: 10px;
}

.dialog-options {
  margin: 0;
  border: 0;
  border-top: 1px solid var(--border);
  padding: 12px 15px 4px;
}

.dialog-options legend {
  padding: 0;
  color: var(--muted);
  font-size: 10px;
}

.dialog-check {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
}

.dialog-check input {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  flex: none;
  accent-color: var(--accent);
}

.dialog-check span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dialog-check strong {
  font-size: 11px;
  font-weight: 650;
}

.dialog-check small {
  color: var(--muted);
  font-size: 10px;
  line-height: 1.35;
}

.dialog input {
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 7px;
  outline: none;
  background: var(--input-bg);
  color: var(--text);
  padding: 0 10px;
  font-size: 12px;
}

.dialog input:focus {
  border-color: var(--accent);
}

.dialog-error {
  margin: -8px 15px 0;
  color: var(--danger);
  font-size: 11px;
}

.dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 15px;
  border-top: 1px solid var(--border);
}

.dialog footer button {
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 12px;
  cursor: pointer;
  font-size: 11px;
}

.dialog footer .position-field {
  display: flex;
  align-items: center;
  padding: 0;
  gap: 6px;
  color: var(--muted);
  font-size: 10px;
}

.dialog select {
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  appearance: none;
  -webkit-appearance: none;
  background: var(--input-bg)
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4' fill='none' stroke='%2391a0b5' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
    no-repeat right 9px center / 12px 12px;
  color: var(--text);
  padding: 0 26px 0 10px;
  font-size: 11px;
  cursor: pointer;
}

.dialog select:focus {
  border-color: var(--accent);
}

.dialog footer .secondary {
  background: transparent;
  color: var(--text);
}

.dialog footer .primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}

.dialog footer .danger {
  border-color: var(--danger);
  background: var(--danger);
  color: #fff;
}

.delete-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 16px 15px 8px;
}

.delete-summary > div {
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
}

.delete-summary strong {
  color: var(--danger);
  font-size: 18px;
}

.delete-summary span {
  color: var(--muted);
  font-size: 9px;
}

.danger-dialog p {
  margin: 0;
  padding: 8px 15px 17px;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.55;
}

.untracked-files {
  max-height: 105px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow: auto;
  margin: 0 15px 14px;
  border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--border));
  border-radius: 6px;
  background: var(--input-bg);
  padding: 7px;
  color: var(--danger);
  font-family: var(--font-mono);
  font-size: 8px;
}

.git-dialog p {
  margin: 0;
  padding: 17px 15px;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.65;
}
</style>
