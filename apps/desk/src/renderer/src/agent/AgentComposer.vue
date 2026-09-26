<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import AgentIcon from './AgentIcon.vue'
import { listNoteRefs, rankNotes } from './agentNoteQuery'
import { selectionLabelParts } from './agentLabels'
import { MAX_IMAGES, useAgentStore, type MentionItem } from './agentStore'
import { prepareImage } from './attachmentCache'
import { shouldSendOnEnter } from './composerKeys'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'

import type { AgentReasoningEffort } from '../../../shared/contracts'

const agent = useAgentStore()
const workspace = useWorkspaceStore()
const editor = useEditorStore()
const input = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const mentionStart = ref(-1)
const mentionQuery = ref('')
const activeIndex = ref(0)
const menu = ref<'mode' | 'model' | null>(null)
const dragging = ref(false)

const EFFORTS: Array<{ value: AgentReasoningEffort; label: string }> = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' }
]

interface Candidate extends MentionItem {
  path: string
  current: boolean
}

const currentKbId = computed(() => workspace.knowledgeBase?.id ?? '')

const candidates = computed<Candidate[]>(() => {
  const kb = workspace.knowledgeBase
  if (mentionStart.value < 0 || !kb) return []
  const tab = editor.activeTab
  const currentUuid = tab?.type === 'note' && tab.knowledgeBaseId === kb.id ? tab.noteUuid : ''
  const toCandidate = (note: { uuid: string; title: string; index: string; path: string }): Candidate => ({
    knowledgeBaseId: kb.id,
    knowledgeBaseName: kb.displayName,
    noteUuid: note.uuid,
    title: note.title,
    index: note.index,
    path: note.path,
    current: note.uuid === currentUuid
  })
  const notes = listNoteRefs(kb.toc)
  const ranked = rankNotes(notes, mentionQuery.value, 8)
  const current = notes.find((note) => note.uuid === currentUuid)
  const ordered =
    current && (!mentionQuery.value.trim() || ranked.includes(current))
      ? [current, ...ranked.filter((note) => note !== current)]
      : ranked
  return ordered.slice(0, 8).map(toCandidate)
})

watch(candidates, () => {
  activeIndex.value = 0
})

const modelGroups = computed(() => {
  const groups = new Map<string, { name: string; items: typeof agent.models }>()
  for (const item of agent.models) {
    const group = groups.get(item.provider.id) ?? { name: item.provider.name, items: [] }
    group.items.push(item)
    groups.set(item.provider.id, group)
  }
  return [...groups.values()]
})

const modelLabel = computed(() => agent.currentModel?.model.id ?? '未配置模型')
const effortLabel = computed(() => EFFORTS.find((item) => item.value === agent.reasoningEffort)?.label ?? '')
const canSend = computed(() => Boolean(agent.draft.trim()) || agent.images.length > 0)

