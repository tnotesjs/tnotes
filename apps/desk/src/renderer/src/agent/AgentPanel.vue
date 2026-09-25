<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'

import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import { liveEditorFor } from '../livePreview/editorRegistry'
import { acceptAgentEdits, pendingAgentReviews, rejectAgentEdits } from '../livePreview/agentReview'
import { applyEditInView } from './applyEdit'
import { agentTurnPayload } from './turnPayload'

import type { AgentChatMessage } from '../../../shared/contracts'

const editor = useEditorStore()
const workspace = useWorkspaceStore()
const messages = ref<AgentChatMessage[]>([])
const draft = ref('')
const pending = ref(false)
const error = ref('')
const edits = ref(0)
const scroller = ref<HTMLElement | null>(null)
let offApply: (() => void) | null = null

function currentNote() {
  const tab = editor.activeTab
  if (tab?.type !== 'note') return null
  const session = workspace.getDocumentSession(tab.knowledgeBaseId, tab.noteUuid)
  const view = liveEditorFor(tab.knowledgeBaseId, tab.noteUuid)
  const content = view ? view.state.doc.toString() : (session?.document.content ?? '')
  const selection = view
    ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
    : ''
  return {
    title: session?.document.title ?? tab.title,
    path: session?.document.relPath ?? '',
    content,
    selection,
    view
  }
}

onMounted(() => {
  offApply = window.desk.agent.onApplyEdit((request) => {
    const note = currentNote()
    void applyEditInView(note?.view ?? null, request.oldString, request.newString).then((result) => {
      if (result.ok) edits.value += 1
      void window.desk.agent.applyResult({ id: request.id, ...result })
    })
  })
})

onUnmounted(() => {
  offApply?.()
  offApply = null
})

async function scrollDown(): Promise<void> {
  await nextTick()
  const node = scroller.value
  if (node) node.scrollTop = node.scrollHeight
}

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!text || pending.value) return
  error.value = ''
  draft.value = ''
  messages.value = [...messages.value, { role: 'user', content: text }]
  pending.value = true
  await scrollDown()
  const note = currentNote()
  try {
    const result = await window.desk.agent.turn(
      agentTurnPayload(
        messages.value,
        note
          ? { title: note.title, path: note.path, content: note.content, selection: note.selection }
          : null
      )
    )
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    edits.value = result.value.edits
    messages.value = [...messages.value, { role: 'assistant', content: result.value.reply }]
    await scrollDown()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    pending.value = false
  }
}

function stop(): void {
  void window.desk.agent.cancel()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send()
  }
}

function review(action: 'accept' | 'reject'): void {
  const note = currentNote()
  if (!note?.view) return
  if (action === 'accept') acceptAgentEdits(note.view)
  else rejectAgentEdits(note.view)
  edits.value = pendingAgentReviews(note.view)
}

function focusInput(): void {
  document.querySelector<HTMLTextAreaElement>('.agent-panel textarea')?.focus()
}

defineExpose({ focusInput })
</script>

<template>
  <aside class="agent-panel" aria-label="内置 Agent">
    <header>
      <strong>Agent</strong>
      <span>{{ edits > 0 ? `${edits} 处修改待确认` : '当前笔记' }}</span>
    </header>
    <div v-if="edits > 0" class="agent-review">
      <button type="button" class="is-primary" @click="review('accept')">接受</button>
      <button type="button" @click="review('reject')">撤销</button>
    </div>
    <div ref="scroller" class="agent-log">
      <p v-if="messages.length === 0" class="agent-empty">
        问当前笔记，或让它直接改。改动会标在正文里，你可以接受或撤销。
      </p>
      <article v-for="(message, index) in messages" :key="index" :class="message.role">
        {{ message.content }}
      </article>
      <p v-if="pending" class="agent-pending">正在思考…</p>
      <p v-if="error" class="agent-error">{{ error }}</p>
    </div>
    <form @submit.prevent="send">
      <textarea
        v-model="draft"
        rows="3"
        placeholder="让 Agent 修改这篇笔记"
        @keydown="onKeydown"
      />
      <div class="agent-actions">
        <button v-if="pending" type="button" @click="stop">停止</button>
        <button v-else type="submit" class="is-primary" :disabled="!draft.trim()">发送</button>
      </div>
    </form>
  </aside>
</template>

<style scoped>
.agent-panel {
  position: fixed;
  top: 46px;
  right: 12px;
  bottom: 12px;
  z-index: 40;
  width: 360px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
}

header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

header span {
  color: var(--muted, #8b919a);
  font-size: 12px;
}

.agent-review,
.agent-actions {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
}

.agent-log {
  flex: 1;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

article {
  white-space: pre-wrap;
  line-height: 1.5;
  border-radius: 8px;
  padding: 8px 10px;
}

article.user {
  align-self: flex-end;
  background: color-mix(in srgb, var(--accent, #3b82f6) 18%, var(--panel));
}

article.assistant {
  background: color-mix(in srgb, var(--editor-bg, #111) 55%, var(--panel));
}

.agent-empty,
.agent-pending,
.agent-error {
  margin: 0;
  color: var(--muted, #8b919a);
  font-size: 13px;
}

.agent-error {
  color: #e06c75;
}

form {
  border-top: 1px solid var(--border);
}

textarea {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 10px 12px;
  font: inherit;
}

button.is-primary {
  background: var(--accent, #3b82f6);
  color: white;
  border-color: transparent;
}
</style>
