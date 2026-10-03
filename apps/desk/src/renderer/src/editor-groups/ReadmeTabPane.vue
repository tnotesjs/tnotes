<script setup lang="ts">
/**
 * 知识库根目录 README.md：当作一篇特殊笔记，用同一个实时预览编辑器和格式工具栏。
 *
 * 和笔记的差别只在读写通道（`kbReadme`，按 revision 防覆盖）和资源归属：粘贴的图片命名为
 * `README-…`，链接写成 `./assets/…`（README 在库根）。编辑后自动保存；磁盘被别处改过时，
 * 没有未保存的编辑就直接载入，有就停下来让用户选。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import KbPathBreadcrumb from './KbPathBreadcrumb.vue'
import NoteFormatToolbar from './NoteFormatToolbar.vue'
import LivePreviewEditor from '../livePreview/LivePreviewEditor.vue'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import { registerViewToggleRunner } from '../commands/viewToggleBridge'
import { pastedImageMarkdown } from '../editor/markdown/pasteImageWidth'
import { HEADING_NUMBER_DEFAULT_MAX_DEPTH } from '../../../shared/headingNumbering'
import { README_NOTE_UUID } from '../../../shared/contracts'

import type { NoteViewMode, TextFileEditorTab as TextFileTab } from '../../../shared/contracts'
import type { FormatToolbarEditor } from './NoteFormatToolbar.vue'

interface ReadmeEditorHandle extends FormatToolbarEditor {
  beginImageUpload?(position: number, label: string): number
  finishImageUpload?(id: number, markdown: string): boolean
  cancelImageUpload?(id: number): void
  flush(): void
}

const SAVE_DELAY = 600
const EXCLUDED_BLOCKS = ['canvas'] as const

const props = defineProps<{ tab: TextFileTab; active: boolean; groupId: string }>()
const editorStore = useEditorStore()
const workspace = useWorkspaceStore()
const showPathBreadcrumb = computed(() => workspace.settings?.showPathBreadcrumb !== false)

const viewMode = ref<NoteViewMode>('visual')
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const message = ref('')
const saveState = ref<'saved' | 'pending' | 'saving' | 'error'>('saved')
const externalConflict = ref(false)
const content = ref('')
/** 从磁盘重新载入时换 key，让编辑器整份重建 */
const loadId = ref(0)
const headingLevel = ref<number | null>(null)
const markdownEditor = ref<ReadmeEditorHandle | null>(null)

let revision = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> | null = null

const headingNumberMaxDepth = computed(
  () =>
    workspace.overview.allKnowledgeBases.find((kb) => kb.id === props.tab.knowledgeBaseId)
      ?.headingNumberMaxDepth ??
    workspace.settings?.headingNumberMaxDepth ??
    HEADING_NUMBER_DEFAULT_MAX_DEPTH
)
const saveLabel = computed(() =>
  saveState.value === 'error' ? '保存失败' : saveState.value === 'saved' ? '已保存' : '保存中…'
)

async function load(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  phase.value = 'loading'
  const result = await window.desk.kbReadme.read({
    knowledgeBaseId: props.tab.knowledgeBaseId,
    create: true
  })
  if (!result.ok) {
    phase.value = 'error'
    message.value = result.error.message
    return
  }
  revision = result.value.revision
  content.value = result.value.content
  saveState.value = 'saved'
  externalConflict.value = false
  message.value = ''
  loadId.value += 1
  phase.value = 'ready'
}

async function save(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (saving) await saving
  if (saveState.value !== 'pending' || externalConflict.value) return
  saving = writeOnce()
  await saving
  saving = null
}

async function writeOnce(): Promise<void> {
  saveState.value = 'saving'
  const text = content.value
  const result = await window.desk.kbReadme.write({
    knowledgeBaseId: props.tab.knowledgeBaseId,
    content: text,
    baseRevision: revision
  })
  if (!result.ok) {
    saveState.value = 'error'
    message.value = result.error.message
    return
  }
  revision = result.value.revision
  message.value = ''
  if (content.value === text) saveState.value = 'saved'
  else scheduleSave()
}

function scheduleSave(): void {
  if (saveState.value === 'error') return
  saveState.value = 'pending'
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void save(), SAVE_DELAY)
}

function updateContent(next: string): void {
  if (next === content.value) return
  content.value = next
  scheduleSave()
}

/** 冲突时保留编辑：以磁盘当前版本为基准再写一次 */
async function keepEdits(): Promise<void> {
  const result = await window.desk.kbReadme.read({
    knowledgeBaseId: props.tab.knowledgeBaseId,
    create: true
  })
  if (!result.ok) {
    message.value = result.error.message
    return
  }
  revision = result.value.revision
  externalConflict.value = false
  saveState.value = 'pending'
  message.value = ''
  await save()
}

function toggleMode(): void {
  markdownEditor.value?.flush()
  viewMode.value = viewMode.value === 'source' ? 'visual' : 'source'
}

