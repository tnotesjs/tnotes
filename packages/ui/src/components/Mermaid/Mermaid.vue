<template>
  <div
    ref="rootRef"
    class="tn-mermaid"
    :class="{ 'is-centered': centered, 'is-fullscreen': isFullscreen }"
  >
    <div
      v-if="showActions"
      class="tn-mermaid__actions"
      :class="{ 'is-suppressed': loading || !!error || empty }"
      :data-copy-state="copyState"
    >
      <slot name="actions-start" />
      <button
        v-if="enableCenterToggle"
        type="button"
        class="tn-mermaid__action"
        :title="centered ? '取消居中' : '居中显示'"
        :aria-pressed="centered ? 'true' : 'false'"
        @click="toggleCenter"
      >
        <img :src="centered ? iconCenterOn : iconCenterOff" alt="" width="16" height="16" />
      </button>
      <button
        v-if="enableFullscreen"
        type="button"
        class="tn-mermaid__action"
        :title="isFullscreen ? '退出全屏' : '全屏查看图表'"
        @click="toggleFullscreen"
      >
        <img
          :src="isFullscreen ? iconFullscreenExit : iconFullscreen"
          :alt="isFullscreen ? '退出全屏' : '全屏'"
          width="16"
          height="16"
        />
      </button>
      <button
        v-if="enableCopy"
        type="button"
        class="tn-mermaid__action tn-mermaid__action--copy"
        :data-copy-state="copyState"
        :title="copyTitle"
        @click="copySource"
      >
        <img :src="copyIcon" alt="复制" width="16" height="16" />
      </button>
      <slot name="actions-end" />
    </div>

    <div
      class="tn-mermaid__stage"
      @mousedown="startDrag"
      @mousemove="onDrag"
      @mouseup="endDrag"
      @mouseleave="endDrag"
    >
      <!-- Keep host laid out during render; display:none breaks Mermaid SVG sizing. -->
      <div
        ref="diagramRef"
        class="tn-mermaid__diagram"
        :class="{ 'is-centered': centered, 'is-obscured': empty || !!error }"
        :style="
          diagramTransform
            ? { transform: diagramTransform, transformOrigin: 'top left' }
            : undefined
        "
        @wheel="handleWheel"
      />
      <div v-if="loading" class="tn-mermaid__loading tn-mermaid__status">
        <div class="tn-mermaid__spinner" />
        <p>加载图表中...</p>
      </div>
      <div v-else-if="empty" class="tn-mermaid__empty tn-mermaid__status">
        输入 Mermaid 源码后显示预览
      </div>
      <div v-else-if="error" class="tn-mermaid__error tn-mermaid__status">
        <p>{{ error }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import mermaid from 'mermaid'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { adoptLiveSvg } from './adoptLiveSvg'
import iconCenterOff from './icons/icon__center_off.svg?url'
import iconCenterOn from './icons/icon__center_on.svg?url'
import iconCheck from './icons/icon__check.svg?url'
import iconClipboard from './icons/icon__clipboard.svg?url'
import iconFullscreen from './icons/icon__fullscreen.svg?url'
import iconFullscreenExit from './icons/icon__fullscreen_exit.svg?url'

let idSeq = 0

/** Mermaid's renderer is not safe for overlapping `render()` calls. */
let renderChain = Promise.resolve()
/** Re-init wipes layout engines mid-flight when several diagrams mount at once. */
let initializedKey = null

function enqueueRender(task) {
  const run = renderChain.then(task, task)
  renderChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function ensureMermaidInitialized(dark, securityLevel) {
  const key = `${dark ? 'dark' : 'light'}:${securityLevel}`
  if (initializedKey === key) return
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
    securityLevel,
    fontFamily: 'inherit'
  })
  initializedKey = key
}

function waitForLayoutBox(el) {
  if (!el || el.clientWidth > 0) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      observer?.disconnect()
      resolve()
    }
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            if (el.clientWidth > 0) finish()
          })
        : null
    observer?.observe(el)
    requestAnimationFrame(() => {
      if (el.clientWidth > 0) finish()
    })
    setTimeout(finish, 1200)
  })
}

