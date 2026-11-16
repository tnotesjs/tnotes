import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  listDemoFolders,
  probeSidebarExtras,
  resolveDemoDirectory,
  selectDemoFolders
} from './kbDemos'

describe('selectDemoFolders', () => {
  it('keeps only 0001. name folders and sorts by the four-digit index', () => {
    expect(
      selectDemoFolders([
        '0002. 后',
        '001. 位数不够',
        '00010. 多一位',
        '0001.先',
        'readme.md',
        '0001. 先',
        '0003. 嵌套/内部'
      ]).map((entry) => entry.folder)
    ).toEqual(['0001. 先', '0002. 后'])
  })
})

describe('demos directories', () => {
  let root = ''

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true })
  })

  it('reports assets and demos only when those directories exist', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-demos-'))
    expect(await probeSidebarExtras(root)).toEqual({ hasAssets: false, hasDemos: false })
    await fs.writeFile(path.join(root, 'assets'), 'not a directory')
    await fs.mkdir(path.join(root, 'demos'))
    expect(await probeSidebarExtras(root)).toEqual({ hasAssets: false, hasDemos: true })
    await fs.rm(path.join(root, 'assets'))
    await fs.mkdir(path.join(root, 'assets'))
    expect(await probeSidebarExtras(root)).toEqual({ hasAssets: true, hasDemos: true })
  })

  it('lists only direct compliant folders and resolves the IDE target', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-demos-'))
    await fs.mkdir(path.join(root, 'demos', '0002. 后'), { recursive: true })
    await fs.mkdir(path.join(root, 'demos', '0001. 先', 'inner'), { recursive: true })
    await fs.mkdir(path.join(root, 'demos', 'notes'))
    await fs.writeFile(path.join(root, 'demos', '0004. 文件.txt'), 'x')
    expect((await listDemoFolders(root)).map((entry) => entry.folder)).toEqual([
      '0001. 先',
      '0002. 后'
    ])
    expect(await resolveDemoDirectory(root, '')).toBe(path.join(root, 'demos'))
    expect(await resolveDemoDirectory(root, '0002. 后')).toBe(path.join(root, 'demos', '0002. 后'))
    await expect(resolveDemoDirectory(root, '../assets')).rejects.toThrow('不是合规')
    await expect(resolveDemoDirectory(root, 'notes')).rejects.toThrow('不是合规')
  })
})
