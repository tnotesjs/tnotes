import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MiniSearch from 'minisearch'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildSite, createDevServer, previewSite } from '../src/site'
import { normalizeSearchTerm, tokenizeSearch } from '../src/client/search'

let root = ''

function write(relativePath: string, content: string) {
  const filename = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, content)
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tnotes-ssg-site-'))
  write(
    'tnotes.json',
    JSON.stringify(
      {
        base: '/fixture/',
        title: 'Fixture',
        description: 'SSG fixture'
      },
      null,
      2
    )
  )
  write(
    'TOC.md',
    `- 分组 A
  - [x] 0001. 首页笔记
  - [ ] 0002. 指南
`
  )
  write(
    'LocalMessage.vue',
    `<script setup lang="ts">defineProps<{ text: string }>()</script>
<template><strong class="local-message">{{ text }}</strong></template>`
  )
  write(
    'notes/0001. 首页笔记.md',
    `---
id: 00000000-0000-4000-8000-000000000001
description: 首页描述
---
<script setup>
import LocalMessage from '../LocalMessage.vue'
const message = 'Vue SFC works'
</script>

# 首页笔记

<LocalMessage :text="message" />

[阅读指南](./0002.%20指南.md)

![图片](../assets/pic.txt) {w=50%}

![](../assets/pic.txt)
`
  )
  write(
    'notes/0002. 指南.md',
    `---
id: 00000000-0000-4000-8000-000000000002
---
# 指南

[回首页](/)

::: tip 提示
容器管线正常。搜索中文。
:::

$x^2$

\`\`\`js
console.log(1)
\`\`\`

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

\`\`\`mindmap
- 根
  - 子
\`\`\`

\`\`\`js [long.js]
` +
      Array.from({ length: 30 }, (_, index) => `console.log(${index})`).join('\n') +
      `
\`\`\`

\`\`\`text [one-line.txt]
` +
      'x'.repeat(400) +
      `
\`\`\`

::: footprints 2026-09-06 12:00
一段足迹正文。
:::
` +
      '\n行内 `{{ count }}`。正文 {{ n }}。\n'
  )
  write('assets/pic.txt', 'asset file')
  write('public/fixture.txt', 'public asset')

  await buildSite(root)
}, 120_000)

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

const dist = (...segments: string[]) => path.join(root, '.tnotes/dist', ...segments)

