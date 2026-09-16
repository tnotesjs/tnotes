<script setup lang="ts">
import { CanvasEditor, CanvasViewer, MindmapSession } from '@tnotesjs/mindmap-core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import {
  MAX_EXPAND_LEVEL,
  MIN_EXPAND_LEVEL,
  acceptsExpandLevelEdit,
  applyInitialExpandLevel,
  normalizeExpandLevel,
  resolvedExpandLevel,
  stepExpandLevel
} from './expandLevel'
import { FORCE_EXIT_FULLSCREEN_EVENT, reconcileMindmapFullscreen } from './fullscreenFlag'
import { normalizeMindmapMarkdown } from './markdown'
import MindmapOutlineNode from './MindmapOutlineNode.vue'
import MindmapViewIcon from './MindmapViewIcon.vue'
import FocusBreadcrumbs from './FocusBreadcrumbs.vue'
import MindmapCanvasEditor from './editor/MindmapView.vue'
import MindmapOutlineEditor from './editor/OutlineView.vue'
import MindmapMarkdownEditor from './editor/MarkdownView.vue'
import { insertImageIntoSource } from './editor/imagePaste'
import { gateMindmapWheel } from './wheelInteraction'
import iconFullscreen from './icons/icon__fullscreen.svg?url'
import iconFullscreenExit from './icons/icon__fullscreen_exit.svg?url'
import iconZoomFit from './icons/icon__zoom_fit.svg?url'

type PreviewView = 'mindmap' | 'outline' | 'source'

/** One fullscreen mindmap at a time across preview instances on the page. */
const FS_GATE_KEY = '__tnotesjs_mindmap_fullscreen_gate__'

type FsGateState = { owners: Map<symbol, () => void> }

function fsGateState(): FsGateState {
  const g = globalThis as typeof globalThis & { [FS_GATE_KEY]?: FsGateState }
  if (!g[FS_GATE_KEY]) g[FS_GATE_KEY] = { owners: new Map() }
  return g[FS_GATE_KEY]
}

function registerMindmapFullscreenOwner(id: symbol, exit: () => void): () => void {
  const { owners } = fsGateState()
  owners.set(id, exit)
  return () => {
    owners.delete(id)
  }
}

function claimMindmapFullscreen(id: symbol): void {
  for (const [otherId, exit] of [...fsGateState().owners]) {
    if (otherId === id) continue
    try {
      exit()
    } catch {
      /* ignore */
    }
  }
}

function syncBodyFullscreenAttr(activeRoot: HTMLElement | null): void {
  if (typeof document === 'undefined') return
  reconcileMindmapFullscreen(activeRoot, document.querySelectorAll<HTMLElement>('.mindmap-preview'))
}

function forceExitPeerFullscreen(activeRoot: HTMLElement | null): void {
  if (typeof document === 'undefined') return
  for (const el of document.querySelectorAll('.mindmap-preview')) {
    if (!(el instanceof HTMLElement) || el === activeRoot) continue
    el.dispatchEvent(new CustomEvent(FORCE_EXIT_FULLSCREEN_EVENT))
    el.classList.remove('is-fullscreen', 'is-interaction-active')
  }
  syncBodyFullscreenAttr(activeRoot)
}

const props = withDefaults(
  defineProps<{
    content?: string
    /** Plain mindmap markdown (preferred over URI-encoded content). */
    source?: string
    initialExpandLevel?: number
    /** When true, canvas uses CanvasEditor and edits emit `change`. */
    editable?: boolean
    /** Show expand-level control on the chrome (Desk). */
    expandLevelControl?: boolean
    /** Explicit dark mode; omit to auto-detect html.dark / data-theme=dark. */
    isDark?: boolean
    /**
     * Resolve markdown image paths for canvas display (Desk: tnotes-asset protocol).
     * Defaults to identity.
     */
    resolveImageSrc?: (src: string) => string
    /**
     * Persist a pasted/dropped image blob and return the markdown-relative path
     * (e.g. `./assets/foo.png`). Required for editable paste-to-assets.
     */
    writeAsset?: (blob: Blob) => Promise<{ relativePath: string; alt?: string }>
  }>(),
  {
    content: '',
    source: '',
    initialExpandLevel: 3,
    editable: false,
    expandLevelControl: false,
    isDark: undefined,
    resolveImageSrc: undefined,
    writeAsset: undefined
  }
)

const emit = defineEmits<{
  change: [markdown: string]
  expandLevelChange: [level: number]
}>()

function detectDark(): boolean {
  if (typeof props.isDark === 'boolean') return props.isDark
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  if (root.dataset.theme === 'light') return false
  return root.classList.contains('dark') || root.dataset.theme === 'dark'
}

const dark = ref(detectDark())
const activeView = ref<PreviewView>('mindmap')
const previewRoot = ref<HTMLElement | null>(null)
const canvasHost = ref<HTMLElement | null>(null)
const outlineEditorRef = ref<{
  selectAllFromHost?: () => void
  undoFromHost?: () => void
  redoFromHost?: () => void
} | null>(null)
const sourceEditorRef = ref<{ selectAllFromHost?: () => void } | null>(null)
const session = shallowRef<MindmapSession | null>(null)
const renderVersion = ref(0)
const isFullscreen = ref(false)
/** How fullscreen was entered — Electron usually needs the CSS overlay path. */
let fullscreenMode: 'native' | 'css' | null = null
/** Stable id for exclusive fullscreen coordination across preview instances. */
const fullscreenOwnerId = Symbol('mindmap-fullscreen')
let unregisterFullscreenOwner: (() => void) | null = null
const isCanvasActive = ref(false)
const expandLevel = ref(normalizeExpandLevel(props.initialExpandLevel))
/** Readonly CanvasViewer host; editable mode uses MindmapCanvasEditor instead. */
let viewer: CanvasViewer | null = null
let editorRef: CanvasEditor | null = null
let mounted = false
let suppressChangeEmit = false
const sessionEpoch = ref(0)

