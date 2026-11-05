<script setup lang="ts">
/**
 * 斜杠菜单「图片」的选图弹层：选本地图片、拖进来、⌘V 粘贴剪贴板图片，或者贴一个图片链接。
 * 图片文件交回编辑器走粘贴上传的同一条路径。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import { useWorkspaceStore } from '../stores/workspace'

const props = defineProps<{
  /** 插入行在视口里的位置 */
  anchor: { left: number; top: number; bottom: number }
}>()

const emit = defineEmits<{ file: [file: File]; link: [url: string]; close: [] }>()

const workspace = useWorkspaceStore()
const root = ref<HTMLElement | null>(null)
const linkInput = ref<HTMLInputElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const url = ref('')
const dragging = ref(false)
const pasteKey = computed(() => (workspace.runtimePlatform === 'darwin' ? '⌘V' : 'Ctrl+V'))
const validLink = computed(() =>
  /^(https?:\/\/|\.{0,2}\/|data:image\/)\S+$/i.test(url.value.trim())
)

const WIDTH = 360
const HEIGHT = 196
const position = computed(() => {
  const left = Math.max(8, Math.min(props.anchor.left, window.innerWidth - WIDTH - 8))
  const below = props.anchor.bottom + 6
  const top =
    below + HEIGHT > window.innerHeight - 8 ? Math.max(8, props.anchor.top - HEIGHT - 6) : below
  return { left: `${left}px`, top: `${top}px` }
})

function imageFrom(list: ArrayLike<DataTransferItem | File> | undefined | null): File | null {
  for (const entry of Array.from<DataTransferItem | File>(list ?? [])) {
    const file = entry instanceof File ? entry : entry.kind === 'file' ? entry.getAsFile() : null
    if (file && file.type.startsWith('image/')) return file
  }
  return null
}

function chooseFile(): void {
  fileInput.value?.click()
}

function onFileChange(event: Event): void {
  const file = imageFrom((event.target as HTMLInputElement).files)
  if (file) emit('file', file)
}

function onPaste(event: ClipboardEvent): void {
  const file = imageFrom(event.clipboardData?.items)
  if (!file) return
  event.preventDefault()
  emit('file', file)
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const file = imageFrom(event.dataTransfer?.files)
  if (file) emit('file', file)
}

function insertLink(): void {
  if (validLink.value) emit('link', url.value.trim())
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  emit('close')
}

function onOutside(event: Event): void {
  if (!root.value?.contains(event.target as Node | null)) emit('close')
}

onMounted(() => {
  document.addEventListener('pointerdown', onOutside, true)
  void nextTick(() => linkInput.value?.focus())
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutside, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="image-insert"
      role="dialog"
      aria-label="插入图片"
      :style="position"
      @keydown="onKeydown"
      @paste="onPaste"
    >
      <button
        type="button"
        class="image-insert-drop"
        :class="{ 'is-dragging': dragging }"
        @click="chooseFile"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 15V4m0 0L8 8m4-4 4 4" />
          <path d="M4 14v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" />
        </svg>
        <strong>选择本地图片</strong>
        <span>也可以拖到这里，或直接 {{ pasteKey }} 粘贴截图</span>
      </button>
      <form class="image-insert-link" @submit.prevent="insertLink">
        <input
          ref="linkInput"
          v-model="url"
          type="text"
          spellcheck="false"
          :placeholder="`粘贴图片链接，或 ${pasteKey} 粘贴剪贴板图片`"
          aria-label="图片链接"
        />
        <button type="submit" :disabled="!validLink">插入</button>
      </form>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        hidden
        data-testid="image-insert-file"
        @change="onFileChange"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.image-insert {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 360px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--raised, var(--panel));
  box-shadow: var(--tn-shadow-2);
  color: var(--text);
  font: 13px/1.4 var(--font-sans);
}

.image-insert-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 18px 12px 16px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.image-insert-drop:hover,
.image-insert-drop:focus-visible,
.image-insert-drop.is-dragging {
  outline: none;
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}

.image-insert-drop svg {
  width: 22px;
  height: 22px;
  margin-bottom: 4px;
  fill: none;
  stroke: var(--muted);
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.image-insert-drop span {
  color: var(--muted);
  font-size: 12px;
}

.image-insert-link {
  display: flex;
  gap: 6px;
}

.image-insert-link input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--input-bg);
  color: inherit;
  font: inherit;
  outline: none;
}

.image-insert-link input:focus {
  border-color: var(--accent);
}

.image-insert-link button {
  flex: none;
  height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.image-insert-link button:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
