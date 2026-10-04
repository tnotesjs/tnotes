<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import type { AssetRecordDto } from '../../../shared/contracts'
import {
  assetThumbSrc,
  canPreviewAsset,
  canPreviewThumb,
  formatBytes,
  kindBadge,
  kindLabel,
  statusLabel
} from './kbAssetsDisplay'

const props = defineProps<{
  assets: AssetRecordDto[]
  /** 未经过筛选的资源总数，用来区分「库中无资源」与「筛选无结果」。 */
  totalCount: number
  loading: boolean
  error: string | null
  selectedPath: string | null
  mode: 'list' | 'grid'
  /** 窄屏切到详情时为 false；用于保存/还原列表滚动位置。 */
  visible: boolean
  suppressThumbs: boolean
  knowledgeBaseId: string
  assetRevision: number
}>()

const emit = defineEmits<{
  (event: 'select', relPath: string): void
  (event: 'clear-filters'): void
  (event: 'retry'): void
}>()

const scrollElement = ref<HTMLElement | null>(null)
let rememberedScrollTop = 0

// 窄屏用 display 切换浏览/详情，元素还在但不再布局，滚动位置会丢；显式记住再还原。
watch(
  () => props.visible,
  (visible, wasVisible) => {
    const element = scrollElement.value
    if (!element || visible === wasVisible) return
    if (!visible) {
      rememberedScrollTop = element.scrollTop
      return
    }
    void nextTick(() => {
      if (scrollElement.value) scrollElement.value.scrollTop = rememberedScrollTop
    })
  }
)

const emptyLibrary = computed(() => props.totalCount === 0 && !props.loading && !props.error)
const filteredEmpty = computed(() => props.totalCount > 0 && props.assets.length === 0)
const scanning = computed(() => props.loading && props.totalCount === 0)

function thumbSrc(relPath: string): string {
  return assetThumbSrc(props.knowledgeBaseId, relPath, props.assetRevision)
}
</script>

<template>
  <div ref="scrollElement" class="kb-assets-browse">
    <div v-if="error" class="browse-feedback error" role="alert">
      <strong>扫描失败</strong>
      <span>{{ error }}</span>
      <button type="button" class="ghost" :disabled="loading" @click="emit('retry')">重试</button>
    </div>

    <div v-else-if="scanning" class="browse-feedback" role="status" aria-live="polite">
      <strong>扫描中…</strong>
      <span>正在盘点当前知识库的资源与引用，完成后自动显示。</span>
    </div>

    <div v-else-if="emptyLibrary" class="browse-feedback">
      <strong>库中无资源</strong>
      <span>这个知识库的 assets 目录里还没有可盘点的文件。</span>
    </div>

    <div v-else-if="filteredEmpty" class="browse-feedback">
      <strong>筛选无结果</strong>
      <span>当前搜索或筛选条件下没有匹配的资源。</span>
      <button type="button" class="ghost" @click="emit('clear-filters')">清除筛选</button>
    </div>

    <ul v-else class="file-list" :class="{ 'asset-grid': mode === 'grid' }">
      <li v-for="asset in assets" :key="asset.relPath">
        <button
          v-if="mode === 'list'"
          type="button"
          class="file-row"
          :class="{ selected: selectedPath === asset.relPath }"
          :aria-pressed="selectedPath === asset.relPath"
          @click="emit('select', asset.relPath)"
        >
          <img
            v-if="!suppressThumbs && canPreviewThumb(asset)"
            class="thumb"
            :src="thumbSrc(asset.relPath)"
            alt=""
            loading="lazy"
            decoding="async"
          />
          <span v-else class="thumb placeholder" aria-hidden="true">{{
            kindBadge(asset.kind)
          }}</span>
          <span class="file-main">
            <span class="file-name" :title="asset.relPath">{{ asset.relPath }}</span>
            <small class="file-sub">
              {{ formatBytes(asset.size) }} · 引用 {{ asset.references.length }} ·
              {{ statusLabel(asset.status) }}
            </small>
          </span>
          <span class="file-size">{{ formatBytes(asset.size) }}</span>
          <span class="file-refs">引用 {{ asset.references.length }}</span>
          <span class="file-status">{{ statusLabel(asset.status) }}</span>
        </button>

        <button
          v-else
          type="button"
          class="file-card"
          :class="{ selected: selectedPath === asset.relPath }"
          :aria-pressed="selectedPath === asset.relPath"
          @click="emit('select', asset.relPath)"
        >
          <span class="card-preview">
            <img
              v-if="!suppressThumbs && canPreviewAsset(asset)"
              :src="thumbSrc(asset.relPath)"
              alt=""
              loading="lazy"
              decoding="async"
            />
            <span v-else class="card-badge">{{ kindBadge(asset.kind) }}</span>
          </span>
          <span class="card-name" :title="asset.relPath">{{ asset.name }}</span>
          <small class="card-meta">
            {{ kindLabel(asset.kind) }} · {{ formatBytes(asset.size) }} · 引用
            {{ asset.references.length }} · {{ statusLabel(asset.status) }}
          </small>
        </button>
      </li>
    </ul>
  </div>
