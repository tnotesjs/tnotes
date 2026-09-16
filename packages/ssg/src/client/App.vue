<template>
  <div
    class="tn-site"
    :class="{ 'sidebar-hidden': sidebarHidden }"
    :style="{ '--sidebar-width': `${sidebarWidth}px` }"
  >
    <header class="tn-site-header" :inert="mobileOpen || searchOpen">
      <a
        class="tn-site-brand"
        :href="site.repositoryUrl ?? site.base"
        :target="site.repositoryUrl ? '_blank' : undefined"
        :rel="site.repositoryUrl ? 'noopener noreferrer' : undefined"
        :title="site.repositoryUrl ? '在 GitHub 上打开这个知识库' : undefined"
        >{{ site.title }}</a
      >
      <div class="tn-site-actions">
        <button type="button" aria-label="搜索" @click="searchOpen = true">⌕</button>
        <button type="button" aria-label="切换主题" @click="toggleTheme">◐</button>
        <button
          type="button"
          class="tn-site-drawer-button"
          aria-controls="site-sidebar"
          :aria-expanded="mobileOpen"
          aria-label="显示目录"
          title="显示目录"
          @click="mobileOpen = true"
        >
          <SiteIcon name="outline" />
        </button>
      </div>
    </header>

    <div class="tn-site-body" :inert="searchOpen">
      <div v-if="mobileOpen" class="tn-sidebar-mask" @click="mobileOpen = false" />
      <SidebarNav
        :items="site.sidebar"
        :active-route="activeRoute"
        :base="site.base"
        :mobile-open="mobileOpen"
        :desktop-hidden="sidebarHidden"
        :width="sidebarWidth"
        @resize="sidebarWidth = $event"
        @click="closeDrawerOnPick"
      />
      <button
        type="button"
        class="tn-sidebar-handle"
        aria-controls="site-sidebar"
        :aria-expanded="sidebarVisible"
        :aria-label="sidebarVisible ? '隐藏目录' : '显示目录'"
        :title="sidebarVisible ? '隐藏目录' : '显示目录'"
        @click="toggleSidebar"
      >
        <SiteIcon name="sidebarCollapse" />
      </button>
      <main :inert="mobileOpen" class="tn-site-main">
        <ArticleTools
          v-if="data.source !== undefined && data.relativePath.startsWith('notes/')"
          :repo-url="noteRepoUrl"
          :source="data.source"
          :folded="headingsFolded"
          :can-fold="hasArticleHeadings"
          @toggle-fold="headingControls?.toggleAll()"
        />
        <div class="tn-site-article" ref="article" v-html="articleHtml"></div>
        <Discussions v-if="data.noteId" :id="data.noteId" />
      </main>
      <aside :inert="mobileOpen" v-if="outlineHeadings.length" class="tn-site-outline">
        <strong>本页目录</strong>
        <ul>
          <li v-for="heading in outlineHeadings" :key="heading.id" :data-level="heading.level">
            <a :href="`#${heading.id}`" @click.prevent="jumpToHeading(heading.id)">{{
              heading.text
            }}</a>
          </li>
        </ul>
      </aside>
    </div>

    <div v-if="searchOpen" class="tn-search-mask" @click.self="searchOpen = false">
      <section
        ref="searchDialog"
        class="tn-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="搜索笔记"
      >
        <button type="button" class="tn-search-close" @click="searchOpen = false">关闭搜索</button>
        <input
          ref="searchInput"
          v-model="query"
          autofocus
          placeholder="搜索题号、标题和正文"
          role="combobox"
          aria-label="搜索笔记"
          aria-autocomplete="list"
          aria-controls="search-results"
          :aria-expanded="results.length > 0"
          :aria-activedescendant="results.length ? `search-result-${selectedResult}` : undefined"
          @keydown.down.prevent="moveResult(1)"
          @keydown.up.prevent="moveResult(-1)"
          @keydown.enter.prevent="openSelected"
          @keydown.escape="searchOpen = false"
        />
        <p v-if="searchError" role="alert">
          {{ searchError }} <button @click="loadSearch">重试</button>
        </p>
        <p v-else-if="searching">正在载入索引…</p>
        <p v-else-if="query.trim() && !results.length" role="status">没有找到相关笔记</p>
        <ul v-else id="search-results" role="listbox" aria-label="搜索结果">
          <li
            v-for="(result, i) in results"
            :key="result.route"
            :id="`search-result-${i}`"
            role="option"
            :aria-selected="i === selectedResult"
          >
            <a
              :href="navHref(result.route)"
              tabindex="-1"
              :class="{ 'is-selected': i === selectedResult }"
            >
              <strong
                >{{ noteNumber(result.route) ? `${noteNumber(result.route)}. ` : ''
                }}{{ result.title }}</strong
              >
              <small>{{ result.text.slice(0, 120) }}</small>
            </a>
          </li>
        </ul>
      </section>
    </div>

    <ImagePreview v-if="mounted" />
  </div>
