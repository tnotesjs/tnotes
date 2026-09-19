import { BrowserWindow, session, shell, WebContentsView } from 'electron'

import { deskLog } from './log'
import { TabShortcutResolver } from './tabShortcuts'

import type {
  TabShortcutCommand,
  WebBounds,
  WebOpenRequestedEvent,
  WebTabState
} from '../shared/contracts'

const WEB_PARTITION = 'persist:tnotes-desk-web'

interface WebHandle {
  tabId: string
  view: WebContentsView
  state: WebTabState
}

function normalizeWebUrl(value: string): string {
  const trimmed = value.trim()
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(candidate)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('网页标签只允许访问 http/https 地址')
  }
  return url.toString()
}

/**
 * 下载事件里的 URL 来自页面，可能是 `file:`、`blob:` 或 `ms-msdt:` 这类自定义
 * scheme；交给 shell.openExternal 等于把任意协议交给操作系统处理器处理。
 * 只放行 http/https，其余返回 null 由调用方丢弃。
 */
export function externalDownloadUrl(value: string | undefined | null): string | null {
  if (!value) return null
  try {
    return normalizeWebUrl(value)
  } catch {
    return null
  }
}

export function scaledWebBounds(bounds: WebBounds, zoomFactor: number): Electron.Rectangle {
  return {
    x: Math.max(0, Math.round(bounds.x * zoomFactor)),
    y: Math.max(0, Math.round(bounds.y * zoomFactor)),
    width: Math.max(1, Math.round(bounds.width * zoomFactor)),
    height: Math.max(1, Math.round(bounds.height * zoomFactor))
  }
}

export class WebContentsManager {
  private handles = new Map<string, WebHandle>()
  private mainWindow: BrowserWindow | null = null
  private stateListener: ((state: WebTabState) => void) | null = null
  private openRequestedListener: ((event: WebOpenRequestedEvent) => void) | null = null
  private shortcutListener: ((command: TabShortcutCommand) => void) | null = null
  private sessionConfigured = false
  private zoomFactor = 1

