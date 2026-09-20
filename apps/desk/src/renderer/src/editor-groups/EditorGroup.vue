<script setup lang="ts">
import { computed, ref } from 'vue'

import KnowledgeBaseIcon from '../components/KnowledgeBaseIcon.vue'
import UiTooltip from '../components/UiTooltip.vue'
import KbSettingsPane from './KbSettingsPane.vue'
import ExcalidrawTabPane from './ExcalidrawTabPane.vue'
import TextFileTabPane from './TextFileTabPane.vue'
import HistoryTabPane from './HistoryTabPane.vue'
import KbAssetsPane from './KbAssetsPane.vue'
import NoteTabPane from './NoteTabPane.vue'
import WebTabPane from './WebTabPane.vue'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import { resultValue } from '../stores/workspace/helpers'

import type { ContextMenuAction, EditorGroupNode, EditorTab } from '../../../shared/contracts'
import { findTab } from './layoutModel'
import { resolveTabDropPlacement, TAB_DRAG_MIME, useTabDragStore } from './tabDrag'

const props = defineProps<{ group: EditorGroupNode }>()
const editor = useEditorStore()
const workspace = useWorkspaceStore()
const drag = useTabDragStore()
const groupElement = ref<HTMLElement | null>(null)
const bodyElement = ref<HTMLElement | null>(null)
const dropPreview = computed(() => (drag.target?.groupId === props.group.id ? drag.target : null))

const activeTab = computed(
  () => props.group.tabs.find((tab) => tab.id === props.group.activeTabId) ?? null
)
const pinnedTabs = computed(() => props.group.tabs.filter((tab) => tab.pinned))
const regularTabs = computed(() => props.group.tabs.filter((tab) => !tab.pinned))

async function activate(tab: EditorTab): Promise<void> {
  const previous = activeTab.value
  if (previous?.type === 'web' && previous.id !== tab.id) {
    await window.desk.web.layout({ tabId: previous.id, visible: false })
  }
  editor.activate(props.group.id, tab.id)
  void workspace.syncToActiveTab()
}

function beginDrag(event: DragEvent, tab: EditorTab): void {
  if (!event.dataTransfer) return
  event.dataTransfer.setData(TAB_DRAG_MIME, tab.id)
  event.dataTransfer.effectAllowed = 'move'
  drag.start(tab.id)
}

function isTabDrag(event: DragEvent): boolean {
  // `getData` is unavailable during dragenter/dragover, so gate on the transfer
  // type list. Interior editor drags (e.g. Milkdown block reordering) never carry
  // this MIME type, so they must not activate the split-drop overlay.
  return (
    Boolean(drag.tabId && findTab(editor.layout, drag.tabId)) &&
    Array.from(event.dataTransfer?.types ?? []).includes(TAB_DRAG_MIME)
  )
}

function updateDropTarget(event: DragEvent): void {
  drag.target = null
  const body = bodyElement.value
  if (!body || !isTabDrag(event)) return
  const bounds = body.getBoundingClientRect()
  const placement = resolveTabDropPlacement(bounds, event.clientX, event.clientY)
  const source = findTab(editor.layout, drag.tabId!)!
  // Dropping into your own center is a no-op; a lone tab cannot split itself.
  if (
    !placement ||
    (source.group.id === props.group.id &&
      (placement === 'center' || source.group.tabs.length === 1))
  )
    return
  drag.target = { groupId: props.group.id, placement }
}

function handleDragOver(event: DragEvent): void {
  if (!isTabDrag(event)) return
  // Keep tab drops away from CodeMirror/Milkdown's content drop handlers.
  event.preventDefault()
  event.stopPropagation()
  updateDropTarget(event)
  const inTabs = event.target instanceof Element && Boolean(event.target.closest('.tabs-bar'))
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = dropPreview.value || inTabs ? 'move' : 'none'
}

function handleDragLeave(event: DragEvent): void {
  if (event.relatedTarget instanceof Node && groupElement.value?.contains(event.relatedTarget))
    return
  if (drag.target?.groupId === props.group.id) drag.target = null
}

