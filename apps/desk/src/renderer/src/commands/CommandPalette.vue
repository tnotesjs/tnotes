<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'

import type { DeskTocNode, SearchResultDto } from '../../../shared/contracts'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import { resultValue } from '../stores/workspace/helpers'
import { noteFileName } from './noteFileName'
import {
  createPaletteCommands,
  filterPaletteCommands,
  isCommandMode,
  type PaletteCommand
} from './paletteCommands'

const emit = defineEmits<{
  'update:open': [value: boolean]
  openSettings: []
  toggleTerminal: []
}>()

const open = defineModel<boolean>('open', { default: false })

const editor = useEditorStore()
const workspace = useWorkspaceStore()
const input = ref<HTMLInputElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const query = ref('')
const activeIndex = ref(0)
const searchResults = ref<SearchResultDto[]>([])
const searchLoading = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchSequence = 0

const commands = computed(() =>
  createPaletteCommands({
    saveDocument: () => workspace.saveCurrentDocument(),
    openSettings: () => emit('openSettings'),
    openKbSettings: () => {
      if (workspace.knowledgeBase) editor.openKbSettings(workspace.knowledgeBase)
    },
    openKbAssets: () => {
      if (workspace.knowledgeBase) editor.openKbAssets(workspace.knowledgeBase)
    },
    hasSelectedKnowledgeBase: () => Boolean(workspace.knowledgeBase),
    toggleTerminal: () => emit('toggleTerminal')
  })
)

const commandMode = computed(() => isCommandMode(query.value))
const filteredCommands = computed(() => filterPaletteCommands(commands.value, query.value))

function tocNoteByUuid(
  nodes: DeskTocNode[],
  uuid: string
): Extract<DeskTocNode, { type: 'note' }> | null {
  for (const node of nodes) {
    if (node.type === 'note' && node.uuid === uuid) return node
    const found = tocNoteByUuid(node.children, uuid)
    if (found) return found
  }
  return null
}

const recentNotes = computed(() => {
  const knowledgeBaseId = workspace.selectedKnowledgeBaseId
  if (!knowledgeBaseId) return []
  const toc = workspace.knowledgeBase?.id === knowledgeBaseId ? workspace.knowledgeBase.toc : []
  const seen = new Set<string>()
  const notes: { knowledgeBaseId: string; noteUuid: string; title: string; fileName: string }[] = []
  for (const group of editor.groups) {
    for (const tab of [...group.tabs].sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))) {
      if (tab.type !== 'note' || tab.knowledgeBaseId !== knowledgeBaseId) continue
      if (seen.has(tab.noteUuid)) continue
      seen.add(tab.noteUuid)
      const tocNote = tocNoteByUuid(toc, tab.noteUuid)
      notes.push({
        knowledgeBaseId: tab.knowledgeBaseId,
        noteUuid: tab.noteUuid,
        title: tab.title,
        fileName: tocNote
          ? noteFileName({
              noteIndex: tocNote.noteIndex,
              title: tocNote.title,
              dirName: tocNote.dirName
            })
          : tab.title
      })
    }
  }
  return notes.slice(0, 8)
})

const items = computed(() => {
  if (commandMode.value) return filteredCommands.value
  if (query.value.trim()) return searchResults.value
  return recentNotes.value
})

const placeholder = computed(() => {
  if (commandMode.value) return '输入命令'
  if (workspace.selectedKnowledgeBaseId) return '搜索当前知识库中的笔记'
  return '先选择一个知识库'
})

const idleLabel = computed(() => {
  const tab = editor.activeTab
  if (tab?.type === 'note') return tab.title
  if (tab?.type === 'kb-settings' || tab?.type === 'kb-assets') return tab.title
  if (tab?.type === 'web') return tab.title
  return '搜索笔记'
})

watch(open, (value) => {
  emit('update:open', value)
  if (value) {
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    void nextTick(() => input.value?.focus())
    return
  }
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
})

