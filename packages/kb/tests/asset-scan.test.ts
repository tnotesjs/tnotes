import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { classifyAssetUrl } from '../src/asset-scan/paths'
import { extractAssetReferences } from '../src/asset-scan/extract'
import { scanAssets } from '../src/asset-scan/scan'
import { writeAssetScanFixture } from './helpers/assetScanFixture'

let root = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tnotes-asset-scan-'))
  await writeAssetScanFixture(root)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('classifyAssetUrl', () => {
  it('aliases note-relative assets paths and keeps query/fragment', () => {
    const classified = classifyAssetUrl('../assets/used.png?x=1#y', 'notes/0001. a.md')
    expect(classified.urlKind).toBe('local-relative')
    expect(classified.targetRelPath).toBe('assets/used.png')
    expect(classified.urlSuffix).toBe('?x=1#y')
  })

  it('treats ./assets in notes as the same alias', () => {
    expect(classifyAssetUrl('./assets/mindmap.png', 'notes/0002. a.md').targetRelPath).toBe(
      'assets/mindmap.png'
    )
  })

  it('marks /assets as local-root and still maps the target', () => {
    const classified = classifyAssetUrl('/assets/used.png', 'notes/0001. a.md')
    expect(classified.urlKind).toBe('local-root')
    expect(classified.targetRelPath).toBe('assets/used.png')
  })

  it('decodes once and rejects traversal', () => {
    expect(classifyAssetUrl('../assets/%E4%B8%AD.png', 'notes/0001. a.md').targetRelPath).toBe(
      'assets/中.png'
    )
    expect(classifyAssetUrl('../assets/../../etc/passwd', 'notes/0001. a.md').outOfBounds).toBe(
      true
    )
  })
})

describe('extractAssetReferences', () => {
  it('keeps {w=} / {align=} out of the URL dest', () => {
    const source = '![宽图](../assets/used.png) {w=400px}\n'
    const { references } = extractAssetReferences(source, { sourceRelPath: 'notes/0001. a.md' })
    const image = references.find((ref) => ref.syntax === 'markdown-image')
    expect(image?.rawUrl).toBe('../assets/used.png')
    expect(source.slice(image!.startOffset, image!.endOffset)).toBe('../assets/used.png')
    expect(source).toContain('{w=400px}')
  })

  it('maps mindmap fence images back to the enclosing file', () => {
    const source = [
      '# t',
      '',
      '```mindmap',
      '# root',
      '',
      '- ![截图|400](./assets/mindmap.png)',
      '```',
      ''
    ].join('\n')
    const { references } = extractAssetReferences(source, { sourceRelPath: 'notes/0002. a.md' })
    const image = references.find((ref) => ref.syntax === 'mindmap-image')
    expect(image?.rawUrl).toBe('./assets/mindmap.png')
    expect(image?.targetRelPath).toBe('assets/mindmap.png')
    expect(source.slice(image!.startOffset, image!.endOffset)).toBe('./assets/mindmap.png')
  })

  it('把笔记里的 <Excalidraw path> 组件调用记成可改写引用（带精确偏移）', () => {
    const source = [
      '# t',
      '',
      '<Excalidraw path="../assets/0001-drawing.excalidraw" height="480" />',
      ''
    ].join('\n')
    const { references } = extractAssetReferences(source, { sourceRelPath: 'notes/0001. a.md' })
    const canvas = references.find((ref) => ref.syntax === 'excalidraw-component')
    expect(canvas?.rawUrl).toBe('../assets/0001-drawing.excalidraw')
    expect(canvas?.targetRelPath).toBe('assets/0001-drawing.excalidraw')
    expect(canvas?.rewritable).toBe(true)
    expect(source.slice(canvas!.startOffset, canvas!.endOffset)).toBe(
      '../assets/0001-drawing.excalidraw'
    )
  })

  it('支持单引号与多行属性，绑定写法算动态绑定', () => {
    const single = "<Excalidraw\n  path='../assets/a.excalidraw'\n/>\n"
    const singleRefs = extractAssetReferences(single, { sourceRelPath: 'notes/0001. a.md' })
    expect(
      singleRefs.references.find((ref) => ref.syntax === 'excalidraw-component')?.targetRelPath
    ).toBe('assets/a.excalidraw')

    const bound = '<Excalidraw :path="someVar" />\n'
    const boundRefs = extractAssetReferences(bound, { sourceRelPath: 'notes/0001. a.md' })
    expect(
      boundRefs.references.filter((ref) => ref.syntax === 'excalidraw-component')
    ).toHaveLength(0)
    expect(boundRefs.sawDynamicBinding).toBe(true)
  })

  it('围栏里的组件示例不算引用；未知组件带 path 属性也不会被当成已知组件', () => {
    const fenced = '```md\n<Excalidraw path="../assets/a.excalidraw" />\n```\n'
    const fencedRefs = extractAssetReferences(fenced, { sourceRelPath: 'notes/0001. a.md' })
    expect(fencedRefs.references.every((ref) => ref.syntax !== 'excalidraw-component')).toBe(true)

    const unknown = '<UnknownThing path="../assets/a.png" />\n'
    const unknownRefs = extractAssetReferences(unknown, { sourceRelPath: 'notes/0001. a.md' })
    expect(unknownRefs.references.some((ref) => ref.syntax === 'excalidraw-component')).toBe(false)
    expect(unknownRefs.references.some((ref) => ref.targetRelPath === 'assets/a.png')).toBe(false)
  })

  it('does not treat ordinary fence examples as rewritable', () => {
    const source = '```js\n![x](../assets/fenced-only.png)\n```\n'
    const { references } = extractAssetReferences(source, { sourceRelPath: 'notes/0001. a.md' })
    expect(references.every((ref) => ref.syntax === 'uncertain-fence')).toBe(true)
    expect(references.every((ref) => !ref.rewritable)).toBe(true)
  })
})

