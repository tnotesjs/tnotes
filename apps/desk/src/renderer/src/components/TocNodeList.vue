<script setup lang="ts">
import { computed, inject, nextTick, provide, ref, watch } from 'vue'

import { useAgentStore } from '../agent/agentStore'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import { resultValue } from '../stores/workspace/helpers'
import { batchCheckState, batchTargetIds, type BatchCheckState } from './batchDeleteSelection'
import { TOC_DRAG_TYPE } from '../../../shared/tocDrag'
import NoteDoneToggle from './NoteDoneToggle.vue'
import type { ContextMenuAction, EditorTab, DeskTocNode } from '../../../shared/contracts'
import type { InjectionKey, Ref } from 'vue'

defineOptions({ name: 'TocNodeList' })

const props = withDefaults(
  defineProps<{
    nodes: DeskTocNode[]
    selectedNoteUuid: string | null
    depth?: number
    focusRequestId?: number
    batchDeleting?: boolean
    batchSelected?: ReadonlySet<string>
    /** 置顶分组里的行不参与目录拖拽排序。 */
    allowReorder?: boolean
    /** 指针正停在置顶组上，用来标出整组可放下。 */
    pinDropActive?: boolean
  }>(),
  { allowReorder: true }
)

const emit = defineEmits<{
  select: [node: Extract<DeskTocNode, { type: 'note' }>]
  selectPermanent: [node: Extract<DeskTocNode, { type: 'note' }>]
  selectSplit: [node: Extract<DeskTocNode, { type: 'note' }>]
  toggleDone: [node: Extract<DeskTocNode, { type: 'note' }>]
  requestCreate: [node: DeskTocNode, placement: 'before' | 'after' | 'inside']
  requestRename: [node: DeskTocNode]
  requestReindex: [node: Extract<DeskTocNode, { type: 'note' }>]
  requestDelete: [node: DeskTocNode]
  toggleBatchNote: [noteUuid: string]
  toggleBatchGroup: [node: Extract<DeskTocNode, { type: 'group' }>]
  move: [source: DeskTocNode, target: DeskTocNode, placement: 'before' | 'after' | 'inside']
  dragNote: [node: DeskTocNode | null]
}>()

const collapsedKey: InjectionKey<Ref<Set<string>>> = Symbol.for('tnotes-desk-toc-collapsed')
const inheritedCollapsed = inject(collapsedKey, null)
const collapsed = inheritedCollapsed ?? ref(new Set<string>())
if (!inheritedCollapsed) provide(collapsedKey, collapsed)
const listHost = ref<HTMLElement | null>(null)
const focusedNoteUuid = ref<string | null>(null)
const dropTarget = ref<{ nodeId: string; placement: 'before' | 'after' | 'inside' } | null>(null)
const draggingNodeId = ref<string | null>(null)
let expandTimer: ReturnType<typeof setTimeout> | null = null

const store = useWorkspaceStore()
const editor = useEditorStore()
const agent = useAgentStore()

function agentPending(noteUuid: string): boolean {
  const kb = store.knowledgeBase
  return Boolean(kb && agent.pendingNoteKeys.has(`${kb.id}:${noteUuid}`))
}
const tocShowIndex = computed(() => store.settings?.toc?.showNoteIndex !== false)
const tocShowStatus = computed(() => store.settings?.toc?.showNoteStatus !== false)

/**
 * 找出某篇笔记已打开的标签页**及其所在分组**。
 *
 * 带上分组是因为「显示本笔记资源」这类命令光改标签页状态不够 —— 标签页可能在另一个
 * 分组里、或不是该分组当前的活跃标签，得先切过去才看得见效果。
 */
function findNoteTabLocation(
  knowledgeBaseId: string,
  noteUuid: string
): { groupId: string; tab: EditorTab } | null {
  for (const group of editor.groups) {
    const tab = group.tabs.find(
      (item) =>
        item.type === 'note' &&
        item.knowledgeBaseId === knowledgeBaseId &&
        item.noteUuid === noteUuid
    )
    if (tab) return { groupId: group.id, tab }
  }
  return null
}

