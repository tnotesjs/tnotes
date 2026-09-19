import { join } from 'node:path'
import { app, BrowserWindow, Menu, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'

import icon from '../../resources/icon.png?asset'
import { handleAssetProtocol, registerAssetScheme } from './assetProtocol'
import { CloseGuard } from './closeGuard'
import {
  ensureQuitGuard,
  getWindowGuard,
  registerWindowGuard,
  unregisterWindowGuard
} from './closeGuards'
import { reportBackgroundGitFailure } from './backgroundGitFailure'
import { gitManager } from './gitManager'
import { registerIpc } from './ipc'
import { commandTaskManager } from './commandTaskManager'
import { terminalManager } from './terminalManager'
import { deskLog } from './log'
import { loadSettings } from './settings'
import { updateManager } from './updateManager'
import { previewManager } from './preview'
import { searchManager } from './searchManager'
import type { WorkspaceChangeHint } from './workspace/types'
import { applicationMenuTemplate } from './applicationMenu'
import { TabShortcutResolver } from './tabShortcuts'
import { webContentsManager } from './webContentsManager'
import { workspaceManager } from './workspaceManager'

import { IPC_CHANNELS, type TabShortcutCommand } from '../shared/contracts'

let mainWindow: BrowserWindow | null = null
let unregisterIpc: (() => void) | null = null
let unregisterSearchRefresh: (() => void) | null = null
let searchRefreshTimer: NodeJS.Timeout | null = null
let gitRefreshTimer: NodeJS.Timeout | null = null
const mainTabShortcutResolver = new TabShortcutResolver()

registerAssetScheme()

/** Git status is spawned per repo; debounce so save bursts refresh it once. */
function scheduleGitRefresh(): void {
  if (gitRefreshTimer) clearTimeout(gitRefreshTimer)
  gitRefreshTimer = setTimeout(() => {
    gitRefreshTimer = null
    gitManager.configure(workspaceManager.getGitRepositories())
  }, 2000)
}

// 后台 Git 失败（定时 fetch / 自动推送）落成一条可见的失败任务：
// 面板会对失败任务弹带「查看输出」的通知，用户才有入口看到原因。
gitManager.onBackgroundFailure((event) => reportBackgroundGitFailure(event))

function scheduleSearchRefresh(hint?: WorkspaceChangeHint): void {
  const overview = workspaceManager.getOverview()
  scheduleGitRefresh()
  searchManager.setWorkspace(overview.path)
  if (searchRefreshTimer) clearTimeout(searchRefreshTimer)
  if (!overview.path) return
  const workspacePath = overview.path
  searchRefreshTimer = setTimeout(() => {
    searchRefreshTimer = null
    if (hint?.kind === 'content' && hint.knowledgeBaseId && hint.noteUuid) {
      // Single-note edit: reindex just that document instead of re-reading
      // and re-hashing every note in the workspace.
      void workspaceManager
        .getSearchDocument(hint.knowledgeBaseId, hint.noteUuid)
        .then((document) => (document ? searchManager.upsert(workspacePath, document) : undefined))
        .catch((error) =>
          deskLog(
            'search',
            'document refresh failed',
            error instanceof Error ? error.message : String(error)
          )
        )
      return
    }
    void workspaceManager
      .getSearchDocuments()
      .then((documents) => searchManager.rebuild(workspacePath, documents))
      .catch((error) =>
        deskLog(
          'search',
          'document collection failed',
          error instanceof Error ? error.message : String(error)
        )
      )
  }, 350)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function sendTabShortcut(window: BrowserWindow, command: TabShortcutCommand): void {
  if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.tabShortcut, command)
}

function configureApplicationMenu(): void {
  // Select All is a custom command (not role:selectAll) so Cmd+A stays in the note.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenuTemplate({
        appName: app.name,
        platform: process.platform,
        send: (command) => {
          if (mainWindow) sendTabShortcut(mainWindow, command)
        }
      })
    )
  )
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'TNotes Desk',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: { x: 12, y: 15 }
        }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      zoomFactor: loadSettings().appZoomPercent / 100
    }
  })

  window.once('ready-to-show', () => {
    window.show()
    if (is.dev && process.env.DESK_OPEN_DEVTOOLS === '1') {
      window.webContents.openDevTools({ mode: 'bottom' })
      deskLog('desk', 'DevTools opened (dev mode)')
    }
  })
  webContentsManager.attachWindow(window)
  webContentsManager.setZoomFactor(loadSettings().appZoomPercent / 100)
  window.webContents.on('did-finish-load', () => {
    webContentsManager.setZoomFactor(loadSettings().appZoomPercent / 100)
  })
  webContentsManager.onTabShortcut((command) => sendTabShortcut(window, command))
  // 红叉 / ⌘W：先让渲染端 flush 并处理未保存内容，再真正关闭
  const closeGuard = new CloseGuard({
    requestFlush: () => {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.appBeforeClose)
    },
    close: () => window.close(),
    onTimeout: (waited) =>
      deskLog('desk', 'close guard timed out waiting for renderer', { waited, window: window.id }),
    onUnavailable: (error) =>
      deskLog('desk', 'close guard could not reach renderer', {
        message: error instanceof Error ? error.message : String(error)
      })
  })
  registerWindowGuard(window, closeGuard)
  window.on('close', (event) => {
    closeGuard.intercept(event)
  })
  window.on('closed', () => {
    unregisterWindowGuard(window)
    if (mainWindow === window) mainWindow = null
  })

  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url === current) return
    event.preventDefault()
    if (isHttpUrl(url)) void shell.openExternal(url)
  })
  window.webContents.on('before-input-event', (event, input) => {
    const resolution = mainTabShortcutResolver.resolve(input)
    if (!resolution.handled) return
    event.preventDefault()
    if (resolution.command) sendTabShortcut(window, resolution.command)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.tnotesjs.desk')
    configureApplicationMenu()
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    await workspaceManager.initialize()
    unregisterSearchRefresh = workspaceManager.onChanged((_overview, hint) =>
      scheduleSearchRefresh(hint)
    )
    scheduleSearchRefresh()
    handleAssetProtocol()
    unregisterIpc = registerIpc(() => mainWindow)
    updateManager.configure(loadSettings().updates.autoCheck)
    updateManager.start()
    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      }
    })
  })
}

