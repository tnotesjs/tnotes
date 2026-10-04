<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useSlots, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** ISO-ish datetime parts: [y, m, d?, h?, min?, s?] */
    times?: number[]
    /** Text paragraphs when not using `#text-area` slot. */
    paragraphs?: string[]
    /** Image URLs when not using `#image-list` slot. */
    images?: string[]
    /** Footer / other info plain text when not using `#other-info` slot. */
    otherInfo?: string
  }>(),
  {
    times: () => [],
    paragraphs: () => [],
    images: () => [],
    otherInfo: ''
  }
)

const slots = useSlots()
const textEl = ref<HTMLElement | null>(null)
const imageEl = ref<HTMLElement | null>(null)

const isCollapsed = ref(true)
const isExpandable = ref(false)
const isModalVisible = ref(false)
const currentIndex = ref(0)
const slottedImages = ref<string[]>([])

const useTextSlot = computed(() => !!slots['text-area'])
const useImageSlot = computed(() => !!slots['image-list'])
const useOtherSlot = computed(() => !!slots['other-info'])

const resolvedImages = computed(() =>
  useImageSlot.value ? slottedImages.value : (props.images ?? [])
)
const currentImage = computed(() => resolvedImages.value[currentIndex.value] ?? '')

const imageLayoutClass = computed(() => {
  const n = resolvedImages.value.length
  if (n === 1) return 'fp-layout-1'
  if (n === 2) return 'fp-layout-2'
  if (n === 4) return 'fp-layout-4'
  if (n >= 3) return 'fp-layout-grid'
  return ''
})

const formattedTime = computed(() => {
  const times = props.times ?? []
  if (times.length < 2) return ''
  const [year, month, day, hour, minute, second] = times
  const datePart = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
  const dayPart = day !== undefined ? `-${String(day).padStart(2, '0')}` : ''
  let timePart = ''
  if (hour !== undefined && minute !== undefined && second !== undefined) {
    timePart = ` ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
  } else if (hour !== undefined && minute !== undefined) {
    timePart = ` ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }
  let daysSinceBirthday = ''
  if (day !== undefined) {
    const birthday = new Date(Date.UTC(1999, 5, 29))
    const currentDate = new Date(Date.UTC(year, month - 1, day))
    const diffInDays =
      Math.floor((currentDate.getTime() - birthday.getTime()) / (1000 * 60 * 60 * 24)) + 1
    daysSinceBirthday = `👣 ${diffInDays} | `
  }
  return daysSinceBirthday + datePart + dayPart + timePart
})

function openModal(index: number) {
  currentIndex.value = index
  isModalVisible.value = true
}
function closeModal() {
  isModalVisible.value = false
}
function toggleCollapse() {
  isCollapsed.value = !isCollapsed.value
}

function refreshTextExpandable() {
  if (useTextSlot.value) {
    isExpandable.value = (textEl.value?.children.length ?? 0) > 2
    return
  }
  isExpandable.value = (props.paragraphs?.length ?? 0) > 2
}

function refreshSlottedImages() {
  if (!useImageSlot.value || !imageEl.value) {
    slottedImages.value = []
    return
  }
  const imgs = imageEl.value.querySelectorAll('img')
  slottedImages.value = Array.from(imgs).map((img) => img.currentSrc || img.src)
}

function handleKeyDown(event: KeyboardEvent) {
  if (!isModalVisible.value) return
  if (event.key === 'ArrowLeft' && currentIndex.value > 0) currentIndex.value -= 1
  if (event.key === 'ArrowRight' && currentIndex.value < resolvedImages.value.length - 1)
    currentIndex.value += 1
  if (event.key === 'Escape') closeModal()
}

function refresh() {
  nextTick(() => {
    refreshTextExpandable()
    refreshSlottedImages()
  })
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
  refresh()
})
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeyDown))

watch(
  () => [props.paragraphs, props.images, slots['text-area'], slots['image-list']],
  () => {
    isCollapsed.value = true
    refresh()
  }
)
</script>