</template>

<script setup lang="ts">
import MiniSearch from 'minisearch'
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import ImagePreview from '@tnotesjs/ui/image-preview'
import site from 'virtual:tnotes-site'

import { setupHeadingFolds } from './headingFolds'
import { sidebarNotes, noteNumber, clampSidebarWidth } from './navigation'
import { useModalFocus } from './useModalFocus'
// The comments belong to *this* app, not to the article: the article is rendered
// in its own app and injected as HTML, so nothing inside it ever hydrates.
import ArticleTools from './components/ArticleTools.vue'
import Discussions from './components/Discussions.vue'
import SidebarNav from './components/SidebarNav.vue'
import SiteIcon from './components/SiteIcon.vue'
import { canonicalNoteRoute, parseNoteSlug } from './noteRoute'
import { normalizeSearchTerm, tokenizeSearch } from './search'
import type { PageData, PageHeading } from '../types'

const props = defineProps<{
  route: string
  data: PageData
  articleHtml: string
}>()

const hasArticleHeadings = computed(() => /<h[1-6](?:\s|>)/i.test(props.articleHtml))
const headingsFolded = ref(false)
const article = ref<HTMLElement>()
let headingControls: ReturnType<typeof setupHeadingFolds> | undefined
onBeforeUnmount(() => headingControls?.destroy())
async function jumpToHeading(id: string) {
  const target = document.getElementById(id)
  if (target) {
    headingControls?.reveal(target)
    await nextTick()
    window.history.pushState(null, '', `#${encodeURIComponent(id)}`)
    target.scrollIntoView({ block: 'start' })
  }
}
const noteRepoUrl = computed(() => {
  const repository = site.repositoryUrl?.replace(/\/+$/, '')
  if (!repository || !props.data.relativePath.startsWith('notes/')) return ''
  return `${repository}/blob/main/${props.data.relativePath.split('/').map(encodeURIComponent).join('/')}`
})

type SearchResult = Pick<PageData, 'route' | 'title' | 'text'>

/**
 * The sidebar highlights by note, but the home page (and 404) are synthesized
 * routes that reuse a note's body — comparing the raw route left `/` with
 * nothing highlighted at all. Resolve back to the canonical note route so the
 * entry the reader is actually on stays lit.
 */
const activeRoute = computed(() => {
  if (props.route.startsWith('/notes/')) return props.route
  const slug = props.data.relativePath.split('/').pop()?.replace(/\.md$/i, '') ?? ''
  const parsed = parseNoteSlug(slug)
  return parsed?.kind === 'index' ? canonicalNoteRoute(parsed.index) : props.route
})

const outlineHeadings = computed<PageHeading[]>(() => props.data.headings)

const searchOpen = ref(false)
const searching = ref(false)
const query = ref('')
const searchInput = ref<HTMLInputElement>()
const index = ref<MiniSearch<SearchResult>>()
const searchDialog = ref<HTMLElement>()
const selectedResult = ref(0)
const searchError = ref('')
const notes = sidebarNotes(site.sidebar)
const results = computed<SearchResult[]>(() => {
  const term = query.value.trim()
  if (!term) return []
  const exact = /^\d{1,4}$/.test(term)
    ? notes.find((item) => item.index && Number(item.index) === Number(term))
    : undefined
  const matches = (index.value?.search(term, { prefix: true, fuzzy: 0.2 }) ??
    []) as unknown as SearchResult[]
  const combined = exact?.link
    ? [{ route: exact.link, title: exact.text, text: '题号精确匹配' }, ...matches]
    : matches
  return combined
    .filter((item, i, all) => all.findIndex((other) => other.route === item.route) === i)
    .slice(0, 20)
})
watch(results, () => {
  selectedResult.value = 0
})
async function moveResult(delta: number) {
  if (!results.value.length) return
  selectedResult.value =
    (selectedResult.value + delta + results.value.length) % results.value.length
  await nextTick()
  const item = document.getElementById(`search-result-${selectedResult.value}`)
  const container = searchDialog.value
  if (!item || !container) return
  const box = item.getBoundingClientRect(),
    view = container.getBoundingClientRect()
  if (box.bottom > view.bottom) container.scrollTop += box.bottom - view.bottom
  else if (box.top < view.top) container.scrollTop += box.top - view.top
}
function openSelected() {
  const result = results.value[selectedResult.value]
  if (result) window.location.assign(navHref(result.route))
}
useModalFocus(
  searchOpen,
  () => searchDialog.value ?? null,
  () => {
    searchOpen.value = false
  }
)
const sidebarWidth = ref(272)
const sidebarHidden = ref(false)
const mobileOpen = ref(false)
const isMobile = ref(false)
const preferenceKey = `tnotes-sidebar-layout:${site.base}`
let media: MediaQueryList | undefined
function updateMedia() {
  isMobile.value = media?.matches ?? false
  if (!isMobile.value) mobileOpen.value = false
}
function toggleSidebar() {
  if (isMobile.value) mobileOpen.value = !mobileOpen.value
  else sidebarHidden.value = !sidebarHidden.value
}

