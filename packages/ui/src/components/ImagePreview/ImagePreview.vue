<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ selector?: string }>(), {
  selector: '.tn-prose img, .vp-doc img'
})
const visible = ref(false)
const images = ref<string[]>([])
const index = ref(0)
const scale = ref(1)
const x = ref(0)
const y = ref(0)
const dragging = ref(false)
const overlay = ref<HTMLElement>()
let pointerStart = { x: 0, y: 0, baseX: 0, baseY: 0 }
let swiperDownX = 0
let previousOverflow = ''
let previousFocus: HTMLElement | null = null

const source = computed(() => images.value[index.value] || '')
const transform = computed(() => `translate(${x.value}px, ${y.value}px) scale(${scale.value})`)

function eligible(image: HTMLImageElement): boolean {
  if (image.dataset.preview === 'false' || image.closest('.tn-preview-ignore, button')) return false
  return !(image.naturalWidth > 0 && image.naturalWidth < 50 && image.naturalHeight < 50)
}

function reset(): void {
  scale.value = 1
  x.value = 0
  y.value = 0
}

function open(image: HTMLImageElement): void {
  const candidates = [...document.querySelectorAll<HTMLImageElement>(props.selector)].filter(
    eligible
  )
  images.value = candidates.map((item) => item.currentSrc || item.src).filter(Boolean)
  const selected = image.currentSrc || image.src
  const selectedIndex = images.value.indexOf(selected)
  index.value = selectedIndex < 0 ? 0 : selectedIndex
  if (selectedIndex < 0 && selected) images.value = [selected]
  if (images.value.length === 0) return
  reset()
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousOverflow = document.documentElement.style.overflow
  document.documentElement.style.overflow = 'hidden'
  visible.value = true
  void nextTick(() => overlay.value?.focus({ preventScroll: true }))
}

function close(): void {
  visible.value = false
  document.documentElement.style.overflow = previousOverflow
  previousFocus?.focus({ preventScroll: true })
}

function move(step: number): void {
  if (images.value.length < 2) return
  index.value = (index.value + step + images.value.length) % images.value.length
  reset()
}

function zoom(factor: number): void {
  scale.value = Math.min(6, Math.max(0.2, scale.value * factor))
}

function resolvePreviewImage(target: EventTarget | null): HTMLImageElement | null {
  if (target instanceof HTMLImageElement) return target
  if (target instanceof Element) {
    return target.closest<HTMLImageElement>('img')
  }
  return null
}

function onDocumentClick(event: MouseEvent): void {
  if (visible.value) return
  const image = resolvePreviewImage(event.target)
  if (!image || !image.matches(props.selector) || !eligible(image)) return
  if (image.closest('.swiper-container') && Math.abs(event.clientX - swiperDownX) > 5) return
  if (image.closest('a')) {
    event.preventDefault()
    event.stopPropagation()
  }
  open(image)
}

function onPreviewRequest(event: Event): void {
  const detail = (event as CustomEvent<HTMLImageElement | { src?: string }>).detail
  if (detail instanceof HTMLImageElement) {
    open(detail)
    return
  }
  const src = detail && typeof detail.src === 'string' ? detail.src : ''
  if (!src) return
  images.value = [src]
  index.value = 0
  reset()
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousOverflow = document.documentElement.style.overflow
  document.documentElement.style.overflow = 'hidden'
  visible.value = true
  void nextTick(() => overlay.value?.focus({ preventScroll: true }))
}

function onKeydown(event: KeyboardEvent): void {
  if (!visible.value) return
  if (event.key === 'Escape') close()
  else if (event.key === 'ArrowLeft') move(-1)
  else if (event.key === 'ArrowRight') move(1)
  else if (event.key === 'ArrowUp' || event.key === '+') zoom(1.1)
  else if (event.key === 'ArrowDown' || event.key === '-') zoom(1 / 1.1)
  else return
  event.preventDefault()
}

