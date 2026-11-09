import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveConfig } from '../src/config'
import { collectSite, HOME_SIDEBAR_TEXT, noteCorpusStats } from '../src/pages'

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

describe('noteCorpusStats', () => {
  it('counts notes and their source length, and skips pages that are not notes', () => {
    expect(
      noteCorpusStats(
        [{ done: true }, { done: false }, { done: true }],
        [
          { noteIndex: '0001', source: 'abcd' },
          { noteIndex: '0002', source: 'xy' },
          { noteIndex: '', source: '# readme should not count' }
        ]
      )
    ).toEqual({ noteCount: 3, charCount: 6 })
  })
})

describe('collectSite home page', () => {
  it('uses README.md as the home body and pins 首页 as the first sidebar row', async () => {
    fixture({ 'README.md': '# 欢迎\n\n![x](./assets/README-1.png)\n' })
    const site = await collectSite(await resolveConfig(root))
    const home = site.pages.find((page) => page.route === '/')
    expect(path.basename(home?.file ?? '')).toBe('README.md')
    expect(home?.source).toContain('# 欢迎')
    expect(site.sidebar[0]).toEqual({ text: HOME_SIDEBAR_TEXT, link: '/' })
    expect(site.sidebar[1]?.index).toBe('0001')
  })

  it('keeps an empty home page when README.md is missing or blank', async () => {
    fixture({ 'README.md': '  \n' })
    const site = await collectSite(await resolveConfig(root))
    const home = site.pages.find((page) => page.route === '/')
    expect(home?.source).toBe('')
    expect(home?.noteIndex).toBe('')
    expect(site.pages.filter((page) => page.noteIndex === '0001')).toHaveLength(1)
    expect(site.sidebar[0]).toEqual({ text: HOME_SIDEBAR_TEXT, link: '/' })
  })

  it('does not let a configured home note replace the home page', async () => {
    fixture({ 'README.md': '# 欢迎\n' }, { home: '0001' })
    const site = await collectSite(await resolveConfig(root))
    expect(site.pages.find((page) => page.route === '/')?.source).toContain('# 欢迎')
    expect(site.pages.find((page) => page.noteIndex === '0001')?.route).toBe('/notes/1')
    expect(site.sidebar[0]).toEqual({ text: HOME_SIDEBAR_TEXT, link: '/' })
  })
})
