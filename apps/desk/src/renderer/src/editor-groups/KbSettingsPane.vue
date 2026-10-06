<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

import type {
  KbSettingsEditorTab,
  KnowledgeBaseIconDto,
  KnowledgeBaseIconWriteRequest,
  KnowledgeBaseSettingsDto
} from '../../../shared/contracts'
import KnowledgeBaseIcon from '../components/KnowledgeBaseIcon.vue'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import { resultValue } from '../stores/workspace/helpers'
import {
  registerKbSettingsCloseHandler,
  unregisterKbSettingsCloseHandler
} from '../stores/workspace/kbSettingsCloseRegistry'

const props = defineProps<{ tab: KbSettingsEditorTab; active: boolean }>()

const editor = useEditorStore()
const workspace = useWorkspaceStore()

const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const loaded = ref<KnowledgeBaseSettingsDto | null>(null)

type PendingIcon =
  | { kind: 'file'; fileName: string; data: Uint8Array; preview: KnowledgeBaseIconDto }
  | { kind: 'letter'; letter: string }
  | { kind: 'clear' }

const draft = reactive({
  name: '',
  title: '',
  repositoryUrl: '',
  rootUrl: '',
  port: 9193,
  pageUrl: '',
  statsEnabled: false,
  letter: '',
  autoPushEnabled: false,
  autoPushIdleMinutes: 5,
  pushRunUpdateBefore: true,
  headingNumberMaxDepth: null as number | null
})

const pendingIcon = ref<PendingIcon | null>(null)
const baseline = ref('')

const isGitRepo = computed(() => loaded.value?.isGitRepo === true)

const displayIcon = computed<KnowledgeBaseIconDto | null>(() => {
  const pending = pendingIcon.value
  if (pending?.kind === 'file') return pending.preview
  if (pending?.kind === 'letter') return { letter: pending.letter }
  if (pending?.kind === 'clear') return null
  if (draft.letter.trim()) return { letter: draft.letter.trim().slice(0, 1) }
  return loaded.value?.icon ?? null
})

const nameError = computed(() => {
  const value = draft.name.trim()
  if (!value) return '知识库名称必填'
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(value)) return '须匹配 ^[A-Za-z0-9._-]{1,100}$'
  return null
})
const portError = computed(() => {
  if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) {
    return '端口须为 1–65535 的整数'
  }
  return null
})
const titleError = computed(() => (draft.title.trim() ? null : '显示名称不能为空'))
const autoPushIdleError = computed(() => {
  if (!draft.autoPushEnabled) return null
  if (
    !Number.isInteger(draft.autoPushIdleMinutes) ||
    draft.autoPushIdleMinutes < 1 ||
    draft.autoPushIdleMinutes > 1440
  ) {
    return '须为 1–1440 的整数'
  }
  return null
})
const canSave = computed(
  () =>
    !nameError.value &&
    !portError.value &&
    !titleError.value &&
    !autoPushIdleError.value &&
    !saving.value
)

const headingDepthChoice = computed({
  get: () =>
    draft.headingNumberMaxDepth === null ? 'inherit' : String(draft.headingNumberMaxDepth),
  set: (value: string) => {
    draft.headingNumberMaxDepth = value === 'inherit' ? null : Number(value)
  }
})
const globalHeadingDepth = computed(() => workspace.settings?.headingNumberMaxDepth ?? 2)

function formSnapshot(): string {
  return JSON.stringify({
    name: draft.name.trim(),
    title: draft.title.trim(),
    repositoryUrl: draft.repositoryUrl.trim(),
    rootUrl: draft.rootUrl.trim(),
    port: draft.port,
    pageUrl: draft.pageUrl.trim(),
    statsEnabled: draft.statsEnabled,
    letter: draft.letter.trim(),
    autoPushEnabled: draft.autoPushEnabled,
    autoPushIdleMinutes: draft.autoPushIdleMinutes,
    pushRunUpdateBefore: draft.pushRunUpdateBefore,
    headingNumberMaxDepth: draft.headingNumberMaxDepth,
    pending: pendingIcon.value
      ? pendingIcon.value.kind === 'file'
        ? { kind: 'file', fileName: pendingIcon.value.fileName }
        : pendingIcon.value
      : null
  })
}