function handleDrop(event: DragEvent): void {
  if (!isTabDrag(event)) return
  event.preventDefault()
  event.stopPropagation()
  const tabId = event.dataTransfer?.getData(TAB_DRAG_MIME)
  if (!tabId || tabId !== drag.tabId) {
    drag.finish()
    return
  }
  updateDropTarget(event)
  const placement = dropPreview.value?.placement
  const target = event.target instanceof Element ? event.target : null
  const row = target?.closest('.tabs-row')
  const targetTabId = target?.closest<HTMLElement>('.tab')?.dataset.tabId
  const source = findTab(editor.layout, tabId)!
  drag.finish()
  if (row) {
    if (targetTabId === tabId) return
    let index = targetTabId
      ? props.group.tabs.findIndex((tab) => tab.id === targetTabId)
      : props.group.tabs.length
    const sourceIndex = source.group.tabs.findIndex((tab) => tab.id === tabId)
    if (source.group.id === props.group.id && sourceIndex < index) index -= 1
    editor.moveTab(tabId, props.group.id, index)
    editor.setPinned(tabId, row.classList.contains('pinned-row'))
  } else if (placement === 'center') {
    editor.moveTab(tabId, props.group.id)
  } else if (placement) {
    editor.splitTab(tabId, props.group.id, placement, 'move')
  }
}

function isDirty(tab: EditorTab): boolean {
  return workspace.isTabDirty(tab)
}

function tabAriaLabel(tab: EditorTab): string {
  if (tab.type === 'web') return tab.url
  if (tab.type === 'kb-settings' || tab.type === 'kb-assets' || tab.type === 'note-history') {
    return tab.title
  }
  return `${tab.knowledgeBaseName} · ${tab.title}`
}

function closeTab(tab: EditorTab): void {
  void workspace.requestCloseTab(tab.id)
}

/** 点图钉：只取消固定，不关闭标签（关闭另有 .tab-close 与右键菜单）。 */
function togglePinned(tab: EditorTab): void {
  editor.togglePinned(tab.id)
}

function closeTabWithMiddleButton(event: MouseEvent, tab: EditorTab): void {
  if (event.button !== 1) return
  event.preventDefault()
  event.stopPropagation()
  void workspace.requestCloseTab(tab.id, true)
}

function openWeb(): void {
  try {
    editor.openWeb()
  } catch (cause) {
    workspace.error = cause instanceof Error ? cause.message : String(cause)
  }
}

async function showTabMenu(event: MouseEvent, tab: EditorTab): Promise<void> {
  event.stopPropagation()
  const knowledgeBaseId = editor.activeKnowledgeBaseId
  try {
    const action = resultValue(
      await window.desk.app.showContextMenu({
        kind: 'tab',
        tabType: tab.type,
        pinned: Boolean(tab.pinned)
      })
    )
    const currentTab = editor.groups
      .flatMap((group) => group.tabs)
      .find((candidate) => candidate.id === tab.id)
    if (action && currentTab && editor.activeKnowledgeBaseId === knowledgeBaseId) {
      await runTabAction(action, currentTab)
    }
  } catch (cause) {
    workspace.error = cause instanceof Error ? cause.message : String(cause)
  }
}

async function runTabAction(action: ContextMenuAction, tab: EditorTab): Promise<void> {
  if (action === 'close') await workspace.requestCloseTab(tab.id)
  else if (action === 'close-saved') await workspace.requestCloseTabs('saved')
  else if (action === 'close-all') await workspace.requestCloseTabs('all')
  else if (action === 'close-web') await workspace.requestCloseTabs('web')
  else if (action === 'toggle-pin') editor.togglePinned(tab.id)
  else if (tab.type === 'note' && action === 'copy-path') await workspace.copyNoteDirectoryPath(tab)
  else if (tab.type === 'note' && action === 'reveal-file')
    await workspace.revealNoteInFileManager(tab)
  else if (tab.type === 'note' && action === 'reveal-toc') await workspace.revealTabInToc(tab)
}
</script>

