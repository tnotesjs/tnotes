<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { useAgentStore } from '../agent/agentStore'
import KnowledgeBaseIcon from './KnowledgeBaseIcon.vue'
import UiTooltip from './UiTooltip.vue'
import { listsEqual, orderedPinned, prunePinIds } from '../../../shared/pinList'
import { useEditorStore, KNOWLEDGE_SIDEBAR_COMPACT } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'

import type { KnowledgeBaseDescriptor, KnowledgeSidebarMenuAction } from '../../../shared/contracts'

const emit = defineEmits<{
  'create-knowledge-base': []
}>()

const store = useWorkspaceStore()
const editor = useEditorStore()
const agent = useAgentStore()
const query = ref('')
const menuBusy = ref(false)
const compact = computed(() => editor.knowledgeSidebarWidth <= KNOWLEDGE_SIDEBAR_COMPACT)

function showIdeMenu(knowledgeBaseId: string): void {
  void window.desk.ide.showKnowledgeBaseMenu(knowledgeBaseId)
}

function matchesKb(item: KnowledgeBaseDescriptor, needle: string): boolean {
  if (!needle) return true
  const haystacks = [item.displayName, item.name, item.configName ?? '', item.rootPath]
  return haystacks.some((value) => value.toLocaleLowerCase().includes(needle))
}

const filteredKnowledgeBases = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return store.overview.knowledgeBases.filter((item) => matchesKb(item, needle))
})

const pinnedKnowledgeBases = computed(() => {
  const ids = store.settings?.pinnedKnowledgeBaseIds ?? []
  const byId = new Map(filteredKnowledgeBases.value.map((item) => [item.id, item]))
  return orderedPinned(ids, byId)
})

const knowledgePinsCollapsed = computed(() => editor.pinnedKnowledgeBasesCollapsed)

type KnowledgeRow =
  | { kind: 'heading' }
  | { kind: 'item'; item: (typeof filteredKnowledgeBases.value)[number] }

const knowledgeRows = computed((): KnowledgeRow[] => {
  const pinned = pinnedKnowledgeBases.value
  const pinnedIds = new Set(pinned.map((item) => item.id))
  const rows: KnowledgeRow[] = []
  if (pinned.length > 0) {
    rows.push({ kind: 'heading' })
    if (!knowledgePinsCollapsed.value) {
      for (const item of pinned) rows.push({ kind: 'item', item })
    }
  }
  for (const item of filteredKnowledgeBases.value) {
    if (!pinnedIds.has(item.id)) rows.push({ kind: 'item', item })
  }
  return rows
})

watch(
  () => {
    const settings = store.settings
    const all = store.overview.allKnowledgeBases
    if (!settings || all.length === 0) return ''
    const current = settings.pinnedKnowledgeBaseIds ?? []
    const next = prunePinIds(current, new Set(all.map((item) => item.id)))
    if (listsEqual(current, next)) return ''
    return `prune:${next.join('\n')}`
  },
  (encoded) => {
    if (!encoded.startsWith('prune:') || !store.settings) return
    const body = encoded.slice('prune:'.length)
    void store.updateSettings({ pinnedKnowledgeBaseIds: body ? body.split('\n') : [] })
  }
)

const emptyMessage = computed(() => {
  if (store.overview.knowledgeBases.length === 0) {
    return {
      title: '没有扫描到知识库',
      detail: '工作区根或其直接子目录中需要存在 tnotes.json'
    }
  }
  return {
    title: '没有匹配的知识库',
    detail: '试试其它名称关键字'
  }
})

async function applyMenuAction(action: KnowledgeSidebarMenuAction): Promise<void> {
  if (action === 'create') {
    emit('create-knowledge-base')
    return
  }
  if (action === 'refresh') {
    await store.refreshWorkspace()
    return
  }
  if (action === 'choose-workspace') {
    await store.chooseWorkspace()
    return
  }
  try {
    const result = await window.desk.workspace.reveal()
    if (!result.ok) store.error = result.error.message
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  }
}

async function openHeaderMenu(): Promise<void> {
  if (menuBusy.value || store.loading) return
  menuBusy.value = true
  try {
    const result = await window.desk.app.showKnowledgeSidebarMenu({
      hasWorkspace: Boolean(store.overview.path),
      loading: store.loading
    })
    if (!result.ok) {
      store.error = result.error.message
      return
    }
    if (result.value) await applyMenuAction(result.value)
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    menuBusy.value = false
  }
}
</script>

