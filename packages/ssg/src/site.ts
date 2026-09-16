import { existsSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import matter from 'gray-matter'
import MiniSearch from 'minisearch'
import {
  build as viteBuild,
  createServer as createViteServer,
  preview as vitePreview,
  type Manifest,
  type PreviewServer,
  type ViteDevServer
} from 'vite'

import { resolveConfig } from './config'
import { normalizeSearchTerm, tokenizeSearch } from './client/search'
import {
  SIDEBAR_RESTORE_CLASS,
  SIDEBAR_RESTORE_TIMEOUT_MS,
  sidebarStorageKey
} from './client/sidebarState'
import { createMarkdownCompiler, extractMarkdownLinks, extractPageData } from './markdown'
import { resolveNotePath, resolveNoteSlug, stripBase, type NoteRef } from './noteRoute'
import { collectSite, routeToOutput, type SourcePage } from './pages'
import { catalogFromPages, pageModuleId, PageSourceStore, slimPageData } from './pageStore'
import { tnotesPlugin } from './vitePlugin'

import type { PageData, ResolvedSsgConfig } from './types'
import type { Component } from 'vue'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PreviewServerHook } from 'vite'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientRoot = path.join(packageRoot, 'src/client')
const packageRequire = createRequire(import.meta.url)

/** Recycle the SSR Vite server so compiled page modules can be GC'd. */
const SSR_SERVER_PAGES = 250

async function linkRuntimeDependencies(cacheDir: string) {
  const modulesDirectory = path.join(cacheDir, 'node_modules')
  await fs.mkdir(modulesDirectory, { recursive: true })
  for (const dependency of ['vue', '@vue/server-renderer']) {
    const target = path.dirname(packageRequire.resolve(`${dependency}/package.json`))
    const link = path.join(modulesDirectory, dependency)
    await fs.mkdir(path.dirname(link), { recursive: true })
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const values: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return values[character]
  })
}

