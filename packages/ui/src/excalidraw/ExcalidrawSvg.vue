<script setup lang="ts">
/**
 * 共享只读画布：Desk 笔记卡片与 SSG 站点共用。
 *
 * 约束（计划 E2）：
 * - 只读：不挂载可编辑实例、不写任何文件
 * - 明暗跟随宿主，但只影响显示，不改磁盘 appState
 * - 导出能力懒加载：首屏不引入 Excalidraw
 * - 过期结果丢弃；卸载时释放 data URL 与观察器
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { createExcalidrawSvgRenderer } from './renderer'

const props = withDefaults(
  defineProps<{
    /** 磁盘上的原始 JSON（唯一真相源） */
    content: string
    /** 不传则跟随宿主的 .dark 类 */
    theme?: 'light' | 'dark'
    height?: number | string
    /** 无障碍描述 */
    label?: string
  }>(),
  { theme: undefined, height: 480, label: 'Excalidraw 绘图' }
)

const resolvedTheme = ref<'light' | 'dark'>(props.theme ?? 'light')
let observer: MutationObserver | null = null

const renderer = createExcalidrawSvgRenderer({
  getContent: () => props.content,
  getTheme: () => resolvedTheme.value
})

const { state, errorReason, dataUrl } = renderer
const heightStyle = computed(() =>
  typeof props.height === 'number' ? `${props.height}px` : props.height
)

function readHostTheme(): 'light' | 'dark' {
  if (props.theme) return props.theme
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

onMounted(() => {
  resolvedTheme.value = readHostTheme()
  void renderer.render()
  // SSG 通过切换 <html class="dark"> 换主题；这里只跟随显示，不写任何文件
  if (!props.theme && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      const next = readHostTheme()
      if (next !== resolvedTheme.value) resolvedTheme.value = next
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  renderer.dispose()
})

watch(
  () => props.content,
  () => void renderer.render()
)
watch(resolvedTheme, () => void renderer.render())

defineExpose({ state, errorReason })
</script>

<template>
  <div class="tn-excalidraw-view" :style="{ height: heightStyle }" :data-state="state">
    <img
      v-if="state === 'ready'"
      class="tn-excalidraw-view__image"
      :src="dataUrl"
      :alt="label"
      loading="lazy"
      decoding="async"
    />
    <div
      v-else-if="state === 'error'"
      class="tn-excalidraw-view__placeholder"
      role="img"
      :aria-label="label"
    >
      <span>无法显示画布</span>
      <small>{{ errorReason }}</small>
    </div>
    <div v-else class="tn-excalidraw-view__placeholder" :aria-busy="state === 'loading'">
      <span>画布加载中…</span>
    </div>
  </div>
</template>

<style scoped>
.tn-excalidraw-view {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 4px;
  background: var(--tn-excalidraw-bg, transparent);
}
.tn-excalidraw-view__image {
  max-width: 100%;
  max-height: 100%;
  border-radius: 4px;
  object-fit: contain;
}
.tn-excalidraw-view__placeholder {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  justify-content: center;
  color: var(--tn-muted, #8a8a8a);
  font-size: 13px;
}
</style>