watch([query, commandMode], () => {
  activeIndex.value = 0
  if (!open.value || commandMode.value) {
    searchResults.value = []
    searchLoading.value = false
    return
  }
  scheduleSearch()
})

watch(
  () => items.value.length,
  (length) => {
    if (activeIndex.value >= length) activeIndex.value = Math.max(0, length - 1)
  }
)

watch(activeIndex, async () => {
  await nextTick()
  menu.value
    ?.querySelector<HTMLElement>('.command-palette__item.is-active')
    ?.scrollIntoView({ block: 'nearest' })
})

function scheduleSearch(): void {
  if (searchTimer) clearTimeout(searchTimer)
  const text = query.value.trim()
  const knowledgeBaseId = workspace.selectedKnowledgeBaseId
  if (!text || !knowledgeBaseId) {
    searchResults.value = []
    searchLoading.value = false
    return
  }
  searchLoading.value = true
  searchTimer = setTimeout(() => {
    searchTimer = null
    void runSearch(text, knowledgeBaseId)
  }, 140)
}

async function runSearch(text: string, knowledgeBaseId: string): Promise<void> {
  const sequence = (searchSequence += 1)
  try {
    const results = resultValue(
      await window.desk.search({ query: text, knowledgeBaseId, limit: 30 })
    )
    if (sequence === searchSequence) searchResults.value = results
  } catch (cause) {
    if (sequence === searchSequence) {
      workspace.error = cause instanceof Error ? cause.message : String(cause)
      searchResults.value = []
    }
  } finally {
    if (sequence === searchSequence) searchLoading.value = false
  }
}

async function focusInput(mode: 'search' | 'commands'): Promise<void> {
  open.value = true
  await nextTick()
  const field = input.value
  if (!field) return
  field.focus()
  if (mode === 'commands' && field.value.startsWith('>')) {
    field.setSelectionRange(1, field.value.length)
    return
  }
  field.select()
}

async function openSearch(): Promise<void> {
  query.value = isCommandMode(query.value) ? '' : query.value
  await focusInput('search')
}

async function openCommands(): Promise<void> {
  query.value = query.value.startsWith('>') ? query.value : '>'
  await focusInput('commands')
}

function close(): void {
  if (!open.value && !query.value) return
  open.value = false
  query.value = ''
  activeIndex.value = 0
  searchResults.value = []
  if (document.activeElement === input.value) input.value?.blur()
}

function onFocus(): void {
  open.value = true
}

function isInsidePalette(target: EventTarget | null): boolean {
  return (
    target instanceof Node && Boolean(input.value?.contains(target) || menu.value?.contains(target))
  )
}

function onBlur(event: FocusEvent): void {
  if (isInsidePalette(event.relatedTarget)) return
  close()
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value || isInsidePalette(event.target)) return
  close()
}

function move(delta: number): void {
  const count = items.value.length
  if (count === 0) return
  activeIndex.value = (activeIndex.value + delta + count) % count
}

async function confirm(): Promise<void> {
  const item = items.value[activeIndex.value]
  if (!item) return
  if (commandMode.value) {
    const command = item as PaletteCommand
    if (!command.enabled()) return
    close()
    await command.run()
    return
  }
  const note = 'noteUuid' in item ? item : null
  if (!note) return
  close()
  await workspace.openNoteByUuid(note.knowledgeBaseId, note.noteUuid)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    void confirm()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
})

defineExpose({ openSearch, openCommands, close })
</script>

