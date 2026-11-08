import { describe, expect, it } from 'vitest'

import {
  buildNoteAssetsView,
  canvasPairRelPath,
  fixedReferencePath,
  formatBytes,
  indexPrefixedName,
  insertableImageMarkdown,
  parseNoteAssetReferences,
  type NoteAssetsListingEntry
} from './noteAssets'

const NOTE = 'notes/0007. 笔记.md'

const file = (relPath: string, bytes = 1024): NoteAssetsListingEntry => ({
  name: relPath.split('/').pop() ?? relPath,
  relPath,
  kind: 'file',
  bytes,
  textLike: /\.(png|jpe?g|gif|webp|avif|svg|md|txt|json)$/i.test(relPath) === false
})

const listing = (...relPaths: string[]): NoteAssetsListingEntry[] => relPaths.map((p) => file(p))

const build = (source: string, entries: NoteAssetsListingEntry[]) =>
  buildNoteAssetsView({ source, noteRelPath: NOTE, noteIndex: '0007', listing: entries })

describe('解析笔记里的资源引用', () => {
  it('图片、链接与 HTML img 都能解析，并带上偏移与行列', () => {
    const source = ['第一行', '![图](../assets/0007-a.png)', '[下载](../assets/0007-b.pdf)'].join(
      '\n'
    )
    const refs = parseNoteAssetReferences(source, NOTE)
    expect(refs.map((ref) => [ref.syntax, ref.relPath])).toEqual([
      ['image', 'assets/0007-a.png'],
      ['link', 'assets/0007-b.pdf']
    ])
    expect(refs[0]?.line).toBe(2)
    expect(refs[0]?.alt).toBe('图')
    expect(source.slice(refs[0]!.startOffset, refs[0]!.endOffset)).toBe(
      '![图](../assets/0007-a.png)'
    )
  })

  it('外链、data: 与越界路径不进面板', () => {
    const source = [
      '![外链](https://example.com/a.png)',
      '![data](data:image/png;base64,AAAA)',
      '![库外](../../outside.png)',
      '![笔记](../notes/other.md)'
    ].join('\n')
    expect(parseNoteAssetReferences(source, NOTE).every((ref) => ref.relPath === null)).toBe(true)
  })

  it('同一资源引用多次会解析出多处', () => {
    const source = '![a](../assets/0007-a.png)\n\n![b](../assets/0007-a.png)'
    const refs = parseNoteAssetReferences(source, NOTE)
    expect(refs).toHaveLength(2)
    expect(refs[0]!.startOffset).toBeLessThan(refs[1]!.startOffset)
  })
})

describe('分组：引用 / 编号匹配 / 无效 / 缺失', () => {
  it('引用的资源进 referenced，编号匹配的进 own', () => {
    const view = build(
      '![a](../assets/0007-a.png)',
      listing('assets/0007-a.png', 'assets/0007-b.png')
    )
    expect(view.referenced.map((entry) => entry.relPath)).toEqual(['assets/0007-a.png'])
    expect(view.own.map((entry) => entry.relPath)).toEqual([
      'assets/0007-a.png',
      'assets/0007-b.png'
    ])
    expect(view.invalid.map((entry) => entry.relPath)).toEqual(['assets/0007-b.png'])
    // 行本身也要带上 invalid 标记，消费方不必再对着 invalid 集合查
    expect(view.own.find((entry) => entry.relPath === 'assets/0007-b.png')?.invalid).toBe(true)
    expect(view.own.find((entry) => entry.relPath === 'assets/0007-a.png')?.invalid).toBe(false)
  })

  it('编号不匹配但被引用 → needsIndexFix，且给出新名字', () => {
    const view = build('![a](../assets/0001-photo.png)', listing('assets/0001-photo.png'))
    const entry = view.referenced[0]!
    expect(entry.needsIndexFix).toBe(true)
    expect(entry.fixedName).toBe('0007-photo.png')
    expect(view.invalid).toEqual([])
  })

  it('引用了但磁盘上没有 → missing（不进 own / invalid）', () => {
    const view = build('![a](../assets/0007-gone.png)', listing('assets/0007-a.png'))
    expect(view.missing.map((entry) => entry.relPath)).toEqual(['assets/0007-gone.png'])
    expect(view.invalid.map((entry) => entry.relPath)).toEqual(['assets/0007-a.png'])
  })

  it('编号匹配但被引用的资源不算无效', () => {
    const view = build('![a](../assets/0007-a.png)', listing('assets/0007-a.png'))
    expect(view.invalid).toEqual([])
  })

  it('没有四位前缀的资源既不进 own 也不算无效', () => {
    const view = build('', listing('assets/plain.png'))
    expect(view.own).toEqual([])
    expect(view.invalid).toEqual([])
  })

  it('新的无前缀文件被引用时进 own，且不标 needsIndexFix', () => {
    const name = 'assets/26-09-11-10-20-30-abcdef01.png'
    const view = build(`![图](../${name})`, listing(name))
    expect(view.own.map((entry) => entry.relPath)).toEqual([name])
    expect(view.referenced[0]?.needsIndexFix).toBe(false)
    expect(view.invalid).toEqual([])
  })
})

