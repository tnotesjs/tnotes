<script setup lang="ts" generic="T extends string">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

import { computeVisibleCount } from './overflowFit'

const props = defineProps<{
  items: readonly T[]
  disabled?: boolean
}>()

const root = ref<HTMLElement | null>(null)
const measureRow = ref<HTMLElement | null>(null)
const moreButton = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const visibleCount = ref(props.items.length)
const menuOpen = ref(false)
const menuPosition = ref({ left: '0px', top: '0px' })
const menuId = useId()
const itemGap = 2
let closeTimer: ReturnType<typeof setTimeout> | null = null
let observer: ResizeObserver | null = null

const hasOverflow = computed(() => visibleCount.value < props.items.length)
const visibleItems = computed(() => props.items.slice(0, visibleCount.value))
const overflowItems = computed(() => props.items.slice(visibleCount.value))

function cancelClose(): void {
  if (closeTimer !== null) clearTimeout(closeTimer)
  closeTimer = null
}

function closeMenu(): void {
  cancelClose()
  menuOpen.value = false
}

function tryClose(): void {
  cancelClose()
  closeTimer = setTimeout(() => {
    if (document.querySelector('.heading-menu, .block-insert-menu')) {
      tryClose()
      return
    }
    menuOpen.value = false
  }, 200)
}

async function openMenu(): Promise<void> {
  if (props.disabled || !hasOverflow.value) return
  cancelClose()
  menuOpen.value = true
  await nextTick()
  const trigger = moreButton.value?.getBoundingClientRect()
  const panel = menu.value?.getBoundingClientRect()
  if (!trigger || !panel) return
  const left = Math.min(
    Math.max(8, trigger.right - panel.width),
    window.innerWidth - panel.width - 8
  )
  menuPosition.value = {
    left: `${left}px`,
    top: `${trigger.bottom + 6}px`
  }
}

function measure(): void {
  const host = root.value
  const row = measureRow.value
  if (!host || !row) return
  const available = host.clientWidth
  if (available <= 0) return
  const itemEls = [...row.querySelectorAll<HTMLElement>('[data-overflow-measure]')]
  const widths = itemEls.map((element) => {
    const width = element.getBoundingClientRect().width
    return width > 0 ? width : 32
  })
  const more =
    row.querySelector<HTMLElement>('[data-overflow-more-measure]')?.getBoundingClientRect().width ??
    32
  visibleCount.value = computeVisibleCount(available, widths, itemGap, more > 0 ? more : 32)
  if (!hasOverflow.value) closeMenu()
}

onMounted(() => {
  observer = new ResizeObserver(() => measure())
  if (root.value) observer.observe(root.value)
  measure()
})

onBeforeUnmount(() => {
  cancelClose()
  observer?.disconnect()
  observer = null
})

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) closeMenu()
  }
)

watch(
  () => props.items.join('\0'),
  async () => {
    visibleCount.value = props.items.length
    await nextTick()
    measure()
  }
)
</script>

<template>
  <div
    ref="root"
    class="format-overflow"
    :class="{ 'format-overflow--disabled': disabled }"
    aria-label="Markdown 格式工具栏"
    @mousedown.prevent
  >
    <div ref="measureRow" class="format-overflow__measure" aria-hidden="true" inert>
      <div
        v-for="item in items"
        :key="`measure-${item}`"
        class="format-overflow__item"
        data-overflow-measure
      >
        <slot name="item" :item="item" />
      </div>
      <button type="button" class="format-overflow__more" data-overflow-more-measure tabindex="-1">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="18" cy="12" r="1.7" />
        </svg>
      </button>
    </div>

    <div class="format-overflow__inline">
      <div v-for="item in visibleItems" :key="item" class="format-overflow__item">
        <slot name="item" :item="item" />
      </div>
      <button
        v-show="hasOverflow"
        ref="moreButton"
        type="button"
        class="format-overflow__more"
        aria-label="更多"
        :disabled="disabled"
        :aria-expanded="menuOpen"
        :aria-controls="menuOpen ? menuId : undefined"
        @mouseenter="openMenu"
        @mouseleave="tryClose"
        @focus="openMenu"
        @blur="tryClose"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="18" cy="12" r="1.7" />
        </svg>
      </button>
    </div>

    <Teleport to="body">
      <div
        v-if="menuOpen && hasOverflow"
        :id="menuId"
        ref="menu"
        class="format-overflow__menu"
        role="menu"
        aria-label="更多格式"
        :style="menuPosition"
        @mouseenter="cancelClose"
        @mouseleave="tryClose"
      >
        <div v-for="item in overflowItems" :key="item" class="format-overflow__item">
          <slot name="item" :item="item" />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.format-overflow {
  position: relative;
  /*
   * 不抢空白、不居中：视口越宽，视图开关与「正文」下拉之间的缝就越大 —— 那段空白
   * 其实是这里 `flex: 1` + `justify-content: center` 分到的自由空间的一半。
   * 改成"按内容宽、靠左"，空白统一交给右端的布局开关吸收。
   */
  flex: 0 1 auto;
  min-width: 0;
  display: flex;
  justify-content: flex-start;
}

/*
 * 量宽用的隐藏行：装着**全部**条目（不做溢出裁剪），所以它一定比工具条本身宽。
 * 必须自己把这份溢出吃掉（与父级同宽 + `overflow: hidden`）—— 否则它会成为祖先的
 * 可滚动溢出：内容区一旦是横向滚动容器（`.editor-group-body`，最小宽度 500px 那条），
 * 就会被它顶出一条横向滚动条（实测：窗格 838px 宽时 scrollWidth 变 936px，
 * 滚动条吃掉 9px 高度，拖拽落点预览的高度断言因此差 9px）。
 * 用 `right: 0` 与父级同宽；条目是 `flex: none`，宽度仍按自然尺寸量得到。
 */
.format-overflow__measure {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}

.format-overflow__inline,
.format-overflow__menu {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: center;
  gap: 2px;
}

.format-overflow__item {
  flex: none;
  display: inline-flex;
  align-items: center;
}

.format-overflow__item :deep(.ui-tooltip-host) {
  flex: none;
}

.format-overflow__item :deep(button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 14px;
  cursor: pointer;
}

.format-overflow__item :deep(button:hover:not(:disabled)),
.format-overflow__item :deep(button:focus-visible:not(:disabled)) {
  outline: none;
  background: var(--hover);
  color: var(--text);
}

.format-overflow--disabled {
  opacity: 0.4;
}

.format-overflow--disabled :deep(button),
.format-overflow__item :deep(button:disabled) {
  cursor: not-allowed;
}

.format-overflow__more {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.format-overflow__more:hover:not(:disabled),
.format-overflow__more:focus-visible:not(:disabled),
.format-overflow__more[aria-expanded='true']:not(:disabled) {
  outline: none;
  background: var(--hover);
  color: var(--text);
}

.format-overflow__more:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.format-overflow__more svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.format-overflow__menu {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  padding: 6px;
  color: var(--editor-text);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgb(0 0 0 / 28%);
}
</style>