<template>
  <div class="command-palette" :class="{ 'is-open': open }">
    <div class="command-palette__shell">
      <input
        ref="input"
        v-model="query"
        class="command-palette__input"
        :placeholder="open ? placeholder : idleLabel"
        spellcheck="false"
        autocomplete="off"
        :aria-expanded="open"
        aria-controls="desk-command-palette-list"
        role="combobox"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeydown"
      />
      <div
        v-if="open"
        id="desk-command-palette-list"
        ref="menu"
        class="command-palette__menu"
        role="listbox"
      >
        <template v-if="commandMode">
          <button
            v-for="(command, index) in filteredCommands"
            :key="command.id"
            type="button"
            class="command-palette__item"
            :class="{ 'is-active': index === activeIndex, 'is-disabled': !command.enabled() }"
            role="option"
            :aria-selected="index === activeIndex"
            @mousedown.prevent="activeIndex = index"
            @click="void confirm()"
          >
            <span>
              <small>{{ command.category }}</small>
              <strong>{{ command.title }}</strong>
            </span>
            <span class="command-palette__meta">
              <code>{{ command.hint }}</code>
              <kbd v-if="command.shortcut">{{ command.shortcut }}</kbd>
            </span>
          </button>
          <div v-if="filteredCommands.length === 0" class="command-palette__empty">
            没有匹配的命令
          </div>
        </template>
        <template v-else-if="query.trim()">
          <div v-if="searchLoading" class="command-palette__empty">正在搜索…</div>
          <button
            v-for="(result, index) in searchResults"
            :key="`${result.knowledgeBaseId}:${result.noteUuid}`"
            type="button"
            class="command-palette__item"
            :class="{ 'is-active': index === activeIndex }"
            role="option"
            :aria-selected="index === activeIndex"
            @mousedown.prevent="activeIndex = index"
            @click="void confirm()"
          >
            <span>
              <small>笔记</small>
              <strong>{{ noteFileName(result) }}</strong>
            </span>
            <em>{{ result.snippet }}</em>
          </button>
          <div v-if="!searchLoading && searchResults.length === 0" class="command-palette__empty">
            没有匹配标题或正文的笔记
          </div>
        </template>
        <template v-else>
          <button
            v-for="(note, index) in recentNotes"
            :key="`${note.knowledgeBaseId}:${note.noteUuid}`"
            type="button"
            class="command-palette__item"
            :class="{ 'is-active': index === activeIndex }"
            role="option"
            :aria-selected="index === activeIndex"
            @mousedown.prevent="activeIndex = index"
            @click="void confirm()"
          >
            <span>
              <small>最近打开</small>
              <strong>{{ note.fileName }}</strong>
            </span>
          </button>
          <div v-if="recentNotes.length === 0" class="command-palette__empty">
            输入关键字搜索当前知识库，或输入 &gt; 运行命令
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.command-palette {
  position: relative;
  width: min(520px, 100%);
}

.command-palette__shell {
  position: relative;
}

.command-palette__input {
  box-sizing: border-box;
  width: 100%;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--text);
  padding: 0 10px;
  font: 12px/26px var(--font-sans);
  outline: none;
}

.command-palette.is-open .command-palette__input,
.command-palette__input:focus {
  border-color: var(--accent);
}

.command-palette__menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  z-index: 1100;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: min(560px, 80vw);
  max-height: min(420px, 60vh);
  overflow: auto;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--border-strong) 70%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--titlebar-bg) 82%, transparent);
  box-shadow: 0 16px 40px rgb(0 0 0 / 28%);
  backdrop-filter: saturate(160%) blur(22px);
  -webkit-backdrop-filter: saturate(160%) blur(22px);
  transform: translateX(-50%);
}

.command-palette__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  margin: 0;
  padding: 7px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.command-palette__item.is-active {
  background: var(--selected);
}

.command-palette__item.is-disabled {
  color: var(--muted);
}

.command-palette__item > span {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.command-palette__item small,
.command-palette__item em {
  overflow: hidden;
  color: var(--muted);
  font-size: 10px;
  font-style: normal;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-palette__item strong {
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-palette__meta {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.command-palette__item code,
.command-palette__item kbd {
  color: var(--muted);
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 500;
}

.command-palette__item code {
  letter-spacing: 0.01em;
}

.command-palette__empty {
  padding: 14px 8px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}
</style>
