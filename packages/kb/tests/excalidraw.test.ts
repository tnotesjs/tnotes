import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  copyExcalidrawDocument,
  createExcalidrawDocument,
  derivedSvgRelPath,
  emptyExcalidrawScene,
  findExcalidrawSourceFor,
  readExcalidrawDocument,
  writeExcalidrawDerivedSvg,
  writeExcalidrawDocument
} from '../src/excalidraw'

let root = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-excalidraw-'))
  await fs.writeFile(path.join(root, 'tnotes.json'), '{ "title": "画布测试" }\n')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const sceneWith = (extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ ...JSON.parse(emptyExcalidrawScene()), ...extra })}\n`

describe('创建画布源文件', () => {
  it('按笔记前缀排他命名，并返回可插入的相对路径', async () => {
    const now = new Date('2026-09-11T10:20:30')
    const first = await createExcalidrawDocument(root, { ownerNoteIndex: '0042', now })
    const second = await createExcalidrawDocument(root, { ownerNoteIndex: '0042', now })

    expect(first.relPath).toMatch(/^assets\/26-09-11-10-20-30-[0-9a-f]{8}\.excalidraw$/)
    expect(second.relPath).toMatch(/^assets\/26-09-11-10-20-30-[0-9a-f]{8}\.excalidraw$/)
    expect(second.relPath).not.toBe(first.relPath)
    expect(first.ownerNoteIndex).toBe('0042')
    await expect(fs.readFile(path.join(root, second.relPath), 'utf8')).resolves.toContain(
      '"type": "excalidraw"'
    )
  })

  it('并发创建同秒文件不会互相覆盖', async () => {
    const now = new Date('2026-09-11T10:20:30')
    const created = await Promise.all(
      Array.from({ length: 8 }, () =>
        createExcalidrawDocument(root, { ownerNoteIndex: '0007', now })
      )
    )
    const paths = created.map((item) => item.relPath)
    expect(new Set(paths).size).toBe(8)
    for (const item of created) {
      await expect(fs.stat(path.join(root, item.relPath))).resolves.toBeTruthy()
    }
  })

  it('非法笔记编号与非法内容被拒绝', async () => {
    await expect(createExcalidrawDocument(root, { ownerNoteIndex: '42' })).rejects.toMatchObject({
      code: 'INVALID_INDEX'
    })
    await expect(
      createExcalidrawDocument(root, { ownerNoteIndex: '0042', content: '{ not json' })
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' })
    await expect(
      createExcalidrawDocument(root, { ownerNoteIndex: '0042', content: '{"a":1}' })
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' })
  })

  it('新画布不附带 SVG/PNG 等派生文件', async () => {
    const created = await createExcalidrawDocument(root, { ownerNoteIndex: '0001' })
    const entries = await fs.readdir(path.join(root, 'assets'))
    expect(entries).toEqual([path.posix.basename(created.relPath)])
  })
})

describe('读写与版本校验', () => {
  it('往返读写保留内嵌图片与文字', async () => {
    const content = sceneWith({
      elements: [{ id: 'rect-1', type: 'rectangle' }],
      files: {
        'file-1': { id: 'file-1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA' }
      }
    })
    const created = await createExcalidrawDocument(root, { ownerNoteIndex: '0042', content })
    const read = await readExcalidrawDocument(root, created.relPath)

    expect(read.valid).toBe(true)
    expect(read.revision).toBe(created.revision)
    expect(JSON.parse(read.content).files['file-1'].dataURL).toContain('data:image/png')
  })

  it('revision 不一致时拒绝覆盖（磁盘被外部改过）', async () => {
    const created = await createExcalidrawDocument(root, { ownerNoteIndex: '0042' })
    const absolute = path.join(root, created.relPath)
    await fs.writeFile(absolute, sceneWith({ elements: [{ id: 'external' }] }))

    await expect(
      writeExcalidrawDocument(root, {
        relPath: created.relPath,
        content: sceneWith(),
        expectedRevision: created.revision
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    // 外部内容保持原样
    expect(await fs.readFile(absolute, 'utf8')).toContain('external')
  })

  it('版本一致时原子写回并返回新 revision', async () => {
    const created = await createExcalidrawDocument(root, { ownerNoteIndex: '0042' })
    const next = sceneWith({ elements: [{ id: 'added' }] })
    const written = await writeExcalidrawDocument(root, {
      relPath: created.relPath,
      content: next,
      expectedRevision: created.revision
    })

    expect(written.revision).not.toBe(created.revision)
    const reread = await readExcalidrawDocument(root, created.relPath)
    expect(reread.content).toBe(next)
    expect(reread.revision).toBe(written.revision)
  })

  it('损坏的 JSON 只报告不修复，也不覆盖原件', async () => {
    const created = await createExcalidrawDocument(root, { ownerNoteIndex: '0042' })
    const absolute = path.join(root, created.relPath)
    await fs.writeFile(absolute, '{ broken')

    const read = await readExcalidrawDocument(root, created.relPath)
    expect(read.valid).toBe(false)
    await expect(
      writeExcalidrawDocument(root, {
        relPath: created.relPath,
        content: emptyExcalidrawScene(),
        expectedRevision: read.revision
      })
    ).resolves.toBeTruthy()
    // 上面是显式写回；关键是不存在「读失败后自动修复覆盖」的路径：
    expect(await fs.readFile(absolute, 'utf8')).toContain('excalidraw')
  })

  it('文件缺失给明确错误，不会顺手创建空画布', async () => {
    await expect(
      readExcalidrawDocument(root, 'assets/0042-26-09-11-10-20-30.excalidraw')
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' })
    await expect(fs.readdir(path.join(root, 'assets'))).rejects.toThrow()
  })
})

describe('路径与归属校验', () => {
  it('拒绝库外、非 assets、非 excalidraw 扩展名与缺前缀的路径', async () => {
    for (const relPath of [
      'notes/0042-x.excalidraw',
      '../outside/0042-x.excalidraw',
      'assets/../0042-x.excalidraw',
      'assets/0042-x.png',
      'assets/x.excalidraw'
    ]) {
      await expect(readExcalidrawDocument(root, relPath)).rejects.toMatchObject({
        code: expect.stringMatching(/INVALID_OPERATION|NOTE_NOT_FOUND/)
      })
    }
  })

  it('复制到别的笔记必须换前缀，内容与内嵌图片完整保留', async () => {
    const content = sceneWith({
      elements: [{ id: 'rect-1' }],
      files: { 'file-1': { id: 'file-1', dataURL: 'data:image/png;base64,BB' } }
    })
    const now = new Date('2026-09-11T11:00:00')
    const source = await createExcalidrawDocument(root, {
      ownerNoteIndex: '0042',
      content,
      now
    })
    const copy = await copyExcalidrawDocument(root, {
      fromRelPath: source.relPath,
      toOwnerNoteIndex: '0043',
      now
    })

    expect(copy.relPath.startsWith('assets/')).toBe(true)
    expect(copy.relPath).not.toMatch(/^assets\/0043-/)
    expect(copy.relPath).not.toBe(source.relPath)
    const copied = await readExcalidrawDocument(root, copy.relPath)
    expect(copied.content).toBe(content)
    expect(JSON.parse(copied.content).files['file-1'].dataURL).toContain('data:image/png')
    // 源文件不受影响
    expect((await readExcalidrawDocument(root, source.relPath)).content).toBe(content)
  })

  it('复制损坏的源被拒绝，不产生新文件', async () => {
    const created = await createExcalidrawDocument(root, { ownerNoteIndex: '0042' })
    await fs.writeFile(path.join(root, created.relPath), 'not json')

    await expect(
      copyExcalidrawDocument(root, { fromRelPath: created.relPath, toOwnerNoteIndex: '0043' })
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' })
    const entries = await fs.readdir(path.join(root, 'assets'))
    expect(entries.filter((name) => name.startsWith('0043-'))).toEqual([])
  })
})

describe('派生 SVG（笔记里引用那张图）', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'

  it('与源画布同目录同名，只换后缀', async () => {
    const created = await createExcalidrawDocument(root, { ownerNoteIndex: '0042' })
    const written = await writeExcalidrawDerivedSvg(root, {
      sourceRelPath: created.relPath,
      content: SVG
    })

    expect(written.relPath).toBe(created.relPath.replace(/\.excalidraw$/, '.svg'))
    expect(written.sourceRelPath).toBe(created.relPath)
    expect(written.ownerNoteIndex).toBe('')
    await expect(fs.readFile(path.join(root, written.relPath), 'utf8')).resolves.toBe(SVG)
  })

  it('源画布不存在时拒绝写入，不留孤儿文件', async () => {
    await expect(
      writeExcalidrawDerivedSvg(root, {
        sourceRelPath: 'assets/0042-26-09-11-10-20-30.excalidraw',
        content: SVG
      })
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' })
    await expect(fs.readdir(path.join(root, 'assets'))).rejects.toThrow()
  })

  it('内容不是 SVG 就拒绝（防止往 assets 里塞任意 .svg）', async () => {
    const created = await createExcalidrawDocument(root, { ownerNoteIndex: '0042' })
    for (const content of ['', 'not svg at all', '{"a":1}']) {
      await expect(
        writeExcalidrawDerivedSvg(root, { sourceRelPath: created.relPath, content })
      ).rejects.toMatchObject({ code: 'INVALID_OPERATION' })
    }
  })

  it('允许 XML 声明与注释开头的 SVG', async () => {
    const created = await createExcalidrawDocument(root, { ownerNoteIndex: '0042' })
    const withProlog = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- svg-source:excalidraw -->\n${SVG}`
    await expect(
      writeExcalidrawDerivedSvg(root, { sourceRelPath: created.relPath, content: withProlog })
    ).resolves.toMatchObject({ relPath: derivedSvgRelPath(created.relPath) })
  })

  it('源路径越界或后缀不对时拒绝', async () => {
    for (const sourceRelPath of [
      'notes/0042-x.excalidraw',
      '../outside/0042-x.excalidraw',
      'assets/0042-x.png'
    ]) {
      await expect(
        writeExcalidrawDerivedSvg(root, { sourceRelPath, content: SVG })
      ).rejects.toMatchObject({ code: 'INVALID_OPERATION' })
    }
  })
})