/**
 * One handle now stands in for the header button and the sidebar's own 收起
 * button, so it has to speak for whichever control owns the sidebar: the drawer
 * on phones, the hidden flag on desktop. `aria-expanded`, the label, and the
 * chevron's direction all read from this, which is what keeps them consistent.
 */
const sidebarVisible = computed(() => (isMobile.value ? mobileOpen.value : !sidebarHidden.value))

/**
 * Picking a note has to put the drawer away on phones. The navigation would get
 * there eventually — every link is a real document load — but the drawer would
 * sit over the page until the new document arrived, so close it on the way out.
 */
function closeDrawerOnPick(event: MouseEvent) {
  if (!isMobile.value) return
  if ((event.target as Element | null)?.closest('a')) mobileOpen.value = false
}
useModalFocus(
  mobileOpen,
  () => document.getElementById('site-sidebar'),
  () => {
    mobileOpen.value = false
  }
)
watch([sidebarWidth, sidebarHidden], () => {
  try {
    localStorage.setItem(
      preferenceKey,
      JSON.stringify({ width: sidebarWidth.value, hidden: sidebarHidden.value })
    )
  } catch {
    /* optional preference */
  }
})
onBeforeUnmount(() => media?.removeEventListener('change', updateMedia))

const navHref = (link: string) => {
  if (/^(https?:)?\/\//.test(link)) return link
  return `${site.base}${link.replace(/^\//, '')}`
}

const toggleTheme = () => {
  const root = document.documentElement
  const next = root.classList.contains('dark') ? 'light' : 'dark'
  root.classList.toggle('dark', next === 'dark')
  localStorage.setItem('tnotes-theme', next)
}

async function loadSearch() {
  if (index.value || searching.value) return
  searching.value = true
  searchError.value = ''
  try {
    const response = await fetch(`${site.base}search-index.json`)
    if (!response.ok) throw new Error('index unavailable')
    index.value = MiniSearch.loadJSON<SearchResult>(await response.text(), {
      fields: ['title', 'headings', 'text'],
      storeFields: ['route', 'title', 'text'],
      tokenize: tokenizeSearch,
      processTerm: normalizeSearchTerm,
      searchOptions: { boost: { title: 10, headings: 5, text: 3 } }
    })
  } catch {
    searchError.value = '搜索索引加载失败，请重试。'
  } finally {
    searching.value = false
  }
}
watch(searchOpen, async (open) => {
  if (!open) return
  await nextTick()
  searchInput.value?.focus()
  await loadSearch()
})

// Teleport content is client-only; rendering it during SSR breaks hydration
// (server emits anchors, client expects a v-if comment and the walk drifts).
const mounted = ref(false)

onMounted(() => {
  if (article.value)
    headingControls = setupHeadingFolds(article.value, (value) => {
      headingsFolded.value = value
    })
  mounted.value = true
  media = window.matchMedia('(max-width: 760px)')
  updateMedia()
  media.addEventListener('change', updateMedia)
  try {
    const prefs = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null')
    if (prefs) {
      sidebarWidth.value = clampSidebarWidth(prefs.width)
      sidebarHidden.value = prefs.hidden === true
    }
    const theme = localStorage.getItem('tnotes-theme')
    if (theme) document.documentElement.classList.toggle('dark', theme === 'dark')
  } catch {
    /* storage is optional */
  }
})
</script>
