// @vitest-environment happy-dom
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { updateSwiperSlideAttrs } from '../editor/markdown/swiperSlides'
import { tableImageChange } from './cards'
import { imageAt, imageSrcChange, markdownImageDestination } from './images'
import {
  localAssetSrc,
  isRemoteImageSrc,
  runImageMenuAction,
  type ImageMenuState
} from './imageMenu'
import { tnotesMarkdown } from './language'

const toast = vi.hoisted(() => vi.fn())
vi.mock('../stores/toast', () => ({ pushToast: toast }))

function stateOf(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [tnotesMarkdown()] })
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}

function applied(state: EditorState, change: { from: number; to: number; insert: string } | null) {
  return change ? state.update({ changes: change }).state.doc.toString() : null
}

afterEach(() => {
  toast.mockReset()
  Reflect.deleteProperty(window, 'desk')
})

describe('image src rewrite', () => {
  it('swaps only the address in body images, keeping alt, title and attrs', () => {
    const doc = '![图](https://e.com/a.png "t") {w=120px align=center}'
    const state = stateOf(doc)
    expect(applied(state, imageSrcChange(imageAt(state, 3)!, '../assets/0001-a.png'))).toBe(
      '![图](../assets/0001-a.png "t") {w=120px align=center}'
    )
  })

  it('wraps addresses with spaces in angle brackets', () => {
    expect(markdownImageDestination('../assets/a b.png')).toBe('<../assets/a b.png>')
    expect(markdownImageDestination('https://e.com/a.png')).toBe('https://e.com/a.png')
  })

  it('rewrites table card images', () => {
    const table = '| a |\n| --- |\n| ![x](https://e.com/a.png) |\n'
    const tableState = stateOf(table)
    expect(
      applied(tableState, tableImageChange(tableState, 0, 0, { src: '../assets/a.png' }))
    ).toBe('| a |\n| --- |\n| ![x](../assets/a.png) |\n')
  })

  it('rewrites swiper slide addresses', () => {
    const fence = '::: swiper\n![a](https://e.com/a.png) {w=50%}\n![b](./b.png)\n:::'
    expect(updateSwiperSlideAttrs(fence, 0, { src: '../assets/a.png' })).toBe(
      '::: swiper\n![a](../assets/a.png) {w=50%}\n![b](./b.png)\n:::'
    )
  })
})

