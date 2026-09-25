<script setup lang="ts">
/**
 * 思维导图编辑标签：改节点写回笔记里的 ```mindmap 围栏。
 * 不另存资源文件；脏状态落在笔记会话上。
 */
import { onMounted, ref, watch } from 'vue'
import { Mindmap } from '@tnotesjs/ui'

import {
  mindmapPreviewMarkdown,
  rebuildMindmapFence
} from '../editor/markdown/mindmapFence'
import { locateUniqueFence } from '../editor/markdown/mindmapFenceLocate'
import { liveEditorFor } from '../livePreview/editorRegistry'
import { resolveMarkdownImageUrl } from '../markdown/markdownAssetUrl'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import { documentKey } from '../stores/workspace/helpers'

import type { MindmapEditorTab } from '../../../shared/contracts'

const props = defineProps<{ tab: MindmapEditorTab; active: boolean; groupId: string }>()

const editor = useEditorStore()
const workspace = useWorkspaceStore()

const initial = mindmapPreviewMarkdown(props.tab.fenceSource)
const source = ref(initial.markdown)
const expandLevel = ref(initial.initialExpandLevel)
const invalidReason = ref('')

watch(
  () => props.tab.fenceSource,
  (fence) => {
    if (props.tab.invalid) return
    const next = mindmapPreviewMarkdown(fence)
    // 自己写回后 fence 会变；只有正文和当前编辑区不一致时才灌入（例如笔记里别处改了同一段）
    if (next.markdown === source.value) return
    source.value = next.markdown
    expandLevel.value = next.initialExpandLevel
  }
)

watch(
  () => props.tab.invalid,
  (invalid) => {
    if (invalid && !invalidReason.value) {
      invalidReason.value = '这段思维导图在笔记里已经找不到了，或出现了多份相同内容。'
    }
  },
  { immediate: true }
)

function noteContent(): string {
  const view = liveEditorFor(props.tab.knowledgeBaseId, props.tab.noteUuid)
  if (view) return view.state.doc.toString()
  const session = workspace.getDocumentSession(props.tab.knowledgeBaseId, props.tab.noteUuid)
  return session?.content ?? ''
}

function writeFence(nextFence: string): void {
  if (props.tab.invalid) return
  if (nextFence === props.tab.fenceSource) return

  const content = noteContent()
  const located = locateUniqueFence(content, props.tab.fenceSource)
  if (located.status !== 'ok') {
    invalidReason.value =
      located.status === 'ambiguous'
        ? '笔记里有多段相同的思维导图源码，无法安全写回。'
        : '这段思维导图在笔记里已经找不到了。'
    editor.updateMindmapTabMeta(props.tab.id, { invalid: true })
    return
  }

  const view = liveEditorFor(props.tab.knowledgeBaseId, props.tab.noteUuid)
  if (view) {
    view.dispatch({
      changes: { from: located.from, to: located.to, insert: nextFence },
      userEvent: 'input.mindmap'
    })
  } else {
    const next =
      content.slice(0, located.from) + nextFence + content.slice(located.to)
    workspace.updateDocumentContent(
      documentKey(props.tab.knowledgeBaseId, props.tab.noteUuid),
      next,
      true
    )
  }

  editor.updateMindmapTabMeta(props.tab.id, { fenceSource: nextFence, invalid: false })
}

function onMarkdownChange(markdown: string): void {
  writeFence(rebuildMindmapFence(props.tab.fenceSource, { markdown }))
}

function onExpandLevelChange(level: number): void {
  expandLevel.value = level
  writeFence(rebuildMindmapFence(props.tab.fenceSource, { initialExpandLevel: level }))
}

function resolveImageSrc(src: string): string {
  return resolveMarkdownImageUrl(src, props.tab.knowledgeBaseId, props.tab.noteUuid) || src
}

async function writeAsset(blob: Blob): Promise<{ relativePath: string; alt?: string }> {
  const type = blob.type || 'image/png'
  const ext =
    type === 'image/jpeg'
      ? 'jpg'
      : type === 'image/gif'
        ? 'gif'
        : type === 'image/webp'
          ? 'webp'
          : 'png'
  const file =
    blob instanceof File ? blob : new File([blob], `paste-${Date.now()}.${ext}`, { type })
  const uploaded = await workspace.uploadImage(
    props.tab.knowledgeBaseId,
    props.tab.noteUuid,
    file
  )
  return { relativePath: uploaded.markdownPath, alt: file.name }
}

onMounted(async () => {
  await workspace.ensureDocument(props.tab.knowledgeBaseId, props.tab.noteUuid)
})
</script>

<template>
  <div class="mindmap-tab-pane" :class="{ inactive: !active }">
    <div v-if="tab.invalid" class="mindmap-invalid" role="alert">
      <strong>无法继续编辑</strong>
      <p>{{ invalidReason }}</p>
    </div>
    <Mindmap
      v-else
      class="mindmap-editor"
      :source="source"
      :initial-expand-level="expandLevel"
      editable
      expand-level-control
      :resolve-image-src="resolveImageSrc"
      :write-asset="writeAsset"
      @change="onMarkdownChange"
      @expand-level-change="onExpandLevelChange"
    />
  </div>
</template>

<style scoped>
.mindmap-tab-pane {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--editor-bg, var(--tn-c-bg));
}

.mindmap-tab-pane.inactive {
  /* 仍挂载，只是不可见：由 v-show 控制 */
}

.mindmap-editor {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  margin: 0;
  display: flex;
  flex-direction: column;
}

/* 卡片预览把画布、大纲、源码写死 440px；编辑标签里要跟着外层撑满。 */
.mindmap-tab-pane .mindmap-editor:deep(.mindmap-canvas-host),
.mindmap-tab-pane .mindmap-editor:deep(.mindmap-outline.is-editable),
.mindmap-tab-pane .mindmap-editor:deep(.mindmap-source-wrap.is-editable) {
  flex: 1 1 auto;
  height: auto;
  min-height: 0;
  max-height: none;
}

.mindmap-invalid {
  margin: 24px;
  padding: 16px 18px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--tn-c-danger, #c0392b) 12%, transparent);
  color: var(--tn-c-text);
}

.mindmap-invalid strong {
  display: block;
  margin-bottom: 6px;
}

.mindmap-invalid p {
  margin: 0;
  color: var(--tn-c-text-2);
  font-size: 13px;
  line-height: 1.5;
}
</style>