const props = defineProps({
  /** Plain Mermaid source (preferred). */
  source: {
    type: String,
    default: ''
  },
  /** URI-encoded source from SSG fence (`graph="…"`). */
  graph: {
    type: String,
    default: ''
  },
  id: {
    type: String,
    default: ''
  },
  /** Fence `center` keyword → true; omit → false. */
  center: {
    type: Boolean,
    default: false
  },
  /** Explicit dark mode; omit to auto-detect `html.dark` / `data-theme=dark`. */
  isDark: {
    type: Boolean,
    default: undefined
  },
  securityLevel: {
    type: String,
    default: 'strict'
  },
  enableCopy: {
    type: Boolean,
    default: true
  },
  enableFullscreen: {
    type: Boolean,
    default: true
  },
  enableCenterToggle: {
    type: Boolean,
    default: true
  }
})

const emit = defineEmits(['update:center', 'centerChange'])

const rootRef = ref(null)
const diagramRef = ref(null)
const loading = ref(false)
const error = ref(null)
const isFullscreen = ref(false)
const centered = ref(Boolean(props.center))
const idPrefix = props.id || 'tn-mermaid'
let renderToken = 0
let lastThemeDark = null

const showActions = computed(
  () => props.enableCopy || props.enableFullscreen || props.enableCenterToggle
)

const decodedSource = computed(() => {
  if (props.source) return props.source
  if (!props.graph) return ''
  try {
    return decodeURIComponent(props.graph)
  } catch {
    return props.graph
  }
})

const empty = computed(() => !decodedSource.value.trim())

watch(
  () => props.center,
  (value) => {
    centered.value = Boolean(value)
  }
)

function toggleCenter() {
  const next = !centered.value
  centered.value = next
  emit('update:center', next)
  emit('centerChange', next)
}

function detectDark() {
  if (typeof props.isDark === 'boolean') return props.isDark
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  if (root.dataset.theme === 'light') return false
  return root.classList.contains('dark') || root.dataset.theme === 'dark'
}

const COPY_RESET_DELAY = 1000
const copyState = ref('idle')
const copyIcon = computed(() => (copyState.value === 'copied' ? iconCheck : iconClipboard))
const copyTitle = computed(() => {
  if (copyState.value === 'copied') return '已复制'
  if (copyState.value === 'failed') return '复制失败'
  return '复制源码'
})
let copyResetTimer = null
/** How fullscreen was entered — Electron usually needs the CSS overlay path. */
let fullscreenMode = null

/** Sync write that survives Electron's missing clipboard permission. */
function writeTextFallback(text) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  textarea.remove()
  return ok
}

async function copySource() {
  const text = decodedSource.value
  let ok = false
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      // Electron can expose Clipboard without granting the renderer's async
      // Clipboard permission. Fall through to the synchronous user-gesture path.
    }
  }
  if (!ok) ok = writeTextFallback(text)
  copyState.value = ok ? 'copied' : 'failed'
  if (copyResetTimer) clearTimeout(copyResetTimer)
  copyResetTimer = setTimeout(() => {
    copyState.value = 'idle'
  }, COPY_RESET_DELAY)
}

const scale = ref(1)
const panX = ref(0)
const panY = ref(0)
const dragging = ref(false)
let dragStartX = 0
let dragStartY = 0
let panStartX = 0
let panStartY = 0
const MIN_SCALE = 0.1
const MAX_SCALE = 5
const SCALE_STEP = 0.01

const diagramTransform = computed(() =>
  isFullscreen.value
    ? `translate(${panX.value}px, ${panY.value}px) scale(${scale.value})`
    : undefined
)

function startDrag(e) {
  if (!isFullscreen.value) return
  dragging.value = true
  dragStartX = e.clientX
  dragStartY = e.clientY
  panStartX = panX.value
  panStartY = panY.value
}

function onDrag(e) {
  if (!dragging.value) return
  panX.value = panStartX + (e.clientX - dragStartX)
  panY.value = panStartY + (e.clientY - dragStartY)
}

function endDrag() {
  dragging.value = false
}

function handleWheel(e) {
  if (!isFullscreen.value) return
  e.preventDefault()
  const delta = e.deltaY > 0 ? -SCALE_STEP : SCALE_STEP
  scale.value = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale.value + delta))
}

function resetPanZoom() {
  scale.value = 1
  panX.value = 0
  panY.value = 0
}

function exitFullscreenOverlay() {
  if (!isFullscreen.value && fullscreenMode == null) return
  const root = rootRef.value
  if (fullscreenMode === 'native' && root && document.fullscreenElement === root) {
    void document.exitFullscreen().catch(() => {
      /* ignore */
    })
  }
  fullscreenMode = null
  isFullscreen.value = false
  resetPanZoom()
}

