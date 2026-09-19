import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const contents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setZoomFactor: vi.fn(),
    isDestroyed: () => false,
    loadURL: vi.fn(async () => undefined),
    selectAll: vi.fn()
  }
  const view = {
    webContents: contents,
    setBackgroundColor: vi.fn(),
    setVisible: vi.fn(),
    setBounds: vi.fn()
  }
  const createView = vi.fn(function () {
    return view
  })
  const sessionOn = vi.fn()
  const openExternal = vi.fn(async () => undefined)
  return { contents, view, createView, sessionOn, openExternal }
})
vi.mock('electron', () => ({
  WebContentsView: mocks.createView,
  // deskLog 会遍历窗口广播日志；测试环境里给个空实现
  BrowserWindow: { getAllWindows: () => [] },
  session: {
    fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), on: mocks.sessionOn })
  },
  shell: { openExternal: mocks.openExternal }
}))

import { externalDownloadUrl, scaledWebBounds, WebContentsManager } from './webContentsManager'

describe('native embedded web view app zoom', () => {
  it.each([0.5, 1, 1.1, 2])('converts CSS bounds to native coordinates at %sx', (factor) => {
    expect(scaledWebBounds({ x: 200, y: 120, width: 700, height: 400 }, factor)).toEqual({
      x: Math.round(200 * factor),
      y: Math.round(120 * factor),
      width: Math.round(700 * factor),
      height: Math.round(400 * factor)
    })
  })

  it('zooms the main window and existing/new web views and restores zoom after navigation', async () => {
    const manager = new WebContentsManager()
    const mainContents = { setZoomFactor: vi.fn() }
    manager.attachWindow({
      on: vi.fn(),
      isDestroyed: () => false,
      webContents: mainContents,
      contentView: { addChildView: vi.fn() }
    } as unknown as Electron.BrowserWindow)
    manager.setZoomFactor(1.5)
    expect(mainContents.setZoomFactor).toHaveBeenLastCalledWith(1.5)
    await manager.create('web-test', 'https://example.com')
    expect(mocks.createView).toHaveBeenLastCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({ zoomFactor: 1.5 })
      })
    )
    manager.setZoomFactor(2)
    expect(mocks.contents.setZoomFactor).toHaveBeenLastCalledWith(2)
    const onLoaded = mocks.contents.on.mock.calls.find(([name]) => name === 'did-finish-load')?.[1]
    onLoaded()
    expect(mocks.contents.setZoomFactor).toHaveBeenLastCalledWith(2)
    manager.layout('web-test', true, { x: 200, y: 120, width: 500, height: 300 })
    expect(mocks.view.setBounds).toHaveBeenLastCalledWith({
      x: 400,
      y: 240,
      width: 1000,
      height: 600
    })
  })
})

it('includes the native web tab origin when forwarding numbered tab shortcuts', async () => {
  mocks.contents.on.mockClear()
  const manager = new WebContentsManager()
  manager.attachWindow({
    on: vi.fn(),
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn() }
  } as unknown as Electron.BrowserWindow)
  const listener = vi.fn()
  manager.onTabShortcut(listener)
  await manager.create('right-web-tab', 'https://example.com')
  const onInput = mocks.contents.on.mock.calls.find(([name]) => name === 'before-input-event')?.[1]
  const event = { preventDefault: vi.fn() }
  onInput(event, {
    type: 'keyDown',
    key: '3',
    meta: process.platform === 'darwin',
    control: process.platform !== 'darwin',
    alt: false,
    shift: false,
    isComposing: false
  })
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledExactlyOnceWith({
    type: 'activate-tab-by-number',
    number: 3,
    sourceTabId: 'right-web-tab'
  })
})

it('网页里按 Cmd+A 会带上来源标签（渲染端据此定位，而不是猜活动标签）', async () => {
  const manager = new WebContentsManager()
  manager.attachWindow({
    on: vi.fn(),
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn() }
  } as unknown as Electron.BrowserWindow)
  const listener = vi.fn()
  manager.onTabShortcut(listener)
  await manager.create('web-focus', 'https://example.com')
  // mocks.contents.on 跨用例累积，取**最后一次**注册的处理器（本次 create 的）
  const onInput = mocks.contents.on.mock.calls
    .filter(([name]) => name === 'before-input-event')
    .at(-1)?.[1]
  const event = { preventDefault: vi.fn() }
  onInput(event, {
    type: 'keyDown',
    key: 'a',
    meta: process.platform === 'darwin',
    control: process.platform !== 'darwin',
    alt: false,
    shift: false,
    isComposing: false
  })
  expect(event.preventDefault).toHaveBeenCalledOnce()
  // 关键：带 sourceTabId，否则渲染端只能按 editor.activeTab 猜（会误选笔记）
  expect(listener).toHaveBeenCalledExactlyOnceWith({
    type: 'select-all',
    sourceTabId: 'web-focus'
  })
})

it('selects all in a native web tab without touching the Desk chrome', async () => {
  mocks.contents.selectAll.mockClear()
  const manager = new WebContentsManager()
  manager.attachWindow({
    on: vi.fn(),
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn() }
  } as unknown as Electron.BrowserWindow)
  await manager.create('web-select', 'https://example.com')
  manager.selectAll('web-select')
  expect(mocks.contents.selectAll).toHaveBeenCalledOnce()
})

describe('externalDownloadUrl', () => {
  it('只放行 http/https', () => {
    expect(externalDownloadUrl('https://example.com/a.zip')).toBe('https://example.com/a.zip')
    expect(externalDownloadUrl('http://example.com/a.zip')).toBe('http://example.com/a.zip')
  })

  it('丢弃 file/blob/自定义 scheme 与空值', () => {
    for (const url of [
      'file:///etc/passwd',
      'blob:https://example.com/1234',
      'ms-msdt:/id',
      'search-ms:query=x',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      '',
      undefined,
      null
    ]) {
      expect(externalDownloadUrl(url)).toBeNull()
    }
  })
})

describe('will-download 白名单', () => {
  const downloadHandler = () => {
    mocks.sessionOn.mockClear()
    mocks.openExternal.mockClear()
    const manager = new WebContentsManager()
    manager.attachWindow({
      on: vi.fn(),
      isDestroyed: () => false,
      webContents: { setZoomFactor: vi.fn() },
      contentView: { addChildView: vi.fn() }
    } as unknown as Electron.BrowserWindow)
    return mocks.sessionOn.mock.calls.find(([name]) => name === 'will-download')?.[1] as (
      event: { preventDefault: () => void },
      item: { getURL: () => string }
    ) => void
  }

  it('不会把 file: 下载交给系统处理器', () => {
    const handler = downloadHandler()
    const event = { preventDefault: vi.fn() }
    handler(event, { getURL: () => 'file:///etc/passwd' })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('https 下载仍按原行为交给系统浏览器', () => {
    const handler = downloadHandler()
    const event = { preventDefault: vi.fn() }
    handler(event, { getURL: () => 'https://example.com/a.zip' })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/a.zip')
  })
})
