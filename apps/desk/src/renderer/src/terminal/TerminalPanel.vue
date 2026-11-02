<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import OutputPane from './OutputPane.vue'
import TerminalIcon from './TerminalIcon.vue'
import TerminalPane from './TerminalPane.vue'
import { useCommandTaskStore } from '../stores/commandTask'
import { useTerminalStore } from '../stores/terminal'
import { useWorkspaceStore } from '../stores/workspace'

import { terminalShortcutCloseTarget } from './terminalTabClose'

import type { TerminalSessionDto } from '../../../shared/contracts'

interface TerminalPaneHandle {
  focus: () => void
  clear: () => void
  selectAll: () => void
  paste: (text: string) => void
  getSelection: () => string
  search: (term: string, direction: 'next' | 'prev') => boolean
}

const store = useTerminalStore()
const commandTasks = useCommandTaskStore()
const workspace = useWorkspaceStore()
const panes = ref<Record<string, TerminalPaneHandle | null>>({})
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const searchOpen = ref(false)
const searchTerm = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const root = ref<HTMLElement | null>(null)

const heightStyle = computed(() =>
  store.maximized ? { height: '100%' } : { height: `${store.height}px` }
)

/** 当前知识库：新建会话的默认归属（已有会话的 cwd 不受切换影响）。 */
const activeKnowledgeBaseId = computed(() => workspace.selectedKnowledgeBaseId ?? null)

function setPaneRef(sessionId: string, instance: unknown): void {
  if (instance) panes.value[sessionId] = instance as TerminalPaneHandle
  else delete panes.value[sessionId]
}

const showingOutput = computed(() => store.view === 'output')

/** 输出视图展示的任务：没有显式选中时落到最近一条 */
const shownTask = computed(
  () => commandTasks.active ?? commandTasks.tasks[commandTasks.tasks.length - 1] ?? null
)

function selectTask(taskId: string): void {
  commandTasks.select(taskId)
  store.view = 'output'
}

function showOutput(): void {
  store.view = 'output'
}

function showTerminal(): void {
  store.view = 'terminal'
  focusActive()
}

function focusActive(): void {
  const id = store.activeSessionId
  if (!id) return
  void nextTick(() => panes.value[id]?.focus())
}

async function createSession(): Promise<void> {
  const knowledgeBaseId = activeKnowledgeBaseId.value
  if (!knowledgeBaseId) return
  store.view = 'terminal'
  await store.createSession(knowledgeBaseId)
  focusActive()
}

async function closeSession(session: TerminalSessionDto): Promise<void> {
  await store.closeSession(session.id)
  if (store.sessions.length === 0) store.toggle(false)
  else focusActive()
}

/** 同一次 ⌘W 可能投递两次，第二次不要再关下一个标签，也不要落到笔记标签上。 */
let shortcutClosePending = false

/**
 * 焦点在终端面板里时关掉当前标签。
 * 输出视图只收起任务输出；终端视图关掉会话进程。没有可关的标签时返回 false，
 * 让 ⌘W 继续去关笔记标签或窗口。
 */
function closeFocusedTab(): boolean {
  if (shortcutClosePending) return true
  const active = document.activeElement
  const target = terminalShortcutCloseTarget({
    panelOpen: store.open,
    focusInsidePanel: Boolean(active && root.value?.contains(active)),
    activeTaskId: showingOutput.value ? (shownTask.value?.id ?? null) : null,
    activeSessionId: showingOutput.value ? null : store.activeSessionId
  })
  if (!target) return false
  const session =
    target.kind === 'session' ? store.sessions.find((item) => item.id === target.id) : null
  if (target.kind === 'session' && !session) return false
  shortcutClosePending = true
  window.setTimeout(() => {
    shortcutClosePending = false
  }, 150)
  if (target.kind === 'task') void commandTasks.closeTask(target.id)
  else if (session) void closeSession(session)
  return true
}

function preventMiddleClickAutoscroll(event: MouseEvent): void {
  if (event.button === 1) event.preventDefault()
}

