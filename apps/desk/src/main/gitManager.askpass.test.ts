import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./settings', () => ({ loadSettings: () => ({ gitPath: '' }) }))

import { runGit, type GitAskpassBridge } from './gitManager'

function fakeBridge(): {
  bridge: GitAskpassBridge
  setWaiting: (waiting: boolean) => void
  cancel: ReturnType<typeof vi.fn>
} {
  let listener: ((waiting: boolean) => void) | null = null
  const cancel = vi.fn()
  return {
    bridge: {
      env: { GIT_ASKPASS: '/tmp/tn-askpass.sh', TNOTES_ASKPASS_RUN: 'task:1' },
      onWaiting: (next) => {
        listener = next
        return () => {
          listener = null
        }
      },
      cancel
    },
    setWaiting: (waiting) => listener?.(waiting),
    cancel
  }
}

describe('runGit 的凭据桥', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tn-git-askpass-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('把凭据桥的环境变量交给 git，且仍保留 GIT_TERMINAL_PROMPT=0', async () => {
    const { bridge, cancel } = fakeBridge()
    const result = await runGit(
      dir,
      ['-c', 'alias.env=!printf "%s|%s" "$GIT_ASKPASS" "$GIT_TERMINAL_PROMPT"', 'env'],
      10_000,
      { askpass: bridge }
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('/tmp/tn-askpass.sh|0')
    // 结算时关掉这一轮残留的询问
    expect(cancel).toHaveBeenCalled()
  })

  it('不传凭据桥时不注入 GIT_ASKPASS', async () => {
    const result = await runGit(
      dir,
      ['-c', 'alias.env=!printf "[%s]" "$TNOTES_ASKPASS_RUN"', 'env'],
      10_000
    )
    expect(result.stdout).toBe('[]')
  })

  it('凭据框打开期间暂停超时计时，关闭后按剩余时间继续', async () => {
    const { bridge, setWaiting } = fakeBridge()
    // 不暂停的话 300ms 就会超时；暂停 400ms 后剩余 ~300ms，足够 sleep 0.5 跑完
    const running = runGit(dir, ['-c', 'alias.nap=!sleep 0.5', 'nap'], 300, { askpass: bridge })
    setWaiting(true)
    await new Promise((resolve) => setTimeout(resolve, 400))
    setWaiting(false)
    const result = await running
    expect(result.code).toBe(0)
  })

  it('没有凭据框时照常超时', async () => {
    const { bridge } = fakeBridge()
    const result = await runGit(dir, ['-c', 'alias.nap=!sleep 2', 'nap'], 200, {
      askpass: bridge
    })
    expect(result.code).toBe(124)
  })
})