function findNoteTab(knowledgeBaseId: string, noteUuid: string): EditorTab | null {
  return findNoteTabLocation(knowledgeBaseId, noteUuid)?.tab ?? null
}

function parentPathToNote(
  nodes: DeskTocNode[],
  noteUuid: string,
  parents: string[] = []
): string[] | null {
  for (const node of nodes) {
    if (node.type === 'note' && node.uuid === noteUuid) return parents
    const match = parentPathToNote(node.children, noteUuid, [...parents, node.nodeId])
    if (match) return match
  }
  return null
}

watch(
  () => props.focusRequestId,
  async (requestId) => {
    if (inheritedCollapsed || !requestId || !props.selectedNoteUuid) return
    const parents = parentPathToNote(props.nodes, props.selectedNoteUuid)
    if (!parents) return
    const next = new Set(collapsed.value)
    for (const nodeId of parents) next.delete(nodeId)
    collapsed.value = next
    focusedNoteUuid.value = props.selectedNoteUuid
    await nextTick()
    requestAnimationFrame(() => {
      const row = [...(listHost.value?.querySelectorAll<HTMLElement>('.toc-row') ?? [])].find(
        (candidate) => candidate.dataset.noteUuid === props.selectedNoteUuid
      )
      row?.scrollIntoView?.({ block: 'nearest' })
      window.setTimeout(() => {
        if (focusedNoteUuid.value === props.selectedNoteUuid) focusedNoteUuid.value = null
      }, 900)
    })
  }
)

function toggle(nodeId: string): void {
  const next = new Set(collapsed.value)
  if (next.has(nodeId)) next.delete(nodeId)
  else next.add(nodeId)
  collapsed.value = next
}

const EMPTY_BATCH: ReadonlySet<string> = new Set()

function batchSelection(): ReadonlySet<string> {
  return props.batchSelected ?? EMPTY_BATCH
}

function rowCheckState(node: DeskTocNode): BatchCheckState {
  return batchCheckState(batchTargetIds(node), batchSelection())
}

function onBatchToggle(node: DeskTocNode): void {
  if (node.type === 'note') emit('toggleBatchNote', node.uuid)
  else emit('toggleBatchGroup', node)
}

function onGroupLabelClick(node: Extract<DeskTocNode, { type: 'group' }>): void {
  if (props.batchDeleting) {
    emit('toggleBatchGroup', node)
    return
  }
  toggle(node.nodeId)
}

function onNoteClick(node: Extract<DeskTocNode, { type: 'note' }>): void {
  if (props.batchDeleting) {
    emit('toggleBatchNote', node.uuid)
    return
  }
  emit('select', node)
}

function onNoteDoubleClick(node: Extract<DeskTocNode, { type: 'note' }>): void {
  if (props.batchDeleting) return
  emit('selectPermanent', node)
}

function onDoneToggle(node: Extract<DeskTocNode, { type: 'note' }>): void {
  if (props.batchDeleting) {
    emit('toggleBatchNote', node.uuid)
    return
  }
  emit('toggleDone', node)
}

function dragStart(event: DragEvent, node: DeskTocNode): void {
  if (props.batchDeleting || !props.allowReorder) {
    event.preventDefault()
    return
  }
  if (!event.dataTransfer) return
  const target = event.target as HTMLElement
  if (target.closest('.row-action')) {
    event.preventDefault()
    return
  }
  draggingNodeId.value = node.nodeId
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData(TOC_DRAG_TYPE, JSON.stringify(node))
  event.dataTransfer.setData('text/plain', node.title)
  emit('dragNote', node)
  const ghost = document.createElement('div')
  ghost.className = 'toc-drag-ghost'
  ghost.textContent = node.type === 'note' ? `${node.noteIndex}  ${node.title}` : node.title
  document.body.append(ghost)
  event.dataTransfer.setDragImage(ghost, 18, 16)
  requestAnimationFrame(() => ghost.remove())
}