<template>
  <section
    ref="groupElement"
    class="editor-group"
    :class="{ active: editor.activeGroupId === group.id }"
    @mousedown="editor.activeGroupId = group.id"
    @focusin="editor.activeGroupId = group.id"
    @dragenter.capture="handleDragOver"
    @dragleave.capture="handleDragLeave"
    @dragover.capture="handleDragOver"
    @drop.capture="handleDrop"
  >
    <div class="tabs-bar" :class="{ 'has-pinned': pinnedTabs.length, wrap: editor.wrapTabs }">
      <div v-if="pinnedTabs.length" class="tabs-row pinned-row">
        <button
          v-for="tab in pinnedTabs"
          :key="tab.id"
          :data-tab-id="tab.id"
          type="button"
          class="tab pinned"
          :class="{ selected: tab.id === group.activeTabId }"
          draggable="true"
          :aria-label="tabAriaLabel(tab)"
          @click="activate(tab)"
          @auxclick="closeTabWithMiddleButton($event, tab)"
          @contextmenu.prevent="showTabMenu($event, tab)"
          @dragstart="beginDrag($event, tab)"
        >
          <img
            v-if="tab.type === 'web' && editor.webStates[tab.id]?.faviconUrl"
            class="tab-favicon"
            :src="editor.webStates[tab.id].faviconUrl"
            alt=""
          />
          <span
            v-else-if="
              tab.type === 'note' || tab.type === 'kb-settings' || tab.type === 'kb-assets'
            "
            class="tab-icon knowledge-tab-icon"
          >
            <KnowledgeBaseIcon :icon="tab.icon" :fallback="tab.knowledgeBaseName" />
          </span>
          <span v-else class="tab-icon">⌘</span>
          <span class="tab-title">{{ tab.title }}</span>
          <span v-if="isDirty(tab)" class="dirty-dot">●</span>
          <!-- 图钉就是"取消固定"的入口：单击只取消固定，不关闭标签（标签本体是 button，
               所以这里用 span + 可访问名称，与 .tab-close 同一写法） -->
          <span
            class="pin-mark"
            role="button"
            tabindex="0"
            aria-label="取消固定标签"
            :title="`取消固定 ${tab.title}`"
            @click.stop="togglePinned(tab)"
            @keydown.enter.prevent.stop="togglePinned(tab)"
            @keydown.space.prevent.stop="togglePinned(tab)"
            @mousedown.stop
            @dblclick.stop
            >⌖</span
          >
        </button>
      </div>

      <div class="tabs-row regular-row" :class="{ wrap: editor.wrapTabs }">
        <button
          v-for="tab in regularTabs"
          :key="tab.id"
          :data-tab-id="tab.id"
          type="button"
          class="tab"
          :class="{
            selected: tab.id === group.activeTabId,
            preview: tab.type === 'note' && tab.preview
          }"
          draggable="true"
          :aria-label="tabAriaLabel(tab)"
          @click="activate(tab)"
          @auxclick="closeTabWithMiddleButton($event, tab)"
          @dblclick.stop="editor.keepOpen(tab.id)"
          @contextmenu.prevent="showTabMenu($event, tab)"
          @dragstart="beginDrag($event, tab)"
        >
          <img
            v-if="tab.type === 'web' && editor.webStates[tab.id]?.faviconUrl"
            class="tab-favicon"
            :src="editor.webStates[tab.id].faviconUrl"
            alt=""
          />
          <span
            v-else-if="
              tab.type === 'note' || tab.type === 'kb-settings' || tab.type === 'kb-assets'
            "
            class="tab-icon knowledge-tab-icon"
          >
            <KnowledgeBaseIcon :icon="tab.icon" :fallback="tab.knowledgeBaseName" />
          </span>
          <span v-else class="tab-icon">⌘</span>
          <span class="tab-title">{{ tab.title }}</span>
          <span v-if="isDirty(tab)" class="dirty-dot">●</span>
          <span class="tab-close" aria-label="关闭标签" @click.stop="closeTab(tab)">×</span>
        </button>

        <div class="tab-actions">
          <UiTooltip label="新建网页标签">
            <button type="button" aria-label="新建网页标签" @click="openWeb">＋</button>
          </UiTooltip>
          <UiTooltip label="向右拆分">
            <button
              type="button"
              aria-label="向右拆分当前标签"
              :disabled="!activeTab"
              @click="editor.splitActive('right')"
            >
              ◫
            </button>
          </UiTooltip>
          <UiTooltip label="向下拆分">
            <button
              type="button"
              aria-label="向下拆分当前标签"
              :disabled="!activeTab"
              @click="editor.splitActive('bottom')"
            >
              ⊟
            </button>
          </UiTooltip>
        </div>
      </div>
    </div>

    <div ref="bodyElement" class="editor-group-body">
      <div
        v-for="tab in group.tabs"
        v-show="tab.id === group.activeTabId"
        :key="tab.id"
        class="tab-content"
      >
        <NoteTabPane
          v-if="tab.type === 'note'"
          :tab="tab"
          :group-id="group.id"
          :active="tab.id === group.activeTabId"
        />
        <KbSettingsPane
          v-else-if="tab.type === 'kb-settings'"
          :tab="tab"
          :active="tab.id === group.activeTabId"
        />
        <KbAssetsPane
          v-else-if="tab.type === 'kb-assets'"
          :tab="tab"
          :active="tab.id === group.activeTabId"
        />
        <ExcalidrawTabPane
          v-else-if="tab.type === 'excalidraw'"
          :tab="tab"
          :group-id="group.id"
          :active="tab.id === group.activeTabId"
        />
        <TextFileTabPane
          v-else-if="tab.type === 'text-file'"
          :tab="tab"
          :group-id="group.id"
          :active="tab.id === group.activeTabId"
        />
        <HistoryTabPane
          v-else-if="tab.type === 'note-history'"
          :tab="tab"
          :group-id="group.id"
          :active="tab.id === group.activeTabId"
        />
        <WebTabPane v-else :tab="tab" :active="tab.id === group.activeTabId" />
      </div>
      <div v-if="!activeTab" class="editor-empty">
        <div class="empty-mark">T</div>
        <strong>打开一篇笔记或网页</strong>
        <span>可把标签拖到边缘进行左右或上下拆分。</span>
        <button type="button" @click="openWeb">打开网页标签</button>
      </div>

      <!-- Capture tab drops above editor/iframe contents without intercepting
         ordinary text, file, or Milkdown block drags. -->
      <div v-if="drag.tabId" class="tab-drag-surface" aria-hidden="true" />
      <div v-if="dropPreview" class="tab-drop-overlay" aria-hidden="true">
        <div class="tab-drop-preview" :class="dropPreview.placement" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.editor-group {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--editor-bg);
}