const viewOptions = [
  { value: 'mindmap', label: '脑图' },
  { value: 'outline', label: '大纲' },
  { value: 'source', label: '源码' }
] as const

function decodeContent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const rawContent = computed(() => props.source || decodeContent(props.content || ''))
const normalizedContent = computed(() => normalizeMindmapMarkdown(rawContent.value))

function destroyViewer(): void {
  viewer?.destroy()
  viewer = null
}

async function handlePasteImage(anchorId: string, blob: Blob): Promise<void> {
  if (!props.editable || !session.value || !props.writeAsset) return
  try {
    const asset = await props.writeAsset(blob)
    const prepared = session.value.prepareImageInsertion(
      anchorId,
      asset.relativePath,
      asset.alt ?? '截图'
    )
    if (!prepared) return
    prepared.commit()
  } catch {
    /* Host surfaces upload errors; keep canvas usable. */
  }
}

function createViewer(): void {
  // Editable canvas is owned by MindmapCanvasEditor (toolbar / context menu).
  if (props.editable) return
  if (!mounted || !canvasHost.value || !session.value || viewer) return
  const theme = dark.value ? 'dark' : 'light'
  viewer = new CanvasViewer(canvasHost.value, session.value, {
    theme,
    resolveImageSrc: (src) => props.resolveImageSrc?.(src) ?? src
  })
}

function onEditorReady(editor: CanvasEditor): void {
  editorRef = editor
  editor.setTheme(dark.value ? 'dark' : 'light')
  if (activeView.value === 'mindmap') {
    requestAnimationFrame(() => editor.zoomToFit())
  }
}

function resolveImageSrcProp(src: string): string {
  return props.resolveImageSrc?.(src) ?? src
}

function rebuildSession(): void {
  destroyViewer()
  editorRef = null
  suppressChangeEmit = true
  const next = new MindmapSession({
    markdown: normalizedContent.value,
    fileName: 'mindmap-preview.tn-mindmap.md'
  })
  applyInitialExpandLevel(next, expandLevel.value)
  const invalidate = () => {
    renderVersion.value += 1
  }
  next.on('collapseChange', invalidate)
  next.on('focusChange', invalidate)
  next.on('selectionChange', invalidate)
  next.on('change', (markdown) => {
    invalidate()
    if (suppressChangeEmit || !props.editable) return
    emit('change', markdown)
  })
  session.value = next
  sessionEpoch.value += 1
  renderVersion.value += 1
  void nextTick(() => {
    createViewer()
    suppressChangeEmit = false
  })
}

function onSourceMarkdown(value: string): void {
  if (!session.value || !props.editable) return
  if (value === session.value.getMarkdown()) return
  session.value.setMarkdown(value)
}

async function onSourcePasteImage(
  blob: Blob,
  selectionStart: number,
  selectionEnd: number
): Promise<void> {
  if (!props.editable || !session.value || !props.writeAsset) return
  try {
    const asset = await props.writeAsset(blob)
    const next = insertImageIntoSource(
      session.value.getMarkdown(),
      selectionStart,
      selectionEnd,
      asset.relativePath,
      asset.alt ?? '截图'
    )
    onSourceMarkdown(next)
  } catch {
    /* Host surfaces upload errors. */
  }
}

function setExpandLevel(raw: number): void {
  const level = normalizeExpandLevel(raw)
  if (level === expandLevel.value) return
  expandLevel.value = level
  if (session.value) applyInitialExpandLevel(session.value, level)
  renderVersion.value += 1
  emit('expandLevelChange', level)
}

/** The value the field held when it was focused — what ESC / an empty blur restores. */
let expandLevelBeforeFocus: number | null = null

/**
 * Refuse a non-digit before it ever reaches the field. Cancelling `beforeinput`
 * leaves the value and the selection untouched, which is what keeps the field
 * usable after a rejected key — restoring `input.value` after the fact leaves
 * the browser's editing state wedged, and nothing types into the field again.
 *
 * The first character cannot be `0` (the range starts at 1); a second character
 * completes a 1–99 number, so `0` is allowed there (`10`, `20`, …).
 */
function onExpandLevelBeforeInput(event: InputEvent): void {
  // Only text being inserted is judged; deletions and history carry no `data`.
  if (event.data === null) return
  if (event.inputType !== 'insertText') return
  if (!/^\d+$/.test(event.data)) {
    event.preventDefault()
    return
  }
  const input = event.target as HTMLInputElement
  const replacingAll = input.selectionStart === 0 && input.selectionEnd === input.value.length
  const next = replacingAll
    ? event.data
    : input.value.slice(0, input.selectionStart ?? input.value.length) +
      event.data +
      input.value.slice(input.selectionEnd ?? input.value.length)
  if (!acceptsExpandLevelEdit(next)) event.preventDefault()
}

function onExpandLevelInput(event: Event): void {
  const input = event.target as HTMLInputElement
  // Safety net for input that skips `beforeinput` (paste, IME, drag-and-drop, a
  // programmatic value): anything that cannot be a 1–99 number is dropped.
  if (!acceptsExpandLevelEdit(input.value)) {
    input.value = String(expandLevel.value)
    input.select()
    return
  }
  if (input.value === '') return
  const typed = Number(input.value)
  // `0` (and anything above the cap) stays in the field uncommitted; blur clamps it.
  if (typed >= MIN_EXPAND_LEVEL && typed <= MAX_EXPAND_LEVEL) setExpandLevel(typed)
}