async function pasteImage(file: File, insertAt: number): Promise<void> {
  const target = markdownEditor.value
  const label =
    workspace.settings?.imageUpload.defaultTarget === 'github' ? '正在上传到图床' : '正在保存图片'
  const uploadId = target?.beginImageUpload?.(insertAt, label)
  try {
    const attachment = await workspace.uploadImage(
      props.tab.knowledgeBaseId,
      README_NOTE_UUID,
      file
    )
    const markdown = await pastedImageMarkdown(file, attachment.markdownPath)
    const placed =
      uploadId != null && uploadId >= 0 && target?.finishImageUpload?.(uploadId, markdown)
    if (!placed) target?.insertTextAt(markdown, insertAt)
  } catch (cause) {
    if (uploadId != null && uploadId >= 0) target?.cancelImageUpload?.(uploadId)
    workspace.error = cause instanceof Error ? cause.message : String(cause)
  }
}

function openLink(url: string): void {
  try {
    editorStore.openWeb(url)
  } catch (cause) {
    workspace.error = cause instanceof Error ? cause.message : String(cause)
  }
}

let unregisterViewRunner: (() => void) | null = null
let unsubscribeExternal: (() => void) | null = null

watch(
  () => props.active,
  (active) => {
    if (!active) return
    unregisterViewRunner?.()
    unregisterViewRunner = registerViewToggleRunner(toggleMode)
  },
  { immediate: true }
)

onMounted(() => {
  void load()
  unsubscribeExternal = window.desk.notes.onExternalChanged((event) => {
    if (event.knowledgeBaseId !== props.tab.knowledgeBaseId) return
    if (event.noteUuid !== README_NOTE_UUID) return
    if (saveState.value === 'saved') void load()
    else externalConflict.value = true
  })
})

watch(
  () => props.tab.knowledgeBaseId,
  () => {
    void save().then(load)
  }
)

onBeforeUnmount(() => {
  markdownEditor.value?.flush()
  void save()
  unregisterViewRunner?.()
  unregisterViewRunner = null
  unsubscribeExternal?.()
  unsubscribeExternal = null
})
</script>

<template>
  <section class="readme-pane">
    <div v-if="externalConflict" class="conflict-banner" role="alert">
      <span>README.md 已在磁盘上被修改，Desk 没有覆盖你的编辑。</span>
      <button type="button" @click="load">载入磁盘</button>
      <button type="button" @click="keepEdits">保留编辑内容</button>
    </div>
    <div v-if="showPathBreadcrumb" class="path-bar">
      <KbPathBreadcrumb
        :knowledge-base-id="tab.knowledgeBaseId"
        :rel-path="tab.relPath"
        :fallback-name="tab.knowledgeBaseName"
      />
    </div>
    <header class="readme-toolbar">
      <span class="readme-title">README.md</span>
      <NoteFormatToolbar
        :editor="markdownEditor"
        :view-mode="viewMode"
        :disabled="phase !== 'ready'"
        :active="active"
        :heading-level="headingLevel"
        :heading-number-max-depth="headingNumberMaxDepth"
        :exclude-blocks="EXCLUDED_BLOCKS"
        @toggle-mode="toggleMode"
      />
      <span v-if="phase === 'ready'" class="save-state" :class="saveState">{{ saveLabel }}</span>
    </header>
    <p v-if="phase === 'loading'" class="pane-note">正在读取…</p>
    <p v-else-if="message" class="pane-note is-error" role="alert">
      {{ message }}
      <button type="button" class="reload" @click="load">重新读取</button>
    </p>
    <LivePreviewEditor
      v-if="phase === 'ready'"
      :key="`${tab.knowledgeBaseId}:${loadId}`"
      ref="markdownEditor"
      class="readme-editor"
      :content="content"
      :mode="viewMode"
      :read-only="false"
      :knowledge-base-id="tab.knowledgeBaseId"
      :note-uuid="README_NOTE_UUID"
      note-rel-path="README.md"
      :active="active"
      :outline-visible="false"
      @change="updateContent"
      @open-link="openLink"
      @open-note="workspace.openNoteByUuid(tab.knowledgeBaseId, $event)"
      @paste-image="pasteImage"
      @heading-level-change="headingLevel = $event"
    />
  </section>
</template>

<style scoped>
.readme-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--editor-bg);
  color: var(--text);
}

.path-bar {
  flex: none;
  height: 22px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--editor-bg);
}

.readme-toolbar {
  height: 40px;
  flex: none;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  font: 12px/1.6 var(--font-sans);
}

.readme-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-weight: 600;
}

.save-state {
  justify-self: end;
  color: var(--muted);
}

.save-state.error {
  color: var(--danger, #e5484d);
}

.conflict-banner {
  min-height: 35px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  background: var(--warning-soft);
  color: var(--warning);
  font-size: 10px;
}

.conflict-banner span {
  flex: 1;
}

.conflict-banner button {
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  border-radius: 5px;
  background: transparent;
  color: var(--warning);
  cursor: pointer;
  font-size: 10px;
  padding: 4px 7px;
}

.pane-note {
  margin: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font: 12px/1.6 var(--font-sans);
  color: var(--muted);
  flex: none;
}

.pane-note.is-error {
  color: var(--danger, #e5484d);
}

.reload {
  margin-left: 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font: inherit;
  cursor: pointer;
}

.readme-editor {
  flex: 1;
  min-height: 0;
}
</style>
