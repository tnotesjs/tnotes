<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { CanvasEditor, serializeSubtree } from '@tnotesjs/mindmap-core'
import type {
  CanvasContextRequest,
  CanvasEditState,
  CanvasLinkHover,
  CanvasLinkRequest,
  InlineFormat,
  MindmapNode,
  MindmapSession
} from '@tnotesjs/mindmap-core'
import CanvasContextMenu from './CanvasContextMenu.vue'
import LinkPopover from './LinkPopover.vue'
import SelectionToolbar from './SelectionToolbar.vue'
import { pasteCanvasOutline, readMindmapClipboard, writeMindmapClipboard } from './mindmapClipboard'

const props = defineProps<{
  session: MindmapSession
  resolveImageSrc?: (src: string) => string
  /**
   * 浮层挂载点，透传给 `CanvasContextMenu` / `LinkPopover`。
   * 默认 `undefined` = 就地渲染（嵌在笔记里的 Desk / SSG）；整页宿主传 `'body'`。
   */
  teleportTo?: string
}>()

const emit = defineEmits<{
  ready: [editor: CanvasEditor]
  requestSearch: []
  imagePreview: [src: string]
  pasteImage: [anchorId: string, blob: Blob]
}>()

const host = ref<HTMLElement>()
let editor: CanvasEditor | null = null
const selectedCount = ref(0)
/** 选中的不全是图片节点；图片说明是纯文本，不出格式按钮 */
const selectionFormattable = ref(true)
/** 内联编辑态：编辑框里有文字选区时，弹出与大纲视图同一套文字格式工具栏 */
const editState = ref<CanvasEditState | null>(null)
const selectionLink = ref<CanvasLinkRequest | null>(null)
const textSelection = computed(() => {
  const state = editState.value
  return state && !state.image ? state.selection : null
})
const textFormats = computed<Partial<Record<InlineFormat, boolean>>>(() => {
  const state = editState.value
  const selection = textSelection.value
  if (!state || !selection) return {}
  const formats: InlineFormat[] = ['bold', 'italic', 'underline', 'strike', 'highlight', 'code']
  return Object.fromEntries(
    formats.map((format) => [
      format,
      props.session.inlineFormatActive(state.nodeId, selection.start, selection.end, format)
    ])
  )
})
const linkEditor = ref<CanvasLinkHover | null>(null)
const contextMenu = ref<CanvasContextRequest | null>(null)
let linkCloseTimer: ReturnType<typeof setTimeout> | null = null

function keepLinkPopover() {
  if (linkCloseTimer) clearTimeout(linkCloseTimer)
  linkCloseTimer = null
}

function closeLinkPopoverSoon() {
  keepLinkPopover()
  linkCloseTimer = setTimeout(() => (linkEditor.value = null), 180)
}

function onCanvasLinkHover(link: CanvasLinkHover | null) {
  if (!link) {
    closeLinkPopoverSoon()
    return
  }
  keepLinkPopover()
  linkEditor.value = link
}

function saveLink(url: string) {
  const link = linkEditor.value
  if (!link) return
  props.session.updateNodeInlineLink(link.nodeId, link.rawStart, link.rawEnd, url)
  // URL 长度变化会让原始 Markdown 范围失效；关闭后按下一次 hover 的新范围重开。
  linkEditor.value = null
}

function removeLink() {
  const link = linkEditor.value
  if (!link) return
  props.session.updateNodeInlineLink(link.nodeId, link.rawStart, link.rawEnd, null)
  linkEditor.value = null
}

function selectedRoots(): MindmapNode[] {
  const selected = props.session.selectionIds
  return props.session.selectedNodes.filter((node) => {
    let parent = node.parent
    while (parent) {
      if (selected.has(parent.id)) return false
      parent = parent.parent
    }
    return true
  })
}

function applyNodeFormat(format: InlineFormat) {
  props.session.formatSelectedNodes(format)
}

function formatEditing(format: InlineFormat) {
  editor?.formatEditing(format)
}