async function toggleFullscreen() {
  const root = rootRef.value
  if (!root) return

  if (isFullscreen.value) {
    exitFullscreenOverlay()
    return
  }

  // CSS overlay first — Electron often rejects/hangs on requestFullscreen.
  fullscreenMode = 'css'
  isFullscreen.value = true

  // Best-effort native fullscreen (non-blocking).
  if (!document.fullscreenEnabled || typeof root.requestFullscreen !== 'function') return
  if (/Electron/i.test(navigator.userAgent)) return
  try {
    await Promise.race([
      root.requestFullscreen(),
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error('fullscreen-timeout')), 500)
      })
    ])
    if (document.fullscreenElement === root) fullscreenMode = 'native'
  } catch {
    /* keep CSS overlay */
  }
}

function handleFullscreenChange() {
  const root = rootRef.value
  if (root && document.fullscreenElement === root) {
    fullscreenMode = 'native'
    isFullscreen.value = true
  } else if (fullscreenMode === 'native') {
    fullscreenMode = null
    isFullscreen.value = false
    resetPanZoom()
  }
}

function handleDocumentKeydown(event) {
  if (event.key === 'Escape' && isFullscreen.value && fullscreenMode === 'css') {
    event.preventDefault()
    exitFullscreenOverlay()
  }
}

async function renderDiagram() {
  await nextTick()
  if (!diagramRef.value) return

  if (!decodedSource.value.trim()) {
    loading.value = false
    error.value = null
    diagramRef.value.innerHTML = ''
    return
  }

  const token = ++renderToken
  const dark = detectDark()
  lastThemeDark = dark

  loading.value = true
  error.value = null

  try {
    await waitForLayoutBox(rootRef.value || diagramRef.value)
    if (token !== renderToken || !diagramRef.value) return

    await enqueueRender(async () => {
      if (token !== renderToken || !diagramRef.value) return
      ensureMermaidInitialized(dark, props.securityLevel)
      // Unique render id (mermaid deletes getElementById(id) before the next
      // draw). After insert, adoptLiveSvg renames the root so a later render
      // cannot yank this live SVG out of Desk.
      const renderId = `${idPrefix}-${++idSeq}`
      const { svg, bindFunctions } = await mermaid.render(renderId, decodedSource.value)
      if (token !== renderToken || !diagramRef.value) return
      diagramRef.value.innerHTML = adoptLiveSvg(svg, renderId)
      if (bindFunctions) bindFunctions(diagramRef.value)
    })
  } catch (err) {
    if (token !== renderToken) return
    const message = err instanceof Error ? err.message : String(err)
    error.value = `Failed to render diagram: ${message}`
    if (diagramRef.value) diagramRef.value.innerHTML = ''
  } finally {
    if (token === renderToken) loading.value = false
  }
}

function observeTheme() {
  const observer = new MutationObserver(() => {
    const dark = detectDark()
    if (dark === lastThemeDark) return
    void renderDiagram()
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme']
  })
  return observer
}

let themeObserver = null
let layoutObserver = null

onMounted(() => {
  void renderDiagram()
  themeObserver = observeTheme()
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  document.addEventListener('keydown', handleDocumentKeydown, true)

  // Desk NodeViews often mount at width 0. Wait once for a real box — do not
  // re-render on later width flicker (that cancels in-flight mermaid.render).
  const root = rootRef.value
  if (root && root.clientWidth === 0 && typeof ResizeObserver === 'function') {
    layoutObserver = new ResizeObserver(() => {
      if (root.clientWidth <= 0) return
      layoutObserver?.disconnect()
      layoutObserver = null
      void renderDiagram()
    })
    layoutObserver.observe(root)
  }
})

onBeforeUnmount(() => {
  themeObserver?.disconnect()
  layoutObserver?.disconnect()
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  document.removeEventListener('keydown', handleDocumentKeydown, true)
  if (copyResetTimer) clearTimeout(copyResetTimer)
  if (isFullscreen.value) exitFullscreenOverlay()
})

watch(
  () => [decodedSource.value, props.securityLevel, props.isDark],
  () => {
    void renderDiagram()
  }
)
</script>

<style scoped lang="scss">
.tn-mermaid {
  position: relative;
  margin: 1rem 0;
  border: 1px solid var(--tn-c-divider);
  border-radius: 8px;
  background: var(--tn-c-bg);
  overflow: hidden;
  color: var(--tn-c-text);
  transition: border-color 0.2s ease;

  &.is-fullscreen {
    position: fixed;
    inset: 0;
    z-index: 9999;
    margin: 0;
    border-radius: 0;
    border-color: var(--tn-c-divider);
  }
}