function jsonScript(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function renderHead(config: ResolvedSsgConfig) {
  return config.head
    .map(([tag, attrs, content = '']) => {
      const serialized = Object.entries(attrs)
        .map(([name, value]) => ` ${name}="${htmlEscape(value)}"`)
        .join('')
      return content ? `<${tag}${serialized}>${content}</${tag}>` : `<${tag}${serialized}>`
    })
    .join('\n')
}

/**
 * The sidebar's collapse set and scroll offset live in sessionStorage, but the
 * client bundle only runs after first paint — applying them on mount would show
 * a fully expanded tree at offset 0 and then jump. Flag the document before
 * paint instead, and let CSS keep the sidebar out of sight until the state has
 * landed. The timeout is the no-JS / failed-bundle fallback: navigation must
 * never stay invisible because a script never arrived.
 *
 * The key comes from `sidebarStorageKey` so this inline script and the client
 * cannot drift apart.
 */
function sidebarRestoreGate(base: string) {
  const key = JSON.stringify(sidebarStorageKey(base))
  const name = SIDEBAR_RESTORE_CLASS
  return `<script>try{if(sessionStorage.getItem(${key})){var e=document.documentElement;e.classList.add('${name}');setTimeout(function(){e.classList.remove('${name}')},${SIDEBAR_RESTORE_TIMEOUT_MS})}}catch(_){}</script>`
}

function pageDocument(config: ResolvedSsgConfig, route: string, page: PageData, appHtml: string) {
  const description = page.description || config.description
  return `<!doctype html>
<html lang="${htmlEscape(config.lang)}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${htmlEscape(description)}" />
    <title>${htmlEscape(page.title)} | ${htmlEscape(config.title)}</title>
    ${renderHead(config)}
    <script>try{const t=localStorage.getItem('tnotes-theme');const d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d)}catch{}</script>
    ${sidebarRestoreGate(config.base)}
  </head>
  <body>
    <div id="app" data-route="${htmlEscape(route)}">${appHtml}</div>
    <script type="application/json" id="tn-page-data">${jsonScript(slimPageData(page))}</script>
    <script type="module" src="/entry.ts"></script>
  </body>
</html>`
}

function joinBase(base: string, file: string): string {
  const prefix = base.endsWith('/') ? base : `${base}/`
  return `${prefix}${file.replace(/^\//, '')}`
}

/**
 * Dev-only: entry.ts imports CSS as JS modules, which Vite injects as
 * <style> tags *after* the module graph loads — a flash of unstyled article
 * on every navigation. Serving the files as <link> tags relies on
 * browser-specific render-blocking and Accept-header negotiation (Safari and
 * embedded webviews still flash), so inline them instead: ~20KB total, no
 * url()/@import inside to rebase, and entry.ts keeps its imports so Vite's
 * JS-injected duplicates continue to provide HMR.
 */
const DEV_STYLE_SPECIFIERS = [
  '@tnotesjs/ui/styles/tokens.css',
  '@tnotesjs/ui/styles/prose.css',
  '@tnotesjs/ui/styles/code.css',
  '@tnotesjs/ui/styles/swiper.css'
]

async function devStyleBlocks(): Promise<string> {
  const files = [
    ...DEV_STYLE_SPECIFIERS.map((specifier) => packageRequire.resolve(specifier)),
    path.join(clientRoot, 'theme.css')
  ]
  const contents = await Promise.all(files.map((file) => fs.readFile(file, 'utf8')))
  return contents.map((css) => `<style>\n${css}\n</style>`).join('\n    ')
}

function injectDevStyles(html: string, tags: string): string {
  const next = html.replace('</head>', `    ${tags}\n  </head>`)
  if (next === html) {
    throw new Error('Failed to inject dev styles into HTML (</head> missing)')
  }
  return next
}

/**
 * Dev replacement for vite.transformIndexHtml: swap the entry placeholder for
 * the HMR client + entry script, both base-prefixed. We cannot use Vite's
 * hook because it rebases *every* root-absolute src/href in the document —
 * our SSR HTML already includes the base, so assets ended up at
 * /base/base/assets/... and 404'd.
 */
function injectDevClient(html: string, base: string): string {
  const tags = [
    `<script type="module" src="${joinBase(base, '@vite/client')}"></script>`,
    `<script type="module" src="${joinBase(base, 'entry.ts')}"></script>`
  ].join('\n    ')
  const next = html.replace(/<script type="module" src="[^"]*entry\.ts"><\/script>/, () => tags)
  if (next === html) {
    throw new Error('Failed to inject dev client (entry.ts script tag missing)')
  }
  return next
}

function clientAssetTags(base: string, manifest: Manifest): { styles: string; script: string } {
  const entry = Object.values(manifest).find((chunk) => chunk.isEntry)
  if (!entry) {
    throw new Error('Vite manifest is missing the client entry')
  }
  const styles = (entry.css ?? [])
    .map((href) => `<link rel="stylesheet" href="${joinBase(base, href)}" />`)
    .join('\n    ')
  return {
    styles,
    script: `<script type="module" src="${joinBase(base, entry.file)}"></script>`
  }
}

/**
 * Stylesheets belong in <head>: injected at the body's end (with the script)
 * they are discovered after the whole SSR page parses, so first paint happens
 * unstyled — a visible flash on every load.
 */
function applyClientAssets(html: string, tags: { styles: string; script: string }): string {
  const next = html.replace('</head>', `    ${tags.styles}\n  </head>`)
  if (next === html) {
    throw new Error('Failed to inject client styles into HTML (</head> missing)')
  }
  const withScript = next.replace(
    /<script type="module" src="[^"]*entry\.ts"><\/script>/,
    tags.script
  )
  if (withScript === next) {
    throw new Error('Failed to inject client assets into HTML (entry.ts script tag missing)')
  }
  return withScript
}

