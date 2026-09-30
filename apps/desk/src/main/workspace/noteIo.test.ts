import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspace } from '@tnotesjs/kb'

import { toNoteDocument } from './dto'
import {
  readNote,
  resolveNoteAsset,
  resolveNoteIndex,
  saveNote,
  updateNoteConfig,
  writeLocalAttachment
} from './noteIo'
import type { KnowledgeBaseHandle } from './types'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

async function makeHandle(config: Record<string, unknown> = {}): Promise<KnowledgeBaseHandle> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-kb-'))
  cleanups.push(async () => fs.rm(rootPath, { recursive: true, force: true }))
  await fs.mkdir(path.join(rootPath, 'notes'), { recursive: true })
  await fs.writeFile(
    path.join(rootPath, 'tnotes.json'),
    `${JSON.stringify({ title: '测试库', ...config })}\n`
  )
  await fs.writeFile(path.join(rootPath, 'TOC.md'), '- [ ] 0001. 第一篇\n- [x] 0002. 第二篇\n')
  await fs.writeFile(path.join(rootPath, 'notes', '0001. 第一篇.md'), '# 第一篇\n\n正文。\n')
  await fs.writeFile(
    path.join(rootPath, 'notes', '0002. 第二篇.md'),
    '---\nid: note-uuid-2\n---\n\n# 第二篇\n'
  )
  const workspace = createWorkspace({ rootPath })
  const handle: KnowledgeBaseHandle = {
    id: 'kb-test',
    name: 'TNotes.test',
    rootPath,
    workspace,
    snapshot: await workspace.scan()
  }
  return handle
}

const noopEffects = {
  markInternalWrites: () => {},
  emitChanged: () => {}
}

/**
 * 一段「处处不合 Prettier 内置默认」的正文。保存不再整篇重排，这些字节必须原样落盘。
 */
const STYLED_BODY = [
  '---',
  'id: note-uuid-1',
  '---',
  '',
  '* 甲',
  '',
  '***',
  '',
  '```js',
  'const a  =  1',
  "const s = 'x'",
  '```',
  '',
  '正文。',
  ''
].join('\n')