function clearEditingFormats() {
  editor?.clearEditingFormats()
}

function linkEditing() {
  editor?.linkEditing()
}

function toggleEditingTask() {
  editor?.commitEditing()
  props.session.toggleTaskSelectedNodes()
}

function removeEditingNode() {
  editor?.commitEditing()
  props.session.removeSelectedNodes()
}

function saveSelectionLink(url: string) {
  const request = selectionLink.value
  selectionLink.value = null
  if (!request) return
  props.session.setNodeInlineLink(request.nodeId, request.start, request.end, url.trim() || null)
}

function removeSelectionLink() {
  const request = selectionLink.value
  selectionLink.value = null
  if (request) props.session.setNodeInlineLink(request.nodeId, request.start, request.end, null)
}

function selectedMarkdown() {
  return selectedRoots()
    .map((node) => serializeSubtree(node))
    .join('\n')
}

async function copySelected(event?: ClipboardEvent | null) {
  const text = selectedMarkdown()
  if (!text) return
  writeMindmapClipboard(text, event)
}

async function cutSelected(event?: ClipboardEvent | null) {
  const text = selectedMarkdown()
  if (!text) return
  const ids = [...props.session.selectionIds]
  writeMindmapClipboard(text, event)
  props.session.removeNodesByIds(ids)
}

async function pasteAtSelection(anchorId?: string, event?: ClipboardEvent | null) {
  const targetId = anchorId ?? props.session.selectedNode?.id ?? props.session.focusRootNode.id
  const text = await readMindmapClipboard(event)
  if (text) pasteCanvasOutline(props.session, targetId, text)
}

async function pasteAtContextNode() {
  const target = contextMenu.value
  if (!target) return
  await pasteAtSelection(target.nodeId)
}

function pasteTextAt(text: string, anchorId: string) {
  writeMindmapClipboard(text)
  pasteCanvasOutline(props.session, anchorId, text)
}

function editCreated(node: MindmapNode | null) {
  if (node) editor?.startEdit(node.id)
}

function insertSibling() {
  const target = contextMenu.value
  if (target) editCreated(props.session.insertSiblingOf(target.nodeId))
}

function insertChild() {
  const target = contextMenu.value
  if (target) editCreated(props.session.insertChildOf(target.nodeId))
}

function insertParent() {
  const target = contextMenu.value
  if (target) editCreated(props.session.insertParentOf(target.nodeId))
}

function deleteOnly() {
  const target = contextMenu.value
  if (target) props.session.removeNodeOnly(target.nodeId)
}

function toggleContextSiblings() {
  const target = contextMenu.value
  if (target) props.session.toggleCollapseSiblings(target.nodeId)
}

function focusContextNode() {
  const target = contextMenu.value
  if (target) props.session.focusNode(target.nodeId)
}

onMounted(() => {
  editor = new CanvasEditor(host.value!, props.session, {
    onRequestSearch: () => emit('requestSearch'),
    onImagePreview: (src) => emit('imagePreview', src),
    onPasteImage: (anchorId, blob) => emit('pasteImage', anchorId, blob),
    resolveImageSrc: (src) => props.resolveImageSrc?.(src) ?? src,
    onSelectionPositionChange: (_position, count) => {
      // Canvas toolbar is absolutely anchored; only the selection count gates visibility.
      selectedCount.value = count
      selectionFormattable.value = !props.session.selectedNodes.every((node) => node.content.image)
    },
    onEditStateChange: (state) => {
      editState.value = state
    },
    onRequestLink: (request) => {
      linkEditor.value = null
      selectionLink.value = request
    },
    onLinkHover: onCanvasLinkHover,
    onContextMenu: (request) => {
      contextMenu.value = request
      if (request) linkEditor.value = null
    },
    onCopySelection: (event) => {
      void copySelected(event)
    },
    onCutSelection: (event) => {
      void cutSelected(event)
    },
    onPasteSelection: (event) => {
      void pasteAtSelection(undefined, event)
    },
    onPasteText: pasteTextAt
  })
  emit('ready', editor)
  // 切回脑图视图：居中当前选中节点（无选中则保持 zoomToFit）
  const sel = props.session.selectedNode
  if (sel) {
    requestAnimationFrame(() => editor?.centerOnNode(sel.id, false))
    setTimeout(() => editor?.centerOnNode(sel.id, false), 80)
  }
})

