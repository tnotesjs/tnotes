import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { README_NOTE_UUID } from '../../shared/contracts'
import {
  downloadRemoteImage,
  loadImageBytes,
  MAX_REMOTE_IMAGE_BYTES,
  referencesAsset,
  releaseLocalAsset
} from './imageTransfer'

import type { KnowledgeBaseHandle } from './types'

function response(body: Uint8Array, headers: Record<string, string>, status = 200): Response {
  return new Response(status === 404 ? null : new Blob([body as Uint8Array<ArrayBuffer>]), {
    status,
    headers
  })
}

describe('downloadRemoteImage', () => {
  it('keeps the URL file name and bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const image = await downloadRemoteImage(
      'https://cdn.example.com/a/%E5%9B%BE.png?x=1',
      async () => response(bytes, { 'content-type': 'image/png' })
    )
    expect(image.fileName).toBe('图.png')
    expect([...image.data]).toEqual([1, 2, 3])
  })

  it('adds an extension from the MIME type when the URL has none', async () => {
    const image = await downloadRemoteImage('https://example.com/raw/abc', async () =>
      response(new Uint8Array([1]), { 'content-type': 'image/webp; charset=binary' })
    )
    expect(image.fileName).toBe('abc.webp')
  })

  it('rejects non-images, oversized bodies, failed responses and other schemes', async () => {
    await expect(
      downloadRemoteImage('https://example.com/x.png', async () =>
        response(new Uint8Array([1]), { 'content-type': 'text/html' })
      )
    ).rejects.toThrow('不是图片')
    await expect(
      downloadRemoteImage('https://example.com/x.png', async () =>
        response(new Uint8Array([1]), {
          'content-type': 'image/png',
          'content-length': String(MAX_REMOTE_IMAGE_BYTES + 1)
        })
      )
    ).rejects.toThrow('25 MB')
    await expect(
      downloadRemoteImage('https://example.com/x.png', async () =>
        response(new Uint8Array(), { 'content-type': 'image/png' }, 404)
      )
    ).rejects.toThrow('HTTP 404')
    const fetchImpl = vi.fn()
    await expect(downloadRemoteImage('file:///etc/passwd', fetchImpl)).rejects.toThrow('http')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('loadImageBytes', () => {
  it('reads assets from disk, decodes data: URIs and downloads online images', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tn-bytes-'))
    try {
      await writeFile(path.join(dir, 'a b.png'), 'local')
      const resolveLocal = vi.fn(async (src: string) => path.join(dir, path.basename(src)))
      const fetchImpl = vi.fn(async () =>
        response(new Uint8Array([9]), { 'content-type': 'image/gif' })
      )

      const local = await loadImageBytes('../assets/a%20b.png', { resolveLocal, fetchImpl })
      expect(resolveLocal).toHaveBeenCalledWith('../assets/a b.png')
      expect(local.fileName).toBe('a b.png')
      expect(Buffer.from(local.data).toString()).toBe('local')

      const inline = await loadImageBytes('data:image/svg+xml,%3Csvg%2F%3E', {
        resolveLocal,
        fetchImpl
      })
      expect(inline.fileName).toBe('image.svg')
      expect(Buffer.from(inline.data).toString()).toBe('<svg/>')

      const remote = await loadImageBytes('https://e.com/x.gif', { resolveLocal, fetchImpl })
      expect(remote.fileName).toBe('x.gif')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('referencesAsset', () => {
  it('matches ../assets/, ./assets/ and URL-encoded spellings', () => {
    expect(referencesAsset('![](../assets/a.png)', 'a.png')).toBe(true)
    expect(referencesAsset('![](./assets/a.png)', 'a.png')).toBe(true)
    expect(referencesAsset('![](../assets/a%20b.png)', 'a b.png')).toBe(true)
    expect(referencesAsset('![](../assets/ab.png)', 'a.png')).toBe(false)
  })
})

describe('releaseLocalAsset', () => {
  let root = ''

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = ''
  })

  async function kb(files: Record<string, string>): Promise<KnowledgeBaseHandle> {
    root = await mkdtemp(path.join(tmpdir(), 'tn-release-'))
    await mkdir(path.join(root, 'notes'))
    await mkdir(path.join(root, 'assets'))
    await writeFile(path.join(root, 'assets', 'pic.png'), 'png')
    for (const [rel, content] of Object.entries(files)) {
      await writeFile(path.join(root, rel), content)
    }
    return {
      id: 'kb',
      name: 'kb',
      rootPath: root,
      lastCommitAt: null,
      workspace: { scan: async () => ({ notes: [] }) },
      snapshot: {
        notes: [
          { index: '0001', relPath: 'notes/0001. 甲.md', frontmatter: { id: 'uuid-1' } },
          { index: '0002', relPath: 'notes/0002. 乙.md', frontmatter: { id: 'uuid-2' } }
        ]
      }
    } as unknown as KnowledgeBaseHandle
  }

  const effects = () => ({ markInternalWrites: vi.fn(), emitChanged: vi.fn() })
  const exists = (rel: string) =>
    access(path.join(root, rel)).then(
      () => true,
      () => false
    )

  it('deletes when no note references the file, judging the current note by its unsaved content', async () => {
    const handle = await kb({
      'notes/0001. 甲.md': '![](../assets/pic.png)',
      'notes/0002. 乙.md': '无图'
    })
    const sideEffects = effects()
    const result = await releaseLocalAsset(
      handle,
      {
        knowledgeBaseId: 'kb',
        noteUuid: 'uuid-1',
        src: '../assets/pic.png',
        content: '![](https://cdn/x.png)'
      },
      sideEffects
    )
    expect(result).toEqual({ deleted: true })
    expect(await exists('assets/pic.png')).toBe(false)
    expect(sideEffects.markInternalWrites).toHaveBeenCalledWith(root, [{ path: 'assets/pic.png' }])
    expect(await readFile(path.join(root, 'notes/0001. 甲.md'), 'utf8')).toContain(
      '../assets/pic.png'
    )
  })

  it('keeps the file when another note or the README still references it', async () => {
    const other = await kb({ 'notes/0002. 乙.md': '![](../assets/pic.png)' })
    expect(
      await releaseLocalAsset(
        other,
        { knowledgeBaseId: 'kb', noteUuid: 'uuid-1', src: '../assets/pic.png', content: '' },
        effects()
      )
    ).toEqual({ deleted: false, reason: 'referenced' })
    expect(await exists('assets/pic.png')).toBe(true)
    await rm(root, { recursive: true, force: true })

    const readme = await kb({ 'README.md': '![](./assets/pic.png)', 'notes/0002. 乙.md': '' })
    expect(
      await releaseLocalAsset(
        readme,
        { knowledgeBaseId: 'kb', noteUuid: 'uuid-1', src: '../assets/pic.png', content: '' },
        effects()
      )
    ).toEqual({ deleted: false, reason: 'referenced' })
  })

  it('keeps the file when the current content still references it elsewhere', async () => {
    const handle = await kb({})
    expect(
      await releaseLocalAsset(
        handle,
        {
          knowledgeBaseId: 'kb',
          noteUuid: README_NOTE_UUID,
          src: './assets/pic.png',
          content: '![](./assets/pic.png)'
        },
        effects()
      )
    ).toEqual({ deleted: false, reason: 'referenced' })
  })

  it('never deletes when the scan cannot be trusted', async () => {
    const handle = await kb({})
    await rm(path.join(root, 'notes'), { recursive: true })
    expect(
      await releaseLocalAsset(
        handle,
        { knowledgeBaseId: 'kb', noteUuid: 'uuid-1', src: '../assets/pic.png', content: '' },
        effects()
      )
    ).toEqual({ deleted: false, reason: 'scan-failed' })
    expect(await exists('assets/pic.png')).toBe(true)
  })
})
