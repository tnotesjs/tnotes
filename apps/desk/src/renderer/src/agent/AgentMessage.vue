<script setup lang="ts">
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { computed, ref, watch } from 'vue'

import AgentIcon from './AgentIcon.vue'
import { useAgentStore } from './agentStore'
import { attachmentUrl } from './attachmentCache'
import { writeClipboardText } from '../clipboardText'
import type { AgentContextRef, AgentMessagePart, AgentStoredMessage, AgentToolRow } from '../../../shared/contracts'

const props = defineProps<{
  message?: AgentStoredMessage
  streaming?: string
  reasoning?: string
  parts?: AgentMessagePart[]
}>()

const agent = useAgentStore()
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const imageUrls = ref<Record<string, string>>({})
const zoomed = ref('')
const copied = ref<'' | 'ok' | 'failed'>('')
const copyLabel = computed(() => (copied.value === 'ok' ? '已复制' : copied.value === 'failed' ? '复制失败' : '复制'))

const TOOL_ICONS: Record<string, string> = {
  list_notes: 'list',
  search_notes: 'search',
  read_note: 'file',
  edit_note: 'pencil',
  create_note: 'filePlus'
}

function render(text: string): string {
  return DOMPurify.sanitize(markdown.render(text || ''))
}

function mergeReads(parts: AgentMessagePart[]): AgentMessagePart[] {
  const merged: AgentMessagePart[] = []
  for (const part of parts) {
    const previous = merged[merged.length - 1]
    const tool = part.tool
    if (
      part.type === 'tool' &&
      tool?.name === 'read_note' &&
      !tool.running &&
      previous?.type === 'tool' &&
      previous.tool?.name === 'read_note' &&
      previous.tool.noteUuid &&
      previous.tool.noteUuid === tool.noteUuid
    ) {
      previous.tool = {
        ...previous.tool,
        ok: previous.tool.ok && tool.ok,
        summary: tool.summary,
        detail: `${previous.tool.detail}\n\n${tool.detail}`
      }
      continue
    }
    merged.push(part.type === 'tool' && tool ? { ...part, tool: { ...tool } } : { ...part })
  }
  return merged
}

const shown = computed(() => {
  if (props.parts?.length) return mergeReads(props.parts)
  if (!props.message) return []
  if (props.message.parts?.length) return mergeReads(props.message.parts)
  const fallback: AgentMessagePart[] = []
  if (props.message.content) fallback.push({ type: 'text', text: props.message.content })
  for (const tool of props.message.tools ?? []) fallback.push({ type: 'tool', tool })
  return fallback
})

const copyText = computed(() => {
  const fromParts = shown.value
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n')
  return fromParts || props.message?.content || props.streaming || ''
})

const statusLabel = computed(() => {
  if (props.message?.status === 'stopped') return '已停止'
  if (props.message?.status === 'truncated') return '回复被截断，可以说「继续」'
  if (props.message?.status === 'error') return '出错了'
  return ''
})

const thoughtLabel = computed(() => {
  const ms = props.message?.thoughtMs
  return ms ? `已思考 ${Math.max(1, Math.round(ms / 1000))} 秒` : '思考过程'
})

const liveThinking = computed(() => Boolean(props.reasoning) && !shown.value.some((part) => part.type === 'text' && part.text))

const refs = computed<AgentContextRef[]>(() => props.message?.refs ?? [])
const legacyContext = computed(() => (refs.value.length ? [] : (props.message?.context ?? [])))

watch(
  () => props.message?.images,
  (images) => {
    if (!images?.length) return
    for (const image of images) {
      if (imageUrls.value[image.id]) continue
      void attachmentUrl(image.id).then((url) => {
        if (url) imageUrls.value = { ...imageUrls.value, [image.id]: url }
      })
    }
  },
  { immediate: true }
)

const OPENABLE = new Set(['read_note', 'edit_note', 'create_note'])

function canOpen(tool: AgentToolRow): boolean {
  return Boolean(tool.noteUuid && tool.ok && !tool.running && OPENABLE.has(tool.name))
}

function openTool(tool: AgentToolRow): void {
  if (canOpen(tool)) agent.revealTool(tool)
}

async function copy(): Promise<void> {
  if (!copyText.value) return
  copied.value = (await writeClipboardText(copyText.value)) ? 'ok' : 'failed'
  setTimeout(() => (copied.value = ''), 1500)
}
</script>