function resolveInternalRoute(raw: string, currentRoute: string) {
  const value = decodeURIComponent(raw.split(/[?#]/)[0]).replace(/\.(md|html)$/i, '')
  if (!value || value.startsWith('#')) return null
  if (/^(?:[a-z]+:)?\/\//i.test(value) || /^(mailto|tel):/i.test(value)) return null
  if (value.startsWith('/')) return value.replace(/\/$/, '') || '/'
  const base = currentRoute === '/' ? '/' : `${path.posix.dirname(currentRoute)}/`
  const resolved = path.posix.resolve(base, value)
  return resolved.replace(/\/$/, '') || '/'
}

function validateDeadLinks(config: ResolvedSsgConfig, pages: SourcePage[], notes: NoteRef[]) {
  if (config.ignoreDeadLinks === true) return
  const routes = new Set(pages.map((page) => page.route))
  const ignores = Array.isArray(config.ignoreDeadLinks) ? config.ignoreDeadLinks : []
  const errors: string[] = []
  for (const page of pages) {
    for (const link of extractMarkdownLinks(page.source)) {
      const localFile = decodeURIComponent(link.split(/[?#]/)[0])
      if (
        !localFile.startsWith('/') &&
        existsSync(path.resolve(path.dirname(page.file), localFile))
      ) {
        continue
      }
      const route = resolveInternalRoute(link, page.route)
      if (!route) continue
      if (routes.has(route)) continue
      const slug = route.split('/').filter(Boolean).pop()
      const canonical = slug ? resolveNoteSlug(slug, notes) : null
      if (canonical && routes.has(canonical)) continue
      if (ignores.some((ignore) => ignore === link)) continue
      errors.push(`${path.relative(config.root, page.file)} -> ${link}`)
    }
  }
  if (errors.length) {
    throw new Error(`Found ${errors.length} dead link(s):\n${errors.join('\n')}`)
  }
}

function notesFromSnapshot(
  snapshot: Awaited<ReturnType<typeof collectSite>>['snapshot']
): NoteRef[] {
  return snapshot.notes.map((note) => ({
    index: note.index,
    id: note.frontmatter.id
  }))
}

async function ensure404Page(config: ResolvedSsgConfig, pages: SourcePage[]) {
  if (pages.some((page) => page.route === '/404')) return
  const file = path.join(config.cacheDir, '404.md')
  const source = '# 页面未找到\n\n[返回首页](/)\n'
  await fs.writeFile(file, source)
  pages.push({ file, route: '/404', source, titleHint: '404', noteIndex: '' })
}

/** Runtime template compilation (page-from-HTML) needs the full Vue build. */
function vueAlias(): { find: string; replacement: string } {
  return {
    find: 'vue',
    replacement: path.join(
      path.dirname(packageRequire.resolve('vue/package.json')),
      'dist/vue.esm-bundler.js'
    )
  }
}

function vuePlugin() {
  return vue({
    include: [/\.vue$/],
    template: {
      transformAssetUrls: false,
      compilerOptions: {
        isCustomElement: (tag) => tag.startsWith('mjx-')
      }
    }
  })
}

async function writeRuntimeEntries(config: ResolvedSsgConfig) {
  await fs.writeFile(
    path.join(config.cacheDir, 'entry.ts'),
    `import ${JSON.stringify(path.join(clientRoot, 'entry.ts'))}`
  )
  await fs.writeFile(
    path.join(config.cacheDir, 'ssr-entry.ts'),
    `export { render } from ${JSON.stringify(path.join(clientRoot, 'ssr.ts'))}`
  )
}

function invalidatePageModule(server: ViteDevServer, route: string) {
  const id = pageModuleId(route)
  const mod = server.moduleGraph.getModuleById(id) ?? server.moduleGraph.getModuleById(`\0${id}`)
  if (mod) server.moduleGraph.invalidateModule(mod)
}

async function loadRenderer(server: ViteDevServer) {
  return (await server.ssrLoadModule('/ssr-entry.ts')) as {
    render: (
      route: string,
      data: PageData,
      options: { page?: Component; html?: string }
    ) => Promise<{ html: string; data: PageData }>
  }
}

async function createSsrVite(config: ResolvedSsgConfig, store: PageSourceStore) {
  return createViteServer({
    root: config.cacheDir,
    base: config.base,
    publicDir: config.publicDir,
    configFile: false,
    appType: 'custom',
    plugins: [tnotesPlugin(config, store), vuePlugin()],
    server: { middlewareMode: true, fs: { allow: [config.root, packageRoot] } },
    resolve: { dedupe: ['vue'], alias: [vueAlias()] },
    ssr: { noExternal: ['@tnotesjs/ui'] },
    logLevel: 'warn'
  })
}

function serializeSearchIndex(
  entries: Array<{ file: string; route: string; data: PageData }>
): string {
  const search = new MiniSearch<PageData>({
    idField: 'route',
    fields: ['title', 'headings', 'text'],
    storeFields: ['route', 'title', 'text'],
    tokenize: tokenizeSearch,
    processTerm: normalizeSearchTerm
  })
  const seenFiles = new Set<string>()
  const documents = entries
    .filter((entry) => entry.route !== '/404')
    .filter((entry) => {
      if (seenFiles.has(entry.file)) return false
      seenFiles.add(entry.file)
      return true
    })
    .map((entry) => ({
      ...entry.data,
      headings: entry.data.headings
        .map((heading) => (typeof heading === 'string' ? heading : heading.text))
        .join(' ')
    }))
  search.addAll(documents as unknown as PageData[])
  return JSON.stringify(search)
}

async function writeSearchIndex(
  config: ResolvedSsgConfig,
  entries: Array<{ file: string; route: string; data: PageData }>
) {
  await fs.writeFile(path.join(config.outDir, 'search-index.json'), serializeSearchIndex(entries))
}

async function copyAssets(config: ResolvedSsgConfig) {
  const source = path.join(config.root, 'assets')
  if (!existsSync(source)) return
  await fs.cp(source, path.join(config.outDir, 'assets'), {
    recursive: true
  })
}

export async function buildSite(root = process.cwd()) {
  const config = await resolveConfig(root)
  await fs.rm(config.cacheDir, { recursive: true, force: true })
  await fs.mkdir(config.cacheDir, { recursive: true })
  await linkRuntimeDependencies(config.cacheDir)
  await writeRuntimeEntries(config)

  const { pages, sidebar, snapshot } = await collectSite(config)
  const notes = notesFromSnapshot(snapshot)
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.severity === 'error') {
      console.warn(`[kb] ${diagnostic.message}`)
    }
  }
  await ensure404Page(config, pages)
  validateDeadLinks(config, pages, notes)

  const compiler = await createMarkdownCompiler(config, notes)
  await compiler.prepare(pages.map((page) => page.source))

  const store = new PageSourceStore()
  store.sidebar = sidebar
  store.notes = notes
  store.catalog = catalogFromPages(config, pages)

  let server = await createSsrVite(config, store)
  let renderer = await loadRenderer(server)
  const searchEntries: Array<{ file: string; route: string; data: PageData }> = []
  try {
    for (let index = 0; index < pages.length; index++) {
      if (index > 0 && index % SSR_SERVER_PAGES === 0) {
        await server.close()
        server = await createSsrVite(config, store)
        renderer = await loadRenderer(server)
      }
      const page = pages[index]!
      const compiled = compiler.compile(page.source, page.file, page.route, page.titleHint)
      let rendered: { html: string; data: PageData }
      try {
        if (compiled.hasUserSfc) {
          store.setCompiled(page.route, compiled.vueSource, compiled.data, compiled.html, true)
          const loaded = (await server.ssrLoadModule(pageModuleId(page.route))) as {
            default: Component
          }
          rendered = await renderer.render(page.route, compiled.data, {
            page: loaded.default
          })
          store.dropVue(page.route)
          invalidatePageModule(server, page.route)
        } else {
          rendered = await renderer.render(page.route, compiled.data, {
            html: compiled.html
          })
        }
      } catch (error) {
        throw new Error(`渲染页面失败 ${page.route}（${page.file}）：${(error as Error).message}`, {
          cause: error
        })
      }
      const relative = routeToOutput(page.route)
      const filename = path.join(config.cacheDir, relative)
      await fs.mkdir(path.dirname(filename), { recursive: true })
      await fs.writeFile(filename, pageDocument(config, page.route, rendered.data, rendered.html))
      searchEntries.push({
        file: page.file,
        route: page.route,
        data: compiled.data
      })
    }
  } finally {
    await server.close()
  }

  // Chrome-only client graph — page SFCs are not imported.
  // Vite 的 `development|production` 条件看的是 NODE_ENV（不是 mode）：不显式设置就会
  // 走 development 条件，在 chunk 里写入绝对源码路径（__file）。
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    await buildClientGraph(config, store, pages)
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
  await copyAssets(config)
  await writeSearchIndex(config, searchEntries)
  await fs.writeFile(path.join(config.outDir, 'notes-map.json'), `${JSON.stringify(notes)}\n`)
  return { config, pageCount: pages.length, notes }
}

async function buildClientGraph(
  config: ResolvedSsgConfig,
  store: PageSourceStore,
  pages: ReadonlyArray<{ route: string }>
): Promise<void> {
  // Chrome-only client graph — page SFCs are not imported.
  await viteBuild({
    root: config.cacheDir,
    base: config.base,
    publicDir: config.publicDir,
    configFile: false,
    // 显式声明生产模式：否则 Vite 会按 NODE_ENV 走到 development 条件，
    // 产物里会写入绝对源码路径（__file）
    mode: 'production',
    plugins: [tnotesPlugin(config, store), vuePlugin()],
    build: {
      outDir: config.outDir,
      emptyOutDir: true,
      assetsDir: '_chunks',
      chunkSizeWarningLimit: 800,
      manifest: true,
      rollupOptions: {
        input: path.join(config.cacheDir, 'entry.ts')
      }
    },
    resolve: { dedupe: ['vue'] },
    logLevel: 'warn'
  })

  const manifest = JSON.parse(
    await fs.readFile(path.join(config.outDir, '.vite', 'manifest.json'), 'utf8')
  ) as Manifest
  const clientTags = clientAssetTags(config.base, manifest)
  for (const page of pages) {
    const relative = routeToOutput(page.route)
    const html = applyClientAssets(
      await fs.readFile(path.join(config.cacheDir, relative), 'utf8'),
      clientTags
    )
    const dest = path.join(config.outDir, relative)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, html)
  }
  // Vite 构建清单的键里带绝对机器路径；页面已注入完资源标签，产物不需要它
  await fs.rm(path.join(config.outDir, '.vite'), { recursive: true, force: true })
}

async function loadNotesMap(config: ResolvedSsgConfig): Promise<NoteRef[]> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(config.outDir, 'notes-map.json'), 'utf8')
    ) as NoteRef[]
  } catch {
    return []
  }
}

