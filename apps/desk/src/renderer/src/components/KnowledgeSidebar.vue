<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { useAgentStore } from '../agent/agentStore'
import KnowledgeBaseIcon from './KnowledgeBaseIcon.vue'
import { listsEqual, movePinId, orderedPinned, prunePinIds } from '../../../shared/pinList'
import { useEditorStore, KNOWLEDGE_SIDEBAR_COMPACT } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'

import type {
  KnowledgeBaseDescriptor,
  KnowledgeBaseSort,
  KnowledgeSidebarMenuAction
} from '../../../shared/contracts'

const PIN_DRAG_TYPE = 'application/x-tnotes-kb-pin'

const emit = defineEmits<{
  'create-knowledge-base': []
}>()

const store = useWorkspaceStore()
const editor = useEditorStore()
const agent = useAgentStore()
const menuBusy = ref(false)
const pinDrop = ref<{ id: string; placement: 'before' | 'after' } | null>(null)
const compact = computed(
  () =>
    editor.knowledgeSidebarCollapsed || editor.knowledgeSidebarWidth <= KNOWLEDGE_SIDEBAR_COMPACT
)

function showIdeMenu(knowledgeBaseId: string): void {
  void window.desk.ide.showKnowledgeBaseMenu(knowledgeBaseId)
}

const knowledgeBases = computed(() => store.overview.knowledgeBases)

const pinnedKnowledgeBases = computed(() => {
  const ids = store.settings?.pinnedKnowledgeBaseIds ?? []
  const byId = new Map(knowledgeBases.value.map((item) => [item.id, item]))
  return orderedPinned(ids, byId)
})

const groupedKnowledgeBases = computed(() =>
  sortKnowledgeBases(knowledgeBases.value, editor.knowledgeBaseSort)
)

const groupExpanded = computed(() => !editor.knowledgeGroupCollapsed)

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

const emptyMessage = computed(() =>
  store.overview.path
    ? {
        title: '没有扫描到知识库',
        detail: '工作区根或其直接子目录中需要存在 tnotes.json'
      }
    : {
        title: '还没有打开工作区',
        detail: '从菜单里选择或更换工作区'
      }
)

function sortKnowledgeBases(
  items: KnowledgeBaseDescriptor[],
  sort: KnowledgeBaseSort | undefined
): KnowledgeBaseDescriptor[] {
  const mode = sort ?? 'name-asc'
  const direction = mode.endsWith('-desc') ? -1 : 1
  const kind = mode.slice(0, mode.lastIndexOf('-'))
  return [...items].sort((left, right) => {
    const delta = compareKnowledgeBases(left, right, kind) * direction
    return delta || left.displayName.localeCompare(right.displayName)
  })
}

function compareKnowledgeBases(
  left: KnowledgeBaseDescriptor,
  right: KnowledgeBaseDescriptor,
  kind: string
): number {
  if (kind === 'count') return left.noteCount - right.noteCount
  if (kind === 'done') return (left.completedCount ?? 0) - (right.completedCount ?? 0)
  if (kind === 'updated') {
    const leftAt = left.lastCommitAt ?? Number.NEGATIVE_INFINITY
    const rightAt = right.lastCommitAt ?? Number.NEGATIVE_INFINITY
    return leftAt - rightAt
  }
  return left.displayName.localeCompare(right.displayName)
}

function toggleGroup(): void {
  editor.knowledgeGroupCollapsed = !editor.knowledgeGroupCollapsed
}

function unpin(id: string): void {
  store.togglePinnedKnowledgeBase(id)
}

function pinPlacement(event: DragEvent): 'before' | 'after' {
  const row = event.currentTarget as HTMLElement
  const ratio = (event.clientY - row.getBoundingClientRect().top) / row.offsetHeight
  return ratio < 0.5 ? 'before' : 'after'
}

function onPinDragStart(event: DragEvent, item: KnowledgeBaseDescriptor): void {
  const target = event.target
  if (target instanceof Element && target.closest('.pin-button')) {
    event.preventDefault()
    return
  }
  if (!event.dataTransfer || pinnedKnowledgeBases.value.length < 2) {
    event.preventDefault()
    return
  }
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData(PIN_DRAG_TYPE, item.id)
}

