import { dialog, shell } from 'electron'
import { z } from 'zod'

import { previewManager } from '../preview'
import { confirmTabClose } from '../closeConfirmation'
import { showContextMenu } from '../contextMenus'
import { showKnowledgeSidebarMenu, showNavigatorSidebarMenu } from '../sidebarMenus'
import { loadRecoveries } from '../recovery'
import { loadWorkspaceSession, saveWorkspaceSession } from '../session'
import { loadSettings } from '../settings'
import { searchManager } from '../searchManager'
import { webContentsManager } from '../webContentsManager'
import { workspaceManager } from '../workspaceManager'
import { IPC_CHANNELS } from '../../shared/contracts'
import {
  workspaceSessionSchema,
  knowledgeBaseCreateSchema,
  knowledgeBaseSettingsWriteSchema,
  knowledgeBaseIconWriteSchema
} from './schemas'
import { settleCloseGuards } from '../closeGuards'
import { handle, noInputSchema, type GetWindow } from './shared'

export function registerWorkspace(getWindow: GetWindow): () => void {
  handle(
    IPC_CHANNELS.contextMenuShow,
    getWindow,
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('note'),
        pinned: z.boolean(),
        tocPinned: z.boolean(),
        completed: z.boolean()
      }),
      z.object({ kind: z.literal('group') }),
      z.object({
        kind: z.literal('tab'),
        tabType: z.enum([
          'note',
          'web',
          'kb-settings',
          'kb-assets',
          'excalidraw',
          'mindmap',
          'note-history',
          'text-file'
        ]),
        pinned: z.boolean(),
        othersClosable: z.boolean().optional()
      }),
      z.object({ kind: z.literal('code-group-tab') })
    ]),
    (request) => {
      const window = getWindow()
      if (!window || window.isDestroyed()) throw new Error('Desk 主窗口不可用')
      return showContextMenu(window, request)
    }
  )
  handle(
    IPC_CHANNELS.knowledgeSidebarMenuShow,
    getWindow,
    z.object({
      hasWorkspace: z.boolean(),
      loading: z.boolean()
    }),
    (request) => {
      const window = getWindow()
      if (!window || window.isDestroyed()) throw new Error('Desk 主窗口不可用')
      return showKnowledgeSidebarMenu(window, request)
    }
  )
  handle(
    IPC_CHANNELS.navigatorSidebarMenuShow,
    getWindow,
    z.object({
      ready: z.boolean(),
      previewLabel: z.string().min(1),
      buildBusy: z.boolean(),
      noteCount: z.number().int().min(0)
    }),
    (request) => {
      const window = getWindow()
      if (!window || window.isDestroyed()) throw new Error('Desk 主窗口不可用')
      return showNavigatorSidebarMenu(window, request)
    }
  )
  handle(IPC_CHANNELS.tabConfirmClose, getWindow, z.array(z.string().min(1)).min(1), (titles) => {
    const window = getWindow()
    if (!window || window.isDestroyed()) throw new Error('Desk 主窗口不可用')
    return confirmTabClose(window, titles)
  })
  handle(IPC_CHANNELS.bootstrap, getWindow, noInputSchema, async () => {
    const workspace = workspaceManager.getOverview()
    return {
      workspace,
      settings: loadSettings(),
      platform:
        process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
      session: await loadWorkspaceSession(workspace.path),
      recoveries: await loadRecoveries(workspace.path)
    }
  })
  handle(IPC_CHANNELS.appCloseReady, getWindow, z.object({ proceed: z.boolean() }), (input) => {
    settleCloseGuards(getWindow() ?? null, input.proceed)
  })

  handle(IPC_CHANNELS.windowClose, getWindow, noInputSchema, () => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    setImmediate(() => {
      if (!window.isDestroyed()) window.close()
    })
  })

  handle(IPC_CHANNELS.workspaceChoose, getWindow, noInputSchema, async () => {
    const parent = getWindow()
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory']
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return workspaceManager.getOverview()
    }
    await previewManager.stopAll()
    webContentsManager.closeAll()
    const overview = await workspaceManager.setWorkspace(result.filePaths[0])
    return overview
  })

  handle(
    IPC_CHANNELS.workspaceSet,
    getWindow,
    z.string().min(1).nullable(),
    async (workspacePath) => {
      await previewManager.stopAll()
      webContentsManager.closeAll()
      return workspaceManager.setWorkspace(workspacePath)
    }
  )
  handle(IPC_CHANNELS.workspaceRefresh, getWindow, noInputSchema, () => workspaceManager.refresh())
  handle(IPC_CHANNELS.workspaceReveal, getWindow, noInputSchema, async () => {
    const path = workspaceManager.getOverview().path
    if (!path) throw new Error('请先选择工作区')
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  handle(IPC_CHANNELS.knowledgeBaseCreate, getWindow, knowledgeBaseCreateSchema, (request) =>
    workspaceManager.createKnowledgeBase(request)
  )
  handle(
    IPC_CHANNELS.workspaceRevealKnowledgeBase,
    getWindow,
    z.string().min(1),
    async (knowledgeBaseId) => {
      const error = await shell.openPath(workspaceManager.getLocation(knowledgeBaseId).rootPath)
      if (error) throw new Error(error)
    }
  )
  handle(IPC_CHANNELS.knowledgeBaseRead, getWindow, z.string().min(1), (knowledgeBaseId) =>
    workspaceManager.getDetail(knowledgeBaseId)
  )
  handle(IPC_CHANNELS.knowledgeBaseReadSettings, getWindow, z.string().min(1), (knowledgeBaseId) =>
    workspaceManager.readSettings(knowledgeBaseId)
  )
  handle(
    IPC_CHANNELS.knowledgeBaseWriteSettings,
    getWindow,
    knowledgeBaseSettingsWriteSchema,
    (request) => workspaceManager.writeSettings(request)
  )
  handle(IPC_CHANNELS.knowledgeBaseWriteIcon, getWindow, knowledgeBaseIconWriteSchema, (request) =>
    workspaceManager.writeIcon(request)
  )
  handle(IPC_CHANNELS.kbBuild, getWindow, z.string().min(1), (knowledgeBaseId) =>
    workspaceManager.buildKnowledgeBase(knowledgeBaseId)
  )
  handle(
    IPC_CHANNELS.searchQuery,
    getWindow,
    z.object({
      query: z.string().max(500),
      knowledgeBaseId: z.string().min(1).nullable(),
      limit: z.number().int().min(1).max(100).optional()
    }),
    (request) => searchManager.search(request)
  )
  handle(IPC_CHANNELS.sessionRead, getWindow, noInputSchema, () =>
    loadWorkspaceSession(workspaceManager.getOverview().path)
  )
  handle(IPC_CHANNELS.sessionSave, getWindow, workspaceSessionSchema, (session) =>
    saveWorkspaceSession(workspaceManager.getOverview().path, session)
  )

  const offChanged = workspaceManager.onChanged((overview) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.workspaceChanged, overview)
    }
  })
  const offExternalChanged = workspaceManager.onNoteExternalChanged((event) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.noteExternalChanged, event)
    }
  })

  return () => {
    offChanged()
    offExternalChanged()
  }
}
