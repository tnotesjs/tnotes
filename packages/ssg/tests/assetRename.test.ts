import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkspace } from '@tnotesjs/kb'
import { writeWritableAssetFixture } from '../../kb/tests/helpers/assetScanFixture'
import { buildSite } from '../src/site'

let root = ''
let journalDir = ''
let recycleDir = ''

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tnotes-ssg-asset-'))
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnotes-ssg-asset-journal-'))
  recycleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnotes-ssg-asset-recycle-'))
  await writeWritableAssetFixture(root)
  fs.writeFileSync(
    path.join(root, 'tnotes.json'),
    JSON.stringify({ base: '/fixture/', title: 'asset-rename' }, null, 2) + '\n'
  )
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(journalDir, { recursive: true, force: true })
  fs.rmSync(recycleDir, { recursive: true, force: true })
})

describe('SSG after asset rename and recycle', () => {
  it('rewrites note and mindmap URLs and does not copy recycle or journal', async () => {
    const ws = createWorkspace({ rootPath: root, assetStore: { journalDir, recycleDir } })
    const rename = await ws.assets.planRename({
      fromRelPath: 'assets/used.png',
      toRelPath: 'assets/renamed.png'
    })
    expect(rename.blockedReasons).toEqual([])
    expect((await ws.assets.applyPlan(rename)).status).toBe('applied')

    const recycle = await ws.assets.planRecycle({ relPaths: ['assets/idle.png'] })
    expect(recycle.blockedReasons).toEqual([])
    expect((await ws.assets.applyPlan(recycle)).status).toBe('applied')

    await buildSite(root)

    const dist = path.join(root, '.tnotes/dist')
    const note = fs.readFileSync(path.join(dist, 'notes/1.html'), 'utf8')
    expect(note).toContain('src="/fixture/assets/renamed.png"')
    expect(note).not.toContain('assets/used.png')
    expect(note).toContain('%2Fassets%2Fmindmap.png')
    expect(fs.existsSync(path.join(dist, 'assets/renamed.png'))).toBe(true)
    expect(fs.existsSync(path.join(dist, 'assets/used.png'))).toBe(false)
    expect(fs.existsSync(path.join(dist, 'assets/idle.png'))).toBe(false)
    expect(fs.existsSync(path.join(dist, 'assets/mindmap.png'))).toBe(true)

    const distListing = fs.readdirSync(dist, { recursive: true }).map(String)
    expect(
      distListing.some((item) => item.includes('asset-recycle') || item.includes('journal'))
    ).toBe(false)
    expect(recycleDir.startsWith(path.join(root, 'assets'))).toBe(false)
    expect(journalDir.startsWith(path.join(root, 'assets'))).toBe(false)
    expect(fs.existsSync(path.join(recycleDir, recycle.id, 'assets/idle.png'))).toBe(true)
  }, 120_000)
})
