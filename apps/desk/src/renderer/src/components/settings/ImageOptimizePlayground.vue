<script setup lang="ts">
/**
 * 设置页「压缩效果测试」：拖入 / 点选 / 粘贴一张临时图片，按当前草稿参数试压一次。
 * 数据只在内存里（data: URL + IPC 往返），不落盘、不写任何知识库，关闭面板即丢。
 *
 * 注意：本应用的 CSP 是 `img-src 'self' data: https: tnotes-asset:`，不含 blob:，
 * 所以预览必须用 data: URL；`URL.createObjectURL()` 出来的图会被 CSP 拦成破图。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import ImagePreviewLightbox, { type LightboxItem } from './ImagePreviewLightbox.vue'

import type { AppSettings, ImageOptimizePreviewResult } from '../../../../shared/contracts'

const props = defineProps<{ draft: AppSettings }>()

const MAX_BYTES = 25 * 1024 * 1024
const PICKABLE = /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico|excalidraw)$/i

const rootEl = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const fileName = ref('')
const fileBytes = ref<Uint8Array | null>(null)
const originalSrc = ref('')
const outputSrc = ref('')
const result = ref<ImageOptimizePreviewResult | null>(null)
const busy = ref(false)
const dragging = ref(false)
const error = ref('')

let requestSeq = 0
let debounceTimer: ReturnType<typeof setTimeout> | null = null

const options = computed(() => props.draft.imageUpload.optimize)

const savedPercent = computed(() => {
  const item = result.value
  if (!item?.bytesAfter || !item.bytesBefore) return null
  return Math.round((1 - item.bytesAfter / item.bytesBefore) * 100)
})

function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 全屏查看用的图片清单：原图恒在，优化图只在真的产出时才加入。 */
const lightboxItems = computed<LightboxItem[]>(() => {
  const items: LightboxItem[] = []
  if (originalSrc.value) {
    items.push({
      src: originalSrc.value,
      label: '原图',
      meta: formatBytes(result.value?.bytesBefore ?? 0)
    })
  }
  if (outputSrc.value) {
    const saved = savedPercent.value
    items.push({
      src: outputSrc.value,
      label: '优化后',
      lossy: result.value?.lossy ?? true,
      meta:
        formatBytes(result.value?.bytesAfter ?? 0) +
        (saved !== null && saved > 0 ? ` · -${saved}%` : '')
    })
  }
  return items
})

const lightboxIndex = ref<number | null>(null)

function openLightbox(target: 'original' | 'output'): void {
  const wanted = target === 'original' ? originalSrc.value : outputSrc.value
  if (!wanted) return
  const next = lightboxItems.value.findIndex((item) => item.src === wanted)
  if (next >= 0) lightboxIndex.value = next
}

/** bytes → data: URL（CSP 允许 data:，不允许 blob:）。 */
function toDataUrl(bytes: Uint8Array, mime: string): string {
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'avif') return 'image/avif'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'ico') return 'image/x-icon'
  return 'image/png'
}

