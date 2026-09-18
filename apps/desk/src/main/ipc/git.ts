import path from 'node:path'
import { z } from 'zod'

import { gitManager } from '../gitManager'
import { openInConfiguredIde, showIdeContextMenu } from '../ide'
import { workspaceManager } from '../workspaceManager'
import { IPC_CHANNELS } from '../../shared/contracts'
import { handle, noInputSchema, type GetWindow } from './shared'

export function registerGit(getWindow: GetWindow): () => void {
  handle(IPC_CHANNELS.gitList, getWindow, noInputSchema, () => gitManager.list())
  handle(IPC_CHANNELS.gitRefresh, getWindow, z.string().min(1).optional(), (knowledgeBaseId) =>
    gitManager.refresh(knowledgeBaseId)
  )
  handle(IPC_CHANNELS.gitFetch, getWindow, z.string().min(1), (knowledgeBaseId) =>
    gitManager.fetch(knowledgeBaseId)
  )
  handle(IPC_CHANNELS.gitPull, getWindow, z.string().min(1), (knowledgeBaseId) =>
    gitManager.pull(knowledgeBaseId)
  )
  handle(IPC_CHANNELS.gitPublish, getWindow, z.string().min(1), (knowledgeBaseId) =>
    gitManager.publish(knowledgeBaseId)
  )
  handle(IPC_CHANNELS.ideShowKnowledgeBaseMenu, getWindow, z.string().min(1), (knowledgeBaseId) => {
    const window = getWindow()
    if (!window) throw new Error('Desk 主窗口不可用')
    const location = workspaceManager.getLocation(knowledgeBaseId)
    const detail = workspaceManager.getDetail(knowledgeBaseId)
    showIdeContextMenu(
      window,
      location.rootPath,
      {
        repositoryUrl: detail.repositoryUrl,
        pageUrl: detail.pageUrl
      },
      {
        onOpenSettings: () => {
          window.webContents.send(IPC_CHANNELS.kbOpenSettingsRequested, knowledgeBaseId)
        },
        onOpenAssets: () => {
          window.webContents.send(IPC_CHANNELS.kbOpenAssetsRequested, knowledgeBaseId)
        }
      }
    )
  })
  handle(
    IPC_CHANNELS.ideShowNoteMenu,
    getWindow,
    z.object({ knowledgeBaseId: z.string().min(1), noteUuid: z.string().min(1) }),
    ({ knowledgeBaseId, noteUuid }) => {
      const window = getWindow()
      if (!window) throw new Error('Desk 主窗口不可用')
      showIdeContextMenu(window, workspaceManager.getNoteLocation(knowledgeBaseId, noteUuid))
    }
  )
  handle(
    IPC_CHANNELS.ideShowFileMenu,
    getWindow,
    z.object({ knowledgeBaseId: z.string().min(1), path: z.string().min(1) }),
    ({ knowledgeBaseId, path: relativePath }) => {
      const window = getWindow()
      if (!window) throw new Error('Desk 主窗口不可用')
      const rootPath = workspaceManager.getLocation(knowledgeBaseId).rootPath
      const targetPath = path.resolve(rootPath, relativePath)
      if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
        throw new Error('变更路径超出知识库')
      }
      // 目录/文件右键都走这里：额外给一个「在终端中打开」，由渲染端建会话。
      // 顺序固定为最相关 → 最通用，终端排在 IDE 之前（终端是本应用内的动作）。
      showIdeContextMenu(window, targetPath, undefined, {
        onOpenTerminal: () => {
          window.webContents.send(IPC_CHANNELS.terminalOpenAt, {
            knowledgeBaseId,
            cwd: targetPath
          })
        }
      })
    }
  )
  handle(IPC_CHANNELS.ideOpenKnowledgeBase, getWindow, z.string().min(1), (knowledgeBaseId) =>
    openInConfiguredIde(workspaceManager.getLocation(knowledgeBaseId).rootPath)
  )
  handle(
    IPC_CHANNELS.ideOpenNote,
    getWindow,
    z.object({ knowledgeBaseId: z.string().min(1), noteUuid: z.string().min(1) }),
    ({ knowledgeBaseId, noteUuid }) =>
      openInConfiguredIde(workspaceManager.getNoteLocation(knowledgeBaseId, noteUuid))
  )

  const offGitChanged = gitManager.onChanged((state) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.gitStateChanged, state)
    }
  })

  return () => {
    offGitChanged()
  }
}
