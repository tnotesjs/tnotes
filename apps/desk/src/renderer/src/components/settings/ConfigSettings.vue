<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { pushToast } from '../../stores/toast'

import type { AppSettings, DeskResult } from '../../../../shared/contracts'

const emit = defineEmits<{
  'settings-synced': [settings: AppSettings]
}>()

const configText = ref('')
const configBusy = ref(false)
const configMenu = ref<HTMLDetailsElement | null>(null)

function closeConfigMenuOnOutsidePointer(event: PointerEvent): void {
  const menu = configMenu.value
  if (!menu?.open) return
  if (event.target instanceof Node && menu.contains(event.target)) return
  menu.open = false
}

function resultValue<T>(result: DeskResult<T>): T {
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

function syncSettings(settings: AppSettings): void {
  emit('settings-synced', settings)
  configText.value = JSON.stringify(settings, null, 2)
}

async function loadConfigText(): Promise<void> {
  try {
    configText.value = resultValue<string>(await window.desk.settings.readRaw())
  } catch (cause) {
    pushToast(cause instanceof Error ? cause.message : String(cause), 'error')
  }
}

async function applyConfig(): Promise<void> {
  if (configBusy.value) return
  configBusy.value = true
  try {
    const settings = resultValue<AppSettings>(await window.desk.settings.writeRaw(configText.value))
    syncSettings(settings)
    pushToast('配置已保存', 'success')
  } catch {
    try {
      const defaults = resultValue<AppSettings>(await window.desk.settings.reset())
      syncSettings(defaults)
      pushToast('配置无效，已回退到默认配置', 'error')
    } catch (cause) {
      pushToast(cause instanceof Error ? cause.message : String(cause), 'error')
    }
  } finally {
    configBusy.value = false
  }
}

async function exportConfig(): Promise<void> {
  configBusy.value = true
  try {
    const result = await window.desk.settings.export()
    if (!result.ok) throw new Error(result.error.message)
    pushToast('配置已导出', 'success')
  } catch (cause) {
    pushToast(cause instanceof Error ? cause.message : String(cause), 'error')
  } finally {
    configBusy.value = false
  }
}

async function importConfig(): Promise<void> {
  configBusy.value = true
  try {
    const settings = resultValue<AppSettings>(await window.desk.settings.import())
    syncSettings(settings)
    pushToast('配置已导入', 'success')
  } catch (cause) {
    pushToast(cause instanceof Error ? cause.message : String(cause), 'error')
  } finally {
    configBusy.value = false
  }
}

async function resetConfig(): Promise<void> {
  configBusy.value = true
  try {
    const defaults = resultValue<AppSettings>(await window.desk.settings.reset())
    syncSettings(defaults)
    pushToast('已恢复到默认配置', 'success')
  } catch (cause) {
    pushToast(cause instanceof Error ? cause.message : String(cause), 'error')
  } finally {
    configBusy.value = false
  }
}

function closeConfigMenu(event: Event, action: () => void): void {
  action()
  ;(event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')
}

onMounted(() => {
  void loadConfigText()
  document.addEventListener('pointerdown', closeConfigMenuOnOutsidePointer, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeConfigMenuOnOutsidePointer, true)
})
</script>

<template>
  <section class="settings-section config-section">
    <header class="section-heading">
      <strong>配置文件</strong>
      <span>.tn-desk-config.json · 修改非法值会自动回退到默认配置</span>
    </header>
    <details ref="configMenu" class="config-actions">
      <summary class="config-actions-trigger" title="配置操作" aria-label="配置操作">⋮</summary>
      <div class="config-actions-popover">
        <button type="button" :disabled="configBusy" @click="closeConfigMenu($event, applyConfig)">
          保存并校验
        </button>
        <button type="button" :disabled="configBusy" @click="closeConfigMenu($event, exportConfig)">
          导出配置
        </button>
        <button type="button" :disabled="configBusy" @click="closeConfigMenu($event, importConfig)">
          导入配置
        </button>
        <button
          type="button"
          class="danger"
          :disabled="configBusy"
          @click="closeConfigMenu($event, resetConfig)"
        >
          恢复默认
        </button>
      </div>
    </details>
    <textarea v-model="configText" class="config-editor" spellcheck="false" />
  </section>
</template>

<style src="./settingsShared.css" scoped></style>

<style scoped>
.config-section {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.config-editor {
  width: 100%;
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--editor-text);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  padding: 12px;
  resize: none;
  outline: none;
  tab-size: 2;
}

.config-editor:focus {
  border-color: var(--accent);
}

.config-actions {
  position: absolute;
  top: 12px;
  right: 12px;
}

.config-actions-trigger {
  width: 30px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  list-style: none;
}

.config-actions-trigger::-webkit-details-marker {
  display: none;
}

.config-actions-trigger:hover {
  border-color: var(--accent);
  color: var(--text);
  background: var(--hover);
}

.config-actions-popover {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 40;
  min-width: 150px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--raised);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.34);
  padding: 5px;
}

.config-actions-popover button {
  width: 100%;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  padding: 7px 9px;
  font-size: 11px;
  text-align: left;
}

.config-actions-popover button:hover:not(:disabled) {
  background: var(--hover);
}

.config-actions-popover button:disabled {
  opacity: 0.5;
  cursor: default;
}

.config-actions-popover button.danger {
  color: var(--danger);
}
</style>