  setZoomFactor(factor: number): void {
    this.zoomFactor = factor
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.setZoomFactor(factor)
    }
    for (const handle of this.handles.values()) {
      if (!handle.view.webContents.isDestroyed()) handle.view.webContents.setZoomFactor(factor)
    }
  }

  private configureSession(): void {
    if (this.sessionConfigured) return
    this.sessionConfigured = true
    const webSession = session.fromPartition(WEB_PARTITION)
    webSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    webSession.on('will-download', (event, item) => {
      event.preventDefault()
      const requested = item.getURL()
      const url = externalDownloadUrl(requested)
      if (!url) {
        deskLog('web', 'blocked download with non-http(s) url', { url: requested })
        return
      }
      void shell.openExternal(url)
    })
  }

  attachWindow(window: BrowserWindow): void {
    this.configureSession()
    this.mainWindow = window
    window.on('hide', () => this.hideAll())
    window.on('minimize', () => this.hideAll())
    window.on('closed', () => {
      if (this.mainWindow === window) this.mainWindow = null
      this.closeAll()
    })
  }

  onStateChanged(listener: (state: WebTabState) => void): () => void {
    this.stateListener = listener
    return () => {
      if (this.stateListener === listener) this.stateListener = null
    }
  }

  onOpenRequested(listener: (event: WebOpenRequestedEvent) => void): () => void {
    this.openRequestedListener = listener
    return () => {
      if (this.openRequestedListener === listener) this.openRequestedListener = null
    }
  }

  onTabShortcut(listener: (command: TabShortcutCommand) => void): () => void {
    this.shortcutListener = listener
    return () => {
      if (this.shortcutListener === listener) this.shortcutListener = null
    }
  }

  async create(tabId: string, inputUrl: string): Promise<WebTabState> {
    const existing = this.handles.get(tabId)
    if (existing) return { ...existing.state }
    const window = this.requireWindow()
    const url = normalizeWebUrl(inputUrl)
    const view = new WebContentsView({
      webPreferences: {
        partition: WEB_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        zoomFactor: this.zoomFactor
      }
    })
    view.setBackgroundColor('#101319')
    view.setVisible(false)
    window.contentView.addChildView(view)

    const handle: WebHandle = {
      tabId,
      view,
      state: {
        tabId,
        url,
        title: url,
        canGoBack: false,
        canGoForward: false,
        loading: true
      }
    }
    this.handles.set(tabId, handle)
    this.bindWebContents(handle)

    try {
      await view.webContents.loadURL(url)
    } catch (error) {
      handle.state.error = error instanceof Error ? error.message : String(error)
      handle.state.loading = false
      this.emitState(handle)
    }
    return { ...handle.state }
  }

  layout(tabId: string, visible: boolean, bounds?: WebBounds): void {
    const handle = this.getHandle(tabId)
    if (!visible) {
      handle.view.setVisible(false)
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.focus()
      }
      return
    }
    if (!bounds) throw new Error('显示网页标签时缺少布局区域')
    handle.view.setBounds(scaledWebBounds(bounds, this.zoomFactor))
    handle.view.setVisible(true)
  }

  close(tabId: string): void {
    const handle = this.handles.get(tabId)
    if (!handle) return
    this.handles.delete(tabId)
    handle.view.setVisible(false)
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.contentView.removeChildView(handle.view)
    }
    handle.view.webContents.close()
  }

  closeAll(): void {
    for (const tabId of [...this.handles.keys()]) this.close(tabId)
  }

  hideAll(): void {
    for (const handle of this.handles.values()) handle.view.setVisible(false)
  }

  async navigate(tabId: string, inputUrl: string): Promise<WebTabState> {
    const handle = this.getHandle(tabId)
    const url = normalizeWebUrl(inputUrl)
    handle.state = { ...handle.state, url, loading: true, error: undefined }
    this.emitState(handle)
    try {
      await handle.view.webContents.loadURL(url)
    } catch (error) {
      handle.state.error = error instanceof Error ? error.message : String(error)
      handle.state.loading = false
      this.emitState(handle)
    }
    return { ...handle.state }
  }

  goBack(tabId: string): void {
    const navigation = this.getHandle(tabId).view.webContents.navigationHistory
    if (navigation.canGoBack()) navigation.goBack()
  }

  goForward(tabId: string): void {
    const navigation = this.getHandle(tabId).view.webContents.navigationHistory
    if (navigation.canGoForward()) navigation.goForward()
  }

  reload(tabId: string): void {
    this.getHandle(tabId).view.webContents.reload()
  }

  stop(tabId: string): void {
    this.getHandle(tabId).view.webContents.stop()
  }

  selectAll(tabId: string): void {
    const contents = this.getHandle(tabId).view.webContents
    if (!contents.isDestroyed()) contents.selectAll()
  }

  async openExternal(inputUrl: string): Promise<void> {
    await shell.openExternal(normalizeWebUrl(inputUrl))
  }

  async clearBrowsingData(): Promise<void> {
    this.hideAll()
    await session.fromPartition(WEB_PARTITION).clearStorageData()
  }

  dispose(): void {
    this.closeAll()
    this.stateListener = null
    this.openRequestedListener = null
    this.shortcutListener = null
  }

  private requireWindow(): BrowserWindow {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) throw new Error('主窗口尚未就绪')
    return this.mainWindow
  }

  private getHandle(tabId: string): WebHandle {
    const handle = this.handles.get(tabId)
    if (!handle) throw new Error(`网页标签不存在：${tabId}`)
    return handle
  }

  private bindWebContents(handle: WebHandle): void {
    const contents = handle.view.webContents
    const shortcutResolver = new TabShortcutResolver()
    const refresh = (): void => {
      if (contents.isDestroyed()) return
      const navigation = contents.navigationHistory
      handle.state = {
        ...handle.state,
        url: contents.getURL() || handle.state.url,
        canGoBack: navigation.canGoBack(),
        canGoForward: navigation.canGoForward(),
        loading: contents.isLoading()
      }
      this.emitState(handle)
    }

    contents.setWindowOpenHandler(({ url }) => {
      try {
        this.openRequestedListener?.({ sourceTabId: handle.tabId, url: normalizeWebUrl(url) })
      } catch {
        // Ignore non-http(s) popups.
      }
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      try {
        normalizeWebUrl(url)
      } catch {
        event.preventDefault()
      }
    })
    contents.on('page-title-updated', (_event, title) => {
      handle.state.title = title || handle.state.url
      this.emitState(handle)
    })
    contents.on('page-favicon-updated', (_event, favicons) => {
      handle.state.faviconUrl = favicons.find((url) => /^https?:/i.test(url))
      this.emitState(handle)
    })
    contents.on('did-start-loading', refresh)
    contents.on('did-stop-loading', refresh)
    contents.on('did-navigate', refresh)
    contents.on('did-finish-load', () => contents.setZoomFactor(this.zoomFactor))
    contents.on('did-navigate-in-page', refresh)
    contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      handle.state = {
        ...handle.state,
        url: validatedUrl || handle.state.url,
        loading: false,
        error: description
      }
      this.emitState(handle)
    })
    contents.on('before-input-event', (event, input) => {
      const resolution = shortcutResolver.resolve(input)
      if (!resolution.handled) return
      event.preventDefault()
      if (resolution.command) {
        // Native web views do not bubble focus/mouse events through EditorGroup.
        // Carry the originating tab so numbered navigation uses its actual group.
        this.shortcutListener?.(
          typeof resolution.command === 'object'
            ? { ...resolution.command, sourceTabId: handle.tabId }
            : resolution.command
        )
      }
    })
    contents.on('render-process-gone', (_event, details) => {
      handle.state = { ...handle.state, loading: false, error: `网页进程已退出：${details.reason}` }
      deskLog('web', 'render process gone', { tabId: handle.tabId, reason: details.reason })
      this.emitState(handle)
    })
  }

  private emitState(handle: WebHandle): void {
    this.stateListener?.({ ...handle.state })
  }

  /**
   * 仅供 E2E：把某个标签的原生 WebContents 暴露给测试驱动。
   *
   * 原生网页视图不在渲染端 DOM 里，Playwright 无法直接向它发按键；E2E 需要
   * 通过真实的 `before-input-event` 路径验证「网页里的 Cmd+A 按来源定位」。
   * 只在 `DESK_E2E_EXPOSE_INTERNALS=1` 时可用，生产环境返回 null（不影响行为）。
   */
  debugWebContents(tabId: string): Electron.WebContents | null {
    if (process.env.DESK_E2E_EXPOSE_INTERNALS !== '1') return null
    return this.handles.get(tabId)?.view.webContents ?? null
  }
}

export const webContentsManager = new WebContentsManager()

// E2E 专用：便于测试用 app.evaluate 拿到原生 WebContents（生产不设该变量）
if (process.env.DESK_E2E_EXPOSE_INTERNALS === '1') {
  ;(globalThis as { __deskWebContentsManager?: WebContentsManager }).__deskWebContentsManager =
    webContentsManager
}