export async function previewSite(
  root = process.cwd(),
  options: { port?: number; host?: string | boolean } = {},
  configurePreviewServer?: PreviewServerHook
): Promise<PreviewServer> {
  const config = await resolveConfig(root)
  const notes = await loadNotesMap(config)
  return vitePreview({
    root: config.root,
    base: config.base,
    configFile: false,
    plugins: [
      {
        name: 'tnotes-preview-hooks',
        configurePreviewServer(preview) {
          preview.middlewares.use((request, response, next) => {
            const pathOnly = (request.url ?? '').split('?')[0] ?? ''
            if (pathOnly.endsWith('/__tnotes_reload')) {
              next()
              return
            }
            const canonical = resolveNotePath(pathOnly, notes, config.base)
            if (!canonical || stripBase(pathOnly, config.base) === canonical) {
              next()
              return
            }
            response.statusCode = 302
            response.setHeader(
              'Location',
              `${config.base}${canonical.slice(1)}`.replace(/\/{2,}/g, '/')
            )
            response.end()
          })
          configurePreviewServer?.call(this, preview)
        }
      }
    ],
    preview: {
      port: options.port ?? config.port,
      strictPort: false,
      host: options.host ?? '127.0.0.1',
      open: false
    },
    build: { outDir: config.outDir }
  })
}

