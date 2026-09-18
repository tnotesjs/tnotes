<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import TerminalPane from './TerminalPane.vue'
import { useTerminalStore } from '../stores/terminal'
import { useWorkspaceStore } from '../stores/workspace'

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

function focusActive(): void {
  const id = store.activeSessionId
  if (!id) return
  void nextTick(() => panes.value[id]?.focus())
}

async function createSession(): Promise<void> {
  const knowledgeBaseId = activeKnowledgeBaseId.value
  if (!knowledgeBaseId) return
  await store.createSession(knowledgeBaseId)
  focusActive()
}

async function closeSession(session: TerminalSessionDto): Promise<void> {
  await store.closeSession(session.id)
  if (store.sessions.length === 0) store.toggle(false)
  else focusActive()
}

async function restartSession(sessionId: string): Promise<void> {
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
    openSearch()
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
  if (key === 'w' && store.sessions.length > 1 && store.activeSessionId) {
    // Cmd/Ctrl+W 在终端聚焦时关掉当前会话；只有一个会话时交回默认行为
    const target = store.sessions.find((session) => session.id === store.activeSessionId)
    if (target) {
      event.preventDefault()
      event.stopPropagation()
      void closeSession(target)
    }
  }
}

/** 展开面板：有会话就聚焦，没有就建一个。 */
async function createOrFocus(): Promise<void> {
  if (store.sessions.length === 0) await createSession()
  else focusActive()
}

async function openForKnowledgeBase(knowledgeBaseId: string, cwd?: string): Promise<void> {
  await store.createSession(knowledgeBaseId, cwd)
  focusActive()
}

onBeforeUnmount(stopDrag)

watch(
  () => store.activeSessionId,
  () => focusActive()
)

defineExpose({ createSession, createOrFocus, openForKnowledgeBase, focusActive })
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
      <div class="terminal-tab-list" role="tablist">
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

      <div v-if="searchOpen" class="terminal-search">
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
        <span v-if="store.activeSession?.status === 'exited'" class="terminal-exited-hint">
          进程已退出（{{ store.activeSession.exitCode ?? '—' }}）
        </span>
        <button
          v-if="store.activeSession?.status === 'exited'"
          type="button"
          data-tooltip="重新启动会话"
          @click="store.activeSession && restartSession(store.activeSession.id)"
        >
          重启
        </button>
        <button type="button" data-tooltip="在输出中查找（⌘F）" @click="openSearch">查找</button>
        <button
          type="button"
          data-tooltip="清屏"
          :disabled="!store.activeSession"
          @click="activePane()?.clear()"
        >
          清屏
        </button>
        <button type="button" data-tooltip="缩小字号（⌘-）" @click="store.adjustFontSize(-1)">
          A−
        </button>
        <button type="button" data-tooltip="放大字号（⌘+）" @click="store.adjustFontSize(1)">
          A+
        </button>
        <button
          type="button"
          :aria-label="store.maximized ? '还原面板' : '最大化面板'"
          :data-tooltip="store.maximized ? '还原' : '最大化'"
          @click="store.toggleMaximize()"
        >
          {{ store.maximized ? '❐' : '□' }}
        </button>
        <button
          type="button"
          aria-label="收起终端面板"
          data-tooltip="收起"
          @click="store.toggle(false)"
        >
          ×
        </button>
      </div>
    </header>

    <div class="terminal-bodies">
      <div
        v-for="session in store.sessions"
        v-show="session.id === store.activeSessionId"
        :key="session.id"
        class="terminal-body"
      >
        <div v-if="session.status === 'exited'" class="terminal-exited">
          <p>进程已退出（退出码 {{ session.exitCode ?? '未知' }}）。会话输出已保留。</p>
          <button type="button" class="primary" @click="restartSession(session.id)">
            重新启动
          </button>
        </div>
        <TerminalPane
          v-else
          :ref="(instance) => setPaneRef(session.id, instance)"
          :session="session"
          :active="session.id === store.activeSessionId"
        />
      </div>
      <p v-if="store.sessions.length === 0" class="terminal-empty">
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
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 6px;
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

.terminal-exited {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 100%;
  color: var(--muted);
  font-size: 12px;
}

.terminal-empty {
  margin: 0;
  padding: 16px;
  color: var(--muted);
  font-size: 12px;
}
</style>