function dragPlacement(event: DragEvent): 'before' | 'after' | 'inside' {
  const row = event.currentTarget as HTMLElement
  const ratio = (event.clientY - row.getBoundingClientRect().top) / row.offsetHeight
  if (ratio < 0.28) return 'before'
  if (ratio > 0.72) return 'after'
  return 'inside'
}

let dragScrollQueued = false

function queueDragScroll(event: DragEvent): void {
  if (dragScrollQueued) return
  const scroller = (event.currentTarget as HTMLElement).closest<HTMLElement>('.navigator-body')
  if (!scroller) return
  const bounds = scroller.getBoundingClientRect()
  const delta = event.clientY < bounds.top + 44 ? -12 : event.clientY > bounds.bottom - 44 ? 12 : 0
  if (!delta) return
  dragScrollQueued = true
  const top = scroller.scrollTop + delta
  requestAnimationFrame(() => {
    dragScrollQueued = false
    scroller.scrollTop = top
  })
}

function dragOver(event: DragEvent, node: DeskTocNode): void {
  if (!event.dataTransfer?.types.includes(TOC_DRAG_TYPE)) return
  // 置顶区的放下由外层处理。这里如果继续改滚动位置，拖到顶部时会同步重入 dragover，把界面卡死。
  if ((event.currentTarget as HTMLElement).closest('[data-pin-group="notes"]')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  const placement = dragPlacement(event)
  if (dropTarget.value?.nodeId !== node.nodeId || dropTarget.value.placement !== placement) {
    dropTarget.value = { nodeId: node.nodeId, placement }
  }
  if (expandTimer) clearTimeout(expandTimer)
  expandTimer = null
  if (placement === 'inside' && node.children.length && collapsed.value.has(node.nodeId)) {
    expandTimer = setTimeout(() => toggle(node.nodeId), 520)
  }
  queueDragScroll(event)
}

function dragLeave(event: DragEvent, node: DeskTocNode): void {
  const row = event.currentTarget as HTMLElement
  if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return
  if (dropTarget.value?.nodeId === node.nodeId) dropTarget.value = null
  if (expandTimer) clearTimeout(expandTimer)
  expandTimer = null
}

function containsNode(node: DeskTocNode, nodeId: string): boolean {
  return node.children.some((child) => child.nodeId === nodeId || containsNode(child, nodeId))
}

function dragEnd(): void {
  draggingNodeId.value = null
  dropTarget.value = null
  if (expandTimer) clearTimeout(expandTimer)
  expandTimer = null
  emit('dragNote', null)
}

function drop(event: DragEvent, target: DeskTocNode): void {
  event.preventDefault()
  const raw = event.dataTransfer?.getData(TOC_DRAG_TYPE)
  const placement = dropTarget.value?.placement ?? dragPlacement(event)
  dropTarget.value = null
  if (!raw) return
  try {
    const source = JSON.parse(raw) as DeskTocNode
    if (source.nodeId !== target.nodeId && !containsNode(source, target.nodeId)) {
      emit('move', source, target, placement)
    }
  } catch {
    // Ignore drags originating outside the TNotes tree.
  } finally {
    dragEnd()
  }
}

async function showNodeContextMenu(event: MouseEvent, node: DeskTocNode): Promise<void> {
  event.stopPropagation()
  if (props.batchDeleting) return
  const knowledgeBaseId = store.selectedKnowledgeBaseId
  if (!knowledgeBaseId) return
  try {
    const action = resultValue(
      await window.desk.app.showContextMenu(
        node.type === 'note'
            ? {
              kind: 'note',
              pinned: Boolean(findNoteTab(knowledgeBaseId, node.uuid)?.pinned),
              tocPinned: Boolean(
                store.settings?.pinnedNoteUuids?.[knowledgeBaseId]?.includes(node.uuid)
              ),
              completed: node.completed
            }
          : { kind: 'group' }
      )
    )
    if (action && store.selectedKnowledgeBaseId === knowledgeBaseId) {
      await runNodeContextAction(action, node, knowledgeBaseId)
    }
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  }
}

async function runNodeContextAction(
  action: ContextMenuAction,
  node: DeskTocNode,
  knowledgeBaseId: string
): Promise<void> {
  if (action === 'rename') return emit('requestRename', node)
  if (action === 'reindex') {
    if (node.type === 'note') emit('requestReindex', node)
    return
  }
  if (action === 'add-before') return emit('requestCreate', node, 'before')
  if (action === 'add-after') return emit('requestCreate', node, 'after')
  // Keep deletion behind the existing preview/confirmation dialog.
  if (action === 'request-delete') return emit('requestDelete', node)
  if (node.type !== 'note') return
  if (action === 'add-to-agent') {
    await agent.addNoteToChat(knowledgeBaseId, node.uuid)
    return
  }
  if (action === 'open-split') return emit('selectSplit', node)
  if (action === 'toggle-done') return emit('toggleDone', node)
  const existingTab = findNoteTab(knowledgeBaseId, node.uuid)
  const target = { knowledgeBaseId, noteUuid: node.uuid }
  if (action === 'copy-path') {
    await store.copyNoteDirectoryPath(target)
    return
  }
  if (action === 'reveal-file') {
    await store.revealNoteInFileManager(target)
    return
  }
  if (action === 'show-history') {
    // 浏览历史不需要 flush：先取最新相关提交作为初始选中版本
    const list = await window.desk.history.list({
      knowledgeBaseId,
      noteIndex: node.noteIndex,
      limit: 1
    })
    if (!list.ok) {
      store.error = list.error.message
      return
    }
    const commit = list.value.commits[0]?.oid
    if (!commit) {
      store.error = `编号 ${node.noteIndex} 还没有历史提交`
      return
    }
    const descriptor = store.overview.allKnowledgeBases.find((item) => item.id === knowledgeBaseId)
    if (!descriptor) {
      store.error = '知识库已关闭，无法打开历史版本'
      return
    }
    editor.openNoteHistory(descriptor, {
      noteIndex: node.noteIndex,
      commit,
      noteUuid: node.uuid,
      title: `历史 · ${node.title}`
    })
    return
  }
  if (action === 'show-note-assets') {
    // 「显示本笔记资源」是命令不是切换：已经显示着就保持显示（toggle 是工具栏那个图标的行为）。
    // 笔记没开着就先按「永久打开」打开它 —— 命令不该建出一个随后被下一次单击顶掉的预览标签。
    const opened = findNoteTabLocation(knowledgeBaseId, node.uuid)
    if (opened) {
      // 已开着：可能藏在别的分组 / 不是活跃标签，先切过去，否则面板打开了也看不见
      editor.activate(opened.groupId, opened.tab.id)
      editor.setNoteAssetsVisible(opened.tab.id, true)
      return
    }
    const tabId = await store.selectNote(node, undefined, true)
    if (tabId) editor.setNoteAssetsVisible(tabId, true)
    return
  }
  if (action === 'toggle-toc-pin') {
    if (node.type === 'note') store.togglePinnedNote(knowledgeBaseId, node.uuid)
    return
  }
  if (action === 'open-ide') {
    const result = await window.desk.ide.openNote(knowledgeBaseId, node.uuid)
    if (!result.ok) store.error = result.error.message
    return
  }
  if (action !== 'toggle-pin') return
  if (existingTab) {
    editor.setPinned(existingTab.id, !existingTab.pinned)
    return
  }
  const openedTab = await store.selectNote(node, undefined, true)
  if (openedTab) editor.setPinned(openedTab, true)
}

function collectBranchIds(nodes: DeskTocNode[]): string[] {
  const ids: string[] = []
  for (const node of nodes) {
    if (node.children.length) {
      ids.push(node.nodeId)
      ids.push(...collectBranchIds(node.children))
    }
  }
  return ids
}

function toggleAllCollapsed(): void {
  const branchIds = collectBranchIds(props.nodes)
  const allCollapsed =
    branchIds.length > 0 && branchIds.every((nodeId) => collapsed.value.has(nodeId))
  collapsed.value = allCollapsed ? new Set<string>() : new Set(branchIds)
}

defineExpose({ toggleAllCollapsed })
</script>

<template>
  <ul ref="listHost" class="toc-nodes" :class="{ 'is-pin-drop': pinDropActive }">
    <li v-for="node in nodes" :key="node.nodeId">
      <div
        class="toc-row"
        :class="{
          active: !batchDeleting && node.type === 'note' && node.uuid === selectedNoteUuid,
          'batch-on': batchDeleting && rowCheckState(node) === 'all',
          focused: node.type === 'note' && node.uuid === focusedNoteUuid,
          dragging: draggingNodeId === node.nodeId,
          [`drop-${dropTarget?.placement}`]: dropTarget?.nodeId === node.nodeId
        }"
        :data-note-uuid="node.type === 'note' ? node.uuid : undefined"
        :style="{ '--depth': depth ?? 0 }"
        :draggable="batchDeleting || !allowReorder ? 'false' : 'true'"
        @dragstart.stop="dragStart($event, node)"
        @dragend.stop="dragEnd"
        @dragover.stop="dragOver($event, node)"
        @dragleave="dragLeave($event, node)"
        @drop.stop="drop($event, node)"
        @contextmenu.prevent="showNodeContextMenu($event, node)"
      >
        <button
          v-if="node.children.length"
          type="button"
          class="disclosure"
          :aria-label="collapsed.has(node.nodeId) ? '展开' : '折叠'"
          :data-tooltip="collapsed.has(node.nodeId) ? '展开' : '折叠'"
          @click="toggle(node.nodeId)"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path :d="collapsed.has(node.nodeId) ? 'M4 2.5 7.5 6 4 9.5' : 'M2.5 4 6 7.5 9.5 4'" />
          </svg>
        </button>
        <span v-else class="disclosure spacer" />

        <button
          v-if="batchDeleting"
          type="button"
          class="batch-check"
          :data-state="rowCheckState(node)"
          role="checkbox"
          :aria-checked="
            rowCheckState(node) === 'all' ? 'true' : rowCheckState(node) === 'some' ? 'mixed' : 'false'
          "
          :disabled="rowCheckState(node) === 'empty'"
          :aria-label="node.type === 'note' ? `选择 ${node.title}` : `选择「${node.title}」里的笔记`"
          @click.stop="onBatchToggle(node)"
        >
          <svg v-if="rowCheckState(node) === 'all'" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 6.2 5 8.5 9.5 3.5" />
          </svg>
          <svg v-else-if="rowCheckState(node) === 'some'" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 6h6" />
          </svg>
        </button>

        <template v-if="node.type === 'group'">
          <button type="button" class="node-label group" @click="onGroupLabelClick(node)">
            {{ node.title }}
          </button>
        </template>
        <template v-else>
          <NoteDoneToggle
            v-if="tocShowStatus"
            :done="node.completed"
            @toggle="onDoneToggle(node)"
          />
          <button
            type="button"
            class="node-label"
            @click="onNoteClick(node)"
            @dblclick.stop="onNoteDoubleClick(node)"
          >
            <span v-if="tocShowIndex" class="note-index">{{ node.noteIndex }}</span>
            <span class="note-title">{{ node.title }}</span>
            <span
              v-if="agentPending(node.uuid)"
              class="agent-pending-dot"
              title="有 Agent 改动待确认"
              aria-label="有 Agent 改动待确认"
            />
          </button>
        </template>

        <button
          v-if="!batchDeleting"
          type="button"
          class="row-action add-note-action"
          aria-label="添加子笔记"
          data-tooltip="添加子笔记"
          @click="emit('requestCreate', node, 'inside')"
        >
          +
        </button>
      </div>

      <TocNodeList
        v-if="node.children.length && !collapsed.has(node.nodeId)"
        :nodes="node.children"
        :selected-note-uuid="selectedNoteUuid"
        :focus-request-id="focusRequestId"
        :depth="(depth ?? 0) + 1"
        :batch-deleting="batchDeleting"
        :batch-selected="batchSelected"
        :allow-reorder="allowReorder"
        :pin-drop-active="pinDropActive"
        @select="emit('select', $event)"
        @select-permanent="emit('selectPermanent', $event)"
        @select-split="emit('selectSplit', $event)"
        @toggle-done="emit('toggleDone', $event)"
        @request-create="(child, placement) => emit('requestCreate', child, placement)"
        @request-rename="emit('requestRename', $event)"
        @request-reindex="emit('requestReindex', $event)"
        @request-delete="emit('requestDelete', $event)"
        @toggle-batch-note="emit('toggleBatchNote', $event)"
        @toggle-batch-group="emit('toggleBatchGroup', $event)"
        @move="(source, target, placement) => emit('move', source, target, placement)"
        @drag-note="emit('dragNote', $event)"
      />
    </li>
  </ul>
