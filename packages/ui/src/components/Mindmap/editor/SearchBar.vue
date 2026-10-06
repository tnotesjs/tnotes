<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { replaceInlineRange } from '@tnotesjs/mindmap-core'
import type {
  InlineFormat,
  MindmapNode,
  MindmapSession,
  RichInlineEditorElement
} from '@tnotesjs/mindmap-core'
import AppIcon from './AppIcon.vue'
import RichInlineEditor from './RichInlineEditor.vue'

const props = defineProps<{
  session: MindmapSession
  visible: boolean
  version: number
  onJump: (id: string) => void
}>()

const emit = defineEmits<{ close: [] }>()
const query = ref('')
const replacement = ref('')
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement>()
const replaceInputRef = ref<HTMLInputElement>()
const replaceNotice = ref('')
const EMPTY_MATCHES: MindmapNode[] = []
const hasQuery = computed(() => query.value.trim().length > 0)

const matches = computed<MindmapNode[]>(() => {
  if (props.version < 0 || !hasQuery.value) return EMPTY_MATCHES
  return props.session.search(query.value)
})

watch(query, () => {
  activeIndex.value = 0
  replaceNotice.value = ''
})

watch(matches, () => {
  activeIndex.value = Math.min(activeIndex.value, Math.max(0, matches.value.length - 1))
  props.session.setMatchHighlight(new Set(matches.value.map((node) => node.id)))
})

watch(
  () => props.visible,
  (visible) => {
    if (visible) nextTick(() => inputRef.value?.focus())
    else {
      query.value = ''
      replacement.value = ''
      replaceNotice.value = ''
      props.session.setMatchHighlight(new Set())
    }
  }
)

function pathFor(node: MindmapNode): string {
  const path: string[] = []
  let current = node.parent
  while (current) {
    path.unshift(current.content.text)
    current = current.parent
  }
  return path.join(' / ')
}

function commitResult(node: MindmapNode, payload: { raw: string; text: string }) {
  if (node.content.image) props.session.updateNodeDisplayText(node.id, payload.text)
  else if (payload.raw !== node.content.raw) props.session.updateNodeRaw(node.id, payload.raw)
}

function inlineFormatShortcut(event: KeyboardEvent, hasSelection = true): InlineFormat | null {
  const key = event.key.toLowerCase()
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null
  if (key === 'b' && !event.shiftKey) return 'bold'
  if (key === 'i' && !event.shiftKey) return 'italic'
  if (key === 'u' && !event.shiftKey) return 'underline'
  if (key === 'enter' && !event.shiftKey && hasSelection) return 'strike'
  if ((key === 's' || key === 'x') && event.shiftKey) return 'strike'
  if (key === 'h' && event.shiftKey) return 'highlight'
  if (key === 'e' && !event.shiftKey) return 'code'
  return null
}

function onResultKeydown(node: MindmapNode, event: KeyboardEvent) {
  event.stopPropagation()
  const editor = event.currentTarget as RichInlineEditorElement
  if (event.isComposing || editor.isComposing) return
  const mod = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  if (mod && key === '\\' && !node.content.image && editor.value.length > 0) {
    event.preventDefault()
    const caretStart = editor.selectionStart
    const caretEnd = editor.selectionEnd
    const collapsed = caretStart === caretEnd
    const start = collapsed ? 0 : caretStart
    const end = collapsed ? editor.value.length : caretEnd
    commitResult(node, { raw: editor.rawValue, text: editor.value })
    editor.markCommitted()
    props.session.clearNodeInlineFormats(node.id, start, end)
    nextTick(() => {
      editor.focus()
      editor.setSelectionRange(caretStart, collapsed ? caretStart : caretEnd)
    })
    return
  }
  const format = node.content.image
    ? null
    : inlineFormatShortcut(event, editor.selectionStart !== editor.selectionEnd)
  if (format && editor.value.length > 0) {
    event.preventDefault()
    const caretStart = editor.selectionStart
    const caretEnd = editor.selectionEnd
    const collapsed = caretStart === caretEnd
    const start = collapsed ? 0 : caretStart
    const end = collapsed ? editor.value.length : caretEnd
    commitResult(node, { raw: editor.rawValue, text: editor.value })
    editor.markCommitted()
    props.session.toggleNodeInlineFormat(node.id, start, end, format)
    nextTick(() => {
      editor.focus()
      editor.setSelectionRange(caretStart, collapsed ? caretStart : caretEnd)
    })
    return
  }
  if (mod && event.shiftKey && key === 'l' && node !== props.session.document.root) {
    event.preventDefault()
    commitResult(node, { raw: editor.rawValue, text: editor.value })
    editor.markCommitted()
    props.session.toggleTask(node.id)
  } else if (mod && key === 'f') {
    event.preventDefault()
    inputRef.value?.focus()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    editor.blur()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    editor.blur()
    emit('close')
  }
}

