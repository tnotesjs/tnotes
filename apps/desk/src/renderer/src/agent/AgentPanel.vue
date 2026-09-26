<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'

import AgentChanges from './AgentChanges.vue'
import AgentComposer from './AgentComposer.vue'
import AgentIcon from './AgentIcon.vue'
import AgentMessage from './AgentMessage.vue'
import { useAgentStore } from './agentStore'
import { TAB_DRAG_MIME, useTabDragStore } from '../editor-groups/tabDrag'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'

import type { DeskTocNode } from '../../../shared/contracts'

const TOC_DRAG_MIME = 'application/x-tnotes-toc'

const agent = useAgentStore()
const editor = useEditorStore()
const workspace = useWorkspaceStore()
const tabDrag = useTabDragStore()
const scroller = ref<HTMLElement | null>(null)
const pinned = ref(true)
const noteDrop = ref(false)
const renamingId = ref<string | null>(null)
const renameWhere = ref<'header' | 'list' | null>(null)
const renameDraft = ref('')

function beginRename(id: string, title: string, where: 'header' | 'list'): void {
  renamingId.value = id
  renameWhere.value = where
  renameDraft.value = title
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.agent-dock .title-input')
    input?.focus()
    input?.select()
  })
}

function commitRename(): void {
  const id = renamingId.value
  if (!id) return
  const title = renameDraft.value
  renamingId.value = null
  renameWhere.value = null
  void agent.renameChat(id, title)
}

function cancelRename(): void {
  renamingId.value = null
  renameWhere.value = null
}

function isNoteDrag(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types ?? [])
  return types.includes(TOC_DRAG_MIME) || types.includes(TAB_DRAG_MIME)
}

