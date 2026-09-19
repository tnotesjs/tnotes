import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { runGit } from './gitManager'

/**
 * `runGit` 的真实进程语义（真 git 子进程）。
 *
 * 这里钉的是一个**实测过的严重缺陷**：git push 会再 fork 出
 * `git-remote-http` 之类的孙子进程，它们继承 stdout/stderr 管道。
 * 只等 Node 的 'close' 事件时，git 自己已经退出、管道却仍然打开，
 * 'close' 就永远不来 —— 超时杀掉 git 之后，任务会**永远停在「运行中」**。
 * 所以：结算以 'exit' 为准，并且要杀掉整个进程组（否则孙子进程会留下来）。
 */

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  // 开发机可能设了 http_proxy：会把打到本地服务的请求交给代理，行为就不可控了
  NO_PROXY: '*',
  no_proxy: '*'
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV }).trim()
}

const roots: string[] = []
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-runGit-'))
  roots.push(root)
  mkdirSync(join(root, 'notes'), { recursive: true })
  writeFileSync(join(root, 'notes', 'a.md'), 'x\n')
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'e@t'])
  git(root, ['config', 'user.name', 'e'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', '初始'])
  return root
}

/** 接受连接但**永不响应**的服务：稳定卡住 git 的 HTTP 传输，不依赖外网。 */
async function startHangingServer() {
  const server = createServer(() => {})
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/never.git`,
    close: () => {
      server.closeAllConnections?.()
      server.close()
    }
  }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('runGit 的超时与进程清理（真 git）', () => {
  it('远端挂着不响应时，超时会结算（不会永远停在运行中）并保留已有输出', async () => {
    const hanging = await startHangingServer()
    try {
      const root = makeRepo()
      // 先推到一个真实的裸远端建立上游，再换成挂住的服务：否则 push 会立刻失败
      const bare = join(mkdtempSync(join(tmpdir(), 'desk-runGit-bare-')), 'r.git')
      roots.push(bare)
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: GIT_ENV })
      git(root, ['remote', 'add', 'origin', bare])
      git(root, ['push', '-q', '-u', 'origin', 'main'])
      git(root, ['remote', 'set-url', 'origin', hanging.url])
      writeFileSync(join(root, 'notes', 'a.md'), 'y\n')
      git(root, ['add', '-A'])
      git(root, ['commit', '-q', '-m', '第二笔'])

      const output: string[] = []
      const started = Date.now()
      const result = await runGit(root, ['push'], 1500, {
        observer: { output: (_stream, chunk) => output.push(chunk) }
      })
      const elapsed = Date.now() - started

      // 关键：必须结算（这里就是原缺陷——'close' 永不触发导致永不结算）
      expect(result.code).toBe(124)
      expect(result.stderr).toContain('超时')
      // 结算要快：超时 1500ms + SIGTERM/强杀兜底，远小于这里的 20s
      expect(elapsed).toBeLessThan(20000)
      // 超时不覆盖已有输出（进程挂住期间输出可能为空，但绝不能是异常）
      expect(typeof result.stdout).toBe('string')
    } finally {
      hanging.close()
    }
  }, 30000)

  it('超时后不留下还活着的 git 子孙进程', async () => {
    const hanging = await startHangingServer()
    try {
      const root = makeRepo()
      const bare = join(mkdtempSync(join(tmpdir(), 'desk-runGit-bare2-')), 'r.git')
      roots.push(bare)
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: GIT_ENV })
      git(root, ['remote', 'add', 'origin', bare])
      git(root, ['push', '-q', '-u', 'origin', 'main'])
      git(root, ['remote', 'set-url', 'origin', hanging.url])
      writeFileSync(join(root, 'notes', 'a.md'), 'z\n')
      git(root, ['add', '-A'])
      git(root, ['commit', '-q', '-m', '第三笔'])

      const result = await runGit(root, ['push'], 1500)
      expect(result.code).toBe(124)

      // git 的传输子进程会带 -C <这个仓库> 的痕迹；超时后不该再有它
      const ps = execFileSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8' })
      const leftovers = ps
        .split('\n')
        .filter((line) => line.includes(root) && line.includes('git'))
        .filter((line) => !line.includes('ps -Ao'))
      expect(leftovers).toEqual([])
    } finally {
      hanging.close()
    }
  }, 30000)
})
