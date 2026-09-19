// @vitest-environment happy-dom

import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createGit, type GitContext } from './git'

import type { GitRepositoryStateDto, WorkspaceOverview } from '../../../../shared/contracts'

/**
 * 推送的**完整业务流程**：认领 → 声明开始 → 保存 → Git。
 *
 * 这里钉住的是"保存阶段"的语义——单看 `runGitWithTask` 覆盖不到这一段：
 *  - 保存期间收到的取消要有归属（不能按知识库去猜一个 Git 队列项，那会误伤同库其他任务）；
 *  - 保存完成后若这一轮已被取消，**不得**进入 Git，也不得重新认领。
 */

function state(): GitRepositoryStateDto {
  return {
    knowledgeBaseId: 'kb1',
    knowledgeBaseName: 'TNotes.kb1',
    initialized: true,
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    changes: [],
    conflict: false,
    busy: null,
    lastFetchedAt: null,
    error: null
  } as unknown as GitRepositoryStateDto
}

const commandTaskApi = {
  claim: vi.fn(),
  begin: vi.fn(),
  reportStage: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn(),
  list: vi.fn(),
  close: vi.fn(),
  retry: vi.fn(),
  onChanged: vi.fn(),
  onLog: vi.fn(),
  onReveal: vi.fn(),
  onRetryRequested: vi.fn()
}
const gitApi = {
  fetch: vi.fn(),
  pull: vi.fn(),
  publish: vi.fn(),
  list: vi.fn(),
  refresh: vi.fn()
}

function makeContext(): GitContext & {
  error: { value: string | null }
  status: { value: string | null }
  saveAllDocuments: ReturnType<typeof vi.fn>
} {
  const overview = {
    allKnowledgeBases: [{ id: 'kb1', displayName: 'TNotes.kb1', rootPath: '/kb1' }]
  } as unknown as WorkspaceOverview
  return {
    gitStates: ref({}),
    gitAttention: ref(null),
    pendingGitPublishId: ref(null),
    overview: ref(overview),
    settings: ref(null),
    error: ref<string | null>(null),
    status: ref<string | null>(null),
    saveAllDocuments: vi.fn(async () => {}),
    refreshWorkspace: vi.fn(async () => {})
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  Object.defineProperty(window, 'desk', {
    configurable: true,
    value: { commandTask: commandTaskApi, git: gitApi }
  })
  commandTaskApi.claim.mockResolvedValue({ ok: true, value: { id: 't1', run: 1 } })
  commandTaskApi.begin.mockResolvedValue({ ok: true, value: true })
  commandTaskApi.reportStage.mockResolvedValue({ ok: true, value: true })
  commandTaskApi.finish.mockResolvedValue({ ok: true, value: undefined })
})

describe('推送：保存阶段被取消', () => {
  it('保存期间取消、保存随后完成 → 不执行任何 Git 写操作，也不重新认领', async () => {
    const ctx = makeContext()
    const git = createGit(ctx)

    let releaseSave: () => void = () => {}
    ctx.saveAllDocuments.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve
        })
    )
    // 保存结束时那一轮已不是当前运行（已被取消）
    commandTaskApi.reportStage.mockImplementation(async (_id, _run, stage) => ({
      ok: true,
      value: stage !== 'precheck'
    }))

    const publishing = git.publishGit('kb1')
    // 等它真的进到保存阶段
    await vi.waitFor(() => expect(ctx.saveAllDocuments).toHaveBeenCalled())
    releaseSave()
    await publishing

    // 关键断言：保存完成后**没有**执行 add/commit/push（publish 一次都没调）
    expect(gitApi.publish).not.toHaveBeenCalled()
    expect(gitApi.fetch).not.toHaveBeenCalled()
    expect(gitApi.pull).not.toHaveBeenCalled()
    // 也不重新认领（认领一次 = 创建这一轮；再认领会把已取消的操作复活）
    expect(commandTaskApi.claim).toHaveBeenCalledTimes(1)
    // 任务以 canceled 收尾，而不是被悄悄丢掉
    expect(commandTaskApi.finish).toHaveBeenCalledWith('t1', 1, 'canceled', '任务已取消')
  })

  it('进入 Git 之前已不是当前运行（begin 返回 false）→ 直接收手', async () => {
    const ctx = makeContext()
    const git = createGit(ctx)
    commandTaskApi.begin.mockResolvedValue({ ok: true, value: false })

    await git.publishGit('kb1')

    expect(ctx.saveAllDocuments).not.toHaveBeenCalled()
    expect(gitApi.publish).not.toHaveBeenCalled()
    expect(commandTaskApi.claim).toHaveBeenCalledTimes(1)
  })

  it('保存失败 → 任务标 failed 且原因可读，不发生 Git 写操作', async () => {
    const ctx = makeContext()
    const git = createGit(ctx)
    ctx.saveAllDocuments.mockRejectedValue(new Error('磁盘只读'))

    await git.publishGit('kb1')

    expect(gitApi.publish).not.toHaveBeenCalled()
    expect(commandTaskApi.finish).toHaveBeenCalledWith('t1', 1, 'failed', '保存失败：磁盘只读')
  })

  it('保存成功且未取消 → 进入 Git，并把这一轮的 run 传给主进程（不得靠认领复活）', async () => {
    const ctx = makeContext()
    const git = createGit(ctx)
    gitApi.publish.mockResolvedValue({
      ok: true,
      value: { state: state(), message: 'ok', conflict: false }
    })

    await git.publishGit('kb1')

    expect(gitApi.publish).toHaveBeenCalledWith('kb1', 't1', 1)
    expect(commandTaskApi.finish).not.toHaveBeenCalled()
  })
})