interface DevSession {
  pages: SourcePage[]
  byRoute: Map<string, SourcePage>
  byFile: Map<string, SourcePage>
  store: PageSourceStore
  compiler: Awaited<ReturnType<typeof createMarkdownCompiler>>
  /** Lazily serialized MiniSearch index; reset whenever watched files change. */
  searchIndexJson?: string
}

async function createDevSession(config: ResolvedSsgConfig): Promise<DevSession> {
  const { pages, sidebar, snapshot } = await collectSite(config)
  const notes = notesFromSnapshot(snapshot)
  await ensure404Page(config, pages)
  const compiler = await createMarkdownCompiler(config, notes)
  // No upfront compiler.prepare: scanning every note for code languages takes
  // ~90s at leetcode scale. renderDevPage prepares per page on first compile;
  // the highlighter loads languages incrementally, so repeat calls are cheap.
  const store = new PageSourceStore()
  store.sidebar = sidebar
  store.notes = notes
  store.catalog = catalogFromPages(config, pages)
  return {
    pages,
    byRoute: new Map(pages.map((page) => [page.route, page])),
    byFile: new Map(pages.map((page) => [path.resolve(page.file), page])),
    store,
    compiler
  }
}

async function refreshDevSession(config: ResolvedSsgConfig, session: DevSession) {
  const next = await createDevSession(config)
  session.pages = next.pages
  session.byRoute = next.byRoute
  session.byFile = next.byFile
  session.compiler = next.compiler
  session.store.sidebar = next.store.sidebar
  session.store.notes = next.store.notes
  session.store.catalog = next.store.catalog
  session.store.dropAllVue()
}