function closeWithMiddleButton(event: MouseEvent, close: () => void): void {
  if (event.button !== 1) return
  event.preventDefault()
  event.stopPropagation()
  close()
}

async function restartSession(sessionId: string): Promise<void> {
  // 先清掉旧输出再重启：否则新 shell 的提示符会接在旧内容同一行上。
  // 清屏是用户可预期的（旧输出在退出时已经看过），比混在一起更不易误读。
  panes.value[sessionId]?.clear()
  await store.restart(sessionId)
  focusActive()
}

function beginRename(session: TerminalSessionDto): void {
  renamingId.value = session.id
  renameDraft.value = session.title
  void nextTick(() => {
    const input = root.value?.querySelector<HTMLInputElement>('.terminal-tab-rename')
    input?.focus()
    input?.select()
  })
}

async function commitRename(): Promise<void> {
  const id = renamingId.value
  if (!id) return
  const title = renameDraft.value.trim()
  renamingId.value = null
  if (title) await store.renameSession(id, title)
  focusActive()
}

function cancelRename(): void {
  renamingId.value = null
  focusActive()
}

function activePane(): TerminalPaneHandle | null {
  const id = store.activeSessionId
  return id ? (panes.value[id] ?? null) : null
}

function openSearch(): void {
  searchOpen.value = true
  void nextTick(() => {
    searchInput.value?.focus()
    searchInput.value?.select()
  })
}

function closeSearch(): void {
  searchOpen.value = false
  searchTerm.value = ''
  focusActive()
}

function runSearch(direction: 'next' | 'prev'): void {
  const term = searchTerm.value
  if (term) activePane()?.search(term, direction)
}

function selectSession(sessionId: string): void {
  store.activeSessionId = sessionId
  focusActive()
}

/* ---------- 拖动高度 ---------- */

let dragging = false
let dragStartY = 0
let dragStartHeight = 0

function onDragMove(event: MouseEvent): void {
  if (!dragging) return
  // 向上拖动（y 变小）= 面板变高
  store.setHeight(dragStartHeight + (dragStartY - event.clientY))
}

function stopDrag(): void {
  if (!dragging) return
  dragging = false
  document.body.classList.remove('is-resizing')
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', stopDrag)
}

function startDrag(event: MouseEvent): void {
  if (store.maximized) return
  dragging = true
  dragStartY = event.clientY
  dragStartHeight = store.height
  document.body.classList.add('is-resizing')
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', stopDrag)
  event.preventDefault()
}

/* ---------- 面板级快捷键 ---------- */

function onKeydownCapture(event: KeyboardEvent): void {
  const meta = event.metaKey || event.ctrlKey
  if (!meta || event.altKey) return
  const key = event.key.toLowerCase()
  if (key === 'j') {
    // 必须 stopPropagation：App 的窗口级处理器也认这个键，不拦会各切一次互相抵消
    event.preventDefault()
    event.stopPropagation()
    store.toggle()
    if (store.open) void nextTick().then(createOrFocus)
    return
  }
  if (key === 'f') {
    // 终端里的查找：只在面板聚焦时接管，避免抢走编辑器/网页的 Cmd+F
    event.preventDefault()
    event.stopPropagation()
    if (!showingOutput.value) openSearch()
    return
  }
  if (key === '=' || key === '+') {
    event.preventDefault()
    event.stopPropagation()
    store.adjustFontSize(1)
    return
  }
  if (key === '-') {
    event.preventDefault()
    event.stopPropagation()
    store.adjustFontSize(-1)
    return
  }
  if (key === '0') {
    event.preventDefault()
    event.stopPropagation()
    store.resetFontSize()
    return
  }
  if (key === 'w' && closeFocusedTab()) {
    // 窗口级 ⌘W 通常已在主进程被拦住；事件真的进到面板时同样关掉当前终端标签。
    event.preventDefault()
    event.stopPropagation()
  }
}

/** 展开面板：有会话就聚焦，没有就建一个。 */
async function createOrFocus(): Promise<void> {
  if (showingOutput.value) return
  if (store.sessions.length === 0) await createSession()
  else focusActive()
}