</template>

<style scoped>
.toc-nodes.is-pin-drop {
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.toc-nodes {
  margin: 0;
  padding: 0;
  list-style: none;
}

.toc-row {
  position: relative;
  min-height: 28px;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 5px 2px calc(5px + var(--depth) * 12px);
  border-radius: 5px;
  color: var(--text);
}

.toc-row:hover {
  background: var(--hover);
}

.toc-row.active {
  background: var(--selected);
  color: var(--accent-strong);
}

.toc-row.batch-on {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}

.batch-check {
  width: 14px;
  height: 14px;
  flex: none;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--muted);
  border-radius: 3px;
  background: transparent;
  color: white;
  cursor: pointer;
}

.batch-check[data-state='all'] {
  border-color: var(--danger);
  background: var(--danger);
}

.batch-check[data-state='some'] {
  border-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 55%, transparent);
}

.batch-check:disabled {
  opacity: 0.35;
  cursor: default;
}

.batch-check svg {
  width: 10px;
  height: 10px;
  overflow: visible;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.toc-row.focused {
  animation: toc-focus-pulse 0.9s ease-out;
}

@keyframes toc-focus-pulse {
  0%,
  45% {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 80%, transparent);
  }
  100% {
    box-shadow: inset 0 0 0 1px transparent;
  }
}

