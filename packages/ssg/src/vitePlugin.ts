import type { Plugin } from 'vite'

import { PAGE_ID_PREFIX, parsePageModuleId, type PageSourceStore } from './pageStore'
import type { ResolvedSsgConfig } from './types'

const PAGES_ID = '\0virtual:tnotes-pages'
const SITE_ID = '\0virtual:tnotes-site'
const THEME_ID = '\0virtual:tnotes-theme'

const serializeSite = (site: ResolvedSsgConfig, store: PageSourceStore) => ({
  base: site.base,
  title: site.title,
  description: site.description,
  lang: site.lang,
  repositoryUrl: site.repositoryUrl,
  discussions: site.discussions,
  sidebar: store.sidebar,
  notes: store.notes,
  markdown: {
    lineNumbers: site.markdown.lineNumbers,
    math: site.markdown.math,
    imageLazyLoading: site.markdown.imageLazyLoading
  }
})

/**
 * Virtual modules for the SSG.
 *
 * Client builds must not import page SFCs. Each note template is the full
 * article HTML; putting `() => import(page)` in one module made Vite compile
 * the entire library in a single graph (O(n) huge SFCs, OOM at ~10k notes).
 * SSR loads `virtual:tnotes-page:…vue` one route at a time instead.
 */
export function tnotesPlugin(config: ResolvedSsgConfig, store: PageSourceStore): Plugin {
  return {
    name: 'tnotes-ssg',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'virtual:tnotes-pages') return PAGES_ID
      if (id === 'virtual:tnotes-site') return SITE_ID
      if (id === 'virtual:tnotes-theme') return THEME_ID
      if (id.startsWith(PAGE_ID_PREFIX)) return id
    },
    load(id) {
      if (id === SITE_ID) {
        return `export default ${JSON.stringify(serializeSite(config, store))}`
      }
      if (id === THEME_ID) {
        return config.theme
          ? `export { default } from ${JSON.stringify(config.theme)}`
          : 'export default {}'
      }
      if (id === PAGES_ID) {
        // Catalog only — never an import map of page SFCs.
        return `export const pages = {}; export const pageData = ${JSON.stringify(store.catalog)};`
      }
      if (id.startsWith(PAGE_ID_PREFIX)) {
        const route = parsePageModuleId(id)
        if (!route) return undefined
        return store.getVue(route)
      }
    }
  }
}
