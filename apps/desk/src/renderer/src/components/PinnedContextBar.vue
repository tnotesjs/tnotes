<script setup lang="ts">
/**
 * 固定选区上下文的状态条（全局一条，切到别的标签也看得见）。
 *
 * 只显示三件事：来源笔记、选区摘要、「查看 / 解除」。
 * 失效时不显示旧正文，只给原因与「解除」——**恢复实时模式必须由用户显式触发**。
 */
import { computed } from 'vue'

import { findTab } from '../editor-groups/layoutModel'
import { useEditorStore } from '../stores/editor'
import { pinnedContext, pinnedSummary } from '../context/pinnedContextStore'

const editor = useEditorStore()

const context = computed(() => pinnedContext.value)
const visible = computed(() => Boolean(context.value && context.value.state !== 'none'))
const invalidated = computed(() => context.value?.state === 'invalidated')
const summary = computed(() => pinnedSummary(context.value))
const sourceLabel = computed(() => {
  const note = context.value?.note
  const kb = context.value?.knowledgeBase
  if (!note) return '来源未知'
  return kb ? `${note.title} · ${kb.name}` : note.title
})

/** 「查看」：切到来源分组 / 标签，并让它把固定时的范围重新选出来 */
function reveal(): void {
  const current = context.value
  if (!current?.owner || !current.anchor || current.state !== 'pinned') return
  const { tabId, knowledgeBaseId } = current.owner
  if (editor.activeKnowledgeBaseId !== knowledgeBaseId) {
    editor.switchKnowledgeBase(knowledgeBaseId)
  }
  // 标签可能被拖到别的分组：以布局里的当前位置为准
  const located = findTab(editor.layout, tabId)
  const groupId = located?.group.id ?? current.owner.groupId
  editor.activate(groupId, tabId)
  editor.requestReveal(groupId, tabId, current.anchor)
}

/** 「解除」：显式回到实时选区模式（自动失效**不会**悄悄回退） */
function dismiss(): void {
  void window.desk.context
    .clearPin({
      reason: invalidated.value ? '用户确认固定上下文已失效' : '用户解除了固定上下文'
    })
    .catch(() => undefined)
}
</script>

<template>
  <div
    v-if="visible"
    class="pinned-context-bar"
    :class="{ 'is-invalidated': invalidated }"
    data-testid="pinned-context-bar"
    role="status"
  >
    <span class="pinned-context-title">
      {{ invalidated ? '固定上下文已失效' : '已固定 Agent 上下文' }}
    </span>
    <span class="pinned-context-source" :title="context?.note?.absolutePath ?? ''">
      {{ sourceLabel }}
    </span>
    <span v-if="invalidated" class="pinned-context-reason" data-testid="pinned-context-reason">
      {{ context?.reason }}
    </span>
    <span v-else class="pinned-context-summary" data-testid="pinned-context-summary">
      {{ summary }}
    </span>
    <span class="pinned-context-spacer" />
    <button v-if="!invalidated" type="button" data-testid="pinned-context-reveal" @click="reveal">
      查看
    </button>
    <button type="button" data-testid="pinned-context-clear" @click="dismiss">解除</button>
  </div>
</template>

<style scoped>
.pinned-context-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--accent-soft, var(--hover)) 60%, transparent);
  color: var(--text);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
}

.pinned-context-bar.is-invalidated {
  background: var(--warning-soft);
  color: var(--warning);
}

.pinned-context-title {
  flex: none;
  font-weight: 600;
}

.pinned-context-source,
.pinned-context-summary,
.pinned-context-reason {
  overflow: hidden;
  text-overflow: ellipsis;
}

.pinned-context-source {
  flex: none;
  max-width: 32%;
  color: var(--muted);
}

.pinned-context-summary {
  flex: 0 1 auto;
  min-width: 0;
  color: var(--muted);
}

.pinned-context-reason {
  flex: 0 1 auto;
  min-width: 0;
}

.pinned-context-spacer {
  flex: 1 1 auto;
}

.pinned-context-bar button {
  flex: none;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--raised);
  color: var(--text);
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}

.pinned-context-bar button:hover {
  background: var(--hover);
}
</style>
