import type { Ref } from 'vue'

import type {
  AppSettings,
  GitRepositoryStateDto,
  WorkspaceOverview
} from '../../../../shared/contracts'

import { resultValue, type GitAttention } from './helpers'
import { useCommandTaskStore } from '../commandTask'

export interface GitContext {
  gitStates: Ref<Record<string, GitRepositoryStateDto>>
  gitAttention: Ref<GitAttention | null>
  pendingGitPublishId: Ref<string | null>
  overview: Ref<WorkspaceOverview>
  settings: Ref<AppSettings | null>
  error: Ref<string | null>
  status: Ref<string | null>
  saveAllDocuments: () => Promise<void>
  refreshWorkspace: () => Promise<void>
}

export function createGit(ctx: GitContext) {
  async function refreshGit(knowledgeBaseId?: string): Promise<void> {
    try {
      const states = resultValue(await window.desk.git.refresh(knowledgeBaseId))
      ctx.gitStates.value = Object.fromEntries(
        states.map((state) => [state.knowledgeBaseId, state])
      )
    } catch (cause) {
      ctx.error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const commandTasks = useCommandTaskStore()

  /** 知识库根目录：显式取出基本类型，避免把响应式代理交给 IPC。 */
  function commandTaskCwd(knowledgeBaseId: string): string {
    const found = ctx.overview.value.allKnowledgeBases.find((item) => item.id === knowledgeBaseId)
    return typeof found?.rootPath === 'string' ? found.rootPath : ''
  }

  /** 执行一次带面板展示的 Git 操作：任务标签在命令开始前就存在，前置失败也能看到原因。 */
  async function runGitWithTask(
    knowledgeBaseId: string,
    kind: 'git-pull' | 'git-push' | 'git-fetch',
    claimed?: { id: string; run: number }
  ): Promise<void> {
    // 注意：传给 IPC 的必须是**普通值**。`ctx.overview.value...` 是 Vue 响应式代理，
    // Electron 的 structured clone 克隆不了它，invoke 会直接抛
    // 「An object could not be cloned.」。认领也不能在 try 之外——它抛错时
    // 整个流程会静默中断（用户点了没反应，控制台也看不到原因）。
    let task: { id: string; run: number } | null = null
    try {
      task =
        claimed ??
        (await commandTasks.claim({
          knowledgeBaseId,
          kind,
          title:
            kind === 'git-pull' ? '拉取更新' : kind === 'git-push' ? '推送更改' : '获取远端更新',
          cwd: commandTaskCwd(knowledgeBaseId)
        }))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      ctx.error.value = message
      return
    }
    if (!task) {
      ctx.error.value = '无法创建命令任务'
      return
    }
    try {
      const result = resultValue(
        await window.desk.git[
          kind === 'git-fetch' ? 'fetch' : kind === 'git-pull' ? 'pull' : 'publish'
        ](knowledgeBaseId, task.id)
      )
      ctx.gitStates.value = { ...ctx.gitStates.value, [knowledgeBaseId]: result.state }
      if (kind === 'git-pull' && result.conflict) {
        const descriptor = ctx.overview.value.allKnowledgeBases.find(
          (item) => item.id === knowledgeBaseId
        )
        ctx.gitAttention.value = {
          knowledgeBaseId,
          knowledgeBaseName: descriptor?.displayName ?? result.state.knowledgeBaseName,
          kind: 'conflict',
          message: result.message
        }
      } else {
        ctx.status.value = result.message
        if (kind === 'git-pull') await ctx.refreshWorkspace()
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      ctx.error.value = message
      // 失败原因进任务记录；输出由主进程保留，这里只负责让用户能看到
      void commandTasks.finish(task.id, task.run, 'failed', message)
    }
  }

  async function fetchGit(knowledgeBaseId: string): Promise<void> {
    await runGitWithTask(knowledgeBaseId, 'git-fetch')
  }

  /** 确认拉取：**立即**关掉提醒弹窗，任务在面板里继续跑。 */
  function confirmPull(knowledgeBaseId: string): void {
    ctx.gitAttention.value = null
    void runGitWithTask(knowledgeBaseId, 'git-pull')
  }

  async function pullGit(knowledgeBaseId: string): Promise<void> {
    ctx.gitAttention.value = null
    await runGitWithTask(knowledgeBaseId, 'git-pull')
  }

  function requestGitPublish(knowledgeBaseId: string): void {
    if (ctx.settings.value?.confirmBeforeCommit) {
      ctx.pendingGitPublishId.value = knowledgeBaseId
    } else {
      void publishGit(knowledgeBaseId)
    }
  }

  async function publishGit(knowledgeBaseId: string): Promise<void> {
    ctx.pendingGitPublishId.value = null
    const task = await commandTasks.claim({
      knowledgeBaseId,
      kind: 'git-push',
      title: '推送更改',
      cwd:
        ctx.overview.value.allKnowledgeBases.find((item) => item.id === knowledgeBaseId)
          ?.rootPath ?? ''
    })
    if (!task) {
      ctx.error.value = '无法创建命令任务'
      return
    }
    // 推送前先受控保存：这一步的进度与失败原因也要出现在任务里
    await commandTasks.reportStage(task.id, task.run, 'saving', '保存未提交的更改')
    try {
      await ctx.saveAllDocuments()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      ctx.error.value = message
      await commandTasks.finish(task.id, task.run, 'failed', `保存失败：${message}`)
      return
    }
    await runGitWithTask(knowledgeBaseId, 'git-push', { id: task.id, run: task.run })
  }

  async function openKnowledgeBaseInIde(knowledgeBaseId: string): Promise<void> {
    const result = await window.desk.ide.openKnowledgeBase(knowledgeBaseId)
    if (!result.ok) ctx.error.value = result.error.message
  }

  return {
    refreshGit,
    fetchGit,
    pullGit,
    confirmPull,
    requestGitPublish,
    publishGit,
    openKnowledgeBaseInIde
  }
}

export type GitApi = ReturnType<typeof createGit>
