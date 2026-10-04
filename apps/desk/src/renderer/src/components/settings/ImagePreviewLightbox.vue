<script setup lang="ts">
/**
 * 全屏图片查看浮层（供设置页压缩对比使用）。
 * 切换：鼠标左键 → 下一张、右键 → 上一张；同时支持 ← / → 方向键与浮层内按钮。
 * 关闭：Esc 或点击空白处。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface LightboxItem {
  src: string
  label: string
  meta?: string
  lossy?: boolean
}

const props = defineProps<{ items: LightboxItem[]; startIndex?: number }>()
const emit = defineEmits<{ close: [] }>()

const index = ref(Math.min(Math.max(props.startIndex ?? 0, 0), Math.max(props.items.length - 1, 0)))
const current = computed<LightboxItem | null>(() => props.items[index.value] ?? null)
const hasMultiple = computed(() => props.items.length > 1)

function next(): void {
  if (!hasMultiple.value) return
  index.value = (index.value + 1) % props.items.length
}

function prev(): void {
  if (!hasMultiple.value) return
  index.value = (index.value - 1 + props.items.length) % props.items.length
}

function close(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    next()
    return
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    prev()
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      class="image-lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="current?.label ?? '图片预览'"
      @click.self="close"
      @wheel.prevent
    >
      <button
        v-if="hasMultiple"
        type="button"
        class="nav-arrow prev"
        aria-label="上一张"
        @click.stop="prev"
      >
        ‹
      </button>

      <figure class="stage">
        <img
          v-if="current"
          :src="current.src"
          :alt="current.label"
          @click.stop="next"
          @contextmenu.prevent.stop="prev"
        />
        <figcaption>
          <strong>{{ current?.label }}</strong>
          <span
            v-if="typeof current?.lossy === 'boolean'"
            :class="current.lossy ? 'lossy-badge' : 'lossless-badge'"
          >
            {{ current.lossy ? '有损' : '无损' }}
          </span>
          <span v-if="current?.meta" class="meta">{{ current.meta }}</span>
          <span v-if="hasMultiple" class="counter">{{ index + 1 }} / {{ items.length }}</span>
        </figcaption>
      </figure>

      <button
        v-if="hasMultiple"
        type="button"
        class="nav-arrow next"
        aria-label="下一张"
        @click.stop="next"
      >
        ›
      </button>

      <p v-if="hasMultiple" class="hint">左键 下一张 · 右键 上一张 · ← / → 切换 · Esc 关闭</p>
    </div>
  </Teleport>
</template>

<style scoped>
.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 2400;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 36px 56px 56px;
  background: color-mix(in srgb, var(--panel-strong, #101014) 88%, transparent);
  backdrop-filter: blur(3px);
}

.stage {
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  max-height: 100%;
}

.stage img {
  max-width: 100%;
  max-height: calc(100vh - 140px);
  object-fit: contain;
  border-radius: 4px;
  background: var(--panel);
  cursor: pointer;
  box-shadow: 0 18px 48px rgb(0 0 0 / 45%);
}

.stage figcaption {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #e8e8e8;
  font-size: 11px;
}

.stage .meta,
.stage .counter {
  color: #a9a9a9;
  font-size: 10px;
}

.lossy-badge {
  border: 1px solid var(--accent);
  border-radius: 5px;
  color: var(--accent);
  padding: 0 5px;
  font-size: 9px;
}

.lossless-badge {
  border: 1px solid rgb(255 255 255 / 30%);
  border-radius: 5px;
  color: #cfcfcf;
  padding: 0 5px;
  font-size: 9px;
}

.nav-arrow {
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border: 1px solid rgb(255 255 255 / 22%);
  border-radius: 50%;
  background: rgb(0 0 0 / 35%);
  color: #e8e8e8;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.nav-arrow:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.hint {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  margin: 0;
  color: #9a9a9a;
  font-size: 10px;
}
</style>