function isDirty(): boolean {
  return Boolean(baseline.value) && formSnapshot() !== baseline.value
}

function syncDirty(): void {
  editor.setKbSettingsDirty(props.tab.id, isDirty())
}

function applyLoaded(settings: KnowledgeBaseSettingsDto): void {
  loaded.value = settings
  draft.name = settings.name
  draft.title = settings.title
  draft.repositoryUrl = settings.repositoryUrl
  draft.rootUrl = settings.rootUrl
  draft.port = settings.port
  draft.pageUrl = settings.pageUrl
  draft.statsEnabled = settings.isGitRepo ? settings.statsEnabled : false
  draft.letter = settings.icon?.letter ?? ''
  draft.autoPushEnabled = settings.autoPush?.enabled === true
  draft.autoPushIdleMinutes = settings.autoPush?.idleMinutes ?? 5
  draft.pushRunUpdateBefore = settings.pushRunUpdateBefore !== false
  draft.headingNumberMaxDepth = settings.headingNumberMaxDepth
  pendingIcon.value = null
  baseline.value = formSnapshot()
  syncDirty()
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    applyLoaded(
      resultValue(await window.desk.knowledgeBases.readSettings(props.tab.knowledgeBaseId))
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

watch([() => formSnapshot()], () => {
  if (!loading.value) syncDirty()
})

watch(
  () => draft.letter,
  (value) => {
    if (loading.value) return
    const letter = value.trim().slice(0, 1)
    const current = loaded.value?.icon?.letter ?? ''
    if (!letter) {
      if (pendingIcon.value?.kind === 'letter') pendingIcon.value = null
      return
    }
    if (letter === current && pendingIcon.value?.kind !== 'file') {
      if (pendingIcon.value?.kind === 'letter') pendingIcon.value = null
      return
    }
    pendingIcon.value = { kind: 'letter', letter }
  }
)

async function persistSettings(): Promise<void> {
  if (!canSave.value) {
    throw new Error(nameError.value || portError.value || titleError.value || '无法保存')
  }
  saving.value = true
  error.value = null
  try {
    const pending = pendingIcon.value
    if (pending) {
      let request: KnowledgeBaseIconWriteRequest
      if (pending.kind === 'file') {
        request = {
          knowledgeBaseId: props.tab.knowledgeBaseId,
          kind: 'file',
          fileName: pending.fileName,
          data: pending.data
        }
      } else if (pending.kind === 'letter') {
        request = {
          knowledgeBaseId: props.tab.knowledgeBaseId,
          kind: 'letter',
          letter: pending.letter
        }
      } else {
        request = { knowledgeBaseId: props.tab.knowledgeBaseId, kind: 'clear' }
      }
      resultValue(await window.desk.knowledgeBases.writeIcon(request))
    } else if (draft.letter.trim() && draft.letter.trim() !== (loaded.value?.icon?.letter ?? '')) {
      resultValue(
        await window.desk.knowledgeBases.writeIcon({
          knowledgeBaseId: props.tab.knowledgeBaseId,
          kind: 'letter',
          letter: draft.letter.trim().slice(0, 1)
        })
      )
    }

    resultValue(
      await window.desk.knowledgeBases.writeSettings({
        knowledgeBaseId: props.tab.knowledgeBaseId,
        name: draft.name.trim(),
        title: draft.title.trim(),
        repositoryUrl: draft.repositoryUrl.trim() || undefined,
        rootUrl: draft.rootUrl.trim() || undefined,
        port: draft.port,
        pageUrl: draft.pageUrl.trim() || undefined,
        statsEnabled: isGitRepo.value ? draft.statsEnabled : false,
        autoPush: draft.autoPushEnabled
          ? { enabled: true, idleMinutes: draft.autoPushIdleMinutes }
          : null,
        pushRunUpdateBefore: draft.pushRunUpdateBefore,
        headingNumberMaxDepth: draft.headingNumberMaxDepth
      })
    )

    await workspace.refreshWorkspace()
    await load()
    editor.updateKbSettingsTabMeta(props.tab.id, {
      knowledgeBaseName:
        workspace.overview.knowledgeBases.find((item) => item.id === props.tab.knowledgeBaseId)
          ?.displayName ?? props.tab.knowledgeBaseName,
      icon:
        workspace.overview.knowledgeBases.find((item) => item.id === props.tab.knowledgeBaseId)
          ?.icon ?? null
    })
    workspace.status = '知识库配置已保存'
  } finally {
    saving.value = false
  }
}

async function discard(): Promise<void> {
  if (loaded.value) applyLoaded(loaded.value)
  else await load()
}

async function onPickFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const data = new Uint8Array(await file.arrayBuffer())
  const blobUrl = URL.createObjectURL(
    new Blob([new Uint8Array(data)], { type: file.type || 'image/png' })
  )
  draft.letter = ''
  pendingIcon.value = {
    kind: 'file',
    fileName: file.name,
    data,
    preview: { src: blobUrl }
  }
  syncDirty()
}

function clearIcon(): void {
  draft.letter = ''
  pendingIcon.value = { kind: 'clear' }
  syncDirty()
}

onMounted(() => {
  void load()
  registerKbSettingsCloseHandler(props.tab.id, {
    key: `kb-settings:${props.tab.id}`,
    title: props.tab.title,
    dirty: () => isDirty(),
    saving: () => saving.value,
    pauseAutosave: () => () => undefined,
    waitForSave: async () => {
      while (saving.value) await new Promise((resolve) => setTimeout(resolve, 50))
    },
    save: () => persistSettings(),
    discard: () => discard()
  })
})

onUnmounted(() => {
  unregisterKbSettingsCloseHandler(props.tab.id)
})
</script>

<template>
  <div class="kb-settings-pane">
    <header class="pane-header">
      <div>
        <h2>知识库配置</h2>
        <p>{{ tab.knowledgeBaseName }} · 写入该库的 tnotes.json</p>
      </div>
      <button type="button" class="save-button" :disabled="!canSave" @click="persistSettings">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </header>

    <p v-if="loading" class="status">加载中…</p>
    <p v-else-if="error" class="status error">{{ error }}</p>

    <template v-else>
      <section class="settings-section">
        <header class="section-heading">
          <strong>图标与名称</strong>
          <span>名称不重命名磁盘目录；显示名称用于侧边栏</span>
        </header>

        <div class="icon-row">
          <div class="icon-preview">
            <KnowledgeBaseIcon :icon="displayIcon" :fallback="draft.title || draft.name || 'T'" />
          </div>
          <div class="icon-controls">
            <div class="icon-actions">
              <label class="file-button">
                选择图标
                <input
                  type="file"
                  accept=".svg,.png,.jpg,.jpeg,.webp,.gif,image/*"
                  @change="onPickFile"
                />
              </label>
              <label class="field letter-field">
                <span>单字符</span>
                <input v-model="draft.letter" type="text" maxlength="1" placeholder="T" />
              </label>
              <button type="button" class="clear-icon" @click="clearIcon">清除图标</button>
            </div>
            <small class="hint">本地文件 svg / png / jpg / webp / gif，不走图床</small>
          </div>
        </div>

        <div class="field-grid cols-2">
          <label class="field">
            <span>知识库名称 <em>*</em></span>
            <input v-model="draft.name" type="text" spellcheck="false" autocomplete="off" />
            <small v-if="nameError" class="hint error">{{ nameError }}</small>
            <small v-else class="hint">GitHub 风格：字母数字 . _ -</small>
          </label>
          <label class="field">
            <span>显示名称 <em>*</em></span>
            <input v-model="draft.title" type="text" />
            <small v-if="titleError" class="hint error">{{ titleError }}</small>
          </label>
        </div>
      </section>

      <section class="settings-section">
        <header class="section-heading">
          <strong>仓库与站点</strong>
        </header>
        <div class="field-grid cols-2">
          <label class="field">
            <span>Git 仓库地址</span>
            <input v-model="draft.repositoryUrl" type="url" placeholder="https://github.com/…" />
          </label>
          <label class="field">
            <span>根库地址</span>
            <input v-model="draft.rootUrl" type="url" placeholder="可选" />
            <small class="hint">根库待重构，暂不收集 TOC</small>
          </label>
          <label class="field">
            <span>站点预览端口 <em>*</em></span>
            <input v-model.number="draft.port" type="number" min="1" max="65535" />
            <small v-if="portError" class="hint error">{{ portError }}</small>
            <small v-else class="hint">已在跑的预览不会热切端口，需停再开</small>
          </label>
          <label class="field">
            <span>部署地址</span>
            <input v-model="draft.pageUrl" type="url" placeholder="https://…" />
          </label>
        </div>
      </section>

      <section class="settings-section">
        <header class="section-heading">
          <strong>库级约定</strong>
          <span>写入 tnotes.json 随仓库走，协作者共享；「跟随全局」则不写入</span>
        </header>
        <div class="field-grid cols-2">
          <label class="field">
            <span>标题编号层级上限</span>
            <select v-model="headingDepthChoice">
              <option value="inherit">跟随全局（当前：{{ globalHeadingDepth }} 级）</option>
              <option v-for="n in 6" :key="n" :value="String(n)">{{ n }} 级</option>
            </select>
          </label>
        </div>
        <label class="switch-field">
          <input v-model="draft.autoPushEnabled" type="checkbox" />
          <span>自动提交并推送（无全局项，仅库级）</span>
        </label>
        <label v-if="draft.autoPushEnabled" class="field auto-push-idle">
          <span>空闲多少分钟后推送</span>
          <input v-model.number="draft.autoPushIdleMinutes" type="number" min="1" max="1440" />
          <small v-if="autoPushIdleError" class="hint error">{{ autoPushIdleError }}</small>
        </label>
        <label class="switch-field">
          <input v-model="draft.pushRunUpdateBefore" type="checkbox" />
          <span>推送前自动 update（写入 tnotes.json → push.runUpdateBefore，默认开启）</span>
        </label>
      </section>

      <section class="settings-section">
        <header class="section-heading">
          <strong>完成趋势统计</strong>
          <span>数据写入 tnotes.stats.json（tn:update / 推送前自动 update）</span>
        </header>
        <label class="switch-field" :class="{ disabled: !isGitRepo }">
          <input v-model="draft.statsEnabled" type="checkbox" :disabled="!isGitRepo" />
          <span>启用完成趋势统计</span>
        </label>
        <p v-if="!isGitRepo" class="hint warn">当前目录不是 Git 仓库，无法开启完成趋势统计</p>
        <p v-else class="hint">
          保存开关本身不会扫描全历史；请在知识库中运行 <code>tnotes-kb update</code>
        </p>
      </section>
    </template>
  </div>
</template>

<style src="../components/settings/settingsShared.css" scoped></style>

<style scoped>
.kb-settings-pane {
  flex: 1;
  min-width: 0;
  width: 100%;
  height: 100%;
  overflow: auto;
  padding: 20px 28px 40px;
  box-sizing: border-box;
}

.pane-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.pane-header h2 {
  margin: 0 0 4px;
  font-size: 18px;
}

.pane-header p {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.save-button {
  border: 0;
  border-radius: 8px;
  padding: 8px 16px;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}

.save-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.status {
  color: var(--muted);
}

.status.error,
.hint.error {
  color: #c44;
}

.hint.warn {
  color: #b58900;
}

.icon-row {
  display: flex;
  gap: 16px;
  align-items: center;
  margin-bottom: 16px;
}

.icon-preview {
  width: 72px;
  height: 72px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--panel-2, var(--panel));
  overflow: hidden;
  flex-shrink: 0;
}

.icon-controls {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  min-width: 0;
}

.icon-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
}

.file-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
}

.file-button:hover {
  border-color: var(--accent);
}

.file-button input[type='file'] {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.letter-field {
  width: 72px;
}

.letter-field input {
  text-align: center;
}

.clear-icon {
  height: 32px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  border-radius: 7px;
  padding: 0 12px;
  font-size: 11px;
  cursor: pointer;
}

.clear-icon:hover {
  color: var(--text);
  border-color: var(--accent);
}

.hint {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}

.field em {
  color: #c44;
  font-style: normal;
}

.switch-field.disabled {
  opacity: 0.55;
}

.auto-push-idle {
  max-width: 200px;
  margin-top: 10px;
}

code {
  font-size: 12px;
}
</style>