onBeforeUnmount(() => {
  if (linkCloseTimer) clearTimeout(linkCloseTimer)
  editor?.destroy()
  editor = null
})
</script>

<template>
  <div class="mindmap-view-root">
    <div ref="host" class="mindmap-view-host" />
    <SelectionToolbar
      v-if="textSelection && !selectionLink"
      mode="text"
      :position="textSelection.position"
      :active-formats="textFormats"
      :can-insert-image="false"
      @format="formatEditing"
      @task="toggleEditingTask"
      @link="linkEditing"
      @clear="clearEditingFormats"
      @delete="removeEditingNode"
    />
    <SelectionToolbar
      v-else-if="selectedCount > 0 && !editState"
      mode="nodes"
      placement="canvas-bottom"
      :formattable="selectionFormattable"
      @format="applyNodeFormat"
      @task="props.session.toggleTaskSelectedNodes()"
      @copy="copySelected"
      @clear="props.session.clearSelectedNodeFormats()"
      @delete="props.session.removeSelectedNodes()"
    />
    <LinkPopover
      v-if="linkEditor"
      :url="linkEditor.url"
      :position="linkEditor.position"
      :teleport-to="teleportTo"
      @save="saveLink"
      @remove="removeLink"
      @keep="keepLinkPopover"
      @leave="closeLinkPopoverSoon"
      @close="linkEditor = null"
    />
    <LinkPopover
      v-if="selectionLink"
      :url="selectionLink.url"
      :position="selectionLink.position"
      :teleport-to="teleportTo"
      start-editing
      @save="saveSelectionLink"
      @remove="removeSelectionLink"
      @close="selectionLink = null"
    />
    <CanvasContextMenu
      v-if="contextMenu"
      :position="contextMenu.position"
      :multiple="contextMenu.multiple"
      :can-insert-sibling="contextMenu.canInsertSibling"
      :can-insert-parent="contextMenu.canInsertParent"
      :can-cut="contextMenu.canCut"
      :can-duplicate="contextMenu.canDuplicate"
      :can-delete-only="contextMenu.canDeleteOnly"
      :can-delete-tree="contextMenu.canDeleteTree"
      :can-toggle-siblings="contextMenu.canToggleSiblings"
      :can-focus="contextMenu.canFocus"
      :teleport-to="teleportTo"
      @insert-sibling="insertSibling"
      @insert-child="insertChild"
      @insert-parent="insertParent"
      @copy="copySelected"
      @cut="cutSelected"
      @paste="pasteAtContextNode"
      @duplicate="props.session.duplicateSelectedNodes()"
      @delete-only="deleteOnly"
      @delete-tree="props.session.removeSelectedNodes()"
      @toggle-siblings="toggleContextSiblings"
      @focus="focusContextNode"
      @close="contextMenu = null"
    />
  </div>
</template>

<style scoped>
.mindmap-view-root {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.mindmap-view-host {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  outline: none;
  background: var(--mm-canvas-bg);
}
/* CanvasEditor 在宿主上切换这些状态类；光标规则原在已删除的独立 app 样式里，这里补回。 */
.mindmap-view-host.mm-editor {
  cursor: default;
}
.mindmap-view-host.mm-editor.is-space-pan {
  cursor: grab;
}
.mindmap-view-host.mm-editor.is-panning,
.mindmap-view-host.mm-editor.is-node-dragging {
  cursor: grabbing;
}
.mindmap-view-host.mm-editor.is-link-hover,
.mindmap-view-host.mm-editor.is-control-hover {
  cursor: pointer;
}
</style>