describe('scanAssets', () => {
  it('does not write the knowledge base', async () => {
    const before = await fs.stat(path.join(root, 'notes/0001. 普通笔记.md'))
    await scanAssets(root)
    const after = await fs.stat(path.join(root, 'notes/0001. 普通笔记.md'))
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
  })

  it('covers the P1-1a fixture matrix', async () => {
    const report = await scanAssets(root, { generation: 7 })
    expect(report.generation).toBe(7)

    const byPath = Object.fromEntries(report.assets.map((asset) => [asset.relPath, asset]))
    expect(byPath['assets/used.png']?.status).toBe('referenced')
    expect(byPath['assets/nested/deep.png']?.status).toBe('referenced')
    expect(byPath['assets/中文 (1).png']?.status).toBe('referenced')
    expect(byPath['assets/html-src.png']?.status).toBe('referenced')
    expect(byPath['assets/mindmap.png']?.status).toBe('referenced')
    expect(byPath['assets/orphan-note.png']?.status).toBe('referenced')
    expect(byPath['assets/readme-cover.png']?.status).toBe('referenced')
    expect(byPath['assets/kb-icon.png']?.status).toBe('protected')
    expect(byPath['assets/fenced-only.png']?.status).toBe('uncertain-affected')
    expect(byPath['assets/comment-only.png']?.status).toBe('uncertain-affected')
    expect(byPath['assets/srcset.png']?.status).toBe('referenced')
    expect(byPath['assets/component.png']?.status).toBe('referenced')
    expect(byPath['assets/idle.png']?.status).toBe('idle-candidate')
    expect(byPath['assets/page.html']?.status).toBe('idle-candidate')
    expect(byPath['assets/board.excalidraw']?.kind).toBe('excalidraw')
    expect(byPath['assets/board.excalidraw']?.status).toBe('protected')
    expect(byPath['assets/board.excalidraw']?.protection).toContain('excalidraw-source')
    expect(byPath['assets/board.excalidraw']?.renameAllowed).toBe(false)

    const mindmap = report.references.find((ref) => ref.syntax === 'mindmap-image')
    expect(mindmap?.targetRelPath).toBe('assets/mindmap.png')
    expect(mindmap?.rewritable).toBe(true)

    const widthImage = report.references.find(
      (ref) => ref.syntax === 'markdown-image' && ref.rawUrl === '../assets/used.png'
    )
    expect(widthImage?.rewritable).toBe(true)

    const srcset = report.references.find((ref) => ref.syntax === 'html-srcset')
    expect(srcset?.rawUrl).toBe('../assets/srcset.png')
    expect(srcset?.rewritable).toBe(true)

    const rootSlash = report.references.find((ref) => ref.urlKind === 'local-root')
    expect(rootSlash?.rewritable).toBe(false)
    expect(report.diagnostics.some((item) => item.code === 'path-compat-root-slash')).toBe(true)

    expect(report.coverageComplete).toBe(true)
    expect(report.batchCleanupAllowed).toBe(true)
    expect(byPath['assets/used.png']?.renameAllowed).toBe(true)
    expect(byPath['assets/idle.png']?.renameAllowed).toBe(true)
    expect(byPath['assets/fenced-only.png']?.renameAllowed).toBe(false)

    expect(report.brokenLinks.filter((item) => item.reason === 'missing-file')).toHaveLength(0)
    expect(report.diagnostics.some((item) => item.code === 'unparsed-component')).toBe(false)
    expect(report.diagnostics.some((item) => item.code === 'unparsed-source')).toBe(false)
    expect(report.diagnostics.some((item) => item.message.includes('围栏'))).toBe(true)
  })

  it('allows idle classification when the library has only determined sources', async () => {
    const simple = await fs.mkdtemp(path.join(os.tmpdir(), 'tnotes-asset-simple-'))
    try {
      await fs.mkdir(path.join(simple, 'notes'), { recursive: true })
      await fs.mkdir(path.join(simple, 'assets'), { recursive: true })
      await fs.writeFile(path.join(simple, 'TOC.md'), '- [ ] 0001. a\n')
      await fs.writeFile(path.join(simple, 'tnotes.json'), '{ "title": "simple" }\n')
      await fs.writeFile(
        path.join(simple, 'notes/0001. a.md'),
        '---\nid: a\n---\n\n![x](../assets/used.png)\n'
      )
      await fs.writeFile(path.join(simple, 'assets/used.png'), 'x')
      await fs.writeFile(path.join(simple, 'assets/idle.png'), 'y')
      const report = await scanAssets(simple)
      expect(report.coverageComplete).toBe(true)
      expect(report.batchCleanupAllowed).toBe(true)
      expect(report.assets.find((asset) => asset.relPath === 'assets/idle.png')?.status).toBe(
        'idle-candidate'
      )
      expect(
        report.assets.find((asset) => asset.relPath === 'assets/used.png')?.renameAllowed
      ).toBe(true)
      expect(
        report.assets.find((asset) => asset.relPath === 'assets/idle.png')?.renameAllowed
      ).toBe(true)
    } finally {
      await fs.rm(simple, { recursive: true, force: true })
    }
  })

  it('never treats .excalidraw files as idle cleanup candidates', async () => {
    const simple = await fs.mkdtemp(path.join(os.tmpdir(), 'tnotes-asset-excalidraw-'))
    try {
      await fs.mkdir(path.join(simple, 'notes'), { recursive: true })
      await fs.mkdir(path.join(simple, 'assets'), { recursive: true })
      await fs.writeFile(path.join(simple, 'TOC.md'), '- [ ] 0001. a\n')
      await fs.writeFile(path.join(simple, 'tnotes.json'), '{ "title": "simple" }\n')
      await fs.writeFile(
        path.join(simple, 'notes/0001. a.md'),
        '---\nid: a\n---\n\n![x](../assets/used.png)\n'
      )
      await fs.writeFile(path.join(simple, 'assets/used.png'), 'x')
      await fs.writeFile(path.join(simple, 'assets/idle.png'), 'y')
      await fs.writeFile(path.join(simple, 'assets/drawing.excalidraw'), '{"type":"excalidraw"}\n')
      const report = await scanAssets(simple)
      const drawing = report.assets.find((asset) => asset.relPath === 'assets/drawing.excalidraw')
      expect(drawing?.status).toBe('protected')
      expect(drawing?.protection).toContain('excalidraw-source')
      expect(drawing?.renameAllowed).toBe(false)
      expect(
        report.assets.some(
          (asset) => asset.relPath.endsWith('.excalidraw') && asset.status !== 'protected'
        )
      ).toBe(false)
    } finally {
      await fs.rm(simple, { recursive: true, force: true })
    }
  })

  it('reports determined missing local files as broken links', async () => {
    await fs.appendFile(
      path.join(root, 'notes/0001. 普通笔记.md'),
      '\n![缺](../assets/missing-file.png)\n'
    )
    const report = await scanAssets(root)
    expect(
      report.brokenLinks.some((item) => item.reference.targetRelPath === 'assets/missing-file.png')
    ).toBe(true)
  })

  it('honours AbortSignal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(scanAssets(root, { signal: controller.signal })).rejects.toThrow(
      /ASSET_SCAN_ABORTED|AbortError/
    )
  })
})