function onDragOver(event: DragEvent): void {
  if (!isNoteDrag(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  noteDrop.value = true
}

function onDragLeave(event: DragEvent): void {
  const dock = event.currentTarget as HTMLElement
  if (event.relatedTarget instanceof Node && dock.contains(event.relatedTarget)) return
  noteDrop.value = false
}

/** 从目录树或笔记标签拖进来：点名那篇笔记。 */
function onDrop(event: DragEvent): void {
  if (!isNoteDrag(event)) return
  event.preventDefault()
  noteDrop.value = false
  const toc = event.dataTransfer?.getData(TOC_DRAG_MIME)
  if (toc) {
    try {
      const node = JSON.parse(toc) as DeskTocNode
      const kbId = workspace.knowledgeBase?.id
      if (node.type === 'note' && kbId) void agent.addNoteToChat(kbId, node.uuid)
    } catch {
      // 不是 TNotes 目录树发出的数据
    }
    return
  }
  const tabId = event.dataTransfer?.getData(TAB_DRAG_MIME)
  tabDrag.finish()
  const tab = editor.groups.flatMap((group) => group.tabs).find((item) => item.id === tabId)
  if (tab?.type === 'note') void agent.addNoteToChat(tab.knowledgeBaseId, tab.noteUuid)
}

onMounted(() => {
  agent.ensureListening()
  void agent.loadChats()
  void agent.refreshKey()
})

function onScroll(): void {
  const element = scroller.value
  if (!element) return
  pinned.value = element.scrollHeight - element.scrollTop - element.clientHeight < 40
}

watch(
  () => [agent.active?.messages.length, agent.streaming, agent.pending, agent.liveParts.length, agent.reasoning.length],
  async (next, previous) => {
    const sent = next[0] !== previous?.[0]
    if (!pinned.value && !sent) return
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
    pinned.value = true
  }
)

watch(
  () => agent.activeId,
  async () => {
    pinned.value = true
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  }
)

function focusInput(): void {
  document.querySelector<HTMLTextAreaElement>('.agent-dock textarea')?.focus()
}

defineExpose({ focusInput })
</script>

<template>
  <aside
    class="agent-dock"
    :class="{ 'note-drop': noteDrop }"
    aria-label="内置 Agent"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div v-if="noteDrop" class="drop-hint">松开，把这篇笔记加进对话</div>
    <header>
      <input
        v-if="agent.active && renamingId === agent.active.id && renameWhere === 'header'"
        v-model="renameDraft"
        class="title-input"
        maxlength="80"
        aria-label="对话标题"
        @keydown.enter.prevent="commitRename"
        @keydown.esc.stop.prevent="cancelRename"
        @blur="commitRename"
      />
      <strong
        v-else
        class="title"
        title="双击重命名"
        @dblclick="agent.active && beginRename(agent.active.id, agent.active.title, 'header')"
        >{{ agent.active?.title || '新对话' }}</strong
      >
      <div class="header-actions">
        <button type="button" aria-label="新对话" data-tooltip="新对话" @click="agent.startChat()">
          <AgentIcon name="plus" />
        </button>
        <button
          type="button"
          aria-label="历史对话"
          data-tooltip="历史对话"
          :class="{ on: agent.historyOpen }"
          @click="agent.historyOpen = !agent.historyOpen"
        >
          <AgentIcon name="history" />
        </button>
      </div>
    </header>
    <div v-if="agent.historyOpen" class="history">
      <p v-if="agent.chats.length === 0">还没有对话</p>
      <div
        v-for="chat in agent.chats"
        :key="chat.id"
        class="history-row"
        :class="{ selected: chat.id === agent.activeId }"
      >
        <input
          v-if="renamingId === chat.id && renameWhere === 'list'"
          v-model="renameDraft"
          class="title-input"
          maxlength="80"
          aria-label="对话标题"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.stop.prevent="cancelRename"
          @blur="commitRename"
        />
        <button v-else type="button" class="history-title" @click="agent.selectChat(chat.id)">
          {{ chat.title }}
        </button>
        <small v-if="chat.knowledgeBaseName && renamingId !== chat.id" class="chat-kb">{{ chat.knowledgeBaseName }}</small>
        <button
          v-if="renamingId !== chat.id"
          type="button"
          class="row-icon"
          aria-label="重命名"
          data-tooltip="重命名"
          data-tooltip-placement="top"
          @click.stop="beginRename(chat.id, chat.title, 'list')"
        >
          <AgentIcon name="pencil" />
        </button>
        <button
          v-if="renamingId !== chat.id"
          type="button"
          class="row-icon remove"
          aria-label="删除对话"
          @click.stop="agent.removeChat(chat.id)"
        >
          <AgentIcon name="close" />
        </button>
      </div>
    </div>
    <div ref="scroller" class="log" @scroll="onScroll">
      <p v-if="!agent.active || agent.active.messages.length === 0" class="empty">
        <template v-if="!agent.keyReady">还没有填写 API Key。打开设置 → 内置 Agent。</template>
        <template v-else>用 @ 点名笔记，⌘L 把选中的文字加进来。改动会直接保存并标在正文里，你可以保留或撤销。</template>
      </p>
      <AgentMessage v-for="(message, index) in agent.active?.messages ?? []" :key="index" :message="message" />
      <AgentMessage
        v-if="agent.pending"
        :streaming="agent.streaming"
        :reasoning="agent.reasoning"
        :parts="agent.liveParts"
      />
      <p v-if="agent.error" class="error">{{ agent.error }}</p>
    </div>
    <AgentChanges />
    <AgentComposer />
  </aside>
</template>

<style scoped>
.agent-dock {
  position: relative;
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-left: 1px solid var(--border);
}

.agent-dock.note-drop {
  outline: 2px dashed var(--accent, #3b82f6);
  outline-offset: -4px;
}

.drop-hint {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  pointer-events: none;
  background: color-mix(in srgb, var(--panel) 80%, transparent);
  color: var(--accent, #3b82f6);
  font-size: 13px;
}

.chat-kb {
  margin-left: auto;
  flex: none;
  color: var(--muted);
  font-size: 11px;
}

header,
.header-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

header {
  padding: 6px 8px 6px 12px;
  border-bottom: 1px solid var(--border);
}

.title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.title-input {
  min-width: 0;
  flex: 1;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--accent, #3b82f6);
  border-radius: 4px;
  background: var(--panel, #fff);
  color: inherit;
  font: inherit;
  font-size: 12px;
}

header .title-input {
  height: 24px;
  font-size: 13px;
  font-weight: 600;
}

button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.header-actions button {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: var(--muted);
  font-size: 15px;
}

.header-actions button:hover,
.header-actions button.on {
  background: var(--hover);
  color: var(--text);
}

.history {
  max-height: 200px;
  overflow: auto;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 4px;
}

.history p {
  margin: 6px 8px;
  color: var(--muted);
  font-size: 12px;
}

.history-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 0;
  border-radius: 5px;
  font-size: 12px;
}

.history-row.selected,
.history-row:hover {
  background: var(--hover);
}

.history-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  padding: 3px 8px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-icon {
  display: none;
  place-items: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--muted);
}

.history-row:hover .row-icon,
.history-row:focus-within .row-icon {
  display: grid;
}

.row-icon:hover {
  background: var(--hover);
  color: var(--text);
}

.log {
  flex: 1;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.empty,
.error {
  margin: 0;
  color: var(--muted, #8b919a);
  font-size: 13px;
}

.error {
  color: #e06c75;
}
</style>
