<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'

import { writeClipboardText } from '../clipboardText'

import type { AssetRecordDto, AssetReferenceDto } from '../../../shared/contracts'
import {
  assetThumbSrc,
  canPreviewAsset,
  formatBytes,
  kindLabel,
  protectionLabel,
  statusLabel
} from './kbAssetsDisplay'

const props = defineProps<{
  asset: AssetRecordDto
  knowledgeBaseId: string
  assetRevision: number
  /** 同笔记可合并重复组的大小；null 表示不可合并。 */
  mergeGroupSize: number | null
  renameBlock: string
  writeBusy: boolean
  /** 窄屏才提供「返回资源」。 */
  showBack: boolean
  /** 当前选中项是否还在筛选结果里；被筛掉时给出明确提示。 */
  inFilteredResults: boolean
  suppressThumbs: boolean
}>()

const emit = defineEmits<{
  (event: 'back'): void
  (event: 'rename'): void
  (event: 'merge'): void
  (event: 'optimize'): void
  (event: 'recycle'): void
  (event: 'open-reference', reference: AssetReferenceDto): void
}>()

const zoomOpen = ref(false)
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
const nameId = useId()
let copyResetTimer: ReturnType<typeof setTimeout> | null = null

const previewSrc = computed(() =>
  assetThumbSrc(props.knowledgeBaseId, props.asset.relPath, props.assetRevision)
)
const previewable = computed(() => canPreviewAsset(props.asset))

/*
 * 放大层是全屏模态：打开时把焦点移进去，Tab / Shift+Tab 限制在层内，Esc 关闭，
 * 关闭后把焦点还给触发它的那个按钮。
 *
 * 为什么没复用现成的浮层：仓库里的图片浮层（settings/ImagePreviewLightbox.vue、
 * @tnotesjs/ui 的 ImagePreview）都只做 Teleport + role="dialog" + Esc，
 * 没有焦点陷阱；它们各自还被设置页 / 预览页复用，直接改会波及别的入口。
 * 这里沿用同一套约定（Teleport + aria-modal + 文档级 keydown），只补上缺失的焦点管理。
 */
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

const lightboxElement = ref<HTMLElement | null>(null)
let zoomTrigger: HTMLElement | null = null

function focusableElements(): HTMLElement[] {
  const root = lightboxElement.value
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
}

function openZoom(trigger: EventTarget | null): void {
  zoomTrigger = trigger instanceof HTMLElement ? trigger : null
  zoomOpen.value = true
  void nextTick(() => {
    // 先聚焦浮层本身，读屏会念出 aria-labelledby 指到的文件名。
    lightboxElement.value?.focus()
  })
}

function closeZoom(): void {
  if (!zoomOpen.value) return
  zoomOpen.value = false
  const trigger = zoomTrigger
  zoomTrigger = null
  void nextTick(() => {
    // 触发按钮可能随选中资源一起消失，只有还在文档里才还原焦点。
    if (trigger && document.contains(trigger)) trigger.focus()
  })
}

function onLightboxKeydown(event: KeyboardEvent): void {
  if (!zoomOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeZoom()
    return
  }
  if (event.key !== 'Tab') return
  const focusables = focusableElements()
  if (focusables.length === 0) {
    event.preventDefault()
    lightboxElement.value?.focus()
    return
  }
  const current = document.activeElement as HTMLElement | null
  const index = current ? focusables.indexOf(current) : -1
  // 焦点在层外（例如点了不可聚焦的图片）时，Tab 也要先回到层内的端点。
  if (index === -1) {
    event.preventDefault()
    ;(event.shiftKey ? focusables[focusables.length - 1] : focusables[0])?.focus()
    return
  }
  const atStart = index === 0
  const atEnd = index === focusables.length - 1
  if ((event.shiftKey && atStart) || (!event.shiftKey && atEnd)) {
    event.preventDefault()
    ;(event.shiftKey ? focusables[focusables.length - 1] : focusables[0])?.focus()
  }
}

watch(
  () => props.asset.relPath,
  () => {
    closeZoom()
    copyState.value = 'idle'
  }
)

onMounted(() => {
  // 焦点可能落在浮层外的不可聚焦元素上（此时 keydown 不会冒泡到浮层内），
  // 所以和既有浮层一致，用文档级监听。
  document.addEventListener('keydown', onLightboxKeydown, true)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onLightboxKeydown, true)
  if (copyResetTimer) clearTimeout(copyResetTimer)
})