/**
 * Editing ends: an empty field means "no input", so the pre-focus value comes
 * back; otherwise whatever was typed is clamped into 1–99 and committed.
 */
function onExpandLevelBlur(event: Event): void {
  const input = event.target as HTMLInputElement
  const restore = expandLevelBeforeFocus
  expandLevelBeforeFocus = null
  const level = resolvedExpandLevel(input.value, restore ?? expandLevel.value)
  input.value = String(level)
  setExpandLevel(level)
}

/** ESC abandons the edit outright, wherever the field happens to be. */
function onExpandLevelEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape') return false
  const restore = expandLevelBeforeFocus ?? expandLevel.value
  event.preventDefault()
  event.stopPropagation()
  const input = event.target as HTMLInputElement
  input.value = String(restore)
  setExpandLevel(restore)
  input.blur()
  return true
}

/**
 * Backspace clears the field in one press. Editing a single number digit by digit
 * has no use: an empty field here means "no input" — it shows the hint, and blur
 * puts the pre-focus value back.
 */
function onExpandLevelClearKey(event: KeyboardEvent): boolean {
  if (event.key !== 'Backspace' && event.key !== 'Delete') return false
  const input = event.target as HTMLInputElement
  if (input.value === '') return false
  event.preventDefault()
  input.value = ''
  return true
}

/**
 * All four arrows step the level. The field is a text input (see
 * `onExpandLevelFocus`), so ↑/↓ no longer come free from the number input and
 * have to be handled here alongside ←/→ — either hand stays on the arrows.
 * A caret inside one number has nothing to scroll, which is what leaves the
 * horizontal arrows free to take.
 */
function onExpandLevelKeydown(event: KeyboardEvent): void {
  if (onExpandLevelEscape(event)) return
  if (onExpandLevelClearKey(event)) return
  const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key]
  if (step === undefined) return
  // Leave modifiers alone: Cmd/Alt+← are word-jump / back shortcuts.
  if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return
  const input = event.target as HTMLInputElement
  const current = Number(input.value)
  const base = /^\d{1,2}$/.test(input.value) ? current : expandLevel.value
  // Clamp rather than lean on `setExpandLevel`: a clamped step is still a step,
  // and the value stays inside the documented 1–99.
  const bounded = stepExpandLevel(base, step as -1 | 1)
  event.preventDefault()
  input.value = String(bounded)
  setExpandLevel(bounded)
}

/**
 * Two digits mean "type the level, not append to it": select the current value on
 * focus so a keystroke replaces it. This is also why the field is a `text` input
 * with `inputmode="numeric"` rather than `type=number` — selection APIs are not
 * available on the latter (the digit would be appended, giving `39`).
 * The pre-focus value is remembered for ESC and for an empty blur.
 */
function onExpandLevelFocus(event: FocusEvent): void {
  const input = event.target as HTMLInputElement
  expandLevelBeforeFocus = expandLevel.value
  input.select()
}

function setView(view: PreviewView): void {
  if (activeView.value === view) return
  if (activeView.value === 'mindmap' && view !== 'mindmap') {
    editorRef = null
    destroyViewer()
  }
  activeView.value = view
  if (view !== 'mindmap') isCanvasActive.value = false
  if (view === 'mindmap') {
    // Host remounts via v-if; recreate readonly viewer then fit.
    void nextTick(() => {
      createViewer()
      zoomToFit()
      requestAnimationFrame(() => zoomToFit())
      window.setTimeout(() => zoomToFit(), 80)
    })
  }
}

/** Switch on pointerdown so Desk/PM cannot steal the gesture before click. */
function onViewTabPointerDown(view: PreviewView, event: PointerEvent): void {
  event.stopPropagation()
  setView(view)
}

function toggleNode(id: string): void {
  session.value?.toggleCollapse(id)
}

function exitFullscreenOverlay(): void {
  // no-op when idle — claimMindmapFullscreen() invokes exit on peers only.
  if (!isFullscreen.value && fullscreenMode == null) return

  const root = previewRoot.value
  if (fullscreenMode === 'native' && root && document.fullscreenElement === root) {
    void document.exitFullscreen().catch(() => {
      /* ignore */
    })
  }
  fullscreenMode = null
  isFullscreen.value = false
  root?.classList.remove('is-fullscreen', 'is-interaction-active')
  syncBodyFullscreenAttr(null)
}

/** Peer claim / DOM scrub — clear Vue state so is-fullscreen does not come back. */
function onForceExitFullscreen(): void {
  fullscreenMode = null
  isFullscreen.value = false
  previewRoot.value?.classList.remove('is-fullscreen', 'is-interaction-active')
}

async function toggleFullscreen(): Promise<void> {
  const root = previewRoot.value
  if (!root) return

  if (isFullscreen.value) {
    exitFullscreenOverlay()
    void nextTick(() => zoomToFit())
    return
  }

  claimMindmapFullscreen(fullscreenOwnerId)
  forceExitPeerFullscreen(null)

  // CSS overlay first — Electron often rejects/hangs on requestFullscreen.
  fullscreenMode = 'css'
  isFullscreen.value = true
  root.classList.add('is-fullscreen')
  forceExitPeerFullscreen(root)
  void nextTick(() => zoomToFit())

  // Best-effort native fullscreen (non-blocking).
  if (!document.fullscreenEnabled || typeof root.requestFullscreen !== 'function') return
  if (/Electron/i.test(navigator.userAgent)) return
  try {
    await Promise.race([
      root.requestFullscreen(),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('fullscreen-timeout')), 500)
      })
    ])
    if (document.fullscreenElement === root) fullscreenMode = 'native'
  } catch {
    /* keep CSS overlay */
  }
}