.toc-row.dragging {
  opacity: 0.38;
}

.toc-row.drop-before {
  box-shadow: none;
}

.toc-row.drop-after {
  box-shadow: none;
}

.toc-row.drop-before::before,
.toc-row.drop-after::after {
  content: '';
  position: absolute;
  z-index: 2;
  right: 4px;
  left: calc(18px + var(--depth) * 12px);
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  box-shadow: -3px 0 0 1px var(--accent);
}

.toc-row.drop-before::before {
  top: -1px;
}

.toc-row.drop-after::after {
  bottom: -1px;
}

.toc-row.drop-inside {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
  background: color-mix(in srgb, var(--selected) 86%, transparent);
}

.disclosure,
.row-action,
.node-label {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.disclosure {
  width: 18px;
  height: 20px;
  display: grid;
  place-items: center;
  padding: 0;
  flex: none;
  color: var(--muted);
}

.disclosure svg {
  width: 12px;
  height: 12px;
  overflow: visible;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.disclosure.spacer {
  display: inline-block;
}

.node-label {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 0;
  overflow: hidden;
  text-align: left;
  font-size: 12px;
}

.node-label > .note-title,
.node-label.group {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-pending-dot {
  flex: none;
  align-self: center;
  width: 6px;
  height: 6px;
  margin-left: auto;
  margin-right: 4px;
  border-radius: 50%;
  background: var(--accent, #3b82f6);
}

.node-label.group {
  font-weight: 650;
  color: var(--muted);
}

.note-index {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 9px;
}

.row-action {
  width: 20px;
  height: 20px;
  flex: none;
  display: none;
  border-radius: 4px;
  color: var(--muted);
}

.toc-row:hover > .row-action {
  display: block;
}

.row-action:hover {
  background: var(--selected);
  color: var(--accent);
}

:global(.toc-drag-ghost) {
  position: fixed;
  z-index: 9999;
  top: -100px;
  left: -100px;
  max-width: 260px;
  overflow: hidden;
  border: 1px solid var(--accent);
  border-radius: 7px;
  background: var(--raised);
  padding: 7px 12px;
  color: var(--text);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.3);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}
</style>
