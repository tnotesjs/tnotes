<template>
  <aside class="tn-site-sidebar">
    <div ref="scrollRef" class="tn-site-sidebar-scroll">
      <SidebarTree :items="items" :active-route="activeRoute" :base="base" />
    </div>

    <button
      type="button"
      class="tn-site-sidebar-locate"
      :class="{ 'is-visible': showLocate }"
      title="把目录滚动到当前笔记"
      @click="locateActive"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3.25" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path
          d="M8 1.5v2.25M8 12.25v2.25M1.5 8h2.25M12.25 8h2.25"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
      当前笔记
    </button>
  </aside>
</template>

<script setup lang="ts">
/**
 * Sidebar shell: owns the scroll container, the collapse context, and the
 * session state that has to outlive a full document load.
 *
 * The "当前笔记" button is the escape hatch for the one case restore cannot
 * cover — arriving from search or an in-article link, where the current note
 * sits outside the restored viewport. It is absolutely positioned and toggled
 * by visibility rather than mounted, so revealing it never shifts the tree
 * under the reader's cursor.
 *
 * No `<!-- -->` comments in the template: Vue SSR emits them verbatim into
 * every generated page.
 */
import { nextTick, onBeforeUnmount, onMounted, provide, reactive, ref } from 'vue'

import SidebarTree from './SidebarTree.vue'
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
}>()

/** Inputs that mean the reader moved the sidebar, as opposed to us doing it. */
const USER_SCROLL_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const

const scrollRef = ref<HTMLElement>()
const showLocate = ref(false)

// Read once, before any listener can rewrite it: `scrollTop === null` is what
// tells this page to reveal the current note rather than restore a spot.
const stored = readSidebarState(props.base)

/**
 * Deliberately empty on the first render, even when storage holds a collapse
 * set. Hydration only *checks* class mismatches — Vue does not rectify them —
 * so seeding this during setup would leave the tree stuck fully expanded: the
 * vdom would already agree with itself and never emit a patch. The stored set
 * is applied in `onMounted` instead, where a real re-render happens.
 */
const collapsed = reactive(new Set<string>())

/**
 * Only a scroll the reader performed themselves is worth restoring. A scroll we
 * caused — locating the current note — must not masquerade as a chosen
 * position, or every later page would restore it instead of revealing where the
 * reader actually is.
 */
let userBrowsed = false

function persist() {
  writeSidebarState(props.base, {
    collapsed: [...collapsed],
    scrollTop: userBrowsed ? (scrollRef.value?.scrollTop ?? null) : stored.scrollTop
  })
}

const collapseContext: SidebarCollapseContext = {
  collapsed,
  toggle(key: string) {
    if (collapsed.has(key)) collapsed.delete(key)
    else collapsed.add(key)
    persist()
    void refreshLocateVisibility()
  },
  expand(keys: string[]) {
    let changed = false
    for (const key of keys) if (collapsed.delete(key)) changed = true
    if (changed) persist()
    void refreshLocateVisibility()
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

function updateLocateVisibility() {
  const active = activeElement()
  showLocate.value = active !== null && !isWithinViewport(active)
}

/**
 * Collapsing a subtree can hide the current note, so the button's state has to
 * be re-derived once layout settles. Scroll and resize alone miss it — and so
 * does the browser's own scroll event, which never fires when the container is
 * already at offset 0.
 */
async function refreshLocateVisibility() {
  await nextTick()
  updateLocateVisibility()
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
  updateLocateVisibility()
}

let frame = 0
let persistTimer: ReturnType<typeof setTimeout> | undefined

function onScroll() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    updateLocateVisibility()
    if (!userBrowsed) return
    clearTimeout(persistTimer)
    persistTimer = setTimeout(persist, 200)
  })
}

function markUserBrowsed() {
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
    window.addEventListener('resize', updateLocateVisibility)

    // Apply the stored collapse set now that hydration is behind us, and let
    // Vue paint it before anything measures the tree.
    for (const key of stored.collapsed) collapsed.add(key)
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
  updateLocateVisibility()
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
  window.removeEventListener('resize', updateLocateVisibility)
  if (frame) cancelAnimationFrame(frame)
  clearTimeout(persistTimer)
})
</script>
