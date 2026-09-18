<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { useCommandTaskStore } from '../stores/commandTask'
import { useTerminalStore } from '../stores/terminal'

import type { CommandTaskDto } from '../../../shared/contracts'

const props = defineProps<{ task: CommandTaskDto }>()

const store = useCommandTaskStore()
const terminal = useTerminalStore()
const logHost = ref<HTMLElement | null>(null)
/** 用户往上翻看历史时不要再自动滚到底 */
const pinnedToBottom = ref(true)

const lines = computed(() => store.logsFor(props.task.id))
const dropped = computed(() => store.droppedFor(props.task.id))
const running = computed(() => store.isActiveStatus(props.task.status))
const elapsed = ref(0)
let ticker: ReturnType<typeof setInterval> | null = null

function updateElapsed(): void {
  const end = props.task.finishedAt ?? Date.now()
  elapsed.value = Math.max(0, end - props.task.startedAt)
}

/** 计时器：没有新输出时也要让「运行状态 + 耗时」动起来。 */
watch(
  () => [props.task.id, props.task.status, props.task.finishedAt] as const,
  () => {
    updateElapsed()
    if (ticker) clearInterval(ticker)
    ticker = null
    if (running.value) ticker = setInterval(updateElapsed, 500)
  },
  { immediate: true }
)

function onScroll(): void {
  const element = logHost.value
  if (!element) return
  pinnedToBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 24
}

watch(
  () => lines.value.length,
  () => {
    if (!pinnedToBottom.value) return
    void nextTick(() => {
      const element = logHost.value
      if (element) element.scrollTop = element.scrollHeight
    })
  }
)

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

const statusTone = computed(() => {
  switch (props.task.status) {
    case 'done':
      return 'ok'
    case 'timeout':
    case 'canceled':
      return 'warn'
    case 'failed':
      return 'error'
    default:
      return 'busy'
  }
})

/**
 * 在命令的工作目录里开一个独立 Shell。
 * **不重跑失败命令** —— 只把用户放到同一个目录，由他自己决定做什么。
 */
async function openTerminalHere(): Promise<void> {
  await terminal.createSession(props.task.knowledgeBaseId, props.task.cwd)
}
</script>

<template>
  <div class="command-task">
    <header class="command-task-meta">
      <div class="command-task-line">
        <span class="command-task-chip">{{ task.knowledgeBaseName }}</span>
        <span class="command-task-stage" :data-tone="statusTone">{{ task.stageLabel }}</span>
        <span v-if="running" class="command-task-elapsed"
          >已运行 {{ formatDuration(elapsed) }}</span
        >
        <span v-else class="command-task-elapsed">
          耗时 {{ formatDuration((task.finishedAt ?? task.startedAt) - task.startedAt) }}
        </span>
        <span class="command-task-run">第 {{ task.run }} 次运行</span>
      </div>
      <div class="command-task-line">
        <code class="command-task-cwd" :title="task.cwd">{{ task.cwd }}</code>
      </div>
      <div v-if="task.command" class="command-task-line">
        <code class="command-task-command">{{ task.command }}</code>
      </div>
      <p v-if="task.error" class="command-task-error" :data-tone="statusTone">
        {{ task.error }}
      </p>
    </header>

    <div ref="logHost" class="command-task-log" @scroll="onScroll">
      <p v-if="dropped > 0" class="command-task-truncated">
        输出过多，已丢弃最早的 {{ Math.round(dropped / 1024) }}KB（保留最近部分）
      </p>
      <p v-if="lines.length === 0" class="command-task-empty">
        {{ running ? '正在执行，等待输出…' : '这次运行没有产生输出' }}
      </p>
      <pre
        v-for="(line, index) in lines"
        :key="index"
        class="command-task-row"
        :data-stream="line.stream"
        >{{ line.text }}</pre>
    </div>

    <footer class="command-task-actions">
      <span class="command-task-times">
        开始 {{ formatTime(task.startedAt) }}
        <template v-if="task.finishedAt"> · 结束 {{ formatTime(task.finishedAt) }}</template>
      </span>
      <span class="command-task-spacer" />
      <button type="button" @click="openTerminalHere">在此目录打开终端</button>
      <button v-if="running" type="button" class="danger" @click="store.cancel(task.id)">
        停止任务
      </button>
      <button
        v-else
        type="button"
        :disabled="Boolean(store.retrying[task.id])"
        @click="store.retry(task.id)"
      >
        重试
      </button>
      <button type="button" @click="store.closeTask(task.id)">关闭标签</button>
    </footer>
  </div>
</template>

<style scoped>
.command-task {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.command-task-meta {
  flex: none;
  padding: 6px 10px 4px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
}

.command-task-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.command-task-chip {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--tn-c-bg-soft);
  color: var(--text);
}

.command-task-stage[data-tone='busy'] {
  color: var(--accent);
}

.command-task-stage[data-tone='ok'] {
  color: var(--success, #98c379);
}

.command-task-stage[data-tone='warn'] {
  color: var(--warning, #e5c07b);
}

.command-task-stage[data-tone='error'] {
  color: var(--danger, #e06c75);
}

.command-task-elapsed,
.command-task-run {
  color: var(--muted);
}

.command-task-cwd,
.command-task-command {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  color: var(--muted);
}

.command-task-command {
  color: var(--text);
}

.command-task-error {
  margin: 4px 0 0;
  padding: 4px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--danger, #e06c75) 14%, transparent);
  color: var(--text);
  white-space: pre-wrap;
}

.command-task-log {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
}

.command-task-row {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.command-task-row[data-stream='stderr'] {
  color: var(--danger, #e06c75);
}

.command-task-truncated {
  margin: 0 0 4px;
  color: var(--warning, #e5c07b);
}

.command-task-empty {
  margin: 0;
  color: var(--muted);
}

.command-task-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-top: 1px solid var(--border);
  font-size: 11px;
}

.command-task-times {
  color: var(--muted);
}

.command-task-spacer {
  flex: 1;
}

.command-task-actions button {
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}

.command-task-actions button:hover:not(:disabled) {
  color: var(--text);
  background: var(--tn-c-bg-soft);
}

.command-task-actions button.danger {
  color: var(--danger, #e06c75);
}

.command-task-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