describe('画布配对（.excalidraw ↔ 同名 .svg）', () => {
  it('同名配对路径按后缀互换', () => {
    expect(canvasPairRelPath('assets/0007-a.excalidraw')).toBe('assets/0007-a.svg')
    expect(canvasPairRelPath('assets/0007-a.svg')).toBe('assets/0007-a.excalidraw')
    expect(canvasPairRelPath('assets/0007-a.png')).toBeNull()
  })

  it('笔记引用派生图时，源文件不算无效资源', () => {
    const view = build(
      '![画布](../assets/0007-a.svg)',
      listing('assets/0007-a.svg', 'assets/0007-a.excalidraw')
    )
    expect(view.invalid).toEqual([])
  })

  it('两侧都没被引用 → 两半都列为可删', () => {
    const view = build('', listing('assets/0007-a.svg', 'assets/0007-a.excalidraw'))
    expect(view.invalid.map((entry) => entry.relPath).sort()).toEqual([
      'assets/0007-a.excalidraw',
      'assets/0007-a.svg'
    ])
  })

  it('笔记引用源文件时，派生图也不算无效（一份资源两半）', () => {
    const view = build(
      '![画布](../assets/0007-a.excalidraw)',
      listing('assets/0007-a.svg', 'assets/0007-a.excalidraw')
    )
    expect(view.invalid).toEqual([])
  })
})

describe('修复与插入的路径计算', () => {
  it('编号前缀是"替换"而不是叠加', () => {
    expect(indexPrefixedName('0007', 'photo.png')).toBe('0007-photo.png')
    expect(indexPrefixedName('0007', '0001-photo.png')).toBe('0007-photo.png')
    expect(indexPrefixedName('0007', '0001-a-b-c.png')).toBe('0007-a-b-c.png')
  })

  it('修复后的引用是相对笔记文件的新路径', () => {
    expect(fixedReferencePath(NOTE, 'assets/0001-photo.png', '0007')).toBe(
      '../assets/0007-photo.png'
    )
  })

  it('图片可一键插入，其它类型暂不支持', () => {
    expect(insertableImageMarkdown(NOTE, 'assets/0007-a.png', '图')).toBe(
      '![图](../assets/0007-a.png)'
    )
    expect(insertableImageMarkdown(NOTE, 'assets/0007-a.svg')).toBe('![](../assets/0007-a.svg)')
    expect(insertableImageMarkdown(NOTE, 'assets/0007-a.pdf')).toBeNull()
    expect(insertableImageMarkdown(NOTE, 'assets/0007-a.excalidraw')).toBeNull()
  })

  it('插入时清掉描述里的方括号（避免破坏 markdown）', () => {
    expect(insertableImageMarkdown(NOTE, 'assets/0007-a.png', 'a[b]c')).toBe(
      '![abc](../assets/0007-a.png)'
    )
  })

  it('体积格式化', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
