<template>
  <section class="tn-discussions" aria-label="笔记评论">
    <h2 class="tn-discussions-title">
      <a
        class="tn-discussions-link"
        :href="discussionsUrl"
        target="_blank"
        rel="noopener noreferrer"
        title="在 GitHub Discussions 中查看或发表评论（支持上传图片）"
      >
        <SiteIcon name="github" />
        Discussions
      </a>
    </h2>
    <div ref="host" class="tn-discussions-mount">
      <p v-if="!ready" class="tn-discussions-hint" role="status">正在载入评论…</p>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * giscus comments, keyed by the note's own id.
 *
 * That id is the whole interface: giscus maps one discussion per term, and every
 * TNotes knowledge base shares one discussion repo, so nothing is configured per
 * note or per kb. Core behaved the same way from its layout — which is why this
 * renders automatically after the article instead of being opt-in per note.
 *
 * The script is injected on mount, never server-rendered: giscus talks to
 * github.com from the reader's browser, and an iframe host in the first paint
 * would put a third-party request in front of the article.
 *
 * No `<!-- -->` comments in the template: Vue SSR emits them verbatim into every
 * generated page.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import SiteIcon from './SiteIcon.vue'

const props = defineProps<{ id: string }>()

/** The shared discussion repo and the ids its giscus setup hands out. */
const GISCUS = {
  repo: 'tnotesjs/TNotes.discussions',
  repoId: 'R_kgDOQauuyw',
  category: 'Announcements',
  categoryId: 'DIC_kwDOQauuy84CyEuQ',
  /** Custom themes hosted by giscus, matching the site's light/dark pair. */
  theme: { light: 'noborder_light', dark: 'noborder_dark' }
} as const

const host = ref<HTMLElement>()
const ready = ref(false)
let themeWatcher: MutationObserver | undefined

/** Same search core offered: every discussion carrying this note's id. */
const discussionsUrl = computed(
  () => `https://github.com/orgs/tnotesjs/discussions?discussions_q=${encodeURIComponent(props.id)}`
)

const currentTheme = () =>
  document.documentElement.classList.contains('dark') ? GISCUS.theme.dark : GISCUS.theme.light

/**
 * Retheming the live iframe beats reloading it: a reload would throw away
 * whatever the reader had typed. The site's toggle only flips a class on
 * `<html>`, so the iframe is told directly.
 */
function postTheme(theme: string) {
  host.value
    ?.querySelector<HTMLIFrameElement>('iframe.giscus-frame')
    ?.contentWindow?.postMessage({ giscus: { setConfig: { theme } } }, 'https://giscus.app')
}

onMounted(() => {
  const container = host.value
  if (!container) return

  const attributes: Record<string, string> = {
    'data-repo': GISCUS.repo,
    'data-repo-id': GISCUS.repoId,
    'data-category': GISCUS.category,
    'data-category-id': GISCUS.categoryId,
    // One discussion per note, found by the note's own id.
    'data-mapping': 'specific',
    'data-term': props.id,
    'data-strict': '0',
    'data-reactions-enabled': '1',
    'data-emit-metadata': '0',
    'data-input-position': 'top',
    'data-lang': 'zh-CN',
    'data-loading': 'eager',
    'data-theme': currentTheme()
  }

  const script = document.createElement('script')
  script.src = 'https://giscus.app/client.js'
  script.async = true
  script.crossOrigin = 'anonymous'
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value)

  ready.value = true
  container.appendChild(script)

  themeWatcher = new MutationObserver(() => postTheme(currentTheme()))
  themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
})

onBeforeUnmount(() => themeWatcher?.disconnect())
</script>