function onPinDragOver(event: DragEvent, item: KnowledgeBaseDescriptor): void {
  if (!event.dataTransfer?.types.includes(PIN_DRAG_TYPE)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  const placement = pinPlacement(event)
  if (pinDrop.value?.id !== item.id || pinDrop.value.placement !== placement) {
    pinDrop.value = { id: item.id, placement }
  }
}

function onPinDrop(event: DragEvent, item: KnowledgeBaseDescriptor): void {
  if (!event.dataTransfer?.types.includes(PIN_DRAG_TYPE)) return
  event.preventDefault()
  const sourceId = event.dataTransfer.getData(PIN_DRAG_TYPE)
  const placement = pinDrop.value?.placement === 'before' ? 'before' : 'after'
  pinDrop.value = null
  if (sourceId && sourceId !== item.id) {
    const current = store.settings?.pinnedKnowledgeBaseIds ?? []
    const next = movePinId(current, sourceId, item.id, placement)
    if (!listsEqual(current, next)) store.reorderPinnedKnowledgeBase(sourceId, item.id, placement)
  }
}

function onPinDragEnd(): void {
  pinDrop.value = null
}

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

async function openMenu(): Promise<void> {
  if (menuBusy.value) return
  menuBusy.value = true
  try {
    const result = await window.desk.app.showKnowledgeSidebarMenu({
      hasWorkspace: Boolean(store.overview.path),
      loading: store.loading,
      sort: editor.knowledgeBaseSort
    })
    if (!result.ok) {
      store.error = result.error.message
      return
    }
    if (result.value?.kind === 'sort') editor.knowledgeBaseSort = result.value.sort
    if (result.value?.kind === 'action') await applyMenuAction(result.value.action)
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    menuBusy.value = false
  }
}

</script>

<template>
  <aside id="knowledge-sidebar" class="knowledge-sidebar" :class="{ compact }">
    <div v-if="pinnedKnowledgeBases.length" class="pin-strip">
        <div
          v-for="item in pinnedKnowledgeBases"
          :key="item.id"
          class="knowledge-item"
          :class="{
            active: store.selectedKnowledgeBaseId === item.id,
            'drop-before': pinDrop?.id === item.id && pinDrop.placement === 'before',
            'drop-after': pinDrop?.id === item.id && pinDrop.placement === 'after'
          }"
          role="button"
          tabindex="0"
          :draggable="pinnedKnowledgeBases.length > 1 && !compact"
          @click="store.selectKnowledgeBase(item.id)"
          @keydown.enter.prevent="store.selectKnowledgeBase(item.id)"
          @contextmenu.prevent="showIdeMenu(item.id)"
          @dragstart="onPinDragStart($event, item)"
          @dragover="onPinDragOver($event, item)"
          @drop="onPinDrop($event, item)"
          @dragend="onPinDragEnd"
        >
          <span class="knowledge-icon">
            <KnowledgeBaseIcon :icon="item.icon" :fallback="item.displayName" />
          </span>
          <span
            v-if="agent.pendingByKb[item.id]"
            class="agent-dot"
            :title="`${agent.pendingByKb[item.id]} 篇笔记有 Agent 改动待确认`"
            :aria-label="`${agent.pendingByKb[item.id]} 篇笔记有 Agent 改动待确认`"
          />
          <span v-if="!compact" class="knowledge-copy">
            <strong>{{ item.displayName }}</strong>
          </span>
          <button
            v-if="!compact"
            type="button"
            class="pin-button"
            aria-label="取消置顶"
            title="取消置顶"
            @click.stop="unpin(item.id)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479c-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A6 6 0 0 1 5 6.708V2.277a3 3 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354m1.58 1.408l-.002-.001zm-.002-.001l.002.001A.5.5 0 0 1 6 2v5a.5.5 0 0 1-.276.447h-.002l-.012.007l-.054.03a5 5 0 0 0-.827.58c-.318.278-.585.596-.725.936h7.792c-.14-.34-.407-.658-.725-.936a5 5 0 0 0-.881-.61l-.012-.006h-.002A.5.5 0 0 1 10 7V2a.5.5 0 0 1 .295-.458a1.8 1.8 0 0 0 .351-.271c.08-.08.155-.17.214-.271H5.14q.091.15.214.271a1.8 1.8 0 0 0 .37.282"
              />
            </svg>
          </button>
        </div>
      </div>

      <div class="kb-group">
        <div class="section-heading">
          <button
            type="button"
            class="section-toggle"
            :aria-expanded="groupExpanded"
            :aria-label="editor.knowledgeGroupCollapsed ? '展开知识库' : '折叠知识库'"
            @click="toggleGroup"
          >
            <svg
              class="chevron"
              :class="{ collapsed: !groupExpanded }"
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
              <strong>知识库</strong>
              <em>{{ knowledgeBases.length }}</em>
            </template>
          </button>
          <button
            v-if="!compact"
            type="button"
            class="menu-button kb-menu-button"
            aria-label="知识库操作"
            aria-haspopup="menu"
            :disabled="menuBusy"
            @click="openMenu"
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
        <div v-show="groupExpanded" class="knowledge-list">
          <button
            v-for="item in groupedKnowledgeBases"
            :key="item.id"
            type="button"
            class="knowledge-item"
            :class="{ active: store.selectedKnowledgeBaseId === item.id }"
            @click="store.selectKnowledgeBase(item.id)"
            @contextmenu.prevent="showIdeMenu(item.id)"
          >
            <span class="knowledge-icon">
              <KnowledgeBaseIcon :icon="item.icon" :fallback="item.displayName" />
            </span>
            <span
              v-if="agent.pendingByKb[item.id]"
              class="agent-dot"
              :title="`${agent.pendingByKb[item.id]} 篇笔记有 Agent 改动待确认`"
              :aria-label="`${agent.pendingByKb[item.id]} 篇笔记有 Agent 改动待确认`"
            />
            <span v-if="!compact" class="knowledge-copy">
              <strong>{{ item.displayName }}</strong>
            </span>
          </button>
        </div>
        <div v-if="groupExpanded && knowledgeBases.length === 0" class="column-empty">
          <strong>{{ emptyMessage.title }}</strong>
          <span>{{ emptyMessage.detail }}</span>
        </div>
      </div>
  </aside>
