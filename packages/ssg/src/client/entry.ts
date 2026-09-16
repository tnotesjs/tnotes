import '@tnotesjs/ui/styles/tokens.css'
import '@tnotesjs/ui/styles/prose.css'
import '@tnotesjs/ui/styles/code.css'
import '@tnotesjs/ui/styles/swiper.css'
import './theme.css'

import site from 'virtual:tnotes-site'

import { resolveNotePath, stripBase } from './noteRoute'
import { createSiteApp } from './runtime'
import { hydrateIslands } from './hydrateIslands'
import type { PageData } from '../types'

function readPageData(route: string): PageData {
  const script = document.querySelector('#tn-page-data')
  if (script?.textContent) {
    try {
      return JSON.parse(script.textContent) as PageData
    } catch {
      /* fall through */
    }
  }
  return {
    route,
    relativePath: '',
    title: '',
    description: '',
    headings: [],
    text: '',
    frontmatter: {}
  }
}

const canonical = resolveNotePath(location.pathname, site.notes, site.base)
if (canonical && stripBase(location.pathname, site.base) !== canonical) {
  location.replace(`${site.base}${canonical.slice(1)}${location.search}${location.hash}`)
} else {
  const root = document.querySelector<HTMLElement>('#app')
  if (root) {
    const route = root.dataset.route || '/'
    /*
     * The article is adopted from the server-rendered DOM rather than rendered
     * again — but only the part that *is* the article. `main` also holds the
     * comments block, so taking its whole `innerHTML` would re-inject that
     * inside the article div as a second copy.
     */
    const articleHtml = root.querySelector('.tn-site-article')?.innerHTML ?? ''
    const data = readPageData(route)
    void createSiteApp(route, { data, articleHtml }).then(async ({ app }) => {
      app.mount(root)
      const main = root.querySelector('.tn-site-main')
      if (main) await hydrateIslands(main, { base: site.base })
    })
  }
}
