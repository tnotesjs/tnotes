import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { GitManager } from './gitManager'

import type { GitRepositoryDescriptor } from './workspace/types'

/**
 * 应用退出要能**真的**终止正在跑的 Git 进程（走真实执行路径）。
 *
 * 链路：`runGit` 把终止器注册进 `onSpawn` → `GitManager.enqueue` 收进
 * `disposeKills` → `dispose()` 逐个调用。此前 `runGit` 只 unregister、从不
 * register，这条链路是断的：退出时谁也碰不到正在跑的 git。
 *
 * 这里不用注入的假执行器，而是真实 `runGit` + 真实 git：
 * 远端用"接受连接但不响应"的本地服务，让 fetch 一直挂着（可控装置）。
 */

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  // 开发机可能设了 http_proxy：会把打到本地服务的请求交给代理，行为不可控
  NO_PROXY: '*',
  no_proxy: '*'
}

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV }).trim()
}

/** 建一个真实仓库并让 origin 指向"接受连接但不响应"的本地服务 */
async function makeHangingRepo(): Promise<{ root: string; port: number; close: () => void }> {
  const server = createServer(() => {})
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const root = mkdtempSync(join(tmpdir(), 'desk-dispose-'))
  roots.push(root)
  mkdirSync(join(root, 'notes'), { recursive: true })
  writeFileSync(join(root, 'notes', 'a.md'), 'x\n')
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'e@t'])
  git(root, ['config', 'user.name', 'e'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'c'])
  git(root, ['remote', 'add', 'origin', `http://127.0.0.1:${port}/never.git`])
  return {
    root,
    port,
    close: () => {
      server.closeAllConnections?.()
      server.close()
    }
  }
}

const descriptor = (id: string, root: string): GitRepositoryDescriptor =>
  ({
    knowledgeBaseId: id,
    knowledgeBaseName: `TNotes.${id}`,
    configId: `cfg-${id}`,
    rootPath: root,
    notes: []
  }) as GitRepositoryDescriptor

/**
 * 找出正在连这个可控远端的 git 进程。
 *
 * 不能用仓库路径识别：`git fetch` 的命令行里不带 cwd（实测踩过）。
 * 远端端口在命令行里（`git-remote-http origin http://127.0.0.1:<port>/...`），
 * 是精确且稳定的标识。
 */
const gitProcessesFor = (port: number): string[] =>
  execFileSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(`127.0.0.1:${port}`))
    .filter((line) => line.includes('git'))
    .filter((line) => !line.includes('ps -Ao'))

describe('应用退出终止正在运行的 Git 进程（真实 git + 可控远端）', () => {
  it('dispose() 收掉仍在挂着的 git fetch，且不留进程', async () => {
    const hanging = await makeHangingRepo()
    const id = `kb-${Date.now()}`
    const manager = new GitManager()
    manager.configure([descriptor(id, hanging.root)])
    await manager.whenQueueIdle(id)

    // 前台 fetch：超时 60s，保证它在 dispose 时还挂着（后台模式 15s 就自己结束了）
    const running = manager.fetch(id, false, {}).catch(() => undefined)
    // 等真的出现挂着的 git 进程
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && gitProcessesFor(hanging.port).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(gitProcessesFor(hanging.port).length).toBeGreaterThan(0)

    await manager.dispose()
    void running

    // 无残留：这个仓库的 git 进程必须都没了
    const gone = await (async () => {
      const until = Date.now() + 8000
      while (Date.now() < until && gitProcessesFor(hanging.port).length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return gitProcessesFor(hanging.port).length === 0
    })()
    expect(gone).toBe(true)
    hanging.close()
  }, 60000)
})
