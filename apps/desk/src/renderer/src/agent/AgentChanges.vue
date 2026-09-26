<script setup lang="ts">
import { computed, ref } from 'vue'

import AgentIcon from './AgentIcon.vue'
import { useAgentStore } from './agentStore'
import { useWorkspaceStore } from '../stores/workspace'

const agent = useAgentStore()
const workspace = useWorkspaceStore()
const expanded = ref(false)
const busy = ref(false)

const total = computed(() =>
  agent.pendingNotes.reduce((sum, item) => ({ added: sum.added + item.added, removed: sum.removed + item.removed }), {
    added: 0,
    removed: 0
  })
)

async function run(task: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await task()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="agent.pendingNotes.length || agent.staleNotes.length" class="changes" aria-label="Agent 改动">
    <div v-if="agent.pendingNotes.length" class="summary">
      <button type="button" class="toggle" :aria-expanded="expanded" @click="expanded = !expanded">
        <AgentIcon :name="expanded ? 'chevron' : 'chevronRight'" />
        <span>{{ agent.pendingNotes.length }} 个文件</span>
        <span class="added">+{{ total.added }}</span>
        <span class="removed">−{{ total.removed }}</span>
      </button>
      <button type="button" class="action" :disabled="busy" @click="run(() => agent.reject())">全部撤销</button>
      <button type="button" class="action primary" :disabled="busy" @click="run(() => agent.accept())">全部保留</button>
    </div>
    <ul v-if="expanded && agent.pendingNotes.length" class="files">
      <li v-for="item in agent.pendingNotes" :key="`${item.knowledgeBaseId}:${item.uuid}`">
        <button type="button" class="file" @click="agent.revealPending({ knowledgeBaseId: item.knowledgeBaseId, uuid: item.uuid })">
          <AgentIcon name="file" />
          <span v-if="item.knowledgeBaseId !== workspace.knowledgeBase?.id" class="kb">{{ item.knowledgeBaseName }}</span>
          <span class="name">{{ item.index ? `${item.index} ` : '' }}{{ item.title }}</span>
          <span class="added">+{{ item.added }}</span>
          <span class="removed">−{{ item.removed }}</span>
        </button>
        <span class="row-actions">
          <button
            type="button"
            :disabled="busy"
            @click="run(() => agent.reject({ knowledgeBaseId: item.knowledgeBaseId, uuid: item.uuid }))"
          >
            撤销
          </button>
          <button
            type="button"
            :disabled="busy"
            @click="run(() => agent.accept({ knowledgeBaseId: item.knowledgeBaseId, uuid: item.uuid }))"
          >
            保留
          </button>
        </span>
      </li>
    </ul>
    <p v-for="item in agent.staleNotes" :key="`stale-${item.knowledgeBaseId}:${item.uuid}`" class="stale">
      「{{ item.title }}」这篇笔记的 Agent 标记已失效
      <button type="button" @click="agent.dismissStale(item.knowledgeBaseId, item.uuid)">知道了</button>
    </p>
  </section>
</template>

<style scoped>
.changes {
  margin: 0 10px;
  border: 1px solid var(--border);
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
  background: var(--panel);
  font-size: 12px;
}

.summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
}

.toggle {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 2px 0;
  text-align: left;
  font: inherit;
}

.added {
  color: #2f9e44;
}

.removed {
  color: #e03131;
}

.action,
.row-actions button,
.stale button {
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  padding: 2px 6px;
  font: inherit;
  cursor: pointer;
}

.action:hover,
.row-actions button:hover,
.stale button:hover {
  background: var(--hover);
  color: var(--text);
}

.action.primary {
  background: var(--hover);
  color: var(--text);
}

.files {
  list-style: none;
  margin: 0;
  padding: 0 4px 4px;
  max-height: 180px;
  overflow: auto;
  border-top: 1px solid var(--border);
}

.files li {
  display: flex;
  align-items: center;
  border-radius: 5px;
}

.files li:hover {
  background: var(--hover);
}

.file {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 4px 6px;
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.kb {
  color: var(--muted);
  flex: none;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-actions {
  display: flex;
  gap: 2px;
  visibility: hidden;
  padding-right: 4px;
}

.files li:hover .row-actions,
.files li:focus-within .row-actions {
  visibility: visible;
}

.stale {
  margin: 0;
  padding: 4px 8px;
  color: var(--muted);
  border-top: 1px solid var(--border);
}
</style>
