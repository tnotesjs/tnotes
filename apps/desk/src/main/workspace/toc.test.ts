import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspace } from '@tnotesjs/kb'

import { deleteToc, previewDelete } from './toc'
import type { KnowledgeBaseHandle } from './types'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

async function makeHandle(): Promise<KnowledgeBaseHandle> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-toc-'))
  cleanups.push(async () => fs.rm(rootPath, { recursive: true, force: true }))
  await fs.mkdir(path.join(rootPath, 'notes'), { recursive: true })
  await fs.writeFile(path.join(rootPath, 'tnotes.json'), '{ "title": "测试库" }\n')
  await fs.writeFile(path.join(rootPath, 'TOC.md'), '- [ ] 0001. 第一篇\n- [ ] 0002. 第二篇\n')
  await fs.writeFile(
    path.join(rootPath, 'notes', '0001. 第一篇.md'),
    '---\nid: note-uuid-1\n---\n\n# 第一篇\n'
  )
  await fs.writeFile(
    path.join(rootPath, 'notes', '0002. 第二篇.md'),
    '---\nid: note-uuid-2\n---\n\n# 第二篇\n'
  )
  const workspace = createWorkspace({ rootPath })
  return {
    id: 'kb-test',
    name: 'TNotes.test',
    rootPath,
    workspace,
    snapshot: await workspace.scan()
  }
}

const noopEffects = {
  markInternalWrites: () => {},
  emitChanged: () => {}
}

describe('deleteToc 快照版本守卫', () => {
  it('预览后知识库被改动时拒绝删除，不误删别的子树', async () => {
    const handle = await makeHandle()
    const preview = await previewDelete(handle, 'kb-test', {
      type: 'note',
      noteUuid: 'note-uuid-1'
    })

    // 模拟外部改动：新增一篇笔记后重新扫描，快照版本随之变化
    await fs.writeFile(
      path.join(handle.rootPath, 'notes', '0003. 外部新增.md'),
      '---\nid: note-uuid-3\n---\n\n# 外部新增\n'
    )
    await fs.writeFile(
      path.join(handle.rootPath, 'TOC.md'),
      '- [ ] 0001. 第一篇\n- [ ] 0002. 第二篇\n- [ ] 0003. 外部新增\n'
    )
    handle.snapshot = await handle.workspace.scan()

    await expect(
      deleteToc(
        handle,
        {
          knowledgeBaseId: 'kb-test',
          entry: { type: 'note', noteUuid: 'note-uuid-1' },
          expectedSnapshotRevision: preview.snapshotRevision
        },
        noopEffects
      )
    ).rejects.toThrow(/已被外部修改/)

    expect(
      await fs.readFile(path.join(handle.rootPath, 'notes', '0001. 第一篇.md'), 'utf8')
    ).toMatch(/第一篇/)
  })

  it('版本一致时照常删除', async () => {
    const handle = await makeHandle()
    const preview = await previewDelete(handle, 'kb-test', {
      type: 'note',
      noteUuid: 'note-uuid-1'
    })
    const detail = await deleteToc(
      handle,
      {
        knowledgeBaseId: 'kb-test',
        entry: { type: 'note', noteUuid: 'note-uuid-1' },
        expectedSnapshotRevision: preview.snapshotRevision
      },
      noopEffects
    )
    expect(detail.toc.some((node) => node.type === 'note' && node.noteIndex === '0001')).toBe(false)
    await expect(
      fs.readFile(path.join(handle.rootPath, 'notes', '0001. 第一篇.md'), 'utf8')
    ).rejects.toThrow()
  })

  it('批量删除只去掉勾中的笔记，子笔记留在目录里', async () => {
    const handle = await makeHandle()
    await fs.writeFile(
      path.join(handle.rootPath, 'TOC.md'),
      '- [ ] 0001. 第一篇\n  - [ ] 0002. 第二篇\n'
    )
    handle.snapshot = await handle.workspace.scan()
    const preview = await previewDelete(handle, 'kb-test', {
      type: 'notes',
      noteUuids: ['note-uuid-1']
    })
    expect(preview.notes.map((note) => note.index)).toEqual(['0001'])
    await deleteToc(
      handle,
      {
        knowledgeBaseId: 'kb-test',
        entry: preview.entry,
        expectedSnapshotRevision: preview.snapshotRevision
      },
      noopEffects
    )
    const toc = await fs.readFile(path.join(handle.rootPath, 'TOC.md'), 'utf8')
    expect(toc).toBe('- [ ] 0002. 第二篇\n')
    await expect(
      fs.readFile(path.join(handle.rootPath, 'notes', '0001. 第一篇.md'), 'utf8')
    ).rejects.toThrow()
    expect(await fs.readFile(path.join(handle.rootPath, 'notes', '0002. 第二篇.md'), 'utf8')).toMatch(
      /第二篇/
    )
  })
})
