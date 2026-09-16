<script setup lang="ts">
import { ref, watch } from 'vue'

import { useWorkspaceStore } from '../stores/workspace'

import ConfigSettings from './settings/ConfigSettings.vue'
import GeneralSettings from './settings/GeneralSettings.vue'
import ImageSettings from './settings/ImageSettings.vue'
import ShortcutsSettings from './settings/ShortcutsSettings.vue'
import TabsSettings from './settings/TabsSettings.vue'
import TocSettings from './settings/TocSettings.vue'
import ToolsSettings from './settings/ToolsSettings.vue'

import type { AppSettings } from '../../../shared/contracts'
import { APP_ZOOM_DEFAULT } from '../../../shared/appZoom'

const emit = defineEmits<{ close: [] }>()
const store = useWorkspaceStore()
const draft = ref<AppSettings | null>(
  store.settings ? (JSON.parse(JSON.stringify(store.settings)) as AppSettings) : null
)
const fullscreen = ref(false)
const activeGroup = ref('general')
const groups = [
  {
    id: 'general',
    label: '常规',
    icon: 'M4 7h10M18 7h2M4 12h2M10 12h10M4 17h10M18 17h2'
  },
  {
    id: 'tabs',
    label: '标签与导航',
    icon: 'M4 4h16v16H4zM4 8h16M9 8v2M5 12h14M5 17h10'
  },
  {
    id: 'toc',
    label: '目录管理',
    icon: 'M4 6h7M4 12h7M4 18h7M14 6h6M14 12h6M14 18h6'
  },
  {
    id: 'tools',
    label: '外部工具',
    icon: 'M5 7h14M5 12h14M5 17h14M8 5v4M12 10v4M16 15v4'
  },
  {
    id: 'image',
    label: '图片与图床',
    icon: 'M5 4h14v16H5zM8 9.5a2 2 0 1 0 3.9 0a2 2 0 1 0-3.9 0M7 17l4-4 3 3 3-3 2 2'
  },
  {
    id: 'config',
    label: '配置文件',
    icon: 'M6 3h9l4 4v14H6zM15 3v4h4M9 11h6M9 15h6M9 19h4'
  },
  {
    id: 'shortcuts',
    label: '快捷键',
    icon: 'M4 7h16v10H4zM7 10h2M12 10h2M16 10h0.1M7 14h10'
  }
]

const groupDefaults: Record<string, Partial<AppSettings>> = {
  general: {
    theme: 'system',
    density: 'comfortable',
    defaultNoteView: 'visual',
    defaultNotePageWidth: 'standard',
    noteTocDisplay: 'expanded',
    autosave: { enabled: true, delayMs: 1000 },
    workspaceLayout: 'kb-dir-content',
    prettier: false,
    updates: { autoCheck: true }
  },
  tabs: {
    tabs: { maxOpenCount: 10, wrap: true, autoRevealInToc: true }
  },
  toc: {
    createNotePosition: 'top',
    toc: {
      showNoteIndex: true,
      showNoteStatus: true,
      changesCollapsedByDefault: true
    }
  },
  tools: {
    ide: 'vscode',
    gitPath: null,
    nodePath: null,
    confirmBeforeCommit: false
  },
  image: {
    imageUpload: {
      defaultTarget: 'local',
      github: {
        repository: '',
        branch: 'main',
        path: '/',
        cdnTemplate: 'https://cdn.jsdelivr.net/gh/${username}/${repository}@${branch}/${filepath}',
        fileNameFormat: '${YY}-${MM}-${DD}-${HH}-${mm}-${ss}'
      },
      optimize: {
        encoder: 'sharp',
        strength: 'medium',
        maxDimension: null,
        outputFormat: 'keep'
      }
    }
  }
}

function resetGroup(id: string): void {
  if (!draft.value) return
  const defaults = groupDefaults[id]
  if (!defaults) return
  if (id === 'general') {
    void store.setAppZoom(APP_ZOOM_DEFAULT).catch((cause) => {
      store.error = cause instanceof Error ? cause.message : String(cause)
    })
  }
  const next: AppSettings = { ...draft.value, ...defaults }
  draft.value = next
}

let applyTimer: ReturnType<typeof setTimeout> | null = null
let applying = false

function scheduleApply(): void {
  if (applyTimer) clearTimeout(applyTimer)
  applyTimer = setTimeout(() => {
    applyTimer = null
    void applyDraft()
  }, 400)
}

