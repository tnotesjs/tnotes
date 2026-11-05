declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}

declare module 'markdown-it-container'
declare module 'markdown-it-emoji'
declare module 'markdown-it-task-lists'

declare module 'virtual:tnotes-pages' {
  import type { PageData } from './types'
  /** Empty on purpose — page SFCs are SSR-only. */
  export const pages: Record<string, never>
  export const pageData: Record<string, PageData>
}

declare module 'virtual:tnotes-site' {
  const site: import('./types').SiteData
  export default site
}

declare module 'virtual:tnotes-theme' {
  import type { App } from 'vue'
  import type { PageData, SiteData } from './types'
  const theme: {
    enhanceApp?: (context: { app: App; site: SiteData; pages: Record<string, PageData> }) => void
  }
  export default theme
}
