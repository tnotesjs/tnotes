<template>
  <aside
    id="site-sidebar"
    class="tn-site-sidebar"
    :class="{ 'is-drawer-open': mobileOpen }"
    :role="mobileOpen ? 'dialog' : undefined"
    :aria-modal="mobileOpen || undefined"
    aria-label="笔记目录"
  >
    <div class="tn-sidebar-tools">
      <div class="tn-sidebar-filter">
        <input
          ref="filterInput"
          v-model="filter"
          aria-label="筛选目录"
          placeholder="筛选标题或题号"
        /><button v-if="filter" type="button" @click="filter = ''">清空</button
        ><button
          type="button"
          class="tn-sidebar-icon-button"
          title="把目录滚动到当前笔记"
          aria-label="定位当前笔记"
          @click="locateActive"
        >
          <SiteIcon name="focus" />
        </button>
        <button
          type="button"
          class="tn-sidebar-icon-button"
          :disabled="Boolean(filter.trim())"
          :aria-label="allCollapsed ? '全部展开' : '全部收起'"
          :title="allCollapsed ? '全部展开' : '全部收起'"
          @click="toggleAll"
        >
          <SiteIcon name="foldAll" />
        </button>
      </div>
      <p v-if="visibleKeys?.size === 0" role="status">没有匹配的笔记</p>
    </div>
    <div ref="scrollRef" class="tn-site-sidebar-scroll">
      <SidebarTree
        :items="items"
        :active-route="activeRoute"
        :base="base"
        :visible-keys="visibleKeys"
      />
    </div>

    <div
      class="tn-sidebar-resizer"
      role="separator"
      tabindex="0"
      aria-label="调整目录宽度"
      aria-orientation="vertical"
      :aria-valuenow="width"
      :aria-valuemin="220"
      :aria-valuemax="420"
      @pointerdown="startResize"
      @pointermove="moveResize"
      @pointerup="stopResize"
      @pointercancel="stopResize"
      @keydown="resizeKey"
    />
  </aside>
</template>

<script setup lang="ts">
/**
 * Sidebar shell: owns the scroll container, the collapse context, and the
 * session state that has to outlive a full document load.
 *
 * The 定位当前笔记 button is the escape hatch for the one case restore cannot
 * cover — arriving from search or an in-article link, where the current note
 * sits outside the restored viewport. It sits in the tools row, always on, so
 * the reader never has to wonder whether it is about to appear; core had the
 * same control in its toolbar.
 *
 * No `<!-- -->` comments in the template: Vue SSR emits them verbatim into
 * every generated page.
 */
import { nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, computed, watch } from 'vue'

import {
  filterSidebarKeys,
  clampSidebarWidth,
  collapsedByDefaultKeys,
  sidebarGroupKeys
} from '../navigation'
import SidebarTree from './SidebarTree.vue'
import SiteIcon from './SiteIcon.vue'
import { SIDEBAR_COLLAPSE_KEY, type SidebarCollapseContext } from '../sidebarContext'
import {
  centredScrollTop,
  readSidebarState,
  releaseSidebarRestoreGate,
  sidebarAncestorKeys,
  writeSidebarState
} from '../sidebarState'
import type { SidebarItem } from '../../types'

const props = defineProps<{
  items: SidebarItem[]
  activeRoute: string
  base: string
  desktopHidden?: boolean
  mobileOpen?: boolean
  width?: number
}>()

const emit = defineEmits<{ resize: [width: number] }>()
const filter = ref('')
const filterInput = ref<HTMLInputElement>()
const visibleKeys = computed(() => filterSidebarKeys(props.items, filter.value))
let filterScroll = 0
watch(filter, async (value, previous) => {
  if (!previous.trim() && value.trim()) {
    filterScroll = scrollRef.value?.scrollTop ?? 0
    clearTimeout(persistTimer)
  }
  await nextTick()
  if (scrollRef.value) scrollRef.value.scrollTop = value.trim() ? 0 : filterScroll
})
watch(
  () => [props.mobileOpen, props.desktopHidden],
  async () => {
    const scroller = scrollRef.value
    if (scroller?.clientHeight) lastVisibleScroll = scroller.scrollTop
    await nextTick()
    if (!scroller?.clientHeight) return
    scroller.scrollTop = filter.value.trim() ? scroller.scrollTop : lastVisibleScroll
    if (!userBrowsed && stored.scrollTop === null && !filter.value.trim()) await locateActive()
  }
)