function handleFullscreenChange(): void {
  const root = previewRoot.value
  if (root && document.fullscreenElement === root) {
    claimMindmapFullscreen(fullscreenOwnerId)
    fullscreenMode = 'native'
    isFullscreen.value = true
    root.classList.add('is-fullscreen')
    forceExitPeerFullscreen(root)
  } else if (fullscreenMode === 'native') {
    fullscreenMode = null
    isFullscreen.value = false
    // `syncBodyFullscreenAttr` also drops the stale `is-fullscreen` class, so
    // ESC (which only fires `fullscreenchange`) lands in the same state as the
    // button path and the toolbar comes back.
    syncBodyFullscreenAttr(null)
  }
  if (activeView.value === 'mindmap') void nextTick(() => zoomToFit())
}

function zoomToFit(): void {
  editorRef?.zoomToFit()
  viewer?.zoomToFit()
}

function activateCanvas(): void {
  isCanvasActive.value = true
  if (!props.editable) return
  const editorEl = canvasHost.value?.querySelector<HTMLElement>('.mm-editor')
  editorEl?.focus({ preventScroll: true })
}

function handleCanvasWheelCapture(event: WheelEvent): void {
  gateMindmapWheel(event, isCanvasActive.value)
}

/** After the canvas handles paste, stop bubbling into Milkdown's uploader. */
function handlePreviewPasteBubble(event: ClipboardEvent): void {
  if (!props.editable) return
  const hasImage = [...(event.clipboardData?.items ?? [])].some(
    (item) => item.kind === 'file' && item.type.startsWith('image/')
  )
  if (!hasImage) return
  event.stopPropagation()
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (event.target instanceof Node && !previewRoot.value?.contains(event.target)) {
    isCanvasActive.value = false
  }
}

function mindmapIslandOwnsKeyboard(): boolean {
  const root = previewRoot.value
  if (!root || !props.editable) return false
  const active = document.activeElement
  const activeInside = active instanceof Node && root.contains(active)
  const hostBlock = root.closest('.desk-raw-block--mindmap')
  return (
    isCanvasActive.value ||
    activeInside ||
    root.matches(':focus-within') ||
    Boolean(hostBlock?.classList.contains('is-mindmap-island-active')) ||
    Boolean(hostBlock?.classList.contains('ProseMirror-selectednode'))
  )
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isFullscreen.value && fullscreenMode === 'css') {
    event.preventDefault()
    exitFullscreenOverlay()
    void nextTick(() => zoomToFit())
    return
  }

  // Keep Mod+A / Mod+Z / Mod+Y / Mod+C / Mod+X / Mod+V inside the mindmap island.
  if (props.editable && (event.metaKey || event.ctrlKey) && !event.altKey) {
    const key = event.key.toLowerCase()
    const isSelectAll = key === 'a' && !event.shiftKey
    const isUndo = key === 'z' && !event.shiftKey
    const isRedo = key === 'y' || (key === 'z' && event.shiftKey)
    const isCopy = key === 'c' && !event.shiftKey
    const isCut = key === 'x' && !event.shiftKey
    const isPaste = key === 'v' && !event.shiftKey
    if (
      (isSelectAll || isUndo || isRedo || isCopy || isCut || isPaste) &&
      mindmapIslandOwnsKeyboard()
    ) {
      const root = previewRoot.value
      const target = event.target

      // Source view textarea: keep native clipboard / history; only block ProseMirror.
      if (activeView.value === 'source' && (isUndo || isRedo || isCopy || isCut || isPaste)) {
        const inSource =
          target instanceof Element
            ? target.closest('.md-textarea, textarea, .markdown-view')
            : target instanceof Node
              ? (target.parentElement?.closest('.md-textarea, textarea, .markdown-view') ?? null)
              : null
        if (inSource && root?.contains(inSource)) {
          event.stopPropagation()
          return
        }
      }

      // Outline / canvas text editing: keep native clipboard into the caret.
      if (isCopy || isCut || isPaste) {
        const inTextEdit =
          target instanceof Element
            ? target.closest(
                '.mm-edit-input, .rich-inline-editor, [contenteditable="true"], textarea, input'
              )
            : null
        if (inTextEdit && root?.contains(inTextEdit)) return
        if (activeView.value !== 'mindmap') return
        event.preventDefault()
        event.stopPropagation()
        if (isCopy) editorRef?.copyFromHost?.()
        else if (isCut) editorRef?.cutFromHost?.()
        else editorRef?.pasteFromHost?.()
        isCanvasActive.value = true
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (isSelectAll) {
        if (activeView.value === 'outline') {
          outlineEditorRef.value?.selectAllFromHost?.()
        } else if (activeView.value === 'source') {
          sourceEditorRef.value?.selectAllFromHost?.()
        } else {
          editorRef?.selectAllFromHost?.()
          isCanvasActive.value = true
        }
        return
      }

      if (activeView.value === 'outline') {
        if (isUndo) outlineEditorRef.value?.undoFromHost?.()
        else outlineEditorRef.value?.redoFromHost?.()
      } else if (activeView.value === 'source') {
        if (isUndo) session.value?.undo()
        else session.value?.redo()
      } else if (isUndo) {
        if (typeof editorRef?.undoFromHost === 'function') editorRef.undoFromHost()
        else session.value?.undo()
        isCanvasActive.value = true
      } else {
        if (typeof editorRef?.redoFromHost === 'function') editorRef.redoFromHost()
        else session.value?.redo()
        isCanvasActive.value = true
      }
      return
    }
  }

  if (event.key !== 'Escape' || !isCanvasActive.value) return
  isCanvasActive.value = false
  canvasHost.value?.blur()
}