describe('static site build', () => {
  it('renders the first TOC note as home and every note at its route', () => {
    const home = fs.readFileSync(dist('index.html'), 'utf8')
    expect(home).toContain('Vue SFC works')
    expect(home).toContain('首页笔记')
    // Canonical note route is /notes/{n}.
    const noteHtml = fs.readFileSync(dist('notes/1.html'), 'utf8')
    expect(noteHtml).toContain('Vue SFC works')
    // Cross-note links rewrite to the canonical /notes/{n} form.
    expect(home).toContain('href="/fixture/notes/2"')
    // Asset references are rewritten to base-absolute (assets/ copied verbatim).
    expect(home).toContain('src="/fixture/assets/pic.txt"')
    expect(home).toContain('<figure class="tn-image">')
    expect(home).toContain('<figcaption>图片</figcaption>')
    expect(home).toContain('width:50%')
    expect(fs.existsSync(dist('404.html'))).toBe(true)
  })

  it('每个代码块 SSR 都带折叠 Icon，且默认展开', () => {
    const guide = fs.readFileSync(dist('notes/2.html'), 'utf8')
    expect(guide).toContain('tn-code-block__collapse-btn')
    expect(guide).toContain('aria-label="收起代码"')
    expect(guide).toContain('aria-expanded="true"')
    // 折叠是页面内的视图状态：SSR 出来的块都不是收起态
    expect(guide).not.toContain('tn-code-block is-collapsed')
  })

  it('renders the TOC sidebar with status dots and note indices', () => {
    const home = fs.readFileSync(dist('index.html'), 'utf8')
    expect(home).toContain('分组 A')
    // Status is a coloured dot, not an emoji; the title stays the headline.
    expect(home).toContain('tn-site-sidebar-status')
    expect(home).toContain('data-done="true"')
    expect(home).toContain('data-done="false"')
    expect(home).toContain('>0001<')
    expect(home).toContain('>首页笔记<')
    expect(home).toContain('>指南<')
    expect(home).not.toContain('✅')
    expect(home).not.toContain('⏰')
  })

  it('SSR 出来的目录默认全部展开，且每行都是可折叠的结构', () => {
    const home = fs.readFileSync(dist('index.html'), 'utf8')
    // Collapse is a client-side session concern: the server cannot know it, and
    // rendering anything collapsed would flash before the stored state lands.
    expect(home).not.toContain('tn-site-sidebar-item is-collapsed')
    expect(home).toContain('tn-site-sidebar-item')
    expect(home).toContain('aria-expanded="true"')
    expect(home).toContain('data-tn-key="0"')
    // Chevron and title are separate hit areas: disclosure vs navigation.
    expect(home).toContain('tn-site-sidebar-toggle')
    expect(home).toContain('tn-site-sidebar-link')
  })

  it('目录高亮跟随规范笔记路由，首页也能点亮当前项', () => {
    const home = fs.readFileSync(dist('index.html'), 'utf8')
    // `/` reuses note 0001's body; highlighting by raw route left the sidebar
    // with nothing marked on the site's default entry point.
    expect(home).toContain('aria-current="page"')
    const note = fs.readFileSync(dist('notes/2.html'), 'utf8')
    expect(note).toContain('aria-current="page"')
  })

  it('首屏状态闸门脚本只在存在会话状态时生效', () => {
    const home = fs.readFileSync(dist('index.html'), 'utf8')
    // Key carries the site base: storage is per-origin and every TNotes KB
    // shares one origin.
    expect(home).toContain('tnotes-sidebar:1:/fixture/')
    expect(home).toContain('tn-sb-restore')
    // Fallback so a bundle that never arrives cannot hide navigation forever.
    expect(home).toMatch(
      /setTimeout\(function\(\)\{e\.classList\.remove\('tn-sb-restore'\)\},\d+\)/
    )
  })

  it('renders the TNotes block set', () => {
    const guide = fs.readFileSync(dist('notes/2.html'), 'utf8')
    expect(guide).toContain('tn-custom-block tip')
    expect(guide).toContain('tn-mermaid')
    expect(guide).toMatch(/tn-mindmap|mindmap/i)
    expect(guide).toContain('一段足迹正文。')
    expect(guide).toContain('mjx') // mathjax
  })

  it('renders markdown mustaches as visible text', () => {
    const guide = fs.readFileSync(dist('notes/2.html'), 'utf8')
    expect(guide).toMatch(/\{\{\s*count\s*\}\}|&#123;&#123;\s*count\s*&#125;&#125;/)
    expect(guide).toMatch(/\{\{\s*n\s*\}\}|&#123;&#123;\s*n\s*&#125;&#125;/)
  })

  it('产物不含机器路径（Vite manifest 的键、SFC 的 __file 元数据）', () => {
    // 画布已不再由站点客户端渲染（笔记里就是一张派生 SVG）：字体不再随产物分发
    const leaked: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const next = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(next)
        else {
          const content = fs.readFileSync(next)
          if (content.includes('/Users/') || content.includes('/home/')) leaked.push(next)
        }
      }
    }
    walk(dist())
    expect(leaked).toEqual([])
  })

  it('copies library assets and public files into dist', () => {
    expect(fs.readFileSync(dist('assets/pic.txt'), 'utf8')).toBe('asset file')
    expect(fs.readFileSync(dist('fixture.txt'), 'utf8')).toBe('public asset')
  })

  it('keeps mermaid and mindmap sources on island hosts for client hydrate', () => {
    const guide = fs.readFileSync(dist('notes/2.html'), 'utf8')
    expect(guide).toContain('data-tn-island="mermaid"')
    expect(guide).toContain('data-tn-island="mindmap"')
    expect(guide).toContain('data-tn-code=')
  })

  it('does not compile note bodies into the shared client bundle', () => {
    const chunkDir = dist('_chunks')
    const js = fs
      .readdirSync(chunkDir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => fs.readFileSync(path.join(chunkDir, name), 'utf8'))
      .join('\n')
    expect(js).not.toContain('Vue SFC works')
    expect(js).not.toContain('容器管线正常')
    expect(js).not.toContain('一段足迹正文')
  })

  it('injects a single hashed client bundle into every HTML page', () => {
    const home = fs.readFileSync(dist('index.html'), 'utf8')
    const guide = fs.readFileSync(dist('notes/2.html'), 'utf8')
    expect(home).not.toContain('entry.ts')
    expect(home).toMatch(/<script type="module" src="\/fixture\/_chunks\/[^"]+\.js"><\/script>/)
    expect(home).toMatch(/<link rel="stylesheet" href="\/fixture\/_chunks\/[^"]+\.css" \/>/)
    // Stylesheets must land in <head> — at the body's end they are discovered
    // after the SSR page parses and first paint flashes unstyled content.
    const head = home.slice(0, home.indexOf('</head>'))
    expect(head).toContain('rel="stylesheet"')
    expect(home.indexOf('rel="stylesheet"')).toBeLessThan(home.indexOf('<body>'))
    const homeScript = home.match(/<script type="module" src="([^"]+)"><\/script>/)?.[1]
    const guideScript = guide.match(/<script type="module" src="([^"]+)"><\/script>/)?.[1]
    expect(homeScript).toBe(guideScript)
  })

  it('emits a serialized local-search index', () => {
    const serialized = fs.readFileSync(dist('search-index.json'), 'utf8')
    const index = JSON.parse(serialized) as { documentCount: number }
    // Home + its note route are deduplicated.
    expect(index.documentCount).toBe(2)
    const search = MiniSearch.loadJSON(serialized, {
      fields: ['title', 'headings', 'text'],
      storeFields: ['route', 'title', 'text'],
      tokenize: tokenizeSearch,
      processTerm: normalizeSearchTerm
    })
    expect(search.search('首页笔记')[0]?.route).toBe('/')
    expect(search.search('中文')[0]?.route).toBe('/notes/2')
    expect(search.search('草稿')).toHaveLength(0)
  })

  it('serves the generated site under its configured base', async () => {
    const server = await previewSite(root, { port: 0, host: '127.0.0.1' })
    try {
      const address = server.httpServer.address()
      if (!address || typeof address === 'string') throw new Error('Missing preview port')
      const response = await fetch(`http://127.0.0.1:${address.port}/fixture/`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('首页笔记')
      const guide = await fetch(`http://127.0.0.1:${address.port}/fixture/notes/2`)
      expect(guide.status).toBe(200)
      expect(await guide.text()).toContain('提示')
      const alias = await fetch(`http://127.0.0.1:${address.port}/fixture/notes/0001.%20首页笔记`, {
        redirect: 'manual'
      })
      expect(alias.status).toBe(302)
      expect(alias.headers.get('location')).toBe('/fixture/notes/1')
      const byId = await fetch(
        `http://127.0.0.1:${address.port}/fixture/notes/00000000-0000-4000-8000-000000000001`,
        { redirect: 'manual' }
      )
      expect(byId.status).toBe(302)
      expect(byId.headers.get('location')).toBe('/fixture/notes/1')
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('serves pages on demand without rebuilding the whole site', { timeout: 60_000 }, async () => {
    const server = await createDevServer(root, { port: 0 })
    try {
      const address = server.httpServer?.address()
      if (!address || typeof address === 'string') throw new Error('Missing dev port')
      const response = await fetch(`http://127.0.0.1:${address.port}/fixture/`)
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain('Vue SFC works')
      expect(html).toContain('id="tn-page-data"')
      // Dev styles are inlined into <head> so first paint is styled without
      // waiting on the JS module graph (link tags still flash in Safari and
      // embedded webviews).
      const head = html.slice(0, html.indexOf('</head>'))
      expect(head).toContain('<style>')
      expect(head).toContain('--tn-c-')
      // Asset URLs already carry the base; Vite's transformIndexHtml would
      // prepend it again (/fixture/fixture/assets/...), so dev must not
      // rebase. The HMR client and entry script are injected manually.
      expect(html).toContain('src="/fixture/assets/pic.txt"')
      expect(html).not.toContain('/fixture/fixture/')
      expect(html).toContain('src="/fixture/@vite/client"')
      expect(html).toContain('src="/fixture/entry.ts"')
    } finally {
      await server.close()
    }
  })

  it('serves a working search index in dev', { timeout: 60_000 }, async () => {
    const server = await createDevServer(root, { port: 0 })
    try {
      const address = server.httpServer?.address()
      if (!address || typeof address === 'string') throw new Error('Missing dev port')
      const response = await fetch(`http://127.0.0.1:${address.port}/fixture/search-index.json`)
      expect(response.status).toBe(200)
      const search = MiniSearch.loadJSON(await response.text(), {
        fields: ['title', 'headings', 'text'],
        storeFields: ['route', 'title', 'text'],
        tokenize: tokenizeSearch,
        processTerm: normalizeSearchTerm
      })
      expect(search.search('指南')[0]?.route).toBe('/notes/2')
    } finally {
      await server.close()
    }
  })

  it(
    'picks up a single-note edit without a full session rebuild',
    { timeout: 60_000 },
    async () => {
      const server = await createDevServer(root, { port: 0 })
      try {
        const address = server.httpServer?.address()
        if (!address || typeof address === 'string') throw new Error('Missing dev port')
        const url = `http://127.0.0.1:${address.port}/fixture/notes/2`
        const before = await (await fetch(url)).text()
        expect(before).toContain('容器管线正常')

        const file = path.join(root, 'notes', '0002. 指南.md')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\n\n增量更新生效。\n')

        const deadline = Date.now() + 15_000
        let after = ''
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 300))
          after = await (await fetch(url)).text()
          if (after.includes('增量更新生效')) break
        }
        expect(after).toContain('增量更新生效')
      } finally {
        await server.close()
      }
    }
  )
})

describe('dead links', () => {
  it('fails a build when an internal target does not exist', async () => {
    const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tnotes-ssg-deadlink-'))
    try {
      const w = (rel: string, content: string) => {
        const file = path.join(invalidRoot, rel)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, content)
      }
      w('TOC.md', '- [ ] 0001. 首页\n')
      w('notes/0001. 首页.md', '# 首页\n\n[缺失](./0002. 不存在.md)\n')
      await expect(buildSite(invalidRoot)).rejects.toThrow('dead link')
    } finally {
      fs.rmSync(invalidRoot, { recursive: true, force: true })
    }
  })

  it('does not fail when fenced code looks like a markdown link', { timeout: 30_000 }, async () => {
    const validRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tnotes-ssg-codelink-'))
    try {
      const w = (rel: string, content: string) => {
        const file = path.join(validRoot, rel)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, content)
      }
      w('TOC.md', '- [ ] 0001. 首页\n')
      w(
        'notes/0001. 首页.md',
        "# 首页\n\n```ts\nif (prefix === '[' && suffix.startsWith('](')) {}\n```\n"
      )
      await buildSite(validRoot)
    } finally {
      fs.rmSync(validRoot, { recursive: true, force: true })
    }
  })
})
