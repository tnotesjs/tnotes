import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveConfig } from '../src/config'
import { collectSite, README_SIDEBAR_TEXT } from '../src/pages'

let root = ''

function write(relativePath: string, content: string) {
  const filename = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, content)
}

function fixture(extra: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tnotes-ssg-pages-'))
  write('tnotes.json', JSON.stringify({ title: 'Fixture', ...config }))
  write('TOC.md', '- [ ] 0001. 第一篇\n')
  write('notes/0001. 第一篇.md', '# 第一篇\n')
  for (const [file, content] of Object.entries(extra)) write(file, content)
}

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('collectSite home page', () => {
  it('uses README.md as home and pins it as the first sidebar row', async () => {
    fixture({ 'README.md': '# 欢迎\n\n![x](./assets/README-1.png)\n' })
    const site = await collectSite(await resolveConfig(root))
    const home = site.pages.find((page) => page.route === '/')
    expect(path.basename(home?.file ?? '')).toBe('README.md')
    expect(home?.source).toContain('# 欢迎')
    expect(site.sidebar[0]).toEqual({ text: README_SIDEBAR_TEXT, link: '/' })
    expect(site.sidebar[1]?.index).toBe('0001')
  })

  it('falls back to the first TOC note when README.md is missing or blank', async () => {
    fixture({ 'README.md': '  \n' })
    const site = await collectSite(await resolveConfig(root))
    expect(site.pages.find((page) => page.route === '/')?.noteIndex).toBe('0001')
    expect(site.sidebar[0]?.index).toBe('0001')
  })

  it('keeps an explicitly configured home note over README.md', async () => {
    fixture({ 'README.md': '# 欢迎\n' }, { home: '0001' })
    const site = await collectSite(await resolveConfig(root))
    expect(site.pages.find((page) => page.route === '/')?.noteIndex).toBe('0001')
    expect(site.sidebar.some((item) => item.text === README_SIDEBAR_TEXT)).toBe(false)
  })
})