watch(
  normalizedContent,
  (value) => {
    if (session.value && normalizeMindmapMarkdown(session.value.getMarkdown()) === value) {
      return
    }
    rebuildSession()
  },
  { immediate: true }
)
watch(
  () => props.initialExpandLevel,
  (value) => {
    const level = normalizeExpandLevel(value)
    if (level === expandLevel.value) return
    expandLevel.value = level
    if (session.value) {
      applyInitialExpandLevel(session.value, level)
      renderVersion.value += 1
    }
  }
)
watch(
  () => props.editable,
  () => {
    destroyViewer()
    editorRef = null
    void nextTick(createViewer)
  }
)
watch(dark, (value) => {
  const theme = value ? 'dark' : 'light'
  viewer?.setTheme(theme)
  editorRef?.setTheme(theme)
})

function observeTheme() {
  const observer = new MutationObserver(() => {
    const next = detectDark()
    if (next !== dark.value) dark.value = next
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme']
  })
  return observer
}
let themeObserver: MutationObserver | null = null

onMounted(() => {
  mounted = true
  themeObserver = observeTheme()
  unregisterFullscreenOwner = registerMindmapFullscreenOwner(
    fullscreenOwnerId,
    exitFullscreenOverlay
  )
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  document.addEventListener('pointerdown', handleDocumentPointerDown, true)
  document.addEventListener('keydown', handleDocumentKeydown, true)
  void nextTick(() => {
    previewRoot.value?.addEventListener(FORCE_EXIT_FULLSCREEN_EVENT, onForceExitFullscreen)
  })
  createViewer()
})

onBeforeUnmount(() => {
  mounted = false
  exitFullscreenOverlay()
  unregisterFullscreenOwner?.()
  unregisterFullscreenOwner = null
  themeObserver?.disconnect()
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
  document.removeEventListener('keydown', handleDocumentKeydown, true)
  previewRoot.value?.removeEventListener(FORCE_EXIT_FULLSCREEN_EVENT, onForceExitFullscreen)
  destroyViewer()
})
</script>

<template>
  <section
    ref="previewRoot"
    class="mindmap-preview"
    :class="{
      'is-dark': dark,
      'is-fullscreen': isFullscreen,
      'is-editable': editable,
      'is-interaction-active': isCanvasActive
    }"
    :data-view="activeView"
    :data-version="renderVersion"
    @paste="handlePreviewPasteBubble"
  >
    <div class="mindmap-preview-actions">
      <nav class="mindmap-preview-tabs" aria-label="脑图预览视图">
        <button
          v-for="item in viewOptions"
          :key="item.value"
          type="button"
          class="mindmap-preview-action"
          :class="{ 'is-active': activeView === item.value }"
          :data-view-tab="item.value"
          :aria-label="item.label"
          :aria-pressed="activeView === item.value"
          :title="item.label"
          @pointerdown="onViewTabPointerDown(item.value, $event)"
        >
          <MindmapViewIcon :view="item.value" />
        </button>
      </nav>
      <span class="mindmap-preview-action-divider" aria-hidden="true" />
      <label
        v-if="expandLevelControl"
        class="mindmap-preview-expand"
        :title="`默认展开层级（${MIN_EXPAND_LEVEL}～${MAX_EXPAND_LEVEL}）`"
      >
        <input
          class="mindmap-preview-expand-input"
          type="text"
          inputmode="numeric"
          maxlength="2"
          :placeholder="`${MIN_EXPAND_LEVEL}～${MAX_EXPAND_LEVEL}`"
          :value="expandLevel"
          :aria-label="`默认展开层级，${MIN_EXPAND_LEVEL} 到 ${MAX_EXPAND_LEVEL}`"
          @focus="onExpandLevelFocus"
          @beforeinput="onExpandLevelBeforeInput"
          @input="onExpandLevelInput"
          @blur="onExpandLevelBlur"
          @keydown="onExpandLevelKeydown"
        />
      </label>
      <button
        v-if="activeView === 'mindmap'"
        type="button"
        class="mindmap-preview-action"
        aria-label="适应视口"
        title="适应视口"
        @click="zoomToFit"
      >
        <img :src="iconZoomFit" alt="" />
      </button>
      <button
        type="button"
        class="mindmap-preview-action"
        :aria-label="isFullscreen ? '退出全屏' : '全屏查看'"
        :title="isFullscreen ? '退出全屏' : '全屏查看'"
        @click="toggleFullscreen"
      >
        <img :src="isFullscreen ? iconFullscreenExit : iconFullscreen" alt="" />
      </button>
    </div>

    <FocusBreadcrumbs
      v-if="session && session.focusPath.length > 0"
      :session="session"
      :version="renderVersion"
    />

    <!-- Exclusive panes: destroy canvas so it cannot linger over outline/source. -->
    <div
      v-if="activeView === 'mindmap'"
      ref="canvasHost"
      class="mindmap-canvas-host mindmap-pane"
      :class="{ 'is-interaction-active': isCanvasActive }"
      @pointerdown.capture="activateCanvas"
      @wheel.capture="handleCanvasWheelCapture"
    >
      <MindmapCanvasEditor
        v-if="editable && session"
        :key="sessionEpoch"
        :session="session"
        :resolve-image-src="resolveImageSrcProp"
        @ready="onEditorReady"
        @paste-image="handlePasteImage"
      />
    </div>

    <div
      v-else-if="activeView === 'outline' && session"
      class="mindmap-outline mindmap-pane"
      :class="{ 'is-editable': editable }"
      :data-version="renderVersion"
    >
      <MindmapOutlineEditor
        v-if="editable"
        ref="outlineEditorRef"
        :session="session"
        :version="renderVersion"
        :resolve-image-src="resolveImageSrcProp"
        @paste-image="handlePasteImage"
      />
      <ul v-else class="mindmap-outline-root">
        <MindmapOutlineNode
          :node="session.focusRootNode"
          :version="renderVersion"
          root
          @toggle="toggleNode"
        />
      </ul>
    </div>

    <div
      v-else-if="activeView === 'source'"
      class="mindmap-source-wrap mindmap-pane"
      :class="{ 'is-editable': editable }"
    >
      <MindmapMarkdownEditor
        v-if="editable && session"
        ref="sourceEditorRef"
        :model-value="session.getMarkdown()"
        :diagnostics="session.diagnostics"
        @update:model-value="onSourceMarkdown"
        @paste-image="onSourcePasteImage"
      />
      <pre v-else class="mindmap-source"><code>{{ normalizedContent }}</code></pre>
    </div>
  </section>