.editor-group.active {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
}

.tabs-bar {
  flex: none;
  overflow-x: hidden;
  overflow-y: hidden;
  border-bottom: 1px solid var(--border);
  background: var(--tabs-bg);
}

.tabs-row {
  min-height: 35px;
  display: flex;
  align-items: stretch;
}

.pinned-row {
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--raised) 55%, var(--tabs-bg));
}

.regular-row {
  min-width: 100%;
}

.regular-row.wrap {
  flex-wrap: wrap;
}

.tabs-bar:not(.wrap) .regular-row {
  overflow-x: auto;
  overflow-y: hidden;
}

.tab {
  height: 35px;
  min-width: 100px;
  max-width: 230px;
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  border-right: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  padding: 0 8px;
  cursor: default;
  font-size: 10px;
}

.tab.preview .tab-title {
  font-style: italic;
}

.tab.pinned {
  background: color-mix(in srgb, var(--raised) 38%, transparent);
}

.tab.selected {
  background: var(--editor-bg);
  color: var(--text);
  box-shadow: inset 0 1px var(--accent);
}

.tab-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.tab-icon,
.tab-favicon {
  width: 15px;
  height: 15px;
  flex: none;
  border-radius: 4px;
}

.tab-icon {
  display: grid;
  place-items: center;
  background: var(--raised);
  color: var(--accent);
  font-size: 8px;
  font-weight: 750;
}

.knowledge-tab-icon {
  background: transparent;
}

.file-tab-icon {
  width: 20px;
  background: transparent;
  font-family: var(--font-mono);
  font-size: 8px;
}

.dirty-dot {
  color: var(--accent);
  font-size: 7px;
}

/* 「取消固定」与「关闭」是标签右侧同一排的两个入口，统一成 22×22 的方框 + 居中字形：
   两者的点击区域与视觉重心一致（验收要求 22*22）。标签行高 35px，放得下。 */
.pin-mark,
.tab-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  color: var(--muted);
  cursor: pointer;
  line-height: 1;
}

.pin-mark {
  /* `⌖` 字形在 em 框里偏小：10px 时视觉上只有 8px 左右，放大后才与关闭按钮相称 */
  font-size: 14px;
}

.pin-mark:hover {
  color: var(--text);
  background: var(--tn-c-bg-soft, transparent);
}

.pin-mark:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.tab-close {
  font-size: 15px;
}

.tab-close:hover {
  background: var(--hover);
  color: var(--text);
}

.tab-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  padding: 0 4px;
  background: var(--tabs-bg);
}

.tab-actions :deep(.ui-tooltip-host) {
  flex: none;
}

.tab-actions button {
  width: 25px;
  height: 25px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.tab-actions button:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--muted);
  font-size: 11px;
}

.editor-group-body {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}

.tab-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}

.tab-content > * {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.editor-empty strong {
  color: var(--text);
  font-size: 14px;
}

.editor-empty button {
  margin-top: 8px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--raised);
  color: var(--text);
  padding: 0 10px;
  cursor: pointer;
}

.empty-mark {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  margin-bottom: 5px;
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--accent);
  font-size: 21px;
  font-weight: 750;
}

.tab-drag-surface,
.tab-drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
}

.tab-drop-overlay {
  pointer-events: none;
}

.tab-drop-preview {
  position: absolute;
  inset: 0;
  border: 1px solid color-mix(in srgb, var(--text) 12%, transparent);
  background: color-mix(in srgb, var(--text) 10%, transparent);
}

.tab-drop-preview.left {
  right: 50%;
}

.tab-drop-preview.right {
  left: 50%;
}

.tab-drop-preview.top {
  bottom: 50%;
}

.tab-drop-preview.bottom {
  top: 50%;
}
</style>
