<script setup lang="ts">
/**
 * 本机 MCP（选区上下文服务）设置。
 *
 * 首版只有一个**只读**工具 `get_current_selection`：外部 Agent 用它读取用户当前选中的笔记内容，
 * 不必让用户复制路径和正文。
 *
 * 开关 / 端口跟其它设置一样走草稿（`props.draft`），由设置面板统一保存；
 * 保存后主进程会立刻应用（`mcpManager.applySettings`），并把真实状态广播回来：
 * - 开关默认**关闭**；
 * - 端口固定，占用时**明确报错**，不会偷偷换端口（否则已经配好的客户端会失联）；
 * - 令牌只在本机展示与复制，主进程用系统凭据存储加密保存，不写日志。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import type { AppSettings, McpServerStatusDto } from '../../../../shared/contracts'

const props = defineProps<{ draft: AppSettings }>()
const emit = defineEmits<{ reset: [] }>()

const status = ref<McpServerStatusDto | null>(null)
const copied = ref('')
const loadFailed = ref(false)
let offChanged: (() => void) | null = null

async function refresh(): Promise<void> {
  const result = await window.desk.mcp.status()
  if (result.ok) status.value = result.value
  else loadFailed.value = true
}

onMounted(async () => {
  await refresh()
  offChanged = window.desk.mcp.onChanged((next) => {
    status.value = next
    loadFailed.value = false
  })
})

onUnmounted(() => {
  offChanged?.()
  offChanged = null
})

const endpoint = computed(() => status.value?.url ?? `http://127.0.0.1:${props.draft.mcp.port}/mcp`)

const stateLabel = computed(() => {
  if (loadFailed.value) return '状态读取失败'
  if (!props.draft.mcp.enabled) return '已关闭'
  if (status.value?.error) return '启动失败'
  return status.value?.running ? '运行中' : '未运行'
})

const stateDetail = computed(() => {
  if (loadFailed.value) return '无法从主进程读取 MCP 服务状态，请重启 Desk 后再试。'
  if (!props.draft.mcp.enabled) return '打开开关后，外部 Agent 才能通过下面的地址读取当前选区。'
  if (status.value?.error) return status.value.error
  if (!status.value?.running) return '开关已打开，但服务当前没有在监听。'
  const parts = [`已连接会话 ${status.value.sessions} 个`]
  if (status.value.lastCallAt) parts.push(`最近调用 ${status.value.lastCallAt}`)
  return parts.join(' · ')
})

/** 客户端接入配置：给支持 Streamable HTTP + 自定义请求头的客户端用 */
const configExample = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        'tnotes-desk': {
          type: 'streamable-http',
          url: endpoint.value,
          headers: { Authorization: `Bearer ${status.value?.token ?? '<令牌>'}` }
        }
      }
    },
    null,
    2
  )
)

async function copy(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = label
    window.setTimeout(() => {
      if (copied.value === label) copied.value = ''
    }, 1500)
  } catch {
    copied.value = ''
  }
}

async function rotate(): Promise<void> {
  const result = await window.desk.mcp.rotateToken()
  if (result.ok) status.value = result.value
}
</script>

<template>
  <section class="settings-section">
    <header class="section-heading">
      <strong>本机 MCP</strong>
      <span>
        把「当前选中的笔记内容」以只读工具
        <code>get_current_selection</code> 提供给本机 Agent。只监听本机回环地址，请求必须带令牌。
      </span>
    </header>
    <button type="button" class="reset-group" @click="emit('reset')">重置</button>

    <div class="settings-row">
      <label class="switch-field">
        <input v-model="props.draft.mcp.enabled" type="checkbox" data-testid="mcp-enabled" />
        <span>启用本机 MCP 服务（默认关闭）</span>
      </label>
    </div>

    <div class="field-grid cols-3">
      <label class="field">
        <span>监听端口（改端口后需同步客户端配置）</span>
        <input
          v-model.number="props.draft.mcp.port"
          type="number"
          min="1024"
          max="65535"
          data-testid="mcp-port"
        />
      </label>
      <label class="field">
        <span>连接地址（Streamable HTTP）</span>
        <input :value="endpoint" readonly data-testid="mcp-endpoint" />
      </label>
      <label class="field">
        <span>运行状态</span>
        <input :value="stateLabel" readonly data-testid="mcp-state" />
      </label>
    </div>

    <p v-if="stateDetail" class="mcp-state-detail" :class="{ 'is-error': !!status?.error }">
      {{ stateDetail }}
    </p>

    <div class="field-grid cols-3">
      <label class="field">
        <span>连接令牌（放请求头，不放 URL）</span>
        <input
          :value="status?.token ?? ''"
          readonly
          type="text"
          data-testid="mcp-token"
          aria-label="连接令牌"
        />
      </label>
      <div class="mcp-actions">
        <button
          type="button"
          data-testid="mcp-copy-token"
          @click="copy(status?.token ?? '', '令牌')"
        >
          {{ copied === '令牌' ? '已复制' : '复制令牌' }}
        </button>
        <button type="button" data-testid="mcp-rotate" @click="rotate">重置令牌</button>
      </div>
    </div>
    <p class="mcp-state-detail">
      重置令牌会立刻断开已连接的客户端，旧令牌立即失效；客户端需要用新令牌重新连接。
    </p>

    <details class="mcp-example">
      <summary>客户端接入配置示例与用法说明</summary>
      <div class="mcp-example-body">
        <p>
          客户端需要支持 <strong>Streamable HTTP</strong> 以及自定义请求头（Bearer 令牌）； 只支持
          stdio 的客户端不在首版直接接入范围内。
        </p>
        <pre data-testid="mcp-config">{{ configExample }}</pre>
        <p>
          用法约定：用户提到「Desk 当前选区 / 我选中的内容」时，先调用
          <code>get_current_selection</code>；返回的 status 不是 ok（no_selection /
          unsupported_selection / selection_invalidated /
          context_too_large）时，如实告诉用户当前没有有效选区， 不要臆测内容。contentSource=draft
          表示内容来自编辑器草稿，可能与磁盘不一致，
          <strong>不要按返回的行列坐标直接修改磁盘文件</strong>。
        </p>
        <p>只读：工具不会修改笔记内容、文件或 Git 状态。</p>
        <button type="button" @click="copy(configExample, '配置')">
          {{ copied === '配置' ? '已复制配置' : '复制配置示例' }}
        </button>
      </div>
    </details>
  </section>
</template>

<style src="./settingsShared.css" scoped></style>

<style scoped>
.mcp-actions {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding-bottom: 1px;
}

.mcp-state-detail {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

.mcp-state-detail.is-error {
  color: var(--danger);
}

.mcp-example {
  display: grid;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
}

.mcp-example summary {
  cursor: pointer;
  color: var(--text);
}

.mcp-example-body {
  display: grid;
  gap: 8px;
  padding-top: 8px;
}

.mcp-example-body p {
  margin: 0;
  line-height: 1.6;
}

.mcp-example pre {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  overflow: auto;
  font: 11px/1.5 var(--font-mono);
}

.mcp-example code {
  font-family: var(--font-mono);
}

.mcp-example-body > button {
  justify-self: start;
}
</style>