/**
 * 在「输出」视图里定位某个命令任务（手动 Git 操作与后台失败入口都用它）。
 * 已存在的运行中任务只做定位，不重复提交命令。
 */
function showTask(taskId: string): void {
  selectTask(taskId)
}

async function openForKnowledgeBase(knowledgeBaseId: string, cwd?: string): Promise<void> {
  store.view = 'terminal'
  await store.createSession(knowledgeBaseId, cwd)
  focusActive()
}

onBeforeUnmount(stopDrag)

watch(
  () => store.activeSessionId,
  () => focusActive()
)

defineExpose({
  createSession,
  createOrFocus,
  openForKnowledgeBase,
  focusActive,
  showTask,
  closeFocusedTab
})
</script>

<template>
  <section
    v-show="store.open"
    ref="root"
    class="terminal-panel"
    :class="{ 'is-maximized': store.maximized }"
    :style="heightStyle"
    tabindex="-1"
    @keydown.capture="onKeydownCapture"
  >
    <div
      v-if="!store.maximized"
      class="terminal-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label="调整终端面板高度"
      @mousedown="startDrag"
    />

    <header class="terminal-tabs">
      <div class="terminal-views" role="tablist" aria-label="面板视图">
        <button
          type="button"
          class="terminal-view"
          :class="{ active: !showingOutput }"
          role="tab"
          :aria-selected="!showingOutput"
          @click="showTerminal"
        >
          终端
        </button>
        <button
          type="button"
          class="terminal-view"
          :class="{ active: showingOutput }"
          role="tab"
          :aria-selected="showingOutput"
          @click="showOutput"
        >
          输出<span v-if="commandTasks.runningCount > 0" class="terminal-view-badge">{{
            commandTasks.runningCount
          }}</span>
        </button>
      </div>
      <div v-if="showingOutput" class="terminal-tab-list" role="tablist">
        <div
          v-for="task in commandTasks.tasks"
          :key="task.id"
          class="terminal-tab command-tab"
          :class="{ active: task.id === shownTask?.id }"
          role="tab"
          :aria-selected="task.id === shownTask?.id"
          :title="`${task.title} — ${task.cwd}`"
          @click="selectTask(task.id)"
          @mousedown="preventMiddleClickAutoscroll"
          @auxclick="closeWithMiddleButton($event, () => commandTasks.closeTask(task.id))"
        >
          <span class="command-tab-dot" :data-status="task.status" aria-hidden="true" />
          <span class="terminal-tab-title">{{ task.title }}</span>
          <span class="terminal-tab-kb">{{ task.knowledgeBaseName }}</span>
          <button
            type="button"
            class="terminal-tab-close"
            :aria-label="`关闭 ${task.title} 的输出`"
            @click.stop="commandTasks.closeTask(task.id)"
          >
            ×
          </button>
        </div>
      </div>
      <div v-else class="terminal-tab-list" role="tablist">
        <div
          v-for="session in store.sessions"
          :key="session.id"
          class="terminal-tab"
          :class="{
            active: session.id === store.activeSessionId,
            exited: session.status === 'exited'
          }"
          role="tab"
          :aria-selected="session.id === store.activeSessionId"
          :title="`${session.title} — ${session.cwd}`"
          @click="selectSession(session.id)"
          @dblclick="beginRename(session)"
          @mousedown="preventMiddleClickAutoscroll"
          @auxclick="closeWithMiddleButton($event, () => closeSession(session))"
        >
          <input
            v-if="renamingId === session.id"
            v-model="renameDraft"
            class="terminal-tab-rename"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
            @click.stop
          />
          <template v-else>
            <span class="terminal-tab-title">{{ session.title }}</span>
            <span class="terminal-tab-kb">{{ session.knowledgeBaseName }}</span>
          </template>
          <button
            type="button"
            class="terminal-tab-close"
            :aria-label="`关闭 ${session.title}`"
            @click.stop="closeSession(session)"
          >
            ×
          </button>
        </div>
        <button
          type="button"
          class="terminal-tab-new"
          aria-label="新建终端"
          data-tooltip="新建终端"
          :disabled="store.creating || !activeKnowledgeBaseId"
          @click="createSession"
        >
          +
        </button>
      </div>

      <div v-if="searchOpen && !showingOutput" class="terminal-search">
        <input
          ref="searchInput"
          v-model="searchTerm"
          placeholder="在输出中查找"
          @input="runSearch('next')"
          @keydown.enter.exact.prevent="runSearch('next')"
          @keydown.shift.enter.prevent="runSearch('prev')"
          @keydown.esc.prevent="closeSearch"
        />
        <button type="button" data-tooltip="上一个" @click="runSearch('prev')">↑</button>
        <button type="button" data-tooltip="下一个" @click="runSearch('next')">↓</button>
        <button type="button" aria-label="关闭查找" @click="closeSearch">×</button>
      </div>

      <div class="terminal-actions">
        <span
          v-if="!showingOutput && store.activeSession?.status === 'exited'"
          class="terminal-exited-hint"
        >
          进程已退出（{{ store.activeSession.exitCode ?? '—' }}）
        </span>
        <button
          v-if="!showingOutput && store.activeSession?.status === 'exited'"
          type="button"
          aria-label="重新启动会话"
          data-tooltip="重新启动会话"
          @click="store.activeSession && restartSession(store.activeSession.id)"
        >
          <TerminalIcon name="refresh" />
        </button>
        <template v-if="!showingOutput">
          <button
            type="button"
            aria-label="在终端中查找"
            data-tooltip="在终端中查找（⌘F）"
            @click="openSearch"
          >
            <TerminalIcon name="search" />
          </button>
          <button
            type="button"
            aria-label="清屏"
            data-tooltip="清屏"
            :disabled="!store.activeSession"
            @click="activePane()?.clear()"
          >
            <TerminalIcon name="clear" />
          </button>
        </template>
        <button
          type="button"
          aria-label="缩小字号"
          data-tooltip="缩小字号（⌘-）"
          @click="store.adjustFontSize(-1)"
        >
          <TerminalIcon name="zoomOut" />
        </button>
        <button
          type="button"
          aria-label="放大字号"
          data-tooltip="放大字号（⌘+）"
          @click="store.adjustFontSize(1)"
        >
          <TerminalIcon name="zoomIn" />
        </button>
        <button
          type="button"
          :aria-label="store.maximized ? '还原面板' : '最大化面板'"
          :data-tooltip="store.maximized ? '还原' : '最大化'"
          @click="store.toggleMaximize()"
        >
          <TerminalIcon :name="store.maximized ? 'restore' : 'maximize'" />
        </button>
        <button
          type="button"
          aria-label="收起终端面板"
          data-tooltip="收起"
          @click="store.toggle(false)"
        >
          <TerminalIcon name="close" />
        </button>
      </div>
    </header>

    <div class="terminal-bodies">
      <div v-if="showingOutput && shownTask" class="terminal-body">
        <OutputPane :task="shownTask" />
      </div>
      <p v-else-if="showingOutput" class="terminal-empty">
        还没有命令输出。拉取、推送和启动 IDE 的过程会显示在这里。
      </p>
      <div
        v-for="session in store.sessions"
        v-show="!showingOutput && session.id === store.activeSessionId"
        :key="session.id"
        class="terminal-body"
      >
        <!--
          退出后**不卸载** TerminalPane：卸载会销毁 xterm 与它的回滚缓冲，
          「输出已保留」就成了假话。改为在上面叠一条退出提示，终端内容照旧可见。
        -->
        <TerminalPane
          :ref="(instance) => setPaneRef(session.id, instance)"
          :session="session"
          :active="session.id === store.activeSessionId"
        />
        <div v-if="session.status === 'exited'" class="terminal-exited-bar">
          <span>
            进程已退出（退出码 {{ session.exitCode ?? '未知'
            }}<template v-if="session.exitSignal">，信号 {{ session.exitSignal }}</template
            >）。上方保留了退出前的输出。
          </span>
          <button type="button" class="primary" @click="restartSession(session.id)">
            重新启动
          </button>
        </div>
      </div>
      <p v-if="!showingOutput && store.sessions.length === 0" class="terminal-empty">
        还没有终端会话。点「+」在当前知识库根目录新建一个。
      </p>
    </div>
  </section>