</template>

<style scoped lang="scss">
.mindmap-preview {
  --mindmap-panel: var(--tn-c-bg-soft);
  --mindmap-border: var(--tn-c-divider);
  position: relative;
  margin: 1.5rem 0;
  overflow: hidden;
  border: 1px solid var(--mindmap-border);
  border-radius: 10px;
  background: var(--tn-c-bg);
}

.mindmap-preview.is-editable {
  /* Shared with fixed chrome (toolbar / context menu) via inheritance. */
  --mm-canvas-bg: var(--tn-c-bg);
  --mm-panel-bg: var(--tn-c-bg-soft, var(--tn-c-bg));
  --mm-text: var(--tn-c-text);
  --mm-text-dim: var(--tn-c-text-2, var(--tn-c-text));
  --mm-accent: var(--tn-c-brand);
  --mm-border: var(--tn-c-divider, var(--mindmap-border));
  --mm-hover: var(--tn-c-default-soft, color-mix(in srgb, var(--tn-c-text) 8%, transparent));
  --mm-selected-bg: color-mix(in srgb, var(--tn-c-brand) 22%, transparent);
  --mm-edit-bg: var(--tn-c-bg-elv, var(--tn-c-bg));
}

.mindmap-preview.is-editable.is-interaction-active {
  outline: 1px solid color-mix(in srgb, var(--tn-c-brand, #3b82f6) 55%, transparent);
  outline-offset: 0;
}

.mindmap-preview-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  /* Above SelectionToolbar / LinkPopover (fixed ~120) so view tabs stay clickable. */
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  border: 0.1px solid var(--tn-c-divider);
  border-radius: 7px;
  background-color: color-mix(in srgb, var(--tn-c-bg-elv) 92%, transparent);
  box-shadow: var(--tn-shadow-2);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s;
}

/* 工具条按需出现：hover、聚焦（键盘 Tab 进来也算）、画布交互中、全屏。
   Desk 的可编辑岛原本额外钉了 `opacity: 1`（旧注释：“chrome must stay hittable”），
   结果每张脑图右上角常驻一排按钮，既像噪声又占掉画布右上角的拖拽区；
   可点击性并没丢 —— 指针进入即 hover 显现，`:focus-within` 保住键盘路径。
   只读岛（站点）本来就是这套行为，这里让两边一致。 */
.mindmap-preview-tabs {
  display: flex;
  gap: 4px;
}

.mindmap-preview:hover > .mindmap-preview-actions,
.mindmap-preview:focus-within > .mindmap-preview-actions,
.mindmap-preview-actions:focus-within,
.mindmap-preview.is-interaction-active > .mindmap-preview-actions,
.mindmap-preview.is-fullscreen > .mindmap-preview-actions,
.mindmap-preview:fullscreen > .mindmap-preview-actions {
  opacity: 1;
  pointer-events: auto;
}

.mindmap-preview-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--tn-c-brand);
  cursor: pointer;
  transition:
    background-color 0.2s,
    transform 0.2s;

  svg,
  img {
    width: 18px;
    height: 18px;
    pointer-events: none;
  }

  &:hover {
    background-color: var(--tn-c-default-soft);
  }

  &.is-active {
    background-color: color-mix(in srgb, var(--tn-c-brand) 28%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tn-c-brand) 55%, transparent);
  }

  &:hover {
    transform: scale(1.05);
  }
  &:active {
    transform: scale(0.95);
  }
}

.mindmap-preview-action-divider {
  width: 1px;
  height: 20px;
  margin: 0 1px;
  background: var(--tn-c-divider);
}

.mindmap-preview-expand {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 6px;
  border-radius: 6px;
  color: var(--tn-c-brand);
  font-size: 12px;
  cursor: default;
}

/*
 * Just the number: no label, no box, no fill — an underline is enough to say
 * "you can type here". The field is as wide as its placeholder (`1～99`) needs,
 * so the hint is never clipped, and the value is centred so the caret and the
 * number do not jump as it changes.
 */
.mindmap-preview-expand-input {
  width: 2.9rem;
  height: 20px;
  padding: 0;
  border: 0;
  border-bottom: 1px solid var(--tn-c-divider);
  border-radius: 0;
  background: transparent;
  color: var(--tn-c-brand);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  text-align: center;
  cursor: text;
  appearance: textfield;
  -moz-appearance: textfield;

  &::placeholder {
    color: var(--tn-c-text-3, var(--tn-c-text-2));
    font-weight: 400;
    opacity: 0.75;
  }

  &:focus {
    border-bottom-color: var(--tn-c-brand);
    outline: none;
  }

  /* Chromium keeps a spinner on text-ish numeric fields; we step via keys. */
  &::-webkit-outer-spin-button,
  &::-webkit-inner-spin-button {
    margin: 0;
    appearance: none;
    -webkit-appearance: none;
  }
}