async function applyDraft(): Promise<void> {
  if (!draft.value || applying) return
  applying = true
  try {
    const clone = JSON.parse(JSON.stringify(draft.value)) as Partial<AppSettings>
    // Zoom is applied immediately by its control/shortcuts, independently of this draft.
    delete clone.appZoomPercent
    await store.updateSettings(clone)
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    applying = false
  }
}

watch(draft, () => scheduleApply(), { deep: true })

function activateGroup(id: string): void {
  activeGroup.value = id
}

function onSettingsSynced(settings: AppSettings): void {
  store.applySettings(settings)
  draft.value = JSON.parse(JSON.stringify(settings)) as AppSettings
}
</script>

<template>
  <div class="settings-backdrop" @mousedown.self="emit('close')">
    <section v-if="draft" class="settings-panel" :class="{ fullscreen }" aria-label="设置">
      <header class="settings-header">
        <span class="settings-title">TNotes Desk 设置</span>
        <div class="settings-header-actions">
          <button
            type="button"
            class="icon-btn"
            :aria-label="fullscreen ? '退出全屏' : '全屏'"
            :title="fullscreen ? '退出全屏' : '全屏'"
            @click="fullscreen = !fullscreen"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                :d="
                  fullscreen
                    ? 'M9 4v7H4M15 4v7h5M9 20v-7H4M15 20v-7h5'
                    : 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5'
                "
              />
            </svg>
          </button>
          <button type="button" class="icon-btn" aria-label="关闭设置" @click="emit('close')">
            ×
          </button>
        </div>
      </header>

      <div class="settings-body">
        <nav class="settings-nav" aria-label="设置分组">
          <button
            v-for="group in groups"
            :key="group.id"
            type="button"
            class="nav-item"
            :class="{ active: activeGroup === group.id }"
            @click="activateGroup(group.id)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path :d="group.icon" />
            </svg>
            <span>{{ group.label }}</span>
          </button>
        </nav>
        <div class="settings-content">
          <GeneralSettings
            v-if="activeGroup === 'general'"
            :draft="draft"
            @reset="resetGroup('general')"
          />
          <TabsSettings
            v-else-if="activeGroup === 'tabs'"
            :draft="draft"
            @reset="resetGroup('tabs')"
            @open-shortcuts="activateGroup('shortcuts')"
          />
          <TocSettings
            v-else-if="activeGroup === 'toc'"
            :draft="draft"
            @reset="resetGroup('toc')"
          />
          <ToolsSettings
            v-else-if="activeGroup === 'tools'"
            :draft="draft"
            @reset="resetGroup('tools')"
          />
          <ImageSettings
            v-else-if="activeGroup === 'image'"
            :draft="draft"
            @reset="resetGroup('image')"
          />
          <ConfigSettings
            v-else-if="activeGroup === 'config'"
            @settings-synced="onSettingsSynced"
          />
          <ShortcutsSettings v-else />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-backdrop {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: grid;
  place-items: center;
  background: rgba(3, 6, 12, 0.64);
  backdrop-filter: blur(4px);
}

.settings-panel {
  width: min(860px, calc(100% - 44px));
  height: min(720px, calc(100% - 44px));
  max-height: min(800px, calc(100% - 54px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--raised);
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.5);
}

.settings-panel.fullscreen {
  width: 100%;
  height: 100%;
  max-height: 100%;
  border: 0;
  border-radius: 0;
}

.settings-panel > .settings-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 44px;
  padding: 0 14px 0 18px;
  border-bottom: 1px solid var(--border);
}

.settings-header .settings-title {
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.settings-header .settings-header-actions {
  flex: none;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
}

.settings-header .icon-btn {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 16px;
}

.settings-header .icon-btn:hover {
  background: var(--hover);
  color: var(--text);
}

.settings-header .icon-btn svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.settings-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.settings-nav {
  flex: none;
  width: 168px;
  overflow-y: auto;
  padding: 12px 8px;
  border-right: 1px solid var(--border);
}

.nav-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 8px 10px;
  font-size: 11px;
  text-align: left;
}

.nav-item svg {
  width: 16px;
  height: 16px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.nav-item:hover {
  background: var(--hover);
  color: var(--text);
}

.nav-item.active {
  background: var(--selected);
  color: var(--accent-strong);
}

.settings-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 18px 22px;
}
</style>