async function copyPath(): Promise<void> {
  // 只调 `navigator.clipboard` 在 Desk 里必然失败（权限请求被主进程拒绝），
  // 统一走带同步兜底的 writeClipboardText
  copyState.value = (await writeClipboardText(props.asset.relPath)) ? 'copied' : 'failed'
  if (copyResetTimer) clearTimeout(copyResetTimer)
  copyResetTimer = setTimeout(() => {
    copyState.value = 'idle'
  }, 2000)
}
</script>

<template>
  <aside class="detail" aria-label="资源详情">
    <button v-if="showBack" type="button" class="ghost detail-back" @click="emit('back')">
      ← 返回资源
    </button>

    <p v-if="!inFilteredResults" class="detail-notice" role="status">
      当前资源不在筛选结果中：它仍被选中并保留在详情里，但已被搜索或筛选隐藏。
    </p>

    <section class="detail-block preview-block">
      <button
        v-if="previewable && !suppressThumbs"
        type="button"
        class="preview-frame"
        :aria-label="`放大预览 ${asset.name}`"
        @click="openZoom($event.currentTarget)"
      >
        <img class="preview-image" :src="previewSrc" :alt="asset.name" decoding="async" />
      </button>
      <div v-else class="preview-frame preview-placeholder">
        <span class="preview-badge" aria-hidden="true">{{ kindLabel(asset.kind) }}</span>
        <span class="hint">
          {{
            suppressThumbs
              ? '写入进行中，暂停预览以免请求已移动的路径。'
              : '该类型没有内嵌预览；可用下方操作打开或在本机查看。'
          }}
        </span>
      </div>
      <p v-if="previewable && !suppressThumbs" class="preview-tools">
        <button type="button" class="ghost preview-zoom" @click="openZoom($event.currentTarget)">
          放大
        </button>
        <span class="hint">透明区域以棋盘格显示；点预览也可放大，不裁切。</span>
      </p>
    </section>

    <section class="detail-block">
      <h3 :id="nameId" class="detail-name" :title="asset.relPath">{{ asset.name }}</h3>
      <p class="detail-path">
        <code class="asset-path">{{ asset.relPath }}</code>
        <button type="button" class="linkish copy-path" @click="copyPath">
          {{ copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制路径' }}
        </button>
      </p>
      <p class="detail-meta">
        {{ kindLabel(asset.kind) }} · {{ formatBytes(asset.size) }} ·
        {{ statusLabel(asset.status) }}
      </p>
      <p v-if="asset.protection.length" class="hint">
        保护原因：{{ asset.protection.map(protectionLabel).join('、') }}
      </p>
      <p class="hint" data-asset-rename-state>
        <template v-if="asset.renameAllowed">重命名：可生成重命名计划</template>
        <template v-else>重命名：已阻止（{{ renameBlock }}）</template>
      </p>
      <p v-if="mergeGroupSize" class="hint">
        同笔记内容重复 {{ mergeGroupSize }} 个，可合并到当前文件。
      </p>
    </section>

    <section class="detail-block">
      <h4>操作</h4>
      <div class="detail-actions">
        <button
          type="button"
          class="save-button"
          data-asset-rename
          :disabled="writeBusy || !asset.renameAllowed"
          :title="renameBlock"
          @click="emit('rename')"
        >
          重命名
        </button>
        <button
          type="button"
          class="ghost"
          :disabled="writeBusy || !mergeGroupSize"
          @click="emit('merge')"
        >
          合并重复
        </button>
        <button
          v-if="asset.kind !== 'excalidraw'"
          type="button"
          class="ghost"
          :disabled="writeBusy || asset.kind !== 'image'"
          @click="emit('optimize')"
        >
          有损压缩
        </button>
        <button type="button" class="ghost" :disabled="writeBusy" @click="emit('recycle')">
          移入回收区
        </button>
      </div>
    </section>

    <section class="detail-block">
      <h4>引用位置</h4>
      <ul v-if="asset.references.length" class="refs">
        <li v-for="(item, index) in asset.references" :key="index">
          <code>{{ item.sourceRelPath }}:{{ item.line }}</code>
          · {{ item.syntax }}
          <button
            v-if="item.noteUuid"
            type="button"
            class="linkish"
            @click="emit('open-reference', item)"
          >
            打开笔记
          </button>
        </li>
      </ul>
      <p v-else class="hint">没有已解析的确定引用。</p>
      <p class="hint">未覆盖来源见「诊断」。部分扫描不能当成全库无引用。</p>
    </section>

    <Teleport to="body">
      <div
        v-if="zoomOpen"
        ref="lightboxElement"
        class="preview-lightbox"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="nameId"
        tabindex="-1"
        @click.self="closeZoom"
      >
        <img class="lightbox-image" :src="previewSrc" :alt="asset.name" />
        <button type="button" class="ghost lightbox-close" @click="closeZoom">关闭</button>
      </div>
    </Teleport>
  </aside>
</template>

<style src="./kbAssetsShared.css" scoped></style>

<style scoped>
.detail {
  /* 透明背景用棋盘格表示，不能靠底色猜。 */
  --checker: color-mix(in srgb, var(--text) 10%, transparent);
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  background: var(--panel);
  box-sizing: border-box;
}

.detail-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail-back {
  align-self: flex-start;
}

.detail-notice {
  margin: 0;
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--warning-soft);
  color: var(--warning);
  font-size: 12px;
}

.detail h4 {
  margin: 0;
}

.detail-name {
  margin: 0;
  font-size: 15px;
  overflow-wrap: anywhere;
}

.detail-path {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  min-width: 0;
}

.asset-path {
  min-width: 0;
  /* 完整路径允许换行，长路径不许把面板撑破。 */
  overflow-wrap: anywhere;
  word-break: break-all;
  white-space: pre-wrap;
  color: var(--muted);
  font-size: 12px;
}

.detail-meta {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.preview-frame {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  min-height: 120px;
  /* 长图限制预览高度，完整可用「放大」看。 */
  max-height: 260px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  background-color: var(--input-bg);
  background-image:
    linear-gradient(
      45deg,
      var(--checker, color-mix(in srgb, var(--text) 10%, transparent)) 25%,
      transparent 25%
    ),
    linear-gradient(
      -45deg,
      var(--checker, color-mix(in srgb, var(--text) 10%, transparent)) 25%,
      transparent 25%
    ),
    linear-gradient(
      45deg,
      transparent 75%,
      var(--checker, color-mix(in srgb, var(--text) 10%, transparent)) 75%
    ),
    linear-gradient(
      -45deg,
      transparent 75%,
      var(--checker, color-mix(in srgb, var(--text) 10%, transparent)) 75%
    );
  background-size: 16px 16px;
  background-position:
    0 0,
    0 8px,
    8px -8px,
    -8px 0;
  box-sizing: border-box;
}

button.preview-frame {
  cursor: zoom-in;
}

.preview-image {
  max-width: 100%;
  max-height: 240px;
  /* 统一比例完整显示，不默认裁切截图 / 图表。 */
  object-fit: contain;
}

.preview-placeholder {
  background-image: none;
  cursor: default;
  text-align: center;
}

.preview-badge {
  font-size: 13px;
  color: var(--text);
}

.preview-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
}

.preview-zoom {
  flex: none;
  padding: 4px 12px;
  font-size: 12px;
}

.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.copy-path {
  flex: none;
  font-size: 12px;
}

.preview-lightbox {
  /* Teleport 到 body 后不再继承 .detail 上的变量：这里重新定义，
     下面用 var() 的地方也都带兜底值，挪动 DOM 时不会静默失效。 */
  --checker: color-mix(in srgb, var(--text) 10%, transparent);
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  background: color-mix(in srgb, #000 70%, transparent);
}

.lightbox-image {
  max-width: min(1200px, 92vw);
  max-height: 78vh;
  object-fit: contain;
  border-radius: 8px;
  background-color: var(--panel);
  background-image:
    linear-gradient(
      45deg,
      var(--checker, color-mix(in srgb, var(--text) 10%, transparent)) 25%,
      transparent 25%
    ),
    linear-gradient(
      -45deg,
      var(--checker, color-mix(in srgb, var(--text) 10%, transparent)) 25%,
      transparent 25%
    ),
    linear-gradient(
      45deg,
      transparent 75%,
      var(--checker, color-mix(in srgb, var(--text) 10%, transparent)) 75%
    ),
    linear-gradient(
      -45deg,
      transparent 75%,
      var(--checker, color-mix(in srgb, var(--text) 10%, transparent)) 75%
    );
  background-size: 16px 16px;
  background-position:
    0 0,
    0 8px,
    8px -8px,
    -8px 0;
}

.lightbox-close {
  flex: none;
}
</style>
