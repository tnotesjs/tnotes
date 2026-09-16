/**
 * Icons for the site chrome.
 *
 * Geometry is inlined here rather than imported from `.svg` files: the SSG
 * ships no SVG assets and every other icon in the client (the tree chevron, the
 * "current note" crosshair) is an inline `<svg>` too. Inlining keeps each icon
 * paintable with `currentColor`, so light and dark themes need no second asset,
 * and it keeps the icons out of the SSR asset-url path entirely.
 *
 * Provenance of each shape (all copied from local sources, no downloads):
 * - `sidebarCollapse` core  vitepress/assets/icons/icon__prev.svg
 *                     A left chevron. The sidebar toggle turns this one shape
 *                     with CSS rather than swapping assets, which is why desk's
 *                     right-pointing `icon__sidebar_collapsed / _opened` pair is
 *                     not carried over — its geometry is this shape rotated 180°,
 *                     and rotating one icon keeps the state out of the JS layer,
 *                     where it would be wrong for the whole pre-hydration paint.
 * - `foldAll`         core  vitepress/assets/icons/icon__fold.svg
 *                     Same path desk draws inline for its "折叠/展开全部" toggle
 *                     in NavigatorSidebar.vue.
 * - `outline`         desk  src/renderer/src/components/OutlineIcon.vue
 *                     Desk's 正文目录 toggle. Phones open the drawer with it, so
 *                     the two apps read the same way.
 * - `focus`           core  vitepress/assets/icons/icon__focus.svg
 *                     Core's sidebar had a 聚焦到当前笔记 button; the site's locate
 *                     control is the same feature, so it keeps the same glyph.
 *                     (The file's invisible full-circle path is dropped — it has
 *                     neither stroke nor fill.)
 * - `github`          core  vitepress/assets/icons/icon__github.svg
 *                     The comments block links out to the repo's discussions.
 */
export interface SiteIcon {
  readonly viewBox: string
  /** Outlined shapes are stroked, solid shapes take `fill`. */
  readonly mode: 'stroke' | 'fill'
  readonly paths: readonly string[]
}

export const SITE_ICONS = {
  // Core/UI copy glyph; rounded rectangle expressed as path geometry.
  copy: {
    viewBox: '0 0 24 24',
    mode: 'stroke',
    paths: [
      'M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z',
      'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'
    ]
  },
  sidebarCollapse: {
    viewBox: '0 0 24 24',
    mode: 'stroke',
    paths: ['m15 6l-6 6l6 6']
  },
  foldAll: {
    viewBox: '0 0 24 24',
    mode: 'fill',
    paths: ['M2 4h20v2H2zm0 5.57L5.887 12L2 14.43zM7 11h15v2H7zm-5 7h20v2H2z']
  },
  focus: {
    viewBox: '0 0 24 24',
    mode: 'stroke',
    paths: [
      'M19 12a7 7 0 0 1-7 7m7-7a7 7 0 0 0-7-7m7 7h3m-10 7a7 7 0 0 1-7-7m7 7v3M5 12a7 7 0 0 1 7-7m-7 7H2m10-7V2m1 10a1 1 0 1 1-2 0a1 1 0 0 1 2 0Z'
    ]
  },
  github: {
    viewBox: '0 0 24 24',
    mode: 'fill',
    paths: [
      'M12 .297c-6.63 0-12 5.373-12 12c0 5.303 3.438 9.8 8.205 11.385c.6.113.82-.258.82-.577c0-.285-.01-1.04-.015-2.04c-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729c1.205.084 1.838 1.236 1.838 1.236c1.07 1.835 2.809 1.305 3.495.998c.108-.776.417-1.305.76-1.605c-2.665-.3-5.466-1.332-5.466-5.93c0-1.31.465-2.38 1.235-3.22c-.135-.303-.54-1.523.105-3.176c0 0 1.005-.322 3.3 1.23c.96-.267 1.98-.399 3-.405c1.02.006 2.04.138 3 .405c2.28-1.552 3.285-1.23 3.285-1.23c.645 1.653.24 2.873.12 3.176c.765.84 1.23 1.91 1.23 3.22c0 4.61-2.805 5.625-5.475 5.92c.42.36.81 1.096.81 2.22c0 1.606-.015 2.896-.015 3.286c0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'
    ]
  },
  outline: {
    viewBox: '0 0 24 24',
    mode: 'fill',
    paths: [
      'M4.5 15.885q-.213 0-.356-.144Q4 15.597 4 15.384t.144-.356t.356-.144h11.346q.213 0 .357.145t.143.356t-.143.356t-.357.144zm0-3.385q-.213 0-.356-.144T4 11.999t.144-.356t.356-.143h11.346q.213 0 .357.144t.143.357t-.143.356t-.357.143zm0-3.384q-.213 0-.356-.144T4 8.615t.144-.356t.356-.144h11.346q.213 0 .357.144q.143.144.143.357t-.143.356t-.357.144zM19.385 16q-.262 0-.439-.171t-.177-.425q0-.27.177-.452q.177-.183.439-.183q.261 0 .438.183q.177.182.177.452q0 .253-.177.425t-.438.171m0-3.366q-.262 0-.439-.172T18.77 12q0-.253.177-.425t.439-.171t.438.171T20 12q0 .29-.177.463q-.177.172-.438.172m0-3.404q-.262 0-.439-.172t-.177-.424q0-.27.177-.452q.177-.183.438-.183q.262 0 .439.183q.177.182.177.452q0 .253-.177.424q-.177.172-.438.172'
    ]
  }
} as const satisfies Record<string, SiteIcon>

export type SiteIconName = keyof typeof SITE_ICONS