/**
 * Incremental path for content-only edits to a single known page: re-read
 * that file, refresh its catalog entry, and drop its compiled cache so the
 * next request recompiles just it. Full session rebuilds re-read and
 * re-parse every note (seconds at leetcode scale, blocking the host process).
 */
async function applyPageEdit(session: DevSession, file: string): Promise<void> {
  const page = session.byFile.get(path.resolve(file))
  if (!page) return
  const source = await fs.readFile(file, 'utf8')
  if (source === page.source) return
  page.source = source
  session.store.dropVue(page.route)
  const entry = session.store.catalog[page.route]
  if (entry) {
    const parsed = matter(source)
    entry.description = String(parsed.data.description ?? '')
    entry.frontmatter = parsed.data
  }
}

function isViteHandledPath(pathname: string): boolean {
  return (
    pathname.includes('/@') ||
    pathname.includes('node_modules') ||
    /\.(?:tsx?|mts|cts|js|mjs|cjs|css|scss|sass|less|vue|json|map|wasm|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i.test(
      pathname
    )
  )
}

const ASSET_TYPES: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.html': 'text/html; charset=utf-8'
}

function sendKbFile(response: ServerResponse, file: string, root: string, next: () => void) {
  const resolved = path.resolve(file)
  const rootResolved = path.resolve(root)
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    next()
    return
  }
  if (!existsSync(resolved)) {
    next()
    return
  }
  const type = ASSET_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream'
  response.setHeader('Content-Type', type)
  createReadStream(resolved).pipe(response)
}