<template>
  <article v-if="message" :class="message.role">
    <div v-if="refs.length || legacyContext.length" class="refs">
      <button v-for="(item, index) in refs" :key="index" type="button" class="ref" @click="agent.revealRef(item)">
        <AgentIcon name="file" />
        <span>{{ item.label }}</span>
      </button>
      <span v-for="label in legacyContext" :key="label" class="ref static">{{ label }}</span>
    </div>
    <div v-if="message.images?.length" class="images">
      <button
        v-for="image in message.images"
        :key="image.id"
        type="button"
        class="image"
        :style="{ aspectRatio: `${image.width} / ${image.height}` }"
        @click="zoomed = imageUrls[image.id] ?? ''"
      >
        <img v-if="imageUrls[image.id]" :src="imageUrls[image.id]" alt="消息里的图片" />
      </button>
    </div>
    <details v-if="message.reasoning" class="thinking">
      <summary><AgentIcon name="brain" /> {{ thoughtLabel }}</summary>
      <p>{{ message.reasoning }}</p>
    </details>
    <template v-for="(part, index) in shown" :key="index">
      <div v-if="part.type === 'text'" class="body" v-html="render(part.text || '')" />
      <details v-else-if="part.tool" class="tool" :class="{ failed: !part.tool.ok }">
        <summary>
          <AgentIcon :name="TOOL_ICONS[part.tool.name] ?? 'file'" />
          <button v-if="canOpen(part.tool)" type="button" class="link" @click.stop="openTool(part.tool)">
            {{ part.tool.ok ? '' : '失败 · ' }}{{ part.tool.summary }}
          </button>
          <span v-else>{{ part.tool.ok ? '' : '失败 · ' }}{{ part.tool.summary }}</span>
          <template v-if="part.tool.added !== undefined">
            <span class="added">+{{ part.tool.added }}</span>
            <span class="removed">−{{ part.tool.removed ?? 0 }}</span>
          </template>
        </summary>
        <pre v-if="part.tool.detail">{{ part.tool.detail }}</pre>
      </details>
    </template>
    <p v-if="statusLabel" class="status">{{ statusLabel }}</p>
    <button
      v-if="message.role === 'assistant' && copyText"
      type="button"
      class="copy"
      :class="{ shown: copied }"
      :aria-label="copyLabel"
      :data-tooltip="copyLabel"
      @click="copy"
    >
      <AgentIcon name="copy" />
      <span v-if="copied" class="copy-state">{{ copyLabel }}</span>
    </button>
    <div v-if="zoomed" class="zoom" role="dialog" aria-label="查看图片" @click="zoomed = ''">
      <img :src="zoomed" alt="放大的图片" />
    </div>
  </article>
  <article v-else class="assistant live">
    <details v-if="reasoning" class="thinking" :open="liveThinking">
      <summary>
        <AgentIcon :name="liveThinking ? 'spinner' : 'brain'" />
        {{ liveThinking ? '思考中…' : '已思考' }}
      </summary>
      <p>{{ reasoning }}</p>
    </details>
    <template v-for="(part, index) in shown" :key="index">
      <div v-if="part.type === 'text'" class="body" v-html="render(part.text || '')" />
      <details v-else-if="part.tool" class="tool" :class="{ failed: !part.tool.ok }">
        <summary>
          <AgentIcon :name="part.tool.running ? 'spinner' : (TOOL_ICONS[part.tool.name] ?? 'file')" />
          <span>{{ part.tool.ok ? '' : '失败 · ' }}{{ part.tool.summary }}</span>
          <template v-if="part.tool.added !== undefined">
            <span class="added">+{{ part.tool.added }}</span>
            <span class="removed">−{{ part.tool.removed ?? 0 }}</span>
          </template>
        </summary>
        <pre v-if="part.tool.detail">{{ part.tool.detail }}</pre>
      </details>
    </template>
    <div v-if="!reasoning && !shown.length" class="body waiting"><AgentIcon name="spinner" /> 正在思考…</div>
  </article>
</template>

<style scoped>
article {
  position: relative;
  border-radius: 8px;
  padding: 8px 10px;
  line-height: 1.5;
  font-size: 13px;
  /* 整个应用默认不能选中文字；对话内容要能选中、⌘C 复制 */
  user-select: text;
  -webkit-user-select: text;
  cursor: auto;
}

article button {
  user-select: none;
  -webkit-user-select: none;
}

article.user {
  align-self: flex-end;
  max-width: 92%;
  background: color-mix(in srgb, var(--accent, #3b82f6) 14%, var(--panel));
}

article.assistant {
  padding-left: 2px;
  padding-right: 2px;
}

.refs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}

.ref {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  padding: 0 5px;
  font-size: 11px;
  cursor: pointer;
  max-width: 100%;
}

.ref span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ref.static {
  cursor: default;
}

.images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.image {
  width: 96px;
  max-height: 96px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0;
  overflow: hidden;
  background: var(--raised, transparent);
  cursor: zoom-in;
}

.image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.zoom {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 70%);
  cursor: zoom-out;
}

.zoom img {
  max-width: 90vw;
  max-height: 90vh;
  border-radius: 6px;
}

.thinking,
.tool {
  margin: 2px 0 6px;
  font-size: 12px;
  color: var(--muted, #8b919a);
}

.thinking summary,
.tool summary {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  list-style: none;
}

.thinking summary::-webkit-details-marker,
.tool summary::-webkit-details-marker {
  display: none;
}

.thinking p {
  margin: 4px 0 0 18px;
  white-space: pre-wrap;
}

.tool.failed {
  color: #e03131;
}

.tool pre {
  margin: 4px 0 0 18px;
  white-space: pre-wrap;
  max-height: 160px;
  overflow: auto;
}

.added {
  color: #2f9e44;
}

.removed {
  color: #e03131;
}

.body :deep(pre) {
  overflow: auto;
  padding: 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--editor-bg, #111) 80%, transparent);
}

.body :deep(p) {
  margin: 0 0 0.4em;
}

.body :deep(p:last-child) {
  margin-bottom: 0;
}

.waiting {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}

.status {
  margin: 4px 0 0;
  color: var(--muted, #8b919a);
  font-size: 12px;
}

.link,
.copy {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
  font: inherit;
}

.link {
  text-align: left;
}

.link:hover {
  text-decoration: underline;
}

.copy {
  margin-top: 4px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 22px;
  height: 22px;
  padding: 0 4px;
  border-radius: 5px;
  color: var(--muted);
  font-size: 13px;
  visibility: hidden;
}

.copy-state {
  font-size: 12px;
}

article:hover .copy,
.copy.shown,
.copy:focus-visible {
  visibility: visible;
}

.copy:hover {
  background: var(--hover);
}
</style>