describe('识别「这张 .svg 能不能编辑」', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'

  it('同名 .excalidraw 在 → 返回源画布路径', async () => {
    const created = await createExcalidrawDocument(root, { ownerNoteIndex: '0042' })
    await writeExcalidrawDerivedSvg(root, { sourceRelPath: created.relPath, content: SVG })
    const derived = derivedSvgRelPath(created.relPath)

    await expect(findExcalidrawSourceFor(root, derived)).resolves.toEqual({
      relPath: created.relPath,
      ownerNoteIndex: ''
    })
  })

  it('同名 .excalidraw 不在 → 普通图片（null）', async () => {
    await fs.mkdir(path.join(root, 'assets'), { recursive: true })
    await fs.writeFile(path.join(root, 'assets/0042-plain.svg'), SVG)
    await expect(findExcalidrawSourceFor(root, 'assets/0042-plain.svg')).resolves.toBeNull()
  })

  it('四位前缀缺失 / 不在 assets / 非 svg 一律 null，不抛错', async () => {
    for (const relPath of [
      'assets/plain.svg',
      'notes/0042-x.svg',
      '../outside/0042-x.svg',
      'assets/0042-x.png',
      ''
    ]) {
      await expect(findExcalidrawSourceFor(root, relPath)).resolves.toBeNull()
    }
  })
})
