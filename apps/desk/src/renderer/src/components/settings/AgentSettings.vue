<script setup lang="ts">
import { onMounted, ref } from 'vue'

import type { AgentKeyStatus, AppSettings } from '../../../../shared/contracts'

const props = defineProps<{ draft: AppSettings }>()
const emit = defineEmits<{ reset: [] }>()

const status = ref<AgentKeyStatus | null>(null)
const apiKey = ref('')
const keyMessage = ref('')

async function refresh(): Promise<void> {
  const result = await window.desk.agent.keyStatus()
  if (result.ok) status.value = result.value
}

onMounted(() => {
  void refresh()
})

async function saveKey(): Promise<void> {
  keyMessage.value = ''
  const result = await window.desk.agent.updateKey({ apiKey: apiKey.value, clear: false })
  if (!result.ok) {
    keyMessage.value = result.error.message
    return
  }
  status.value = result.value
  apiKey.value = ''
  keyMessage.value = result.value.configured ? '密钥已保存（不写入配置文件）' : '没有写入密钥'
}

async function clearKey(): Promise<void> {
  keyMessage.value = ''
  const result = await window.desk.agent.updateKey({ clear: true })
  if (!result.ok) {
    keyMessage.value = result.error.message
    return
  }
  status.value = result.value
  keyMessage.value = '密钥已清除'
}
</script>

<template>
  <section class="settings-section">
    <header class="section-heading">
      <strong>内置 Agent</strong>
      <span>填 OpenAI 兼容接口的地址、模型和密钥即可使用</span>
    </header>
    <button type="button" class="reset-group" @click="emit('reset')">重置地址和模型</button>
    <div class="field-grid">
      <label>
        <span>接口地址</span>
        <input v-model="props.draft.agent.baseUrl" type="text" spellcheck="false" placeholder="https://api.openai.com/v1" />
        <small>根地址，不要带 /chat/completions。改完后点设置面板的保存。</small>
      </label>
      <label>
        <span>模型</span>
        <input v-model="props.draft.agent.model" type="text" spellcheck="false" placeholder="gpt-4o-mini" />
      </label>
      <label>
        <span>API Key</span>
        <input v-model="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" />
        <small>
          {{ status?.configured ? '本机已保存密钥' : '还没有密钥' }}
          {{ status && !status.encryptionAvailable ? ' · 系统凭据存储不可用，将以本机文件保存' : '' }}
        </small>
      </label>
      <div class="key-actions">
        <button type="button" @click="saveKey">保存密钥</button>
        <button type="button" @click="clearKey">清除密钥</button>
        <small v-if="keyMessage">{{ keyMessage }}</small>
      </div>
    </div>
  </section>
</template>

<style src="./settingsShared.css" scoped></style>

<style scoped>
.key-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