function resize(): void {
  const element = input.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 220)}px`
}

watch(
  () => agent.draft,
  () => void nextTick(resize)
)

function detectMention(): void {
  const element = input.value
  if (!element) return
  const before = element.value.slice(0, element.selectionStart ?? element.value.length)
  const match = before.match(/@([^\s@]*)$/)
  if (!match) {
    mentionStart.value = -1
    mentionQuery.value = ''
    return
  }
  mentionStart.value = before.length - match[0].length
  mentionQuery.value = match[1]
}

function pick(candidate: Candidate | undefined): void {
  const element = input.value
  if (!candidate || !element || mentionStart.value < 0) return
  const caret = element.selectionStart ?? element.value.length
  const start = mentionStart.value
  agent.draft = `${agent.draft.slice(0, start)}${agent.draft.slice(caret)}`
  agent.addMention({
    knowledgeBaseId: candidate.knowledgeBaseId,
    knowledgeBaseName: candidate.knowledgeBaseName,
    noteUuid: candidate.noteUuid,
    title: candidate.title,
    index: candidate.index
  })
  mentionStart.value = -1
  mentionQuery.value = ''
  void nextTick(() => {
    element.focus()
    element.setSelectionRange(start, start)
  })
}

function openMention(): void {
  const element = input.value
  if (!element) return
  const caret = element.selectionStart ?? agent.draft.length
  const needsSpace = caret > 0 && !/\s/.test(agent.draft[caret - 1] ?? '')
  const insert = `${needsSpace ? ' ' : ''}@`
  agent.draft = `${agent.draft.slice(0, caret)}${insert}${agent.draft.slice(caret)}`
  void nextTick(() => {
    element.focus()
    element.setSelectionRange(caret + insert.length, caret + insert.length)
    detectMention()
  })
}

function onKeydown(event: KeyboardEvent): void {
  if (mentionStart.value >= 0 && candidates.value.length > 0) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      activeIndex.value = (activeIndex.value + step + candidates.value.length) % candidates.value.length
      return
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      pick(candidates.value[activeIndex.value])
      return
    }
  }
  if (event.key === 'Escape') {
    if (mentionStart.value >= 0) {
      event.preventDefault()
      mentionStart.value = -1
      return
    }
    if (agent.pending) {
      event.preventDefault()
      agent.stop()
      return
    }
  }
  if (!shouldSendOnEnter(event)) return
  event.preventDefault()
  if (!agent.pending) void agent.send(agent.draft)
}

async function addFiles(files: Iterable<File>): Promise<void> {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    if (agent.images.length >= MAX_IMAGES) {
      agent.error = `每条消息最多 ${MAX_IMAGES} 张图片`
      return
    }
    try {
      const prepared = await prepareImage(file)
      agent.addImage({ id: crypto.randomUUID(), ...prepared })
    } catch (cause) {
      agent.error = cause instanceof Error ? cause.message : String(cause)
    }
  }
}

function onPaste(event: ClipboardEvent): void {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'))
  if (files.length === 0) return
  event.preventDefault()
  void addFiles(files)
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/'))
  if (files.length === 0) return
  event.preventDefault()
  void addFiles(files)
}

function onDragOver(event: DragEvent): void {
  if (![...(event.dataTransfer?.items ?? [])].some((item) => item.type.startsWith('image/'))) return
  event.preventDefault()
  dragging.value = true
}

function onFileChange(event: Event): void {
  const target = event.target as HTMLInputElement
  void addFiles([...(target.files ?? [])])
  target.value = ''
}

function toggleMenu(name: 'mode' | 'model'): void {
  menu.value = menu.value === name ? null : name
}

function closeMenus(event: MouseEvent): void {
  if (!(event.target as HTMLElement | null)?.closest('.menu-anchor')) menu.value = null
}

document.addEventListener('mousedown', closeMenus)
onBeforeUnmount(() => document.removeEventListener('mousedown', closeMenus))

function mentionLabel(item: MentionItem): string {
  return item.knowledgeBaseId === currentKbId.value ? item.title : `${item.knowledgeBaseName} · ${item.title}`
}

function selectionTitle(text: string): string {
  return text.split('\n').slice(0, 6).join('\n')
}
</script>

<template>
  <form
    class="composer"
    :class="{ dragging }"
    @submit.prevent="!agent.pending && agent.send(agent.draft)"
    @dragover="onDragOver"
    @dragleave="dragging = false"
    @drop="onDrop"
  >
    <div class="box">
      <div class="context">
        <button type="button" class="pill add" aria-label="添加笔记" data-tooltip="添加笔记（@）" @click="openMention">
          <AgentIcon name="at" />
        </button>
        <span v-for="item in agent.mentions" :key="`${item.knowledgeBaseId}:${item.noteUuid}`" class="pill">
          <button type="button" class="pill-main" @click="agent.revealRef(item)">
            <AgentIcon name="file" />
            <span>{{ mentionLabel(item) }}</span>
          </button>
          <button type="button" class="pill-remove" aria-label="移除" @click="agent.removeMention(item)">
            <AgentIcon name="close" />
          </button>
        </span>
        <span v-for="item in agent.selections" :key="item.id" class="pill" :title="selectionTitle(item.text)">
          <button type="button" class="pill-main" @click="agent.revealRef(item)">
            <AgentIcon name="file" />
            <span>{{ selectionLabelParts(item, currentKbId).name }}</span>
            <em class="lines">{{ selectionLabelParts(item, currentKbId).lines }}</em>
          </button>
          <button type="button" class="pill-remove" aria-label="移除" @click="agent.removeSelection(item.id)">
            <AgentIcon name="close" />
          </button>
        </span>
        <span v-for="image in agent.images" :key="image.id" class="thumb">
          <img :src="image.url" alt="待发送的图片" />
          <button type="button" class="thumb-remove" aria-label="移除图片" @click="agent.removeImage(image.id)">
            <AgentIcon name="close" />
          </button>
        </span>
      </div>
      <div v-if="candidates.length" class="mentions" role="listbox" aria-label="选择笔记">
        <button
          v-for="(candidate, index) in candidates"
          :key="candidate.noteUuid"
          type="button"
          role="option"
          :aria-selected="index === activeIndex"
          :class="{ active: index === activeIndex }"
          @mousedown.prevent="pick(candidate)"
          @mouseenter="activeIndex = index"
        >
          <AgentIcon name="file" />
          <span class="index">{{ candidate.index }}</span>
          <span class="title">{{ candidate.title }}</span>
          <span v-if="candidate.current" class="tag">当前笔记</span>
          <span v-else class="path">{{ candidate.path }}</span>
        </button>
      </div>
      <textarea
        ref="input"
        v-model="agent.draft"
        rows="2"
        placeholder="让 Agent 修改笔记，@ 添加笔记"
        @input="detectMention"
        @click="detectMention"
        @keyup="(event) => (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && detectMention()"
        @keydown="onKeydown"
        @paste="onPaste"
        @blur="mentionStart = -1"
      />
      <div class="toolbar">
        <div class="left">
          <div class="menu-anchor">
            <button type="button" class="chip" :aria-expanded="menu === 'mode'" @click="toggleMenu('mode')">
              <AgentIcon :name="agent.mode === 'agent' ? 'infinity' : 'chat'" />
              <span>{{ agent.mode === 'agent' ? 'Agent' : 'Ask' }}</span>
              <AgentIcon name="chevron" />
            </button>
            <div v-if="menu === 'mode'" class="menu">
              <button type="button" :class="{ on: agent.mode === 'agent' }" @click="agent.mode = 'agent'; menu = null">
                <AgentIcon name="infinity" />
                <span class="menu-text"><strong>Agent</strong><small>可以读写笔记</small></span>
              </button>
              <button type="button" :class="{ on: agent.mode === 'ask' }" @click="agent.mode = 'ask'; menu = null">
                <AgentIcon name="chat" />
                <span class="menu-text"><strong>Ask</strong><small>只读，不会修改笔记</small></span>
              </button>
            </div>
          </div>
          <div class="menu-anchor">
            <button type="button" class="chip" :aria-expanded="menu === 'model'" @click="toggleMenu('model')">
              <span class="model-name">{{ modelLabel }}</span>
              <span v-if="agent.currentModel?.model.reasoning" class="effort">{{ effortLabel }}</span>
              <AgentIcon name="chevron" />
            </button>
            <div v-if="menu === 'model'" class="menu model-menu">
              <p v-if="modelGroups.length === 0" class="menu-empty">还没有模型。打开设置 → 内置 Agent 添加。</p>
              <template v-for="group in modelGroups" :key="group.name">
                <p class="menu-group">{{ group.name }}</p>
                <button
                  v-for="item in group.items"
                  :key="item.ref"
                  type="button"
                  :class="{ on: item.ref === agent.currentModelRef }"
                  @click="agent.setModel(item.ref); menu = null"
                >
                  <span class="menu-text">
                    <strong>{{ item.model.id }}</strong>
                    <small>{{ [item.model.vision ? '能看图' : '', item.model.reasoning ? '可调思考强度' : ''].filter(Boolean).join(' · ') }}</small>
                  </span>
                </button>
              </template>
              <div v-if="agent.currentModel?.model.reasoning" class="effort-row">
                <span>思考强度</span>
                <div class="segmented">
                  <button
                    v-for="item in EFFORTS"
                    :key="item.value"
                    type="button"
                    :class="{ on: agent.reasoningEffort === item.value }"
                    @click="agent.setEffort(item.value)"
                  >
                    {{ item.label }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="right">
          <button type="button" class="icon" aria-label="添加图片" data-tooltip="添加图片" @click="fileInput?.click()">
            <AgentIcon name="image" />
          </button>
          <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onFileChange" />
          <button
            v-if="agent.pending"
            type="button"
            class="send stop"
            aria-label="停止"
            data-tooltip="停止（Esc）"
            @click="agent.stop()"
          >
            <AgentIcon name="stop" />
          </button>
          <button v-else type="submit" class="send" aria-label="发送" data-tooltip="发送（Enter）" :disabled="!canSend">
            <AgentIcon name="send" />
          </button>
        </div>
      </div>
    </div>
  </form>
</template>

<style scoped>
.composer {
  padding: 8px 10px 10px;
}

.box {
  position: relative;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--editor-bg, var(--panel));
  display: flex;
  flex-direction: column;
}

.composer.dragging .box {
  border-color: var(--accent, #3b82f6);
}

.context {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px 0;
}

.pill {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text);
  background: var(--raised, transparent);
}

.pill.add {
  padding: 2px 5px;
  color: var(--muted);
  cursor: pointer;
}

.pill-main,
.pill-remove {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  font: inherit;
  min-width: 0;
}

.pill-main span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}

.pill-main .lines {
  flex: none;
  margin-left: -4px;
  font-style: normal;
  color: var(--muted);
}

.pill-remove {
  color: var(--muted);
  padding-left: 0;
}

.thumb {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-remove {
  position: absolute;
  top: 1px;
  right: 1px;
  border: 0;
  border-radius: 4px;
  padding: 1px;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 55%);
  color: white;
  font-size: 10px;
  cursor: pointer;
}

.mentions {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: calc(100% + 4px);
  z-index: 20;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
}

.mentions button {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  padding: 4px 6px;
  text-align: left;
  font-size: 12px;
  cursor: pointer;
}

.mentions button.active {
  background: var(--hover);
}

.mentions .index {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.mentions .title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mentions .path {
  margin-left: auto;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}

.mentions .tag {
  margin-left: auto;
  color: var(--accent, #3b82f6);
  font-size: 11px;
  flex: none;
}

textarea {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  padding: 8px 10px 4px;
  font: inherit;
  line-height: 1.5;
  max-height: 220px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px 6px;
}

.left,
.right {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.menu-anchor {
  position: relative;
  min-width: 0;
}

.chip,
.icon {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  padding: 3px 6px;
  font-size: 12px;
  cursor: pointer;
  min-width: 0;
}

.chip:hover,
.icon:hover,
.chip[aria-expanded='true'] {
  background: var(--hover);
  color: var(--text);
}

.model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 130px;
}

.effort {
  color: var(--muted);
  font-size: 11px;
}

.icon {
  font-size: 15px;
  padding: 4px;
}

.send {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: var(--accent, #3b82f6);
  color: white;
  font-size: 14px;
  cursor: pointer;
}

.send:disabled {
  opacity: 0.35;
  cursor: default;
}

.send.stop {
  background: var(--text);
  color: var(--panel);
}

.menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 30;
  min-width: 200px;
  max-height: 320px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
}

.menu > button {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  padding: 5px 8px;
  text-align: left;
  cursor: pointer;
}

.menu > button:hover,
.menu > button.on {
  background: var(--hover);
}

.menu-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.menu-text strong {
  font-size: 12px;
  font-weight: 600;
}

.menu-text small {
  color: var(--muted);
  font-size: 11px;
}

.menu-group {
  margin: 4px 8px 2px;
  color: var(--muted);
  font-size: 11px;
}

.menu-empty {
  margin: 6px 8px;
  color: var(--muted);
  font-size: 12px;
}

.effort-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  padding: 6px 8px 4px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}

.segmented {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.segmented button {
  border: 0;
  background: transparent;
  color: inherit;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.segmented button.on {
  background: color-mix(in srgb, var(--accent, #3b82f6) 22%, transparent);
}
</style>
