<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

import { isCursorProvider, providerFromBaseUrl } from '../../../../shared/agentModels'

import type { AgentKeyStatus, AgentListedModel, AgentProviderConfig, AppSettings } from '../../../../shared/contracts'

const props = defineProps<{ draft: AppSettings }>()
const emit = defineEmits<{ reset: [] }>()

const status = ref<AgentKeyStatus | null>(null)
const keys = reactive<Record<string, string>>({})
const messages = reactive<Record<string, string>>({})
/** 从服务商接口读到的模型；读过才能判断模型名是否存在 */
const listed = reactive<Record<string, AgentListedModel[]>>({})
const busy = reactive<Record<string, boolean>>({})

function unknownModel(provider: AgentProviderConfig, id: string): boolean {
  const list = listed[provider.id]
  return Boolean(list && id.trim() && !list.some((item) => item.id === id.trim()))
}

function addableModels(provider: AgentProviderConfig): AgentListedModel[] {
  const used = new Set(provider.models.map((model) => model.id))
  return (listed[provider.id] ?? []).filter((item) => !used.has(item.id))
}

function addListedModel(provider: AgentProviderConfig, event: Event): void {
  const select = event.target as HTMLSelectElement
  const id = select.value
  select.value = ''
  if (!id) return
  const empty = provider.models.find((model) => !model.id.trim())
  if (empty) empty.id = id
  else provider.models.push({ id, vision: true, reasoning: false })
}

async function loadModels(provider: AgentProviderConfig, silent = false): Promise<void> {
  if (!silent) messages[provider.id] = ''
  busy[provider.id] = true
  try {
    const result = await window.desk.agent.listModels({
      providerId: provider.id,
      kind: provider.kind,
      baseUrl: provider.baseUrl
    })
    if (!result.ok) {
      messages[provider.id] = `读取模型失败：${result.error.message}`
      return
    }
    listed[provider.id] = result.value
    if (!silent) messages[provider.id] = `读到 ${result.value.length} 个模型`
  } finally {
    busy[provider.id] = false
  }
}

function hasCursorProvider(): boolean {
  return providers().some((provider) => isCursorProvider(provider))
}

function addCursorProvider(): void {
  if (hasCursorProvider()) return
  const id = providers().some((provider) => provider.id === 'cursor') ? `cursor-${Math.random().toString(36).slice(2, 6)}` : 'cursor'
  providers().push({ id, name: 'Cursor', kind: 'cursor', baseUrl: '', models: [{ id: 'composer-2.5', vision: true, reasoning: false }] })
}

async function loginCursor(provider: AgentProviderConfig): Promise<void> {
  messages[provider.id] = '已在浏览器打开 Cursor 登录页，确认后回到这里…'
  busy[provider.id] = true
  try {
    const result = await window.desk.agent.cursorLogin({ providerId: provider.id })
    if (!result.ok) {
      messages[provider.id] = result.error.message
      return
    }
    status.value = result.value.status
    messages[provider.id] = result.value.email ? `已登录 ${result.value.email}，密钥已保存` : '已登录，密钥已保存'
  } finally {
    busy[provider.id] = false
  }
  if (status.value?.providers[provider.id]) void loadModels(provider, true)
}


async function refresh(): Promise<void> {
  const result = await window.desk.agent.keyStatus()
  if (result.ok) status.value = result.value
}

onMounted(async () => {
  await refresh()
  // 已有密钥的服务商打开设置就读一次模型列表，模型名写错能马上看出来
  for (const provider of providers()) {
    if (status.value?.providers[provider.id]) void loadModels(provider, true)
  }
})

function providers(): AgentProviderConfig[] {
  return props.draft.agent.providers
}

function addProvider(): void {
  const id = `p-${Math.random().toString(36).slice(2, 8)}`
  providers().push({ id, name: '新服务商', baseUrl: 'https://', models: [{ id: '', vision: true, reasoning: false }] })
}