</template>

<style scoped>
.knowledge-sidebar {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
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

.pin-strip {
  flex: none;
  max-height: 40%;
  overflow-x: clip;
  overflow-y: auto;
  padding: 7px 7px 0;
}

.kb-group {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.section-heading {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 27px;
  margin: 0 7px;
  color: var(--muted);
}

.section-toggle {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}

.section-toggle strong {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.section-toggle em {
  min-width: 18px;
  border-radius: 9px;
  background: var(--raised);
  padding: 1px 5px;
  text-align: center;
  font-style: normal;
  font-size: 9px;
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

.kb-menu-button {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 4px;
}

.knowledge-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 7px 7px;
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
  font-family: inherit;
}

.knowledge-item.drop-before {
  box-shadow: inset 0 2px 0 var(--accent);
}

.knowledge-item.drop-after {
  box-shadow: inset 0 -2px 0 var(--accent);
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

.pin-button {
  flex: none;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.pin-button svg {
  width: 12px;
  height: 12px;
  display: block;
}

.pin-button:hover {
  background: var(--hover);
  color: var(--text);
}

.knowledge-sidebar.compact .pin-strip,
.knowledge-sidebar.compact .knowledge-list,
.knowledge-sidebar.compact .section-heading {
  padding-left: 0;
  padding-right: 0;
  margin-left: 0;
  margin-right: 0;
  /* 有没有滚动条都留出同样的左右空档，图标才能落在同一条中线上。 */
  scrollbar-gutter: stable both-edges;
}

.knowledge-sidebar.compact .section-heading {
  overflow-y: auto;
  height: 28px;
  justify-content: center;
}

.knowledge-sidebar.compact .section-toggle {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  background: var(--raised);
  justify-content: center;
  gap: 0;
}

.knowledge-sidebar.compact .chevron {
  width: 12px;
  height: 12px;
}

.knowledge-sidebar.compact .knowledge-item {
  justify-content: center;
  gap: 0;
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
</style>