app.on('before-quit', (event) => {
  const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (!target) {
    void previewManager.stopAll()
    return
  }
  const guard = ensureQuitGuard(
    () =>
      new CloseGuard({
        requestFlush: () => {
          if (!target.isDestroyed()) target.webContents.send(IPC_CHANNELS.appBeforeClose)
        },
        close: () => {
          // 退出流程已经处理过 flush：随后的窗口 close 直接放行
          getWindowGuard(target)?.approve()
          app.quit()
        },
        onTimeout: (waited) =>
          deskLog('desk', 'quit guard timed out waiting for renderer', { waited }),
        onUnavailable: (error) =>
          deskLog('desk', 'quit guard could not reach renderer', {
            message: error instanceof Error ? error.message : String(error)
          })
      })
  )
  if (guard.intercept(event)) return
  // 已批准退出：停预览后放行
  void previewManager.stopAll()
})

app.on('will-quit', () => {
  if (searchRefreshTimer) clearTimeout(searchRefreshTimer)
  searchRefreshTimer = null
  unregisterSearchRefresh?.()
  unregisterSearchRefresh = null
  unregisterIpc?.()
  unregisterIpc = null
  updateManager.stop()
  void workspaceManager.dispose()
  void searchManager.dispose()
  void gitManager.dispose()
  webContentsManager.dispose()
  // 终端会话持有真实 shell 进程：退出时必须一起结束，否则会把预览服务之类的
  // 子进程留成孤儿
  terminalManager.dispose()
  // 命令任务只持有视图状态：正在跑的 Git 子进程由 gitManager 收尾，这里清掉记录即可
  commandTaskManager.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