function outputMime(payload: ImageOptimizePreviewResult): string {
  // 编码器回传的是扩展名口径（jpg / webp / png），不是 MIME 子类型。
  const format = (payload.format ?? '').toLowerCase()
  if (format === 'jpg' || format === 'jpeg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  if (format === 'png') return 'image/png'
  if (format === 'avif') return 'image/avif'
  if (format === 'gif') return 'image/gif'
  return 'application/octet-stream'
}

async function runPreview(): Promise<void> {
  const bytes = fileBytes.value
  if (!bytes) return
  const mySeq = (requestSeq += 1)
  busy.value = true
  result.value = null
  outputSrc.value = ''
  error.value = ''
  try {
    const response = await window.desk.settings.previewOptimizeImage({
      fileName: fileName.value,
      data: bytes,
      options: {
        ...options.value,
        maxDimension: null,
        ...(options.value.encoder === 'oxipng' ? { outputFormat: 'keep' as const } : {})
      }
    })
    // 滑块又动过：丢弃过期结果，避免旧图盖新图。
    if (mySeq !== requestSeq) return
    if (!response.ok) {
      error.value = response.error.message
      result.value = null
      outputSrc.value = ''
      return
    }
    error.value = ''
    result.value = response.value
    outputSrc.value = response.value.output
      ? toDataUrl(response.value.output, outputMime(response.value))
      : ''
  } catch (cause) {
    if (mySeq === requestSeq) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  } finally {
    if (mySeq === requestSeq) busy.value = false
  }
}

async function pickFile(file: File): Promise<void> {
  error.value = ''
  if (!file.type.startsWith('image/') && !PICKABLE.test(file.name)) {
    error.value = '请选择图片文件'
    return
  }
  if (file.size > MAX_BYTES) {
    error.value = '测试图片不能超过 25 MB'
    return
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  // 截图粘贴常无文件名，或只有 MIME；给一个可读的默认名方便展示。
  fileName.value =
    file.name?.trim() || `paste.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`
  fileBytes.value = bytes
  originalSrc.value = toDataUrl(bytes, file.type || mimeFromName(fileName.value))
  outputSrc.value = ''
  result.value = null
  await runPreview()
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void pickFile(file)
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) void pickFile(file)
}

/** 从剪贴板取出第一张图片（截图粘贴通常是 image/png，且可能没有文件名）。 */
function imageFromClipboard(clipboard: DataTransfer | null): File | null {
  if (!clipboard) return null
  const fromItems = [...(clipboard.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .find((item): item is File => Boolean(item))
  if (fromItems) return fromItems
  return [...(clipboard.files ?? [])].find((file) => file.type.startsWith('image/')) ?? null
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * 组件挂载期间接管 Cmd/Ctrl+V：有图片就试压。
 * 焦点在设置页的文本输入里时不抢粘贴，避免干扰 Token / 仓库等字段。
 */
function onDocumentPaste(event: ClipboardEvent): void {
  if (isTypingTarget(event.target)) return
  // 设置面板可能叠着别的对话框；组件已卸载或节点不在文档里时忽略。
  if (!rootEl.value?.isConnected) return
  const image = imageFromClipboard(event.clipboardData)
  if (!image) return
  event.preventDefault()
  void pickFile(image)
}

function clearFile(): void {
  requestSeq += 1
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  fileName.value = ''
  fileBytes.value = null
  originalSrc.value = ''
  outputSrc.value = ''
  result.value = null
  error.value = ''
  busy.value = false
}

// 参数跟随上方草稿：松开后按编码器防抖再编码（oxipng 慢，给 1s；sharp 给 0.35s）。
watch(
  () => [options.value.encoder, options.value.strength, options.value.outputFormat] as const,
  () => {
    if (!fileBytes.value) return
    requestSeq += 1
    result.value = null
    outputSrc.value = ''
    error.value = ''
    busy.value = true
    if (debounceTimer) clearTimeout(debounceTimer)
    const delay = options.value.encoder === 'oxipng' ? 1000 : 350
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void runPreview()
    }, delay)
  }
)

onMounted(() => {
  window.addEventListener('paste', onDocumentPaste)
})

onBeforeUnmount(() => {
  window.removeEventListener('paste', onDocumentPaste)
  requestSeq += 1
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>

<template>
  <div ref="rootEl" class="sub-block optimize-playground">
    <header class="sub-heading">
      <strong>压缩效果测试</strong>
      <span>拖入、点选或粘贴一张图试压；仅本地测试，不写入任何知识库</span>
    </header>

    <div
      class="drop-zone"
      :class="{ dragging, filled: Boolean(fileName) }"
      tabindex="0"
      @dragenter.prevent="dragging = true"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
      @click="fileInput?.click()"
    >
      <input
        ref="fileInput"
        class="hidden-input"
        type="file"
        accept="image/*"
        @change="onFileChange"
      />
      <template v-if="!fileName">
        <span class="drop-title">点击、拖入或粘贴一张图片</span>
        <span class="drop-sub">
          PNG / JPEG / WebP，≤ 25 MB；支持 Cmd/Ctrl+V；GIF、SVG、.excalidraw 会直接跳过
        </span>
      </template>
      <template v-else>
        <span class="drop-title">{{ fileName }}</span>
        <span class="drop-sub">
          {{ formatBytes(result?.bytesBefore ?? 0) }} · 点击可换一张，也可再粘贴
        </span>
      </template>
    </div>

    <p v-if="error" class="warn-hint">{{ error }}</p>

    <div v-if="fileName" class="compare">
      <figure>
        <figcaption>原图</figcaption>
        <img
          v-if="originalSrc"
          class="zoomable"
          :src="originalSrc"
          alt="原图"
          title="点击放大查看"
          @click="openLightbox('original')"
        />
      </figure>
      <figure>
        <figcaption>
          优化后
          <span
            :class="
              (result ? !result.lossy : options.encoder === 'oxipng')
                ? 'lossless-badge'
                : 'lossy-badge'
            "
          >
            {{ (result ? !result.lossy : options.encoder === 'oxipng') ? '无损' : '有损' }}
          </span>
          <span v-if="busy" class="busy">
            {{ options.encoder === 'oxipng' ? '无损优化中…（较慢）' : '编码中…' }}
          </span>
        </figcaption>
        <img
          v-if="outputSrc"
          class="zoomable"
          :src="outputSrc"
          alt="优化后"
          title="点击放大查看"
          @click="openLightbox('output')"
        />
        <div v-else class="placeholder">
          {{
            busy
              ? options.encoder === 'oxipng'
                ? '无损优化中…（较慢）'
                : '编码中…'
              : '暂无优化结果'
          }}
        </div>
      </figure>
    </div>

    <ImagePreviewLightbox
      v-if="lightboxIndex !== null"
      :items="lightboxItems"
      :start-index="lightboxIndex"
      @close="lightboxIndex = null"
    />

    <ul v-if="fileName && result" class="stats">
      <li>
        原图 <b>{{ formatBytes(result.bytesBefore) }}</b>
      </li>
      <li v-if="result.bytesAfter !== undefined">
        优化后 <b>{{ formatBytes(result.bytesAfter) }}</b>
      </li>
      <li
        v-if="savedPercent !== null"
        :class="savedPercent > 0 ? 'good' : 'bad'"
        data-testid="saved-percent"
      >
        体积 <b>{{ savedPercent > 0 ? `-${savedPercent}%` : `+${Math.abs(savedPercent)}%` }}</b>
      </li>
      <li v-if="result.format">
        格式 <b>{{ result.format }}</b>
      </li>
      <li v-if="result.width">
        尺寸 <b>{{ result.width }}×{{ result.height }}</b>
      </li>
      <li>
        耗时 <b>{{ result.ms }} ms</b>
      </li>
    </ul>

    <p v-if="result?.skipped" class="warn-hint">本次未生成优化图：{{ result.skipped }}</p>

    <div v-if="fileName" class="playground-actions">
      <button type="button" class="btn-ghost" @click="clearFile">清除测试图片</button>
    </div>
  </div>
</template>

<style src="./settingsShared.css" scoped></style>

<style scoped>
.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 76px;
  border: 1px dashed var(--border-strong);
  border-radius: 9px;
  background: var(--panel);
  cursor: pointer;
  padding: 12px;
  text-align: center;
}

.drop-zone.dragging,
.drop-zone:hover {
  border-color: var(--accent);
  background: var(--hover);
}

.drop-zone.filled {
  border-style: solid;
}

.hidden-input {
  display: none;
}

.drop-title {
  color: var(--text);
  font-size: 11px;
  word-break: break-all;
}

.drop-sub {
  color: var(--muted);
  font-size: 9px;
}

.compare {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
}

.compare figure {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.compare figcaption {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 9px;
}

.compare img,
.compare .placeholder {
  width: 100%;
  height: 132px;
  object-fit: contain;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
}

.compare .placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 10px;
}

.compare img.zoomable {
  cursor: zoom-in;
}

.lossy-badge {
  border: 1px solid var(--accent);
  border-radius: 5px;
  color: var(--accent);
  padding: 0 5px;
  font-size: 9px;
}

.lossless-badge {
  border: 1px solid var(--muted);
  border-radius: 5px;
  color: var(--muted);
  padding: 0 5px;
  font-size: 9px;
}

.busy {
  color: var(--accent);
  font-size: 9px;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  color: var(--muted);
  font-size: 10px;
}

.stats b {
  color: var(--text);
}

.stats .good b {
  color: var(--accent);
}

.stats .bad b {
  color: var(--danger);
}

.playground-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}

.playground-actions .btn-ghost {
  margin-left: 0;
}
</style>