</template>

<style scoped>
.terminal-panel {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--border-strong);
  background: var(--tn-c-bg);
  outline: none;
}

.terminal-panel.is-maximized {
  position: absolute;
  inset: 42px 0 0 0;
  z-index: 40;
}

.terminal-resize-handle {
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 6px;
  cursor: row-resize;
  background: transparent;
  z-index: 2;
}

.terminal-resize-handle::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 0;
  right: 0;
  height: 1px;
  background: transparent;
}

.terminal-resize-handle:hover::before,
body.is-resizing .terminal-resize-handle::before {
  background: var(--accent);
}

.terminal-tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 6px;
  border-bottom: 1px solid var(--border);
  background: var(--tabs-bg);
}

.terminal-tab-list {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  min-width: 0;
  flex: 1;
}

.terminal-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px 2px 8px;
  border-radius: 5px;
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
  border: 1px solid transparent;
}

.terminal-tab:hover {
  background: var(--tn-c-bg-soft);
}

.terminal-tab.active {
  color: var(--text);
  background: var(--tn-c-bg-soft);
  border-color: var(--border);
}

.terminal-tab.exited .terminal-tab-title {
  opacity: 0.6;
}

.command-tab-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  background: var(--muted);
}

.command-tab-dot[data-status='queued'],
.command-tab-dot[data-status='saving'],
.command-tab-dot[data-status='precheck'],
.command-tab-dot[data-status='running'] {
  background: var(--accent);
}

