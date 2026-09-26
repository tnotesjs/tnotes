import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkspace } from '../src/workspace'
import { scanKnowledgeBase } from '../src/scanner'
import { PNG_1X1 } from './helpers/assetScanFixture'

let root = ''

async function write(relPath: string, content: string): Promise<void> {
  const full = path.join(root, relPath)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

async function read(relPath: string): Promise<string> {
  return fs.readFile(path.join(root, relPath), 'utf8')
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tnotes-kb-'))
  await write(
    'TOC.md',
    `- 分组 A
  - [x] 0001. 第一篇
  - [ ] 0002. 第二篇
- 分组 B
  - [ ] 0003. 第三篇
`
  )
  await write('notes/0001. 第一篇.md', `---\nid: uuid-1\ndescription: d1\n---\n\n# 第一篇\n`)
  await write('notes/0002. 第二篇.md', `# 第二篇\n`)
  await write('notes/0003. 第三篇.md', `---\nid: uuid-3\n---\n\n# 第三篇\n`)
  await write('tnotes.json', `{\n  "title": "测试库",\n  "base": "/test/"\n}\n`)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('scan', () => {
  it('joins files with TOC entries', async () => {
    const snapshot = await scanKnowledgeBase(root)
    expect(snapshot.notes).toHaveLength(3)
    const first = snapshot.notes.find((n) => n.index === '0001')!
    expect(first.done).toBe(true)
    expect(first.groupPath).toEqual(['分组 A'])
    expect(first.frontmatter).toEqual({ id: 'uuid-1', description: 'd1' })
    expect(snapshot.config).toMatchObject({ title: '测试库', base: '/test/' })
    expect(snapshot.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0)
  })

  it('reports drift between files and TOC', async () => {
    await write('notes/0004. 游离笔记.md', `# 游离\n`)
    await fs.rm(path.join(root, 'notes/0003. 第三篇.md'))
    const snapshot = await scanKnowledgeBase(root)
    const codes = snapshot.diagnostics.map((d) => d.code)
    expect(codes).toContain('file-missing-from-toc')
    expect(codes).toContain('toc-entry-missing-file')
  })

  it('reports duplicate indexes and missing ids', async () => {
    await write('notes/0001. 重复.md', `# 重复\n`)
    const snapshot = await scanKnowledgeBase(root)
    const codes = snapshot.diagnostics.map((d) => d.code)
    expect(codes).toContain('duplicate-index')
    expect(codes).toContain('missing-note-id') // 0002 has no id
  })

  it('tolerates a missing tnotes.json', async () => {
    await fs.rm(path.join(root, 'tnotes.json'))
    const snapshot = await scanKnowledgeBase(root)
    expect(snapshot.config).toEqual({})
  })
})

describe('notes', () => {
  it('reads a note with parsed frontmatter', async () => {
    const ws = createWorkspace({ rootPath: root })
    const doc = await ws.notes.read('0001')
    expect(doc.title).toBe('第一篇')
    expect(doc.body.trim()).toBe('# 第一篇')
    expect(doc.frontmatter.id).toBe('uuid-1')
    expect(doc.revision).toMatch(/^[0-9a-f]{64}$/)
  })

  it('saves with optimistic revision checks', async () => {
    const ws = createWorkspace({ rootPath: root })
    const doc = await ws.notes.read('0002')
    await expect(
      ws.notes.save({ index: '0002', content: '# x\n', expectedRevision: 'bad' })
    ).rejects.toThrow('外部修改')
    const saved = await ws.notes.save({
      index: '0002',
      content: `# 第二篇\n\n新内容\n`,
      expectedRevision: doc.revision
    })
    expect(saved.value.body).toContain('新内容')
    expect(await read('notes/0002. 第二篇.md')).toContain('新内容')
  })

  it('creates a note: allocates the next index, writes file + TOC line', async () => {
    const ws = createWorkspace({ rootPath: root })
    const { value: doc, changedFiles } = await ws.notes.create({
      title: '全新笔记',
      placement: { type: 'group', groupPath: ['分组 A'], placement: 'inside' }
    })
    expect(doc.index).toBe('0004')
    expect(doc.frontmatter.id).toBeTruthy()
    expect(doc.content).toContain('# 0004. 全新笔记')
    expect(changedFiles.map((f) => f.kind).sort()).toEqual(['created', 'updated'])

    const toc = await read('TOC.md')
    expect(toc).toContain('  - [ ] 0004. 全新笔记')
    const onDisk = await read('notes/0004. 全新笔记.md')
    expect(onDisk).toMatch(/^---\nid: [0-9a-f-]{36}\n---/)
  })

  it('creates several root notes in one write and keeps them in order', async () => {
    const ws = createWorkspace({ rootPath: root })
    const { value: docs } = await ws.notes.createMany({
      title: 'new',
      count: 2,
      placement: { type: 'root', placement: 'start' }
    })
    expect(docs.map((doc) => doc.index)).toEqual(['0004', '0005'])
    expect(docs[0]?.content).toContain('# 0004. new')
    const toc = (await read('TOC.md')).trimEnd().split('\n')
    expect(toc[0]).toBe('- [ ] 0004. new')
    expect(toc[1]).toBe('- [ ] 0005. new')
    await expect(ws.notes.createMany({ title: 'new', count: 0 })).rejects.toThrow('999')
  })

  it('refuses a batch that would pass index 9999', async () => {
    const ws = createWorkspace({ rootPath: root })
    await write('notes/9999. 末号.md', `---\nid: uuid-last\n---\n\n# 末号\n`)
    await expect(ws.notes.createMany({ title: 'new', count: 1 })).rejects.toThrow('编号已用尽')
  })

  it('creates a root-level note by default', async () => {
    const ws = createWorkspace({ rootPath: root })
    await ws.notes.create({ title: '末尾' })
    const toc = (await read('TOC.md')).trimEnd().split('\n')
    expect(toc[toc.length - 1]).toBe('- [ ] 0004. 末尾')
  })

  it('renames a note: file renamed, TOC title updated', async () => {
    const ws = createWorkspace({ rootPath: root })
    const { value, changedFiles } = await ws.notes.rename({
      index: '0002',
      title: '第二篇（改）'
    })
    expect(value.fileName).toBe('0002. 第二篇（改）.md')
    expect(changedFiles[0]).toMatchObject({
      kind: 'renamed',
      previousPath: 'notes/0002. 第二篇.md'
    })
    expect(await read('notes/0002. 第二篇（改）.md')).toBe('# 第二篇\n')
    expect(await read('TOC.md')).toContain('- [ ] 0002. 第二篇（改）')
  })

  it('reindexes a note without colliding, and moves its assets', async () => {
    const ws = createWorkspace({ rootPath: root })
    await write('notes/0002. 第二篇.md', `---\nid: uuid-2\n---\n\n# 0002. 第二篇\n\n![](../assets/0002-pic.png)\n`)
    await write('assets/0002-pic.png', 'png')
    await write('notes/0001. 第一篇.md', `# 第一篇\n\n![](../assets/0002-pic.png)\n`)
    const { value } = await ws.notes.reindex({ index: '0002', nextIndex: '42' })
    expect(value.index).toBe('0042')
    expect(value.content).toContain('# 0042. 第二篇')
    expect(value.content).toContain('../assets/0042-pic.png')
    expect(await read('notes/0042. 第二篇.md')).toContain('# 0042. 第二篇')
    expect(await read('assets/0042-pic.png')).toBe('png')
    await expect(read('notes/0002. 第二篇.md')).rejects.toThrow()
    await expect(read('assets/0002-pic.png')).rejects.toThrow()
    expect(await read('TOC.md')).toContain('- [ ] 0042. 第二篇')
    expect(await read('TOC.md')).not.toContain('0002. 第二篇')
    expect(await read('notes/0001. 第一篇.md')).toContain('../assets/0042-pic.png')
    await expect(ws.notes.reindex({ index: '0042', nextIndex: '0001' })).rejects.toThrow('已被占用')
    await expect(ws.notes.reindex({ index: '0042', nextIndex: '0' })).rejects.toThrow('0001 到 9999')
    const same = await ws.notes.reindex({ index: '0042', nextIndex: '0042' })
    expect(same.changedFiles).toEqual([])
  })

  it('removes a childless note', async () => {
    const ws = createWorkspace({ rootPath: root })
    await ws.notes.remove('0003')
    await expect(read('notes/0003. 第三篇.md')).rejects.toThrow()
    expect(await read('TOC.md')).not.toContain('0003')
  })

  it('refuses to remove a note that has children in the TOC', async () => {
    await write(
      'TOC.md',
      `- [ ] 0001. 第一篇
  - [ ] 0002. 第二篇
`
    )
    const ws = createWorkspace({ rootPath: root })
    await expect(ws.notes.remove('0001')).rejects.toThrow('子笔记')
  })

  it('updates frontmatter without touching the body', async () => {
    const ws = createWorkspace({ rootPath: root })
    const { value } = await ws.notes.setFrontmatter({
      index: '0002',
      updates: { description: '新增描述' }
    })
    expect(value.frontmatter).toMatchObject({ description: '新增描述' })
    expect(value.body).toContain('# 第二篇')
  })
})

describe('toc', () => {
  it('moves a note into a group', async () => {
    const ws = createWorkspace({ rootPath: root })
    const { value: snapshot } = await ws.toc.move({
      source: { type: 'note', index: '0003' },
      target: { type: 'note', index: '0001' },
      placement: 'after'
    })
    const note = snapshot.notes.find((n) => n.index === '0003')!
    expect(note.groupPath).toEqual(['分组 A'])
    const toc = await read('TOC.md')
    expect(toc.indexOf('0001')).toBeLessThan(toc.indexOf('0003'))
    expect(toc.indexOf('0003')).toBeLessThan(toc.indexOf('0002'))
  })

  it('creates, renames and removes groups', async () => {
    const ws = createWorkspace({ rootPath: root })
    await ws.toc.createGroup({ title: '新分组' })
    expect(await read('TOC.md')).toContain('- 新分组')

    await ws.toc.renameGroup({ groupPath: ['新分组'], title: '改名分组' })
    expect(await read('TOC.md')).toContain('- 改名分组')

    const { changedFiles } = await ws.toc.removeEntry({
      type: 'group',
      groupPath: ['分组 B']
    })
    expect(await read('TOC.md')).not.toContain('分组 B')
    expect(changedFiles.some((f) => f.kind === 'deleted' && f.path.includes('0003'))).toBe(true)
    await expect(read('notes/0003. 第三篇.md')).rejects.toThrow()
  })

  it('removes several notes at once and promotes the child that stays', async () => {
    await write(
      'TOC.md',
      `- 分组 A
  - [ ] 0001. 第一篇
    - [ ] 0002. 第二篇
- 分组 B
  - [ ] 0003. 第三篇
`
    )
    const ws = createWorkspace({ rootPath: root })
    const { changedFiles } = await ws.toc.removeNotes(['0001', '0003'])
    const toc = await read('TOC.md')
    expect(toc).toBe(`- 分组 A
  - [ ] 0002. 第二篇
- 分组 B
`)
    await expect(read('notes/0001. 第一篇.md')).rejects.toThrow()
    await expect(read('notes/0003. 第三篇.md')).rejects.toThrow()
    expect(await read('notes/0002. 第二篇.md')).toContain('# 第二篇')
    expect(changedFiles.filter((file) => file.kind === 'deleted')).toHaveLength(2)
    const snapshot = await ws.scan()
    expect(snapshot.notes.map((note) => note.index)).toEqual(['0002'])
    expect(snapshot.notes[0]?.groupPath).toEqual(['分组 A'])
    await expect(ws.toc.removeNotes([])).rejects.toThrow('没有要删除的笔记')
    await expect(ws.toc.removeNotes(['0009'])).rejects.toThrow('未找到笔记: 0009')
    expect(await read('notes/0002. 第二篇.md')).toContain('# 第二篇')
  })

  it('sets done state via the checkbox', async () => {
    const ws = createWorkspace({ rootPath: root })
    const { value: snapshot } = await ws.toc.setDone({ index: '0002', done: true })
    expect(snapshot.notes.find((n) => n.index === '0002')!.done).toBe(true)
    expect(await read('TOC.md')).toContain('- [x] 0002. 第二篇')
  })
})

describe('assets', () => {
  it('adds assets with deduped names and markdown paths', async () => {
    const ws = createWorkspace({ rootPath: root })
    const a = await ws.assets.add({ fileName: 'pic.png', data: new Uint8Array([1]) })
    const b = await ws.assets.add({ fileName: 'pic.png', data: new Uint8Array([2]) })
    expect(a.markdownPath).toBe('../assets/pic.png')
    expect(b.markdownPath).toBe('../assets/pic-1.png')
    expect((await ws.assets.list()).map((x) => x.name)).toEqual(['pic-1.png', 'pic.png'])
  })

  it('collects unreferenced assets and deletes on demand', async () => {
    const ws = createWorkspace({ rootPath: root })
    await ws.assets.add({ fileName: 'used.png', data: new Uint8Array([1]) })
    await ws.assets.add({ fileName: 'orphan.png', data: new Uint8Array([1]) })
    await ws.notes.save({
      index: '0002',
      content: `# 第二篇\n\n![x](../assets/used.png)\n`
    })
    const dry = await ws.assets.gc()
    expect(dry.unreferenced).toEqual(['assets/orphan.png'])
    expect(dry.deleted).toEqual([])
    const done = await ws.assets.gc({ delete: true })
    expect(done.deleted).toEqual(['assets/orphan.png'])
    expect((await ws.assets.list()).map((x) => x.name)).toEqual(['used.png'])
  })

  it('reuses same-note same-bytes attachments and keeps cross-note copies', async () => {
    const ws = createWorkspace({ rootPath: root })
    const data = new Uint8Array(PNG_1X1)
    const first = await ws.assets.add({ fileName: '0002-paste.png', data })
    const again = await ws.assets.add({ fileName: '0002-again.png', data })
    const otherNote = await ws.assets.add({ fileName: '0003-paste.png', data })
    expect(first.reused).toBe(false)
    expect(again.reused).toBe(true)
    expect(again.relPath).toBe(first.relPath)
    expect(otherNote.reused).toBe(false)
    expect(otherNote.relPath).not.toBe(first.relPath)
  })
})

describe('config', () => {
  it('reads and updates tnotes.json, preserving unknown keys', async () => {
    const ws = createWorkspace({ rootPath: root })
    await write('tnotes.json', `{\n  "title": "旧",\n  "custom": 1\n}\n`)
    const { value } = await ws.config.set({ title: '新', base: undefined })
    expect(value).toEqual({ title: '新', custom: 1 })
    expect(JSON.parse(await read('tnotes.json'))).toEqual({ title: '新', custom: 1 })
  })
})