function collapseAll() {
  for (const key of sidebarGroupKeys(props.items)) collapsed.add(key)
  persist()
}
function expandAll() {
  collapsed.clear()
  persist()
}

/**
 * Collapse-all and expand-all were two buttons that could never both be right:
 * the tree is either fully collapsed or it is not. One toggle derives its label
 * and its target from that single fact, so the halves cannot disagree — and it
 * keeps desk's single "折叠/展开全部" glyph instead of a two-button row.
 */
function toggleAll() {
  if (allCollapsed.value) expandAll()
  else collapseAll()
}

/**
 * Snapshotting the set rather than probing it with `has()` is deliberate: only
 * *iterating* subscribes to the collection's iteration key, and `clear()` fires
 * nothing else. A per-key probe would therefore survive an expand-all and leave
 * the toggle still offering "全部展开" for a tree that is wide open.
 */
const collapsedKeys = computed(() => new Set(collapsed))
const allCollapsed = computed(() => {
  const keys = sidebarGroupKeys(props.items)
  return keys.length > 0 && keys.every((key) => collapsedKeys.value.has(key))
})
let resizing = false
let resizeLeft = 0
function startResize(event: PointerEvent) {
  if (event.button !== 0) return
  resizing = true
  const handle = event.currentTarget as HTMLElement
  resizeLeft = handle.parentElement!.getBoundingClientRect().left
  handle.setPointerCapture(event.pointerId)
  event.preventDefault()
}
function moveResize(event: PointerEvent) {
  if (resizing) emit('resize', clampSidebarWidth(event.clientX - resizeLeft))
}
function stopResize() {
  resizing = false
}
function resizeKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  emit(
    'resize',
    event.key === 'Home'
      ? 220
      : event.key === 'End'
        ? 420
        : clampSidebarWidth((props.width ?? 272) + (event.key === 'ArrowRight' ? 16 : -16))
  )
}

/** Inputs that mean the reader moved the sidebar, as opposed to us doing it. */
const USER_SCROLL_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const

const scrollRef = ref<HTMLElement>()

// Read once, before any listener can rewrite it: `scrollTop === null` is what
// tells this page to reveal the current note rather than restore a spot.
const stored = readSidebarState(props.base)

/**
 * Seeded with the default view — every group but the current note's branch.
 *
 * The same set is computed on the server, so the markup the server renders and
 * the vdom the client hydrates agree, and the tree is already folded on the
 * first paint. Seeding the *stored* set here is what the comment above used to
 * warn about: hydration only checks class mismatches, so a vdom that agreed with
 * itself would leave the tree stuck on the default. The stored set is applied in
 * `onMounted`, where a real re-render happens.
 */
const collapsed = reactive(new Set(collapsedByDefaultKeys(props.items, props.activeRoute)))

/**
 * Only a scroll the reader performed themselves is worth restoring. A scroll we
 * caused — locating the current note — must not masquerade as a chosen
 * position, or every later page would restore it instead of revealing where the
 * reader actually is.
 */
let userBrowsed = false
let lastVisibleScroll = stored.scrollTop ?? 0

function persist() {
  writeSidebarState(props.base, {
    collapsed: [...collapsed],
    scrollTop: filter.value.trim()
      ? filterScroll
      : userBrowsed
        ? scrollRef.value?.clientHeight
          ? scrollRef.value.scrollTop
          : lastVisibleScroll
        : stored.scrollTop
  })
}

const collapseContext: SidebarCollapseContext = {
  collapsed,
  toggle(key: string) {
    if (collapsed.has(key)) collapsed.delete(key)
    else collapsed.add(key)
    persist()
  },
  expand(keys: string[]) {
    let changed = false
    for (const key of keys) if (collapsed.delete(key)) changed = true
    if (changed) persist()
  }
}
provide(SIDEBAR_COLLAPSE_KEY, collapseContext)