async function renderDevPage(
  server: ViteDevServer,
  config: ResolvedSsgConfig,
  session: DevSession,
  route: string
) {
  const source = session.byRoute.get(route) ?? session.byRoute.get('/404') ?? session.pages[0]
  if (!source) throw new Error(`No page registered for route: ${route}`)
  let data = session.store.getCompiledData(source.route)
  let html = session.store.getHtml(source.route)
  if (!data || html === undefined) {
    // Lazy per-page prepare: loads only this page's code languages.
    await session.compiler.prepare([source.source])
    const compiled = session.compiler.compile(
      source.source,
      source.file,
      source.route,
      source.titleHint
    )
    session.store.setCompiled(
      source.route,
      compiled.vueSource,
      compiled.data,
      compiled.html,
      compiled.hasUserSfc
    )
    data = compiled.data
    html = compiled.html
  }
  const renderer = await loadRenderer(server)
  if (session.store.hasUserSfc(source.route)) {
    const loaded = (await server.ssrLoadModule(pageModuleId(source.route))) as {
      default: Component
    }
    const rendered = await renderer.render(source.route, data, {
      page: loaded.default
    })
    return pageDocument(config, source.route, rendered.data, rendered.html)
  }
  const rendered = await renderer.render(source.route, data, { html })
  return pageDocument(config, source.route, rendered.data, rendered.html)
}

/**
 * On-demand Vite SSR. Desk preview used to call full `buildSite` on every
 * change (minutes at leetcode scale). Markdown is compiled per request.
 */