function onPointerDown(event: PointerEvent): void {
  dragging.value = true
  pointerStart = {
    x: event.clientX,
    y: event.clientY,
    baseX: x.value,
    baseY: y.value
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp, { once: true })
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return
  x.value = pointerStart.baseX + event.clientX - pointerStart.x
  y.value = pointerStart.baseY + event.clientY - pointerStart.y
}

function onPointerUp(): void {
  dragging.value = false
  window.removeEventListener('pointermove', onPointerMove)
}

function onGlobalPointerDown(event: PointerEvent): void {
  swiperDownX = event.clientX
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true)
  document.addEventListener('tn:preview-image', onPreviewRequest)
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('pointerdown', onGlobalPointerDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick, true)
  document.removeEventListener('tn:preview-image', onPreviewRequest)
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('pointerdown', onGlobalPointerDown, true)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  if (visible.value) document.documentElement.style.overflow = previousOverflow
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="overlay"
      class="tn-image-preview"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      tabindex="-1"
      @click.self="close"
      @wheel.prevent="zoom($event.deltaY < 0 ? 1.1 : 1 / 1.1)"
    >
      <button
        v-if="images.length > 1"
        class="tn-image-preview__previous"
        type="button"
        aria-label="上一张"
        @click="move(-1)"
      >
        ‹
      </button>
      <button
        v-if="images.length > 1"
        class="tn-image-preview__next"
        type="button"
        aria-label="下一张"
        @click="move(1)"
      >
        ›
      </button>
      <div class="tn-image-preview__tools">
        <button type="button" aria-label="缩小" @click="zoom(1 / 1.1)">−</button>
        <button type="button" aria-label="还原" @click="reset">↺</button>
        <button type="button" aria-label="放大" @click="zoom(1.1)">＋</button>
        <button type="button" aria-label="关闭" @click="close">×</button>
      </div>
      <img
        :src="source"
        alt=""
        draggable="false"
        :class="{ 'is-dragging': dragging }"
        :style="{ transform }"
        @pointerdown="onPointerDown"
      />
      <span v-if="images.length > 1" class="tn-image-preview__counter"
        >{{ index + 1 }} / {{ images.length }}</span
      >
    </div>
  </Teleport>
</template>

<style scoped>
.tn-image-preview {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 85%);
  backdrop-filter: blur(4px);
}
.tn-image-preview > img {
  max-width: 90vw;
  max-height: 90vh;
  border-radius: 4px;
  user-select: none;
  cursor: grab;
  transition: transform 100ms ease-out;
}
.tn-image-preview > img.is-dragging {
  cursor: grabbing;
}
.tn-image-preview button {
  display: grid;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 15%);
  border-radius: 8px;
  background: rgb(42 42 42 / 85%);
  color: white;
  cursor: pointer;
  font: 24px/1 var(--tn-font-sans);
}
.tn-image-preview button:hover {
  background: rgb(255 255 255 / 18%);
}
.tn-image-preview button:focus-visible {
  outline: 2px solid var(--tn-c-brand);
  outline-offset: 2px;
}
.tn-image-preview__tools {
  position: absolute;
  z-index: 1;
  top: 16px;
  right: 16px;
  display: flex;
  gap: 8px;
}
.tn-image-preview__tools button {
  width: 38px;
  height: 38px;
}
.tn-image-preview__previous,
.tn-image-preview__next {
  position: absolute;
  z-index: 1;
  top: 50%;
  width: 52px;
  height: 52px;
  border-radius: 50% !important;
  transform: translateY(-50%);
}
.tn-image-preview__previous {
  left: 24px;
}
.tn-image-preview__next {
  right: 24px;
}
.tn-image-preview__counter {
  position: absolute;
  bottom: 20px;
  left: 50%;
  border-radius: 999px;
  background: rgb(0 0 0 / 65%);
  padding: 7px 14px;
  color: white;
  transform: translateX(-50%);
}
</style>