function jump(index: number) {
  const list = matches.value
  if (list.length === 0) return
  activeIndex.value = (index + list.length) % list.length
  props.onJump(list[activeIndex.value].id)
}

function matchingRanges(text: string, needle: string): Array<{ start: number; end: number }> {
  const normalizedNeedle = needle.trim().toLocaleLowerCase()
  if (!normalizedNeedle) return []
  const normalizedText = text.toLocaleLowerCase()
  const ranges: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset <= normalizedText.length - normalizedNeedle.length) {
    const start = normalizedText.indexOf(normalizedNeedle, offset)
    if (start < 0) break
    ranges.push({ start, end: start + normalizedNeedle.length })
    offset = start + Math.max(1, normalizedNeedle.length)
  }
  return ranges
}

function replacedNodeValue(
  node: MindmapNode,
  replaceEveryMatch: boolean
): { raw: string; text: string; count: number } {
  const ranges = matchingRanges(node.content.text, query.value)
  const selectedRanges = replaceEveryMatch ? ranges : ranges.slice(0, 1)
  if (selectedRanges.length === 0) {
    return { raw: node.content.raw, text: node.content.text, count: 0 }
  }
  if (node.content.image) {
    let text = node.content.text
    for (const range of [...selectedRanges].reverse()) {
      text = text.slice(0, range.start) + replacement.value + text.slice(range.end)
    }
    return { raw: node.content.raw, text, count: selectedRanges.length }
  }
  let raw = node.content.raw
  for (const range of [...selectedRanges].reverse()) {
    raw = replaceInlineRange(
      raw,
      range.start,
      range.end,
      replacement.value,
      undefined,
      props.session.inlineOptions
    )
  }
  return { raw, text: node.content.text, count: selectedRanges.length }
}

function replaceCurrent() {
  const node = matches.value[activeIndex.value]
  if (!node) return
  const next = replacedNodeValue(node, false)
  if (next.count === 0) return
  if (node.content.image) props.session.updateNodeDisplayText(node.id, next.text)
  else props.session.updateNodeRaw(node.id, next.raw)
  replaceNotice.value = '已替换 1 处'
  nextTick(() => {
    if (matches.value.length > 0) {
      activeIndex.value = Math.min(activeIndex.value, matches.value.length - 1)
      props.onJump(matches.value[activeIndex.value].id)
    }
  })
}

function replaceAll() {
  const operations = matches.value
    .map((node) => ({ id: node.id, image: !!node.content.image, ...replacedNodeValue(node, true) }))
    .filter((operation) => operation.count > 0)
  const count = operations.reduce((total, operation) => total + operation.count, 0)
  if (count === 0) return
  props.session.transact((doc) => {
    for (const operation of operations) {
      const node = doc.find(operation.id)
      if (!node) continue
      if (operation.image) doc.updateDisplayText(node, operation.text)
      else doc.updateRaw(node, operation.raw)
    }
  })
  replaceNotice.value = `已替换 ${count} 处`
  nextTick(() => replaceInputRef.value?.focus())
}