function removeProvider(index: number): void {
  const [removed] = providers().splice(index, 1)
  if (removed && props.draft.agent.defaultModel.startsWith(`${removed.id}/`)) props.draft.agent.defaultModel = ''
}

function addModel(provider: AgentProviderConfig): void {
  provider.models.push({ id: '', vision: true, reasoning: false })
}

function guessName(provider: AgentProviderConfig): void {
  if (provider.name && provider.name !== '新服务商') return
  provider.name = providerFromBaseUrl(provider.baseUrl).name
}

async function saveKey(provider: AgentProviderConfig): Promise<void> {
  messages[provider.id] = ''
  const result = await window.desk.agent.updateKey({ providerId: provider.id, apiKey: keys[provider.id] ?? '', clear: false })
  if (!result.ok) {
    messages[provider.id] = result.error.message
    return
  }
  status.value = result.value
  keys[provider.id] = ''
  messages[provider.id] = result.value.providers[provider.id] ? '密钥已保存（不写入配置文件）' : '没有写入密钥'
  if (result.value.providers[provider.id]) void loadModels(provider, true)
}

async function clearKey(provider: AgentProviderConfig): Promise<void> {
  messages[provider.id] = ''
  const result = await window.desk.agent.updateKey({ providerId: provider.id, clear: true })
  if (!result.ok) {
    messages[provider.id] = result.error.message
    return
  }
  status.value = result.value
  messages[provider.id] = '密钥已清除'
}
</script>

