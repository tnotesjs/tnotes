import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const contents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setZoomFactor: vi.fn(),
    isDestroyed: () => false,
    loadURL: vi.fn(async () => undefined),
    selectAll: vi.fn(),
    getURL: vi.fn(() => ''),
    isLoading: vi.fn(() => false),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false }
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

import {
  externalDownloadUrl,
  isAbortedLoadError,
  scaledWebBounds,
  WebContentsManager
} from './webContentsManager'

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

describe('ERR_ABORTED (-3) 不作为粘滞错误', () => {
  // 模拟 Electron loadURL 的 reject：Error 上带 errno / code
  const loadError = (message: string, errno: number, code: string): Error =>
    Object.assign(new Error(message), { errno, code })
  const aborted = (url: string): Error =>
    loadError(`ERR_ABORTED (-3) loading '${url}'`, -3, 'ERR_ABORTED')

  const setup = () => {
    mocks.contents.on.mockClear()
    mocks.contents.loadURL.mockReset()
    mocks.contents.loadURL.mockResolvedValue(undefined)
    mocks.contents.getURL.mockReturnValue('')
    const manager = new WebContentsManager()
    manager.attachWindow({
      on: vi.fn(),
      isDestroyed: () => false,
      webContents: { setZoomFactor: vi.fn() },
      contentView: { addChildView: vi.fn() }
    } as unknown as Electron.BrowserWindow)
    const states: Array<{ url: string; error?: string; loading: boolean }> = []
    manager.onStateChanged((state) => states.push(state))
    const handler = (name: string) =>
      mocks.contents.on.mock.calls.filter(([event]) => event === name).at(-1)?.[1] as (
        ...args: unknown[]
      ) => void
    return { manager, states, handler }
  }

  it('识别 Electron 的中断错误', () => {
    expect(isAbortedLoadError(aborted('http://localhost:9193/notes/1'))).toBe(true)
    expect(isAbortedLoadError(new Error("ERR_ABORTED (-3) loading 'x'"))).toBe(true)
    expect(
      isAbortedLoadError(
        loadError("ERR_CONNECTION_REFUSED (-102) loading 'x'", -102, 'ERR_CONNECTION_REFUSED')
      )
    ).toBe(false)
    expect(isAbortedLoadError('ERR_ABORTED')).toBe(false)
    expect(isAbortedLoadError(null)).toBe(false)
  })

  it('create / navigate 的 loadURL 被中断时不写 error', async () => {
    const { manager } = setup()
    mocks.contents.loadURL.mockRejectedValueOnce(aborted('http://localhost:9193/notes/1'))
    const created = await manager.create('web-abort', 'http://localhost:9193/notes/1')
    expect(created.error).toBeUndefined()
    mocks.contents.loadURL.mockRejectedValueOnce(aborted('http://localhost:9193/notes/2'))
    const navigated = await manager.navigate('web-abort', 'http://localhost:9193/notes/2')
    expect(navigated.error).toBeUndefined()
  })

  it('真实加载失败仍然显示', async () => {
    const { manager } = setup()
    mocks.contents.loadURL.mockRejectedValueOnce(
      loadError(
        "ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:9193/'",
        -102,
        'ERR_CONNECTION_REFUSED'
      )
    )
    const state = await manager.create('web-down', 'http://localhost:9193/')
    expect(state.error).toContain('ERR_CONNECTION_REFUSED')
    expect(state.loading).toBe(false)
  })

  it('did-fail-load 的真实失败在 did-stop-loading 后仍保留，成功 did-navigate 后清除', async () => {
    const { manager, states, handler } = setup()
    await manager.create('web-recover', 'http://localhost:9193/notes/1')
    handler('did-fail-load')(
      {},
      -102,
      'ERR_CONNECTION_REFUSED',
      'http://localhost:9193/notes/1',
      true
    )
    handler('did-stop-loading')()
    expect(states.at(-1)?.error).toBe('ERR_CONNECTION_REFUSED')

    // 页面内跳到另一个地址并成功提交：地址栏与错误条保持一致
    mocks.contents.getURL.mockReturnValue('http://localhost:9193/notes/2')
    handler('did-navigate')({}, 'http://localhost:9193/notes/2', 200, 'OK')
    expect(states.at(-1)).toMatchObject({ url: 'http://localhost:9193/notes/2', error: undefined })
  })

  it('did-fail-load 忽略 -3', async () => {
    const { manager, states, handler } = setup()
    await manager.create('web-ignore', 'http://localhost:9193/notes/1')
    const before = states.length
    handler('did-fail-load')({}, -3, 'ERR_ABORTED', 'http://localhost:9193/notes/1', true)
    expect(states.length).toBe(before)
  })
})