describe('image transfer menu actions', () => {
  it('classifies remote and local assets', () => {
    expect(isRemoteImageSrc('https://e.com/a.png')).toBe(true)
    expect(isRemoteImageSrc('../assets/a.png')).toBe(false)
    expect(localAssetSrc('../assets/a%20b.png')).toBe('../assets/a b.png')
    expect(localAssetSrc('./assets/a.png')).toBe('./assets/a.png')
    expect(localAssetSrc('https://e.com/assets/a.png')).toBeNull()
    expect(localAssetSrc('../other/a.png')).toBeNull()
  })

  const asset = { knowledgeBaseId: 'kb', noteUuid: 'n1', content: () => '![](https://cdn/x.png)' }
  const state = (src: string): ImageMenuState => ({
    align: 'left',
    hasWidth: false,
    editable: true,
    src,
    asset
  })
  const handlers = () => ({
    align: vi.fn(),
    resetSize: vi.fn(),
    remove: vi.fn(),
    replaceSrc: vi.fn()
  })
  function desk(attachments: Record<string, unknown>): void {
    Object.assign(window, { desk: { attachments } })
  }

  it('pulls an online image and points the src at the saved asset', async () => {
    const pullRemote = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { markdownPath: '../assets/0001-a.png' } })
    desk({ pullRemote })
    const h = handlers()
    await runImageMenuAction(
      'image-pull-remote',
      document.createElement('img'),
      h,
      state('https://e.com/a.png')
    )
    expect(pullRemote).toHaveBeenCalledWith({
      knowledgeBaseId: 'kb',
      noteUuid: 'n1',
      url: 'https://e.com/a.png'
    })
    expect(h.replaceSrc).toHaveBeenCalledWith('../assets/0001-a.png')
  })

  it('leaves the note untouched and toasts when pulling fails', async () => {
    desk({
      pullRemote: vi.fn().mockResolvedValue({ ok: false, error: { message: '下载到的不是图片' } })
    })
    const h = handlers()
    await runImageMenuAction(
      'image-pull-remote',
      document.createElement('img'),
      h,
      state('https://e.com/a')
    )
    expect(h.replaceSrc).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('拉到本地失败：下载到的不是图片', 'error')
  })

  it('pushes a local image and keeps the file unless the setting asks to delete it', async () => {
    const pushLocal = vi.fn().mockResolvedValue({
      ok: true,
      value: { markdownPath: 'https://cdn/x.png', deleteLocalAfterPush: false }
    })
    const releaseLocal = vi.fn()
    desk({ pushLocal, releaseLocal })
    const h = handlers()
    await runImageMenuAction(
      'image-push-local',
      document.createElement('img'),
      h,
      state('../assets/x.png')
    )
    expect(h.replaceSrc).toHaveBeenCalledWith('https://cdn/x.png')
    expect(releaseLocal).not.toHaveBeenCalled()
  })

  it('asks the main process to release the file with the latest note content after rewriting src', async () => {
    const order: string[] = []
    const releaseLocal = vi.fn().mockImplementation(async () => {
      order.push('release')
      return { ok: true, value: { deleted: false, reason: 'referenced' } }
    })
    desk({
      pushLocal: vi.fn().mockResolvedValue({
        ok: true,
        value: { markdownPath: 'https://cdn/x.png', deleteLocalAfterPush: true }
      }),
      releaseLocal
    })
    const h = handlers()
    h.replaceSrc.mockImplementation(() => order.push('replace'))
    await runImageMenuAction(
      'image-push-local',
      document.createElement('img'),
      h,
      state('../assets/x.png')
    )
    expect(order).toEqual(['replace', 'release'])
    expect(releaseLocal).toHaveBeenCalledWith({
      knowledgeBaseId: 'kb',
      noteUuid: 'n1',
      src: '../assets/x.png',
      content: '![](https://cdn/x.png)'
    })
    expect(toast).toHaveBeenCalledWith('已推到图床；知识库里还有其它引用，本地文件未删除', 'info')
  })

  it('copies through the main process and falls back to a canvas PNG for formats it cannot decode', async () => {
    const raw = new Uint8Array([1, 2, 3, 4])
    const copyImage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { copied: false, reason: 'unsupported', bytes: raw }
      })
      .mockResolvedValueOnce({ ok: true, value: { copied: true } })
    desk({ copyImage })
    const bitmap = { width: 4, height: 2, close: vi.fn() }
    const createBitmap = vi.fn(async () => bitmap)
    vi.stubGlobal('createImageBitmap', createBitmap)
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) {
      callback(new Blob([new Uint8Array([7])], { type: 'image/png' }))
    })
    await runImageMenuAction(
      'image-copy',
      document.createElement('img'),
      handlers(),
      state('./assets/a.webp')
    )
    expect(copyImage).toHaveBeenNthCalledWith(1, { knowledgeBaseId: 'kb', src: './assets/a.webp' })
    expect(createBitmap).toHaveBeenCalledTimes(1)
    expect(createBitmap.mock.calls[0]?.[0]).toBeInstanceOf(Blob)
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
    expect(copyImage.mock.calls[1]?.[0].png).toBeInstanceOf(Uint8Array)
    expect(toast).toHaveBeenCalledWith('已复制图片', 'success')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('exports through the save dialog and stays quiet when cancelled', async () => {
    const exportImage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { saved: true, filePath: '/tmp/a.png' } })
      .mockResolvedValueOnce({ ok: true, value: { saved: false } })
    desk({ exportImage })
    await runImageMenuAction(
      'image-export',
      document.createElement('img'),
      handlers(),
      state('https://e.com/a.png')
    )
    expect(exportImage).toHaveBeenCalledWith({ knowledgeBaseId: 'kb', src: 'https://e.com/a.png' })
    expect(toast).toHaveBeenCalledWith('已导出到 /tmp/a.png', 'success')
    toast.mockReset()
    await runImageMenuAction(
      'image-export',
      document.createElement('img'),
      handlers(),
      state('https://e.com/a.png')
    )
    expect(toast).not.toHaveBeenCalled()
  })

  it('does not touch the note or the file when pushing fails', async () => {
    const releaseLocal = vi.fn()
    desk({
      pushLocal: vi.fn().mockResolvedValue({ ok: false, error: { message: 'GitHub 上传失败：x' } }),
      releaseLocal
    })
    const h = handlers()
    await runImageMenuAction(
      'image-push-local',
      document.createElement('img'),
      h,
      state('../assets/x.png')
    )
    expect(h.replaceSrc).not.toHaveBeenCalled()
    expect(releaseLocal).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('推到图床失败：GitHub 上传失败：x', 'error')
  })
})