</template>

<style src="./kbAssetsShared.css" scoped></style>

<style scoped>
.kb-assets-browse {
  /* 透明背景用棋盘格表示，不能靠底色猜。 */
  --checker: color-mix(in srgb, var(--text) 10%, transparent);
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
  box-sizing: border-box;
}

.browse-feedback {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: var(--panel);
  padding: 16px;
  font-size: 13px;
  color: var(--muted);
}

.browse-feedback strong {
  color: var(--text);
  font-size: 14px;
}

.browse-feedback.error {
  border-style: solid;
  border-color: color-mix(in srgb, #c44 40%, var(--border));
  color: #c44;
}

.browse-feedback.error strong {
  color: #c44;
}

.file-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.file-list:not(.asset-grid) {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.file-row {
  width: 100%;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) 76px 72px 84px;
  gap: 10px;
  align-items: center;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  padding: 6px 8px;
  cursor: pointer;
  box-sizing: border-box;
}

.file-row.selected,
.file-row:hover {
  border-color: var(--border);
  background: var(--hover, color-mix(in srgb, var(--text) 6%, transparent));
}

.file-main {
  min-width: 0;
}

.file-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-sub {
  display: none;
  color: var(--muted);
  font-size: 11px;
}

.file-size,
.file-refs,
.file-status {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}

.thumb {
  width: 40px;
  height: 40px;
  object-fit: contain;
  border-radius: 4px;
  border: 1px solid var(--border);
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
  background-size: 12px 12px;
  background-position:
    0 0,
    0 6px,
    6px -6px,
    -6px 0;
  flex: none;
}

.thumb.placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-image: none;
  font-size: 12px;
  color: var(--muted);
}

.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 168px), 1fr));
  gap: 10px;
}

.file-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px;
  background: var(--panel);
  color: inherit;
  cursor: pointer;
  box-sizing: border-box;
}

.file-card.selected,
.file-card:hover {
  border-color: var(--accent);
  background: var(--hover, color-mix(in srgb, var(--text) 6%, transparent));
}

.card-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  width: 100%;
  overflow: hidden;
  border-radius: 8px;
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
}

.card-preview img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.card-badge {
  font-size: 20px;
  color: var(--muted);
}

.card-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.card-meta {
  color: var(--muted);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 面板变窄时列表收成「缩略图 + 文件名/元信息两行」，避免固定列把布局撑破。 */
@container kb-assets-pane (max-width: 999.98px) {
  .file-row {
    grid-template-columns: 40px minmax(0, 1fr);
  }

  .file-size,
  .file-refs,
  .file-status {
    display: none;
  }

  .file-sub {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

@container kb-assets-pane (min-width: 1200px) {
  .file-row {
    grid-template-columns: 48px minmax(0, 1fr) 84px 76px 92px;
  }

  .thumb {
    width: 48px;
    height: 48px;
  }
}
</style>
