<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { useAskpassStore } from '../stores/askpass'

const store = useAskpassStore()
const value = ref('')
const input = ref<HTMLInputElement | null>(null)

const context = computed(() =>
  [store.current?.taskTitle, store.current?.knowledgeBaseName].filter(Boolean).join(' · ')
)

watch(
  () => store.current?.id,
  (id) => {
    value.value = ''
    if (id) void nextTick(() => input.value?.focus())
  }
)

function submit(): void {
  void store.answer(value.value)
  value.value = ''
}

function cancel(): void {
  void store.answer(null)
  value.value = ''
}
</script>

<template>
  <div v-if="store.current" class="credential-backdrop">
    <form
      class="credential-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Git 凭据"
      @submit.prevent="submit"
      @keydown.esc.prevent="cancel"
    >
      <header>
        <span>{{ context || 'Git' }}</span>
        <strong>Git 需要凭据</strong>
      </header>
      <label>
        <span class="credential-prompt">{{ store.current.prompt.trim() }}</span>
        <input
          ref="input"
          v-model="value"
          :type="store.current.secret ? 'password' : 'text'"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <p class="credential-hint">
        凭据只交给 git，Desk 不保存；是否记住由 git 的 credential helper 决定。
      </p>
      <footer>
        <button type="button" class="secondary" @click="cancel">取消</button>
        <button type="submit" class="primary">确定</button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.credential-backdrop {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  background: rgba(3, 6, 12, 0.58);
  backdrop-filter: blur(3px);
}

.credential-dialog {
  width: min(430px, calc(100% - 32px));
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  background: var(--raised);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

header {
  display: flex;
  flex-direction: column;
  padding: 14px 15px;
  border-bottom: 1px solid var(--border);
}

header span {
  color: var(--muted);
  font-size: 9px;
  letter-spacing: 0.06em;
}

header strong {
  font-size: 13px;
  font-weight: 650;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 17px 15px 8px;
  color: var(--muted);
  font-size: 11px;
}

.credential-prompt {
  color: var(--text);
  font-family: var(--font-mono);
  word-break: break-all;
}

.credential-hint {
  margin: 0;
  padding: 0 15px 12px;
  color: var(--muted);
  font-size: 10px;
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 15px;
  border-top: 1px solid var(--border);
}

footer button {
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 12px;
  cursor: pointer;
  font-size: 11px;
}

footer .secondary {
  background: transparent;
  color: var(--text);
}

footer .primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
</style>