<template>
  <section class="settings-section">
    <header class="section-heading">
      <strong>内置 Agent</strong>
      <span>按服务商填写 OpenAI 兼容接口的地址和密钥，每个服务商下可以挂多个模型；也可以接入 Cursor，用 Cursor 账户的额度</span>
    </header>
    <button type="button" class="reset-group" @click="emit('reset')">重置服务商和模型</button>
    <div v-for="(provider, index) in props.draft.agent.providers" :key="provider.id" class="provider">
      <div class="provider-head">
        <input v-model="provider.name" class="provider-name" type="text" spellcheck="false" aria-label="服务商名称" />
        <span v-if="isCursorProvider(provider)" class="provider-kind">Cursor Agent</span>
        <button type="button" class="link danger" @click="removeProvider(index)">删除服务商</button>
      </div>
      <div class="field-grid">
        <div v-if="isCursorProvider(provider)" class="cursor-auth">
          <span>Cursor 账号</span>
          <div class="key-actions">
            <button type="button" :disabled="busy[provider.id]" @click="loginCursor(provider)">用 Cursor 账号登录</button>
            <button type="button" :disabled="busy[provider.id] || !status?.providers[provider.id]" @click="loadModels(provider)">
              读取模型
            </button>
          </div>
          <small>
            登录会生成一个 90 天有效的密钥，只存在本机。也可以在 Cursor 控制台 Integrations 里生成 API Key 填到下面。
            Cursor Agent 只能通过 Desk 的笔记工具读写，改动同样进审阅。
          </small>
        </div>
        <label v-else>
          <span>接口地址</span>
          <input
            v-model="provider.baseUrl"
            type="text"
            spellcheck="false"
            placeholder="https://api.deepseek.com"
            @change="guessName(provider)"
          />
          <small>根地址，不要带 /chat/completions。</small>
        </label>
        <label>
          <span>API Key</span>
          <input
            v-model="keys[provider.id]"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :placeholder="isCursorProvider(provider) ? '粘贴 Cursor API Key，或用上面的登录' : 'sk-…'"
          />
          <small>
            {{ status?.providers[provider.id] ? '本机已保存密钥' : '还没有密钥' }}
            {{ status && !status.encryptionAvailable ? ' · 系统凭据存储不可用，将以本机文件保存' : '' }}
          </small>
        </label>
        <div class="key-actions">
          <button type="button" @click="saveKey(provider)">保存密钥</button>
          <button type="button" @click="clearKey(provider)">清除密钥</button>
          <button
            v-if="!isCursorProvider(provider)"
            type="button"
            :disabled="busy[provider.id] || !status?.providers[provider.id]"
            @click="loadModels(provider)"
          >
            读取模型
          </button>
          <small v-if="messages[provider.id]">{{ messages[provider.id] }}</small>
        </div>
      </div>
      <table class="models">
        <thead>
          <tr>
            <th>模型</th>
            <th>能看图</th>
            <th>支持思考强度</th>
            <th>默认</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="(model, modelIndex) in provider.models" :key="modelIndex">
            <td>
              <input
                v-model="model.id"
                type="text"
                spellcheck="false"
                :class="{ unknown: unknownModel(provider, model.id) }"
                :placeholder="isCursorProvider(provider) ? 'composer-2.5' : 'deepseek-chat'"
                :list="listed[provider.id] ? `listed-models-${provider.id}` : undefined"
                aria-label="模型名"
              />
              <small v-if="unknownModel(provider, model.id)" class="unknown-hint">服务商没有这个模型</small>
            </td>
            <td><input v-model="model.vision" type="checkbox" aria-label="能看图" /></td>
            <td><input v-model="model.reasoning" type="checkbox" aria-label="支持思考强度" /></td>
            <td>
              <input
                type="radio"
                name="agent-default-model"
                aria-label="设为默认"
                :checked="props.draft.agent.defaultModel === `${provider.id}/${model.id}`"
                @change="props.draft.agent.defaultModel = `${provider.id}/${model.id}`"
              />
            </td>
            <td><button type="button" class="link danger" @click="provider.models.splice(modelIndex, 1)">删除</button></td>
          </tr>
        </tbody>
      </table>
      <datalist v-if="listed[provider.id]" :id="`listed-models-${provider.id}`">
        <option v-for="item in listed[provider.id]" :key="item.id" :value="item.id">{{ item.displayName }}</option>
      </datalist>
      <div class="model-actions">
        <select
          v-if="addableModels(provider).length"
          class="add-listed"
          aria-label="从列表添加模型"
          @change="addListedModel(provider, $event)"
        >
          <option value="">从列表添加模型…</option>
          <option v-for="item in addableModels(provider)" :key="item.id" :value="item.id">
            {{ item.displayName === item.id ? item.id : `${item.displayName}（${item.id}）` }}
          </option>
        </select>
        <button type="button" class="link" @click="addModel(provider)">手动添加模型</button>
      </div>
    </div>
    <div class="add-actions">
      <button type="button" class="add-provider" @click="addProvider">添加服务商</button>
      <button type="button" class="add-provider" :disabled="hasCursorProvider()" @click="addCursorProvider">接入 Cursor</button>
    </div>
  </section>
</template>

<style src="./settingsShared.css" scoped></style>

<style scoped>
.provider {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.provider-name {
  font-weight: 600;
  max-width: 240px;
}

.key-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.models {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.models th {
  text-align: left;
  font-weight: 500;
  color: var(--muted);
  padding: 2px 4px;
}

.models td {
  padding: 2px 4px;
}

.models td:first-child input {
  width: 100%;
}

.link {
  border: 0;
  background: transparent;
  color: var(--accent, #3b82f6);
  cursor: pointer;
  padding: 0;
  font: inherit;
  align-self: flex-start;
}

.link.danger {
  color: #e03131;
}

.add-provider {
  align-self: flex-start;
}

.add-actions {
  display: flex;
  gap: 8px;
}

.provider-kind {
  margin-right: auto;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--muted);
  font-size: 11px;
}

.cursor-auth {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.models td input.unknown {
  border-color: #e03131;
}

.unknown-hint {
  display: block;
  color: #e03131;
  font-size: 11px;
}

.model-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.add-listed {
  max-width: 280px;
}
</style>