export async function createDevServer(
  root = process.cwd(),
  options: { port?: number } = {}
): Promise<ViteDevServer> {
  const config = await resolveConfig(root)
  await fs.rm(config.cacheDir, { recursive: true, force: true })
  await fs.mkdir(config.cacheDir, { recursive: true })
  await linkRuntimeDependencies(config.cacheDir)
  await writeRuntimeEntries(config)
  const session = await createDevSession(config)
  const styleTags = await devStyleBlocks()

  const server = await createViteServer({
    root: config.cacheDir,
    base: config.base,
    publicDir: config.publicDir,
    configFile: false,
    appType: 'custom',
    plugins: [
      tnotesPlugin(config, session.store),
      vuePlugin(),
      {
        name: 'tnotes-dev-html',
        configureServer(vite) {
          return () => {
            vite.middlewares.use(
              (
                request: IncomingMessage,
                response: ServerResponse,
                next: (error?: unknown) => void
              ) => {
                void (async () => {
                  try {
                    const pathOnly = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/')
                    const relative = stripBase(pathOnly, config.base)
                    // Must run before isViteHandledPath: ".json" is claimed
                    // by Vite's module pipeline, which knows nothing about
                    // the search index and would 404 it.
                    if (relative === '/search-index.json') {
                      // Built lazily from cheap PageData extraction (no
                      // markdown render / Shiki), cached until the watcher
                      // reports a change.
                      session.searchIndexJson ??= serializeSearchIndex(
                        session.pages.map((page) => ({
                          file: page.file,
                          route: page.route,
                          data: extractPageData(
                            config,
                            page.source,
                            page.file,
                            page.route,
                            page.titleHint
                          )
                        }))
                      )
                      response.statusCode = 200
                      response.setHeader('Content-Type', 'application/json;charset=utf-8')
                      response.end(session.searchIndexJson)
                      return
                    }
                    if (relative.startsWith('/assets/')) {
                      // KB files are served by us, not Vite — this must run
                      // before isViteHandledPath, which claims .svg/.png/...
                      // for Vite's pipeline (where they can only 404).
                      sendKbFile(response, path.join(config.root, relative), config.root, next)
                      return
                    }
                    if (isViteHandledPath(pathOnly)) {
                      next()
                      return
                    }
                    const leaf = relative.split('/').pop() ?? ''
                    if (leaf.includes('.') && !leaf.endsWith('.html')) {
                      next()
                      return
                    }
                    const current = relative.replace(/\.html$/i, '') || '/'
                    const canonical = resolveNotePath(pathOnly, session.store.notes, config.base)
                    if (canonical && current !== canonical) {
                      response.statusCode = 302
                      response.setHeader(
                        'Location',
                        `${config.base}${canonical.slice(1)}`.replace(/\/{2,}/g, '/')
                      )
                      response.end()
                      return
                    }
                    const route = session.byRoute.has(current)
                      ? current
                      : session.byRoute.has('/404')
                        ? '/404'
                        : '/'
                    const html = await renderDevPage(vite, config, session, route)
                    // No vite.transformIndexHtml: our SSR HTML already carries
                    // the base in every URL, and Vite's dev hook prepends base
                    // to all root-absolute src/href again (img assets 404'd as
                    // /base/base/assets/...). Inject the dev client ourselves.
                    const transformed = injectDevClient(
                      injectDevStyles(html, styleTags),
                      config.base
                    )
                    response.statusCode = route === '/404' && current !== '/404' ? 404 : 200
                    response.setHeader('Content-Type', 'text/html;charset=utf-8')
                    response.end(transformed)
                  } catch (error) {
                    next(error)
                  }
                })()
              }
            )
          }
        }
      }
    ],
    server: {
      port: options.port ?? config.port,
      strictPort: false,
      host: '127.0.0.1'
      // No explicit fs.allow: Vite's default walks up to the workspace root,
      // which covers every install layout — published packages under the KB's
      // .pnpm store, and linked checkouts (ui/, ssg/, workspace .pnpm) when
      // developing ssg against a real KB.
    },
    resolve: { dedupe: ['vue'], alias: [vueAlias()] },
    ssr: { noExternal: ['@tnotesjs/ui'] },
    logLevel: 'warn'
  })

  let timer: NodeJS.Timeout | undefined
  let refreshing = false
  const pending = new Set<string>()
  const invalidateVirtualModules = () => {
    for (const id of ['\0virtual:tnotes-site', '\0virtual:tnotes-pages']) {
      const mod = server.moduleGraph.getModuleById(id)
      if (mod) server.moduleGraph.invalidateModule(mod)
    }
  }
  const flush = () => {
    void (async () => {
      if (refreshing) {
        // Keep the queued files and retry shortly — dropping them would lose
        // edits made while a structural refresh is running.
        timer = setTimeout(flush, 200)
        return
      }
      refreshing = true
      try {
        const files = [...pending]
        pending.clear()
        session.searchIndexJson = undefined
        const edited: string[] = []
        let structural = false
        for (const file of files) {
          const normalized = file.replaceAll('\\', '/')
          if (/(?:^|\/)(?:TOC\.md|tnotes\.json)$/.test(normalized) || normalized.endsWith('.vue')) {
            structural = true
            break
          }
          const page = session.byFile.get(path.resolve(file))
          if (page && existsSync(file)) {
            edited.push(file)
          } else if (page || (normalized.includes('/notes/') && normalized.endsWith('.md'))) {
            // Deleted or newly added note — the catalog/sidebar must rebuild.
            structural = true
            break
          }
          // Anything else (assets, …) needs no session work; reload below.
        }
        if (structural) {
          await refreshDevSession(config, session)
          invalidateVirtualModules()
        } else if (edited.length) {
          for (const file of edited) await applyPageEdit(session, file)
          invalidateVirtualModules()
        }
        server.ws.send({ type: 'full-reload' })
      } catch (error) {
        console.error(error)
      } finally {
        refreshing = false
      }
    })()
  }
  const onKbChange = (file: string) => {
    if (/(?:node_modules|\.git|(?:^|[/\\])\.tnotes(?:[/\\]|$))/.test(file)) return
    // Atomic-write staging files (`.name.<uuid>.tmp`) — the rename onto the
    // real path emits its own event.
    if (/(?:^|[/\\])\.[^/\\]*\.tmp$/.test(file)) return
    clearTimeout(timer)
    pending.add(file)
    timer = setTimeout(flush, 120)
  }
  server.watcher.add(config.root)
  server.watcher.on('all', (_event, file) => onKbChange(file))

  await server.listen()
  return server
}