describe('desk noteIo over @tnotesjs/kb', () => {
  it('resolves renderer uuid (frontmatter id) to the note index', async () => {
    const handle = await makeHandle()
    expect(resolveNoteIndex(handle, 'note-uuid-2')).toBe('0002')
    // 无 id 的笔记回退到索引号
    expect(resolveNoteIndex(handle, '0001')).toBe('0001')
    expect(() => resolveNoteIndex(handle, 'missing')).toThrowError()
  })

  it('reads a note document with the new single-file shape', async () => {
    const handle = await makeHandle()
    const doc = await readNote(handle, 'note-uuid-2')
    expect(doc.fileName).toBe('0002. 第二篇.md')
    expect(doc.relPath).toBe('notes/0002. 第二篇.md')
    expect(doc.filePath).toBe(path.join(handle.rootPath, 'notes', '0002. 第二篇.md'))
    expect(doc.config.done).toBe(true)
    expect(doc.content).toContain('# 第二篇')
  })

  it('saves note content with revision conflict detection', async () => {
    const handle = await makeHandle()
    const doc = await readNote(handle, '0001')
    const saved = await saveNote(
      handle,
      {
        knowledgeBaseId: handle.id,
        noteUuid: '0001',
        content: '# 第一篇\n\n改过的正文。\n',
        expectedRevision: doc.revision
      },
      noopEffects
    )
    expect(saved.note.content).toContain('改过的正文')
    await expect(
      saveNote(
        handle,
        {
          knowledgeBaseId: handle.id,
          noteUuid: '0001',
          content: 'stale',
          expectedRevision: doc.revision
        },
        noopEffects
      )
    ).rejects.toThrowError(/外部修改/)
  })

  it('strips unknown frontmatter keys on save and keeps the snapshot id', async () => {
    const handle = await makeHandle()
    const doc = await readNote(handle, 'note-uuid-2')
    const saved = await saveNote(
      handle,
      {
        knowledgeBaseId: handle.id,
        noteUuid: 'note-uuid-2',
        content: [
          '---',
          'id: should-not-overwrite',
          'description: 新描述',
          'draft: true',
          'title: 忽略我',
          '---',
          '',
          '# 第二篇',
          '',
          '正文',
          ''
        ].join('\n'),
        expectedRevision: doc.revision
      },
      noopEffects
    )
    expect(saved.note.content).toBe(
      ['---', 'id: note-uuid-2', 'description: 新描述', '---', '', '# 第二篇', '', '正文', ''].join(
        '\n'
      )
    )
    expect(saved.note.content).not.toContain('draft')
    expect(saved.note.content).not.toContain('title:')
  })

  it('保存不整篇重排，未编辑的字节原样落盘', async () => {
    const handle = await makeHandle()
    const doc = await readNote(handle, '0001')
    const saved = await saveNote(
      handle,
      {
        knowledgeBaseId: handle.id,
        noteUuid: '0001',
        content: STYLED_BODY,
        expectedRevision: doc.revision
      },
      noopEffects
    )

    expect(saved.note.content).toBe(STYLED_BODY)
    await expect(
      fs.readFile(path.join(handle.rootPath, 'notes', '0001. 第一篇.md'), 'utf8')
    ).resolves.toBe(STYLED_BODY)
  })

  it('tnotes.json 里的 prettier 被忽略，正文仍原样落盘', async () => {
    const handle = await makeHandle({ prettier: true })
    const doc = await readNote(handle, '0001')
    const saved = await saveNote(
      handle,
      {
        knowledgeBaseId: handle.id,
        noteUuid: '0001',
        content: STYLED_BODY,
        expectedRevision: doc.revision
      },
      noopEffects
    )

    expect(saved.note.content).toBe(STYLED_BODY)
    expect(saved.note.content).toContain('* 甲')
    expect(saved.note.content).not.toContain('- 甲')
  })

  it('names pasted local assets with the note index and timestamp', async () => {
    const handle = await makeHandle()
    const result = await writeLocalAttachment(
      handle,
      {
        knowledgeBaseId: handle.id,
        noteUuid: '0001',
        fileName: 'clip.PNG',
        data: new Uint8Array([1, 2, 3])
      },
      noopEffects
    )
    expect(result.markdownPath).toMatch(
      /^\.\.\/assets\/0001-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/
    )
  })

  it('resolves kb-level asset references and rejects traversal', async () => {
    const handle = await makeHandle()
    await fs.mkdir(path.join(handle.rootPath, 'assets'), { recursive: true })
    await fs.writeFile(path.join(handle.rootPath, 'assets', 'pic.png'), 'png')
    await expect(resolveNoteAsset(handle, '../assets/pic.png')).resolves.toBe(
      path.join(handle.rootPath, 'assets', 'pic.png')
    )
    await expect(resolveNoteAsset(handle, '../outside/pic.png')).rejects.toThrowError()
    await expect(resolveNoteAsset(handle, '../assets/pic.exe')).rejects.toThrowError()
  })

  it('拒绝 assets 内的路径穿越与指向库外的符号链接', async () => {
    const handle = await makeHandle()
    await fs.mkdir(path.join(handle.rootPath, 'assets'), { recursive: true })
    await fs.writeFile(path.join(handle.rootPath, 'assets', 'pic.png'), 'png')
    // 库根下的封面：归一化后会逃出 assets/
    await fs.writeFile(path.join(handle.rootPath, 'cover.png'), 'png')
    await expect(resolveNoteAsset(handle, '../assets/../cover.png')).rejects.toThrowError(
      /越界|不支持/
    )

    // assets 里的符号链接指向库外文件
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-outside-'))
    cleanups.push(async () => fs.rm(outside, { recursive: true, force: true }))
    await fs.writeFile(path.join(outside, 'secret.png'), 'png')
    await fs.symlink(
      path.join(outside, 'secret.png'),
      path.join(handle.rootPath, 'assets', 'link.png')
    )
    await expect(resolveNoteAsset(handle, '../assets/link.png')).rejects.toThrowError(/越界/)

    // 库内正常文件不受影响
    await expect(resolveNoteAsset(handle, './assets/pic.png')).resolves.toBe(
      path.join(handle.rootPath, 'assets', 'pic.png')
    )
  })

  it('maps note documents without leaking legacy fields', async () => {
    const handle = await makeHandle()
    const doc = await readNote(handle, '0001')
    const dto = toNoteDocument(handle, {
      ...(await handle.workspace.notes.read('0001'))
    })
    expect(dto).not.toHaveProperty('directoryPath')
    expect(dto).not.toHaveProperty('readmePath')
    expect(dto).not.toHaveProperty('configPath')
    expect(doc.dirName).toBe('0001. 第一篇')
  })
})

describe('updateNoteConfig 的 done 同步', () => {
  it('done 写入 TOC 并反映到返回的快照，两个文件都标记为内部写入', async () => {
    const handle = await makeHandle()
    const marked: string[] = []
    const effects = {
      markInternalWrites: (_rootPath: string, files: Array<{ path: string }>) => {
        marked.push(...files.map((file) => file.path))
      },
      emitChanged: () => {}
    }

    const before = await readNote(handle, '0001')
    const result = await updateNoteConfig(
      handle,
      {
        knowledgeBaseId: 'kb-test',
        noteUuid: '0001',
        expectedRevision: before.revision,
        updates: { done: true }
      } as never,
      effects
    )

    const noteNode = result.knowledgeBase.toc.find(
      (node) => node.type === 'note' && node.noteIndex === '0001'
    )
    expect(noteNode && noteNode.type === 'note' ? noteNode.completed : null).toBe(true)
    expect(await fs.readFile(path.join(handle.rootPath, 'TOC.md'), 'utf8')).toMatch(/- \[x\] 0001/)
    expect(marked).toContain('TOC.md')
    expect(handle.snapshot.notes.find((note) => note.index === '0001')?.done).toBe(true)
  })
})
