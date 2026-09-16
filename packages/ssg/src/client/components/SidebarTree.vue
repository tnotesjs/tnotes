<template>
  <ul class="tn-site-sidebar-list">
    <li
      v-for="(item, position) in items"
      :key="nodeKey(position)"
      v-show="!visibleKeys || visibleKeys.has(nodeKey(position))"
      class="tn-site-sidebar-item"
      :class="{
        'is-collapsed':
          !visibleKeys && hasChildren(item) && collapse.collapsed.has(nodeKey(position))
      }"
      :data-tn-key="nodeKey(position)"
    >
      <div class="tn-site-sidebar-row" :class="{ 'is-active': isActive(item) }">
        <button
          v-if="hasChildren(item)"
          type="button"
          class="tn-site-sidebar-toggle"
          :disabled="Boolean(visibleKeys)"
          :aria-expanded="
            !visibleKeys && collapse.collapsed.has(nodeKey(position)) ? 'false' : 'true'
          "
          :aria-label="`${collapse.collapsed.has(nodeKey(position)) ? '展开' : '收起'} ${item.text}`"
          @click="collapse.toggle(nodeKey(position))"
        >
          <svg class="tn-site-sidebar-chevron" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M4.5 2.5 8 6l-3.5 3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <span v-else class="tn-site-sidebar-toggle is-empty" aria-hidden="true"></span>

        <a
          v-if="item.link"
          class="tn-site-sidebar-link"
          :href="href(item.link)"
          :title="tooltip(item)"
          :aria-current="isActive(item) ? 'page' : undefined"
        >
          <span
            v-if="item.index"
            class="tn-site-sidebar-status"
            :data-done="item.done === true"
            aria-hidden="true"
          ></span>
          <span v-if="item.index" class="tn-site-sidebar-index" aria-hidden="true">
            {{ item.index }}
          </span>
          <span v-if="item.index" class="tn-site-visually-hidden">
            {{ item.done === true ? '已完成' : '待完成' }}
          </span>
          <span class="tn-site-sidebar-text">{{ item.text }}</span>
        </a>
        <span v-else class="tn-site-sidebar-heading" :title="item.text">{{ item.text }}</span>
      </div>

      <SidebarTree
        v-if="hasChildren(item)"
        class="tn-site-sidebar-children"
        :items="item.items ?? []"
        :active-route="activeRoute"
        :base="base"
        :prefix="nodeKey(position)"
        :visible-keys="visibleKeys"
      />
    </li>
  </ul>
</template>

<script setup lang="ts">
/**
 * One TOC row.
 *
 * Disclosure and navigation are deliberately separate sibling hit areas: the
 * chevron button toggles a subtree, the link navigates. Neither can do the
 * other's job, so clicking a title never reshuffles the tree, and clicking a
 * chevron never navigates away.
 *
 * No `<!-- -->` comments in the template: Vue SSR emits them verbatim into
 * every generated page.
 */
import { inject } from 'vue'

import { SIDEBAR_COLLAPSE_KEY, createInertCollapseContext } from '../sidebarContext'
import { normalizeRoute } from '../navigation'
import { sidebarNodeKey } from '../sidebarState'
import type { SidebarItem } from '../../types'

/** One shared fallback: a tree recurses per TOC node, so this must not be
 *  allocated per instance. */
const INERT_COLLAPSE = createInertCollapseContext()

const props = withDefaults(
  defineProps<{
    items: SidebarItem[]
    /** Canonical route of the note currently on screen. */
    activeRoute: string
    base: string
    /** Position path of the parent node; "" at the root. */
    visibleKeys?: Set<string> | null
    prefix?: string
  }>(),
  { prefix: '' }
)

const collapse = inject(SIDEBAR_COLLAPSE_KEY, INERT_COLLAPSE)

const nodeKey = (position: number) => sidebarNodeKey(props.prefix, position)

const hasChildren = (item: SidebarItem) => Boolean(item.items?.length)

const isActive = (item: SidebarItem) =>
  Boolean(item.link) && normalizeRoute(item.link!) === normalizeRoute(props.activeRoute)

/** Row is truncated to two lines, so the full label stays reachable here. */
const tooltip = (item: SidebarItem) => (item.index ? `${item.index}. ${item.text}` : item.text)

const href = (link: string) => {
  if (/^(https?:)?\/\//.test(link)) return link
  return `${props.base}${link.replace(/^\//, '')}`
}
</script>
