import path from 'node:path'
import { z } from 'zod'

import { commandTaskManager } from '../commandTaskManager'
import { gitManager } from '../gitManager'
import { launchIde, showIdeContextMenu } from '../ide'
import { loadSettings } from '../settings'

import type { IdeLaunchResult } from '../ide'
import { workspaceManager } from '../workspaceManager'
import { IPC_CHANNELS } from '../../shared/contracts'
import { handle, noInputSchema, type GetWindow } from './shared'
import { runGitTaskFor } from './commandTask'

export function registerGit(getWindow: GetWindow): () => void {
  handle(IPC_CHANNELS.gitList, getWindow, noInputSchema, () => gitManager.list())
  handle(IPC_CHANNELS.gitRefresh, getWindow, z.string().min(1).optional(), (knowledgeBaseId) =>
    gitManager.refresh(knowledgeBaseId)
  )
  handle(IPC_CHANNELS.gitFocus, getWindow, z.string().min(1).nullable(), (knowledgeBaseId) => {
    gitManager.setFocusedKnowledgeBase(knowledgeBaseId)
    return null
  })
  // 带 taskId 时（手动操作）由命令任务处理器执行：它把实时输出与取消信号接进
  // 既有 Git 流程；不带 taskId 时（后台定时 fetch 等）行为与以前完全一致。
  handle(
    IPC_CHANNELS.gitFetch,
    getWindow,
    z.object({
      knowledgeBaseId: z.string().min(1),
      taskId: z.string().min(1).optional(),
      run: z.number().int().min(1).optional()
    }),
    (input) => runGitTaskFor(input.knowledgeBaseId, 'git-fetch', input.taskId, getWindow, input.run)
  )
  handle(
    IPC_CHANNELS.gitPull,
    getWindow,
    z.object({
      knowledgeBaseId: z.string().min(1),
      taskId: z.string().min(1).optional(),
      run: z.number().int().min(1).optional()
    }),
    (input) => runGitTaskFor(input.knowledgeBaseId, 'git-pull', input.taskId, getWindow, input.run)
  )
  handle(
    IPC_CHANNELS.gitPublish,
    getWindow,
    z.object({
      knowledgeBaseId: z.string().min(1),
      taskId: z.string().min(1).optional(),
      run: z.number().int().min(1).optional()
    }),
    (input) => runGitTaskFor(input.knowledgeBaseId, 'git-push', input.taskId, getWindow, input.run)
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
        pinned: loadSettings().pinnedKnowledgeBaseIds.includes(knowledgeBaseId),
        onTogglePin: () => {
          window.webContents.send(IPC_CHANNELS.kbPinToggleRequested, knowledgeBaseId)
        },
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
  /**
   * 启动 IDE 并把**启动器**的过程做成命令任务。
   *
   * 正常打开时只创建任务、不请求展开面板（不抢焦点）；失败才请求展开，
   * 让用户直接看到命令、目标路径与错误。
   */
  const launchIdeTask = async (
    knowledgeBaseId: string,
    targetPath: string
  ): Promise<IdeLaunchResult> => {
    const location = workspaceManager.getLocation(knowledgeBaseId)
    const { handle: task } = commandTaskManager.claimHandle({
      knowledgeBaseId,
      knowledgeBaseName: location.name,
      kind: 'launch-ide',
      title: '启动 IDE',
      cwd: targetPath
    })
    task.stage('running', '启动 IDE')
    const result = await launchIde(targetPath, (stream, chunk) => task.write(stream, chunk))
    task.command(result.command)
    if (result.ok) {
      commandTaskManager.finishRun(task.id, task.run, 'done', null)
      return result
    }
    commandTaskManager.finishRun(
      task.id,
      task.run,
      'failed',
      [result.error, result.stderr.trim()].filter(Boolean).join('\n')
    )
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      // 失败才抢一次注意力：展开面板并定位到这条任务
      window.webContents.send(IPC_CHANNELS.commandTaskReveal, task.id)
    }
    return result
  }

  handle(
    IPC_CHANNELS.ideOpenKnowledgeBase,
    getWindow,
    z.string().min(1),
    async (knowledgeBaseId) => {
      const result = await launchIdeTask(
        knowledgeBaseId,
        workspaceManager.getLocation(knowledgeBaseId).rootPath
      )
      if (!result.ok) throw new Error(result.error ?? '启动 IDE 失败')
    }
  )
  handle(
    IPC_CHANNELS.ideOpenNote,
    getWindow,
    z.object({ knowledgeBaseId: z.string().min(1), noteUuid: z.string().min(1) }),
    async ({ knowledgeBaseId, noteUuid }) => {
      const result = await launchIdeTask(
        knowledgeBaseId,
        workspaceManager.getNoteLocation(knowledgeBaseId, noteUuid)
      )
      if (!result.ok) throw new Error(result.error ?? '启动 IDE 失败')
    }
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