.tn-mermaid:hover,
.tn-mermaid:has(.tn-mermaid__actions:hover),
.tn-mermaid:has(.tn-mermaid__actions:focus-within),
.tn-mermaid:has(.tn-mermaid__actions[data-copy-state='copied']),
.tn-mermaid:has(.tn-mermaid__actions[data-copy-state='failed']),
.tn-mermaid.is-fullscreen {
  border-color: var(--tn-c-divider);
}

.tn-mermaid__actions {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  background-color: color-mix(in srgb, var(--tn-c-bg) 92%, transparent);
  border: 1px solid var(--tn-c-divider);
  border-radius: 7px;
  opacity: 0;
  transition: opacity 0.2s;
}

.tn-mermaid:hover .tn-mermaid__actions,
.tn-mermaid__actions:hover,
.tn-mermaid__actions:focus-within,
.tn-mermaid__actions[data-copy-state='copied'],
.tn-mermaid__actions[data-copy-state='failed'],
.tn-mermaid.is-fullscreen .tn-mermaid__actions {
  opacity: 1;
}

.tn-mermaid__actions.is-suppressed,
.tn-mermaid:hover .tn-mermaid__actions.is-suppressed {
  opacity: 0;
  pointer-events: none;
}

.tn-mermaid__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--tn-c-text-2);
  cursor: pointer;

  &:hover {
    background-color: var(--tn-c-default-soft);
    color: var(--tn-c-brand);
  }

  svg,
  img {
    width: 16px;
    height: 16px;
    display: block;
  }
}

.tn-mermaid__action--copy {
  position: relative;

  &[data-copy-state='copied'] {
    background-color: var(--tn-c-success-soft);
  }

  &[data-copy-state='failed'] {
    background-color: var(--tn-c-danger-soft);
  }

  &::after {
    position: absolute;
    top: 50%;
    right: calc(100% + 6px);
    padding: 4px 7px;
    color: var(--tn-c-text);
    background: var(--tn-c-bg-elv);
    border: 1px solid var(--tn-c-divider);
    border-radius: 6px;
    box-shadow: var(--tn-shadow-2);
    content: attr(title);
    font-size: 12px;
    line-height: 18px;
    opacity: 0;
    pointer-events: none;
    transform: translateY(-50%) translateX(2px);
    transition:
      opacity 0.16s ease,
      transform 0.16s ease;
    white-space: nowrap;
  }

  &[data-copy-state='copied']::after,
  &[data-copy-state='failed']::after {
    opacity: 1;
    transform: translateY(-50%) translateX(0);
  }
}

.tn-mermaid__stage {
  position: relative;
  min-height: 160px;
  padding: 20px;
  background: transparent;
}

.tn-mermaid.is-fullscreen .tn-mermaid__stage {
  min-height: 100%;
  height: 100%;
  padding: 40px;
  overflow: hidden;
  cursor: grab;
  background: var(--tn-c-bg);

  &:active {
    cursor: grabbing;
  }
}

.tn-mermaid.is-fullscreen.is-centered .tn-mermaid__stage {
  display: flex;
  align-items: center;
  justify-content: center;
}

.tn-mermaid.is-fullscreen.is-centered .tn-mermaid__diagram {
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
}

.tn-mermaid__status {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 1.5rem;
  color: var(--tn-c-text-2);
  font-size: 14px;
  text-align: center;
  background: var(--tn-c-bg);

  p {
    margin: 0;
  }
}

.tn-mermaid__error {
  color: var(--tn-c-danger);
}

.tn-mermaid__diagram.is-obscured {
  visibility: hidden;
  pointer-events: none;
}

.tn-mermaid__spinner {
  width: 36px;
  height: 36px;
  border: 3px solid var(--tn-c-divider);
  border-top-color: var(--tn-c-brand);
  border-radius: 50%;
  animation: tn-mermaid-spin 0.8s linear infinite;
}

@keyframes tn-mermaid-spin {
  to {
    transform: rotate(360deg);
  }
}

.tn-mermaid__diagram {
  display: flex;
  justify-content: flex-start;

  &.is-centered {
    justify-content: center;
  }

  :deep(svg) {
    max-width: 100%;
    height: auto;
  }

  :deep(svg .label p) {
    line-height: 1.5;
  }
}
</style>
