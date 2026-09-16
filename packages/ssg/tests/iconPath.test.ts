import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildSite } from '../src/site'
import { resolveIconHref } from '../src/site'

/**
 * `tnotes.json` declares its icon the way a note references an asset — relative
 * to the file that mentions it (`../assets/kb-icon.svg`). Emitted verbatim the
 * href resolves against the *page's* depth, so the home page (`/kb/`) asks for
 * `/assets/…` and 404s while a note page happens to work. Every page has to agree.
 */
describe('kb-declared icon resolves for every page depth', () => {
  let root = ''
  const dist = (p: string): string => path.join(root, '.tnotes', 'dist', p)

  const write = (relativePath: string, content: string): void => {
    const file = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tnotes-ssg-icon-'))
    write(
      'tnotes.json',
      JSON.stringify({
        title: 'Icon',
        base: '/TNotes.icon/',
        // A kb-local icon, exactly like the real ones that hit this bug.
        icon: { src: '../assets/kb-icon.svg' }
      })
    )
    write('TOC.md', '- [ ] 0001. 首页\n')
    write(
      'notes/0001. 首页.md',
      '---\nid: 11111111-1111-4111-8111-111111111111\n---\n\n# 首页\n\n正文\n'
    )
    write('assets/kb-icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    await buildSite(root)
  }, 120_000)

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  it('emits a site-absolute href on the home page and on note pages', () => {
    for (const page of ['index.html', 'notes/1.html', '404.html']) {
      const html = fs.readFileSync(dist(page), 'utf8')
      expect(html, page).toContain('<link rel="icon" type="image/svg+xml"')
      // Absolute → resolves the same everywhere, including the entry point.
      expect(html, page).toContain('href="/TNotes.icon/assets/kb-icon.svg"')
      expect(html, page).not.toContain('href="../assets/kb-icon.svg"')
    }
  })

  it('rebases only kb-relative paths, leaving absolute and data URIs alone', () => {
    expect(resolveIconHref('../assets/kb-icon.svg', '/kb/')).toBe('/kb/assets/kb-icon.svg')
    expect(resolveIconHref('./assets/icon.png', '/kb/')).toBe('/kb/assets/icon.png')
    expect(resolveIconHref('assets/icon.png', '/kb/')).toBe('/kb/assets/icon.png')
    expect(resolveIconHref('/assets/icon.png', '/kb/')).toBe('/kb/assets/icon.png')
    expect(resolveIconHref('https://cdn.example.com/icon.svg', '/kb/')).toBe(
      'https://cdn.example.com/icon.svg'
    )
    expect(resolveIconHref('//cdn.example.com/icon.svg', '/kb/')).toBe('//cdn.example.com/icon.svg')
    expect(resolveIconHref('data:image/svg+xml,%3Csvg/%3E', '/kb/')).toBe(
      'data:image/svg+xml,%3Csvg/%3E'
    )
  })
})