.mindmap-canvas-host {
  position: relative;
  width: 100%;
  height: 440px;
  overflow: hidden;
  /*
   * No background of its own: the canvas is cleared to transparent, and the
   * container above (`.mindmap-preview`) already paints `--tn-c-bg` with the
   * panel border. Painting it again here only made the canvas read as a second,
   * inset panel inside the editor.
   */
  background: transparent;
  touch-action: none;
  user-select: none;

  /* CanvasEditor overlay + chrome tokens (aligned with mindmap-web). */
  --mm-canvas-bg: var(--tn-c-bg);
  --mm-panel-bg: var(--tn-c-bg-soft, var(--tn-c-bg));
  --mm-text: var(--tn-c-text);
  --mm-text-dim: var(--tn-c-text-2, var(--tn-c-text));
  --mm-accent: var(--tn-c-brand);
  --mm-border: var(--tn-c-divider, var(--mindmap-border));
  --mm-hover: var(--tn-c-default-soft, color-mix(in srgb, var(--tn-c-text) 8%, transparent));
  --mm-edit-bg: var(--tn-c-bg-elv, var(--tn-c-bg));

  &.is-interaction-active {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tn-c-brand) 38%, transparent);
  }
}

.mindmap-canvas-host :deep(.mindmap-view-host) {
  width: 100%;
  height: 100%;
}

.mindmap-canvas-host:deep(.mm-editor) {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  outline: none;
}

.mindmap-canvas-host:deep(.mm-canvas),
.mindmap-canvas-host:deep(.mm-overlay) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.mindmap-canvas-host:deep(.mm-overlay) {
  pointer-events: none;
}

/* Marquee box — required for box-select feedback (aligned with mindmap-web). */
.mindmap-canvas-host:deep(.mm-selection-box) {
  position: absolute;
  z-index: 8;
  pointer-events: none;
  border: 1px solid color-mix(in srgb, var(--mm-accent) 88%, white);
  border-radius: 3px;
  background: color-mix(in srgb, var(--mm-accent) 16%, transparent);
}

.mindmap-canvas-host:deep(.mm-edit-input) {
  position: absolute;
  z-index: 10;
  pointer-events: auto;
  box-sizing: border-box;
  padding: 4px 8px;
  overflow: hidden;
  border: 2px solid var(--mm-accent);
  border-radius: 6px;
  outline: none;
  background: var(--mm-edit-bg);
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.15);
  color: var(--mm-text);
  /* Desk ProseMirror sets caret-color: transparent for virtual cursor — restore. */
  caret-color: var(--mm-accent, #3b82f6);
  font-family: inherit;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: normal;
  overflow-wrap: anywhere;
  resize: none;
}

.mindmap-canvas-host:deep(.mm-edit-input.is-root) {
  border-radius: 9px;
  background: #2b3139;
  color: #fff;
}

.mindmap-canvas-host:deep(.mm-edit-input.is-primary) {
  background: #e7eaf0;
  color: #2b3139;
}

.mindmap-canvas-host:deep(.mm-edit-input.is-secondary),
.mindmap-canvas-host:deep(.mm-edit-input.is-tertiary) {
  background: color-mix(in srgb, var(--mm-canvas-bg) 90%, var(--mm-accent) 10%);
}

.mindmap-preview.is-dark .mindmap-canvas-host:deep(.mm-edit-input.is-root) {
  background: #dedede;
  color: #1d1d1f;
}

.mindmap-preview.is-dark .mindmap-canvas-host:deep(.mm-edit-input.is-primary) {
  background: #3b3b3d;
  color: #f0f0f2;
}