.command-tab-dot[data-status='canceling'] {
  background: var(--warning, #e5c07b);
}

.command-tab-dot[data-status='done'] {
  background: var(--success, #98c379);
}

.command-tab-dot[data-status='failed'] {
  background: var(--danger, #e06c75);
}

.command-tab-dot[data-status='canceling'],
.command-tab-dot[data-status='timeout'],
.command-tab-dot[data-status='canceled'] {
  background: var(--warning, #e5c07b);
}

.terminal-views {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 6px;
  border-right: 1px solid var(--border);
}

.terminal-view {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 0;
  border-radius: 5px;
  background: none;
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
}

.terminal-view:hover {
  color: var(--text);
}

.terminal-view.active {
  color: var(--text);
  box-shadow: inset 0 -2px 0 var(--accent);
  border-radius: 0;
}

.terminal-view-badge {
  min-width: 14px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--bg, #fff);
  font-size: 10px;
  line-height: 14px;
  text-align: center;
}

.terminal-tab-kb {
  font-size: 10px;
  opacity: 0.65;
}

.terminal-tab-rename {
  width: 96px;
  font-size: 11px;
  padding: 1px 4px;
}

.terminal-tab-close {
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
  opacity: 0.7;
}

.terminal-tab-close:hover {
  opacity: 1;
}

.terminal-tab-new {
  flex: none;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0 6px;
  font-size: 14px;
}

.terminal-tab-new:disabled {
  opacity: 0.4;
  cursor: default;
}

.terminal-search {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}

.terminal-search input {
  width: 150px;
  font-size: 11px;
  padding: 2px 6px;
}

.terminal-search button {
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 1px 5px;
  border-radius: 4px;
}

.terminal-search button:hover {
  color: var(--text);
  background: var(--tn-c-bg-soft);
}

.terminal-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.terminal-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  border-radius: 4px;
}

.terminal-actions button:hover:not(:disabled) {
  color: var(--text);
  background: var(--tn-c-bg-soft);
}

.terminal-exited-hint {
  font-size: 10px;
  color: var(--warning, #e5c07b);
}

.terminal-bodies {
  position: relative;
  flex: 1;
  min-height: 0;
}

.terminal-body {
  position: absolute;
  inset: 0;
}

.terminal-exited-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--muted);
  background: color-mix(in srgb, var(--tn-c-bg) 88%, transparent);
  border-top: 1px solid var(--border);
}

.terminal-empty {
  margin: 0;
  padding: 16px;
  color: var(--muted);
  font-size: 12px;
}
</style>