const activeElement = () =>
  scrollRef.value?.querySelector<HTMLElement>('.tn-site-sidebar-link[aria-current="page"]') ?? null

function isWithinViewport(element: HTMLElement) {
  const scroller = scrollRef.value
  if (!scroller) return true
  const box = element.getBoundingClientRect()
  // A collapsed ancestor leaves a zero-size box. Say so explicitly instead of
  // relying on the container happening to sit below y=0, where `top >= view.top`
  // would otherwise let a hidden node pass as visible.
  if (box.height === 0) return false
  const view = scroller.getBoundingClientRect()
  return box.top >= view.top && box.bottom <= view.bottom
}

/**
 * The current note must never sit inside a collapsed branch — the reader has no
 * way to tell where they are. Only that path is reopened; every other collapse
 * the reader chose is left alone, and this never scrolls.
 */
async function revealActiveAncestry() {
  const active = activeElement()
  const key = active?.closest<HTMLElement>('.tn-site-sidebar-item')?.dataset.tnKey
  if (!key) return
  collapseContext.expand(sidebarAncestorKeys(key))
  // A collapsed target measures as a zero-height box, so layout must settle
  // before anything tries to measure or scroll to it.
  await nextTick()
}

/** Moves the sidebar only — never the article beside it. */
function scrollActiveIntoView() {
  const scroller = scrollRef.value
  const active = activeElement()
  if (!scroller || !active) return
  const view = scroller.getBoundingClientRect()
  const box = active.getBoundingClientRect()
  // A row the filter has hidden measures as an empty box, and centring on that
  // would throw the sidebar somewhere arbitrary. The locate button is always
  // available, so this case is now reachable.
  if (box.height === 0) return
  scroller.scrollTop = centredScrollTop({
    scrollTop: scroller.scrollTop,
    clientHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
    targetTop: box.top - view.top,
    targetHeight: box.height
  })
}

async function locateActive() {
  await revealActiveAncestry()
  const active = activeElement()
  if (active && !isWithinViewport(active)) scrollActiveIntoView()
}

let frame = 0
let persistTimer: ReturnType<typeof setTimeout> | undefined

function onScroll() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    if (!scrollRef.value?.clientHeight) return
    lastVisibleScroll = scrollRef.value.scrollTop
    if (!userBrowsed || filter.value.trim()) return
    clearTimeout(persistTimer)
    persistTimer = setTimeout(persist, 200)
  })
}

function markUserBrowsed() {
  if (filter.value.trim()) return
  userBrowsed = true
}

function flush() {
  clearTimeout(persistTimer)
  persist()
}

onMounted(async () => {
  const scroller = scrollRef.value
  if (scroller) {
    scroller.addEventListener('scroll', onScroll, { passive: true })
    for (const event of USER_SCROLL_EVENTS) {
      scroller.addEventListener(event, markUserBrowsed, { passive: true })
    }
    window.addEventListener('pagehide', flush)

    // A reader who has already browsed this tab gets their own collapse set back;
    // a fresh visit keeps the default. Either way this runs after hydration, so
    // the re-render it triggers is real rather than a vdom/class mismatch.
    if (stored.scrollTop !== null) {
      collapsed.clear()
      for (const key of stored.collapsed) collapsed.add(key)
    }
    await nextTick()

    await revealActiveAncestry()
    // Restore beats locate: a saved offset is a position the reader picked, so
    // only a page with nothing to restore may scroll itself into place.
    if (stored.scrollTop !== null) {
      scroller.scrollTop = stored.scrollTop
    } else {
      const active = activeElement()
      if (active && !isWithinViewport(active)) scrollActiveIntoView()
    }
  }
  // Everything above is synchronous DOM mutation, so the sidebar is already
  // correct by the time the gate makes it visible again.
  releaseSidebarRestoreGate()
})

onBeforeUnmount(() => {
  const scroller = scrollRef.value
  if (scroller) {
    scroller.removeEventListener('scroll', onScroll)
    for (const event of USER_SCROLL_EVENTS) {
      scroller.removeEventListener(event, markUserBrowsed)
    }
  }
  window.removeEventListener('pagehide', flush)
  if (frame) cancelAnimationFrame(frame)
  clearTimeout(persistTimer)
})
</script>