.mindmap-canvas-host:deep(.mm-edit-input .inline-run.bold) {
  font-weight: 700;
}
.mindmap-canvas-host:deep(.mm-edit-input .inline-run.italic) {
  font-style: italic;
}
.mindmap-canvas-host:deep(.mm-edit-input .inline-run.underline) {
  text-decoration-line: underline;
  text-underline-offset: 3px;
}
.mindmap-canvas-host:deep(.mm-edit-input .inline-run.strike) {
  text-decoration-line: line-through;
}
.mindmap-canvas-host:deep(.mm-edit-input .inline-run.underline.strike) {
  text-decoration-line: underline line-through;
}
.mindmap-canvas-host:deep(.mm-edit-input .inline-run.highlight:not(.code)) {
  padding: 0 1px;
  border-radius: 2px;
  background: #fff36a;
  color: #242424;
}
.mindmap-canvas-host:deep(.mm-edit-input .inline-run.code) {
  padding: 0 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--mm-canvas-bg) 82%, var(--mm-text) 18%);
  color: var(--tn-c-danger, #e85d5d);
  font-family: var(--tn-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.92em;
}
.mindmap-canvas-host:deep(.mm-edit-input .inline-run.link) {
  color: var(--mm-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.mindmap-canvas-host:deep(.mm-edit-add-button) {
  position: absolute;
  z-index: 12;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  outline: none;
  background: var(--mm-text);
  box-shadow: 0 0 0 2px var(--mm-canvas-bg);
  color: var(--mm-canvas-bg);
  font: 600 18px/1 sans-serif;
  pointer-events: auto;
  cursor: pointer;
}

.mindmap-canvas-host:deep(.mm-edit-add-button:hover),
.mindmap-canvas-host:deep(.mm-edit-add-button:focus-visible) {
  background: var(--mm-accent);
  color: #fff;
}

.mindmap-outline {
  max-height: 560px;
  padding: 18px 22px 22px;
  overflow: auto;
}

.mindmap-outline.is-editable {
  height: 440px;
  max-height: none;
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.mindmap-source-wrap.is-editable {
  height: 440px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.mindmap-outline.is-editable :deep(.outline-view),
.mindmap-source-wrap.is-editable :deep(.markdown-view) {
  flex: 1 1 0;
  min-height: 0;
  height: 100%;
}

.mindmap-outline-root,
.mindmap-outline :deep(ul) {
  margin: 0;
  padding: 0;
  list-style: none;
}

.mindmap-outline :deep(.mindmap-outline-children) {
  margin-left: 10px;
  padding-left: 19px;
  border-left: 1px solid var(--tn-c-divider);
}

.mindmap-outline :deep(.mindmap-outline-row) {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  min-height: 30px;
  padding: 3px 0;
  color: var(--tn-c-text);
  line-height: 24px;
}

.mindmap-outline :deep(.mindmap-outline-toggle),
.mindmap-outline :deep(.mindmap-outline-leaf) {
  display: flex;
  flex: 0 0 18px;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 24px;
  color: var(--tn-c-text-2);
  /*
   * The toggle is a real `<button>`, so it arrives with the browser's default
   * chrome — 2px outset border, button-face background, 1px 6px padding and a
   * 13.33px font. Desk never saw it because the preview renders inside
   * `.milkdown`, whose theme reset (`.milkdown button { border/background: none }`)
   * swallowed it; the SSG site has no such ancestor, so the box showed up and
   * the chevron read as a filled square next to the plain `•` leaf. Reset it
   * here so the outline looks the same wherever the component is mounted.
   */
  padding: 0;
  border: 0;
  background: none;
  box-shadow: none;
  font: inherit;
  line-height: inherit;
  text-align: center;
}

.mindmap-outline :deep(.mindmap-outline-toggle:hover) {
  color: var(--tn-c-brand);
}
.mindmap-outline :deep(.mindmap-outline-checkbox) {
  margin-top: 5px;
}
.mindmap-outline :deep(.mindmap-outline-label) {
  min-width: 0;
  overflow-wrap: anywhere;
}
.mindmap-outline :deep(.mindmap-outline-node.is-root > .mindmap-outline-row) {
  font-size: 18px;
  font-weight: 700;
}
.mindmap-outline
  :deep(.mindmap-outline-node.is-done > .mindmap-outline-row .mindmap-outline-label) {
  opacity: 0.58;
  text-decoration: line-through;
}
.mindmap-outline :deep(.mindmap-outline-image) {
  display: block;
  max-width: min(100%, 560px);
  max-height: 360px;
  margin: 5px 0 12px 25px;
  border-radius: 6px;
}
.mindmap-outline :deep(.is-bold) {
  font-weight: 700;
}
.mindmap-outline :deep(.is-italic) {
  font-style: italic;
}
.mindmap-outline :deep(.is-underline) {
  text-decoration: underline;
}
.mindmap-outline :deep(.is-strike) {
  text-decoration: line-through;
}
.mindmap-outline :deep(.is-highlight) {
  padding: 0 2px;
  border-radius: 2px;
  background: #ffe56b;
  color: #252525;
}
.mindmap-outline :deep(.is-code) {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--tn-c-bg-soft);
  color: var(--tn-c-danger);
  font-family: var(--tn-font-mono);
}
.mindmap-outline :deep(.is-link) {
  color: var(--tn-c-brand);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.mindmap-source {
  max-height: 560px;
  margin: 0;
  padding: 18px 22px;
  overflow: auto;
  border-radius: 0;
  background: var(--tn-c-bg-elv);
  color: var(--tn-c-text);
  font-size: 13px;
  line-height: 1.65;
  white-space: pre;
}

.mindmap-preview:fullscreen,
.mindmap-preview.is-fullscreen {
  /* Desk frameless titlebar is ~42px with -webkit-app-region:drag. */
  --mm-fs-chrome-top: 48px;
  position: fixed;
  inset: 0;
  z-index: 200000;
  display: flex;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  margin: 0;
  padding-top: var(--mm-fs-chrome-top);
  border: 0;
  border-radius: 0;
  background: var(--tn-c-bg);
  flex-direction: column;
  overflow: hidden;

  > .mindmap-preview-actions {
    top: var(--mm-fs-chrome-top);
    right: 12px;
    z-index: 10;
    opacity: 1;
    pointer-events: auto;
    -webkit-app-region: no-drag;
    app-region: no-drag;
  }

  > .focus-breadcrumbs {
    -webkit-app-region: no-drag;
    app-region: no-drag;
  }

  /*
   * Only one .mindmap-pane exists (v-if). Use flex-basis:0 + grow — do NOT set
   * height:0 as a separate property (locks the pane at 0px in WebKit/Electron).
   */
  .mindmap-pane {
    flex: 1 1 0%;
    width: 100%;
    min-height: 0;
    max-height: none;
  }

  .mindmap-canvas-host,
  .mindmap-outline,
  .mindmap-outline.is-editable,
  .mindmap-source-wrap,
  .mindmap-source-wrap.is-editable {
    height: auto;
  }

  .mindmap-outline.is-editable,
  .mindmap-source-wrap.is-editable {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .mindmap-outline.is-editable :deep(.outline-view),
  .mindmap-source-wrap.is-editable :deep(.markdown-view) {
    flex: 1 1 0%;
    min-height: 0;
    height: auto;
  }
}

@media (max-width: 768px) {
  .mindmap-canvas-host {
    height: 360px;
  }
  .mindmap-preview-actions {
    top: 6px;
    right: 6px;
  }
  .mindmap-preview-action {
    width: 28px;
    height: 28px;
  }
  .mindmap-outline {
    padding-inline: 12px;
  }
}
</style>

<!-- Unscoped: while one mindmap owns fullscreen, hide chrome on all others. -->
<style lang="scss">
html[data-tn-mindmap-fs] .mindmap-preview:not(.is-fullscreen) .mindmap-preview-actions,
body[data-tn-mindmap-fs] .mindmap-preview:not(.is-fullscreen) .mindmap-preview-actions {
  display: none !important;
  opacity: 0 !important;
  pointer-events: none !important;
  visibility: hidden !important;
}
</style>