<template>
  <aside class="knowledge-sidebar" :class="{ compact }">
    <div class="knowledge-top">
      <div v-if="!compact" class="search-wrap">
        <span>⌕</span>
        <input v-model="query" type="search" placeholder="搜索知识库" />
      </div>
      <div class="header-actions">
        <UiTooltip label="更多知识库操作">
          <button
            type="button"
            class="menu-button"
            aria-label="更多知识库操作"
            :disabled="store.loading || menuBusy"
            @click="openHeaderMenu"
          >
            ⋯
          </button>
        </UiTooltip>
      </div>
    </div>

    <div v-if="filteredKnowledgeBases.length" class="knowledge-list">
      <template v-for="row in knowledgeRows" :key="row.kind === 'item' ? row.item.id : 'pin-heading'">
        <button
          v-if="row.kind === 'heading'"
          type="button"
          class="pin-heading"
          data-pin-group="knowledge"
          :aria-expanded="!knowledgePinsCollapsed"
          :aria-label="knowledgePinsCollapsed ? '展开置顶' : '折叠置顶'"
          @click="editor.togglePinnedKnowledgeBasesCollapsed()"
        >
          <svg
            class="chevron"
            :class="{ collapsed: knowledgePinsCollapsed }"
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
          <template v-if="!compact">
            <strong>置顶</strong>
            <em>{{ pinnedKnowledgeBases.length }}</em>
          </template>
        </button>
        <button
          v-else
          type="button"
          class="knowledge-item"
          :class="{ active: store.selectedKnowledgeBaseId === row.item.id }"
          @click="store.selectKnowledgeBase(row.item.id)"
          @contextmenu.prevent="showIdeMenu(row.item.id)"
        >
          <span class="knowledge-icon">
            <KnowledgeBaseIcon :icon="row.item.icon" :fallback="row.item.displayName" />
          </span>
          <span
            v-if="agent.pendingByKb[row.item.id]"
            class="agent-dot"
            :title="`${agent.pendingByKb[row.item.id]} 篇笔记有 Agent 改动待确认`"
            :aria-label="`${agent.pendingByKb[row.item.id]} 篇笔记有 Agent 改动待确认`"
          />
          <span v-if="!compact" class="knowledge-copy">
            <strong>{{ row.item.displayName }}</strong>
          </span>
        </button>
      </template>
    </div>
    <div v-else class="column-empty">
      <strong>{{ emptyMessage.title }}</strong>
      <span>{{ emptyMessage.detail }}</span>
    </div>

    <footer class="workspace-footer" :title="store.overview.path ?? ''">
      <span v-if="!compact">{{ store.overview.path ?? '尚未选择工作区' }}</span>
    </footer>
  </aside>
</template>

<style scoped>
.knowledge-sidebar {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
}

.knowledge-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--border);
}

.search-wrap {
  height: auto;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--input-bg);
  color: var(--muted);
}

.search-wrap > span {
  flex: none;
  font-size: 13px;
}

.search-wrap input {
  flex: 1;
  min-width: 0;
  height: 26px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 11px;
}

.search-wrap input:focus {
  outline: none;
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
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--raised);
  color: var(--text);
  cursor: pointer;
  font-size: 18px;
  line-height: 20px;
}

.menu-button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.menu-button:disabled {
  opacity: 0.4;
}

.knowledge-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 7px;
}

.agent-dot {
  position: absolute;
  top: 3px;
  left: 22px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent, #3b82f6);
  box-shadow: 0 0 0 1.5px var(--panel, #fff);
  pointer-events: auto;
}

.knowledge-item {
  position: relative;
  width: 100%;
  min-height: 28px;
  display: flex;
  align-items: center;
  gap: 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  padding: 2px 5px;
  text-align: left;
  cursor: pointer;
}

.knowledge-item:hover {
  background: var(--hover);
}

.knowledge-item.active {
  background: var(--selected);
}

.knowledge-icon {
  width: 20px;
  height: 20px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 5px;
  overflow: hidden;
  background: var(--raised);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
}

.knowledge-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}

.knowledge-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
}

.knowledge-sidebar.compact .knowledge-top {
  justify-content: center;
}

.knowledge-sidebar.compact .knowledge-item {
  justify-content: center;
  gap: 0;
}

.pin-heading {
  position: sticky;
  top: 0;
  z-index: 2;
  width: 100%;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 0 2px;
  padding: 0 4px;
  border: 0;
  border-radius: 6px;
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.pin-heading strong {
  flex: 1;
  font-weight: 700;
  text-align: left;
}

.pin-heading em {
  min-width: 16px;
  border-radius: 8px;
  background: var(--raised);
  padding: 0 4px;
  text-align: center;
  font-style: normal;
  font-size: 9px;
}

.pin-heading .chevron {
  flex: none;
  width: 16px;
  height: 12px;
  transition: transform 120ms ease;
}

.pin-heading .chevron.collapsed {
  transform: rotate(-90deg);
}

.knowledge-sidebar.compact .pin-heading {
  justify-content: center;
  padding: 0;
}

.knowledge-sidebar.compact .agent-dot {
  left: calc(50% + 6px);
}

.column-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 20px;
  text-align: center;
  color: var(--muted);
  font-size: 11px;
}

.column-empty strong {
  color: var(--text);
  font-size: 12px;
}

.workspace-footer {
  height: 36px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 14px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 10px;
}

.workspace-footer > span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