<template>
  <!-- tn-preview-ignore: opt out of Layout ImagePreview so only the in-component modal opens -->
  <div class="tn-footprints tn-preview-ignore">
    <div class="tn-footprints__text">
      <div ref="textEl" class="tn-footprints__text-body" :class="{ 'is-collapsed': isCollapsed }">
        <slot name="text-area">
          <p v-for="(line, i) in paragraphs" :key="i">{{ line }}</p>
        </slot>
      </div>
      <button
        v-if="isExpandable"
        type="button"
        class="tn-footprints__toggle"
        @click="toggleCollapse"
      >
        {{ isCollapsed ? '全文' : '收起' }}
      </button>
    </div>

    <div
      v-if="useImageSlot || images.length"
      ref="imageEl"
      class="tn-footprints__images"
      :class="imageLayoutClass"
    >
      <slot name="image-list" :open-modal="openModal">
        <button
          v-for="(src, index) in images"
          :key="`${src}-${index}`"
          type="button"
          class="tn-footprints__image-btn"
          @click="openModal(index)"
        >
          <img :src="src" alt="" />
        </button>
      </slot>
    </div>

    <div v-show="isModalVisible" class="tn-footprints__modal" @click.self="closeModal">
      <button type="button" class="tn-footprints__modal-close" @click="closeModal">&times;</button>
      <img class="tn-footprints__modal-img" :src="currentImage" alt="Preview" />
    </div>

    <div v-if="formattedTime" class="tn-footprints__time">
      <p>{{ formattedTime }}</p>
    </div>
    <div v-if="useOtherSlot || otherInfo" class="tn-footprints__other">
      <slot name="other-info">
        <p>{{ otherInfo }}</p>
      </slot>
    </div>
  </div>
</template>

<style scoped lang="scss">
.tn-footprints {
  margin: 1rem 0;
  padding: 12px 16px;
  border: 1px solid var(--tn-c-divider);
  border-radius: 8px;
  color: var(--tn-c-text);
}

.tn-footprints__text {
  position: relative;
  margin-bottom: 1rem;
}

.tn-footprints__text-body {
  overflow: hidden;

  :deep(p) {
    display: block;
    margin: 0 0 0.5rem;
  }

  &.is-collapsed > :nth-child(n + 3) {
    display: none;
  }
}

.tn-footprints__toggle {
  display: block;
  margin-top: 0.5rem;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--tn-c-brand, #007bff);
  cursor: pointer;
  font-size: 1rem;
  text-align: left;

  &:hover {
    text-decoration: underline;
  }
}

/* 朋友圈式网格：slot 里的 img 常被 Markdown 包在 p/a 中 */
.tn-footprints__images {
  display: grid;
  gap: 4px;
  width: 100%;

  :deep(> *) {
    margin: 0;
    min-width: 0;
  }

  :deep(p) {
    margin: 0;
    line-height: 0;
  }

  :deep(a) {
    display: block;
    line-height: 0;
  }

  :deep(img) {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    display: block;
    margin: 0;
    cursor: pointer;
    vertical-align: top;
    border-radius: 4px;
  }
}

.tn-footprints__image-btn {
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}

.fp-layout-1 {
  grid-template-columns: 1fr;
  max-width: 280px;

  :deep(img) {
    width: auto;
    max-width: 100%;
    max-height: 360px;
    aspect-ratio: auto;
  }
}
.fp-layout-2 {
  grid-template-columns: repeat(2, 1fr);
  max-width: 360px;
}
.fp-layout-4 {
  grid-template-columns: repeat(2, 1fr);
  max-width: 360px;
}
.fp-layout-grid {
  grid-template-columns: repeat(3, 1fr);
  max-width: 480px;
}

.tn-footprints__modal {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.85);
}

.tn-footprints__modal-close {
  position: absolute;
  top: 16px;
  right: 24px;
  border: none;
  background: transparent;
  color: #fff;
  font-size: 2rem;
  cursor: pointer;
}

.tn-footprints__modal-img {
  max-width: min(92vw, 960px);
  max-height: 88vh;
  border-radius: 4px;
  object-fit: contain;
}

.tn-footprints__time,
.tn-footprints__other {
  font-size: 0.8rem;
  color: var(--tn-c-text-2, gray);

  :deep(p) {
    margin: 0.25rem 0;
  }
}
</style>