function onSearchKeydown(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === 'Enter') {
    event.preventDefault()
    jump(activeIndex.value + (event.shiftKey ? -1 : 1))
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

function onReplaceKeydown(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === 'Enter') {
    event.preventDefault()
    replaceCurrent()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

function reveal(node: MindmapNode) {
  props.session.expandAncestors(node.id)
  props.onJump(node.id)
}
</script>

<template>
  <aside
    v-if="visible"
    class="search-results-view"
    :class="{ 'has-query': hasQuery }"
    aria-label="搜索结果"
    @keydown.stop
  >
    <section class="search-panel">
      <header class="search-header">
        <div class="search-field" role="search">
          <AppIcon name="search" :size="18" />
          <input
            ref="inputRef"
            v-model="query"
            aria-label="查找"
            placeholder="查找当前文档中的主题"
            @keydown="onSearchKeydown"
          />
        </div>
        <button
          type="button"
          class="search-close"
          title="关闭搜索 (Esc)"
          aria-label="关闭搜索"
          @click="emit('close')"
        >
          <AppIcon name="close" :size="17" />
        </button>
      </header>

      <div class="replace-row">
        <span class="replace-label">替换为</span>
        <input
          ref="replaceInputRef"
          v-model="replacement"
          aria-label="替换为"
          placeholder="输入替换内容"
          @keydown="onReplaceKeydown"
        />
      </div>

      <div class="search-actions">
        <span class="search-count">{{
          hasQuery ? `${matches.length} 个结果` : '输入关键词开始搜索'
        }}</span>
        <span v-if="replaceNotice" class="replace-notice" role="status">{{ replaceNotice }}</span>
        <div class="search-nav">
          <button
            type="button"
            title="上一个 (Shift+Enter)"
            :disabled="matches.length === 0"
            @click="jump(activeIndex - 1)"
          >
            上一处
          </button>
          <button
            type="button"
            title="下一个 (Enter)"
            :disabled="matches.length === 0"
            @click="jump(activeIndex + 1)"
          >
            下一处
          </button>
          <span v-if="matches.length" class="search-position"
            >{{ activeIndex + 1 }} / {{ matches.length }}</span
          >
          <button
            type="button"
            class="replace-button"
            :disabled="matches.length === 0"
            @click="replaceCurrent"
          >
            替换
          </button>
          <button
            type="button"
            class="replace-button"
            :disabled="matches.length === 0"
            @click="replaceAll"
          >
            全部替换
          </button>
        </div>
      </div>
    </section>

    <div v-if="hasQuery" class="search-result-canvas">
      <div class="result-view-title">搜索结果</div>
      <div class="search-list">
        <div
          v-for="(node, index) in matches"
          :key="node.id"
          class="search-result"
          :class="{ active: index === activeIndex }"
          @click="activeIndex = index"
        >
          <span class="result-path">{{ pathFor(node) }}</span>
          <span class="result-editor-row">
            <button
              v-if="node.content.checked !== null"
              type="button"
              class="result-checkbox"
              :class="{ checked: node.content.checked }"
              :aria-label="node.content.checked ? '标记为未完成' : '标记为已完成'"
              @pointerdown.prevent
              @click.stop="session.toggleChecked(node.id)"
            >
              <svg v-if="node.content.checked" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m3.5 8 3 3 6-6" />
              </svg>
            </button>
            <RichInlineEditor
              class="result-editor"
              :class="{ done: node.content.checked === true }"
              :editor-id="`search-${node.id}`"
              :raw="node.content.image ? node.content.text : node.content.raw"
              :active="true"
              :done="node.content.checked === true"
              @click.stop
              @focus="activeIndex = index"
              @commit="commitResult(node, $event)"
              @keydown="onResultKeydown(node, $event)"
            />
            <button
              type="button"
              class="reveal-button"
              title="在当前视图定位"
              aria-label="在当前视图定位"
              @pointerdown.prevent
              @click.stop="reveal(node)"
            >
              ↗
            </button>
          </span>
        </div>
        <div v-if="matches.length === 0" class="search-empty">没有找到匹配主题</div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.search-results-view {
  position: absolute;
  inset: 0;
  z-index: 35;
  pointer-events: none;
}
.search-results-view.has-query {
  overflow: hidden;
  background: var(--mm-panel-bg);
  pointer-events: auto;
}
.search-panel {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  width: min(680px, calc(100% - 20px));
  overflow: hidden;
  border: 1px solid var(--mm-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--mm-panel-bg) 97%, transparent);
  box-shadow: 0 14px 40px rgb(0 0 0 / 0.2);
  pointer-events: auto;
}
.search-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--mm-border);
}
.search-field {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 11px;
  border: 1px solid var(--mm-border);
  border-radius: 8px;
  background: var(--mm-canvas-bg);
  color: var(--mm-text-dim);
}
.search-field:focus-within {
  border-color: var(--mm-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mm-accent) 16%, transparent);
}
.search-field input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--mm-text);
  font: inherit;
}
.search-close {
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--mm-text-dim);
  cursor: pointer;
}
.search-close:hover {
  background: var(--mm-hover);
  color: var(--mm-text);
}
.replace-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px 0;
}
.replace-label {
  width: 52px;
  flex: none;
  color: var(--mm-text-dim);
  font-size: 13px;
}
.replace-row input {
  min-width: 0;
  height: 36px;
  flex: 1;
  padding: 0 10px;
  border: 1px solid var(--mm-border);
  border-radius: 7px;
  outline: 0;
  background: var(--mm-canvas-bg);
  color: var(--mm-text);
  font: inherit;
}
.replace-row input:focus {
  border-color: var(--mm-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mm-accent) 16%, transparent);
}
.search-actions {
  display: flex;
  min-height: 50px;
  align-items: center;
  gap: 9px;
  padding: 7px 12px 10px;
  color: var(--mm-text-dim);
  font-size: 12px;
}
.search-count {
  white-space: nowrap;
}
.replace-notice {
  color: var(--mm-accent);
  white-space: nowrap;
}
.search-nav {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.search-nav button {
  min-height: 31px;
  padding: 0 10px;
  border: 1px solid var(--mm-border);
  border-radius: 6px;
  background: transparent;
  color: var(--mm-text);
  cursor: pointer;
  white-space: nowrap;
}
.search-nav button:hover:not(:disabled) {
  border-color: var(--mm-text-dim);
  background: var(--mm-hover);
}
.search-nav button:disabled {
  cursor: default;
  opacity: 0.38;
}
.search-nav .replace-button {
  background: var(--mm-text);
  color: var(--mm-panel-bg);
}
.search-position {
  min-width: 38px;
  text-align: center;
  white-space: nowrap;
}
.search-result-canvas {
  position: absolute;
  inset: 0;
  overflow: auto;
  padding: 162px 24px 48px;
}
.result-view-title {
  width: min(820px, 100%);
  margin: 0 auto 20px;
  color: var(--mm-text);
  font-size: 25px;
  font-weight: 650;
}
.search-list {
  width: min(820px, 100%);
  margin: 0 auto;
}
.search-result {
  display: block;
  width: 100%;
  margin-bottom: 8px;
  padding: 11px 13px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--mm-text);
  text-align: left;
  cursor: default;
}
.search-result:hover,
.search-result.active {
  border-color: var(--mm-border);
  background: var(--mm-hover);
}
.result-path {
  display: block;
  overflow: hidden;
  margin-bottom: 6px;
  color: var(--mm-text-dim);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.result-editor-row {
  display: flex;
  align-items: center;
  gap: 7px;
}
.result-editor {
  min-width: 0;
  flex: 1;
  height: 34px;
  padding: 0 4px;
  border: 0;
  border-bottom: 1px solid transparent;
  outline: 0;
  background: transparent;
  color: var(--mm-text);
  font: inherit;
  font-size: 16px;
}
.result-editor:focus {
  border-bottom-color: var(--mm-accent);
}
.result-editor.done {
  color: var(--mm-text-dim);
  text-decoration: line-through;
}
.result-checkbox {
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex: none;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1.5px solid var(--mm-text-dim);
  border-radius: 3px;
  background: transparent;
  color: white;
}
.result-checkbox.checked {
  border-color: var(--mm-accent);
  background: var(--mm-accent);
}
.result-checkbox svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.reveal-button {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--mm-text-dim);
  cursor: pointer;
}
.reveal-button:hover {
  background: var(--mm-panel-bg);
  color: var(--mm-accent);
}
.search-empty {
  padding: 34px 12px;
  color: var(--mm-text-dim);
  text-align: center;
}

@media (max-width: 700px) {
  .search-actions {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .search-nav {
    width: 100%;
    margin-left: 0;
    overflow-x: auto;
  }
  .search-result-canvas {
    padding-top: 202px;
  }
}
</style>
