import { describe, expect, it, vi } from 'vitest'

import { TerminalManager, buildTerminalEnv, detectShell } from './terminalManager'

import type { PtyModule, PtyProcess, PtySpawnOptions } from './terminalManager'

/** 假 PTY：把 spawn 参数、写入、pause/resume 都记下来，并允许手工喂输出。 */
function createFakePty() {
  const writes: string[] = []
  const resizes: Array<{ cols: number; rows: number }> = []
  const kills: string[] = []
  let dataListener: ((data: string) => void) | null = null
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null
  let paused = false
  let resumeCount = 0
  let pauseCount = 0

  const child: PtyProcess = {
    pid: 4242,
    write: (data) => writes.push(data),
    resize: (cols, rows) => resizes.push({ cols, rows }),
    kill: (signal) => kills.push(signal ?? 'default'),
    pause: () => {
      if (paused) return
      paused = true
      pauseCount += 1
    },
    resume: () => {
      if (!paused) return
      paused = false
      resumeCount += 1
    },
    onData: (listener) => {
      dataListener = listener
      return { dispose: () => (dataListener = null) }
    },
    onExit: (listener) => {
      exitListener = listener
      return { dispose: () => (exitListener = null) }
    }
  }

  let lastOptions: PtySpawnOptions | null = null
  const module: PtyModule = {
    spawn: (_file, _args, options) => {
      lastOptions = options
      return child
    }
  }

  return {
    module,
    writes,
    resizes,
    kills,
    emitData: (data: string) => dataListener?.(data),
    emitExit: (exitCode = 0, signal?: number) => exitListener?.({ exitCode, signal }),
    isPaused: () => paused,
    pauseCount: () => pauseCount,
    resumeCount: () => resumeCount,
    lastOptions: () => lastOptions
  }
}

interface SetupOptions {
  highWatermark?: number
  lowWatermark?: number
  flushIntervalMs?: number
}

function setup(options: SetupOptions = {}) {
  const pty = createFakePty()
  const manager = new TerminalManager({ loadPty: () => pty.module, ...options })
  const states: string[] = []
  const data: Array<{ data: string; bytes: number }> = []
  manager.onChanged((state) => states.push(`${state.status}:${state.title}`))
  manager.onData((event) => data.push({ data: event.data, bytes: event.bytes }))
  return { pty, manager, states, data }
}

describe('detectShell', () => {
  it('优先使用有效的 $SHELL', () => {
    const { shell, args } = detectShell('darwin', { SHELL: '/bin/bash' })
    expect(shell).toBe('/bin/bash')
    expect(args).toEqual(['-l'])
  })

  it('$SHELL 无效时回退到系统可用 shell', () => {
    const { shell } = detectShell('darwin', { SHELL: '/definitely/not/a/shell' })
    expect(['/bin/zsh', '/bin/bash', '/bin/sh']).toContain(shell)
  })

  it('只检查存在性是不够的：不可执行的文件不能当 shell', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'desk-shell-'))
    try {
      const file = join(dir, 'not-executable')
      writeFileSync(file, '#!/bin/sh\n')
      chmodSync(file, 0o644)
      const { shell } = detectShell('darwin', { SHELL: file })
      expect(shell).not.toBe(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Windows 分支总能给出可执行文件，且不带登录参数', () => {
    // 具体选中哪个 PowerShell 取决于该机的 Program Files（macOS 上必定不存在），
    // 所以只断言跨平台成立的契约：有结果、不带 -l。
    for (const SystemRoot of ['C:\\Windows', 'C:\\definitely-not-here']) {
      const { shell, args } = detectShell('win32', { SystemRoot })
      expect(shell).toBeTruthy()
      expect(args).toEqual([])
    }
    const fallback = detectShell('win32', {
      SystemRoot: 'C:\\definitely-not-here',
      ProgramFiles: 'C:\\definitely-not-here'
    })
    expect(fallback.shell.toLowerCase()).toContain('cmd')
  })
})

describe('buildTerminalEnv', () => {
  it('只补缺失项，绝不覆盖已有值', () => {
    const { env, filled } = buildTerminalEnv({
      SHELL: '/bin/bash',
      LANG: 'zh_CN.UTF-8',
      PATH: '/custom/bin',
      TERM: 'screen-256color'
    })
    expect(env.LANG).toBe('zh_CN.UTF-8')
    expect(env.TERM).toBe('screen-256color')
    expect(env.PATH).toBe('/custom/bin')
    expect(filled).toEqual(['COLORTERM'])
  })

  it('缺失时补上 TERM / COLORTERM / LANG', () => {
    const { env, filled } = buildTerminalEnv({})
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.LANG).toBeTruthy()
    expect(filled).toEqual(['TERM', 'COLORTERM', 'LANG'])
  })

  it('TERM=dumb 视为不可用值，升级为 xterm-256color', () => {
    // Finder 启动的打包应用、部分 CI 会带着 TERM=dumb：那会让颜色与 TUI 降级
    const { env, filled } = buildTerminalEnv({ TERM: 'dumb' })
    expect(env.TERM).toBe('xterm-256color')
    expect(filled).toContain('TERM')
  })

  it('用户显式设置的 TERM 不被改动', () => {
    const { env } = buildTerminalEnv({ TERM: 'screen-256color' })
    expect(env.TERM).toBe('screen-256color')
  })

  it('不手工拼 PATH（让登录 shell 自己解析）', () => {
    const { env } = buildTerminalEnv({})
    expect(env.PATH).toBeUndefined()
  })
})

describe('会话生命周期', () => {
  const input = { knowledgeBaseId: 'kb-1', knowledgeBaseName: 'TNotes.kb', cwd: '/kb' }

  it('创建会话：spawn 用传入的 cwd 与补全后的环境', () => {
    const { manager, pty } = setup()
    const created = manager.create(input)

    expect(created.status).toBe('running')
    expect(created.pid).toBe(4242)
    expect(created.cwd).toBe('/kb')
    expect(created.error).toBeNull()
    expect(pty.lastOptions()?.cwd).toBe('/kb')
    // 不能断言等于 xterm-256color：父进程可能带了别的有效 TERM（本测试环境是 dumb，
    // 会被升级）；这里断言的是"一定是个可用的终端类型"
    expect(pty.lastOptions()?.env?.TERM).toBeTruthy()
    expect(pty.lastOptions()?.env?.TERM).not.toBe('dumb')
    expect(manager.list()).toHaveLength(1)
  })

  it('spawn 失败不抛出，落到 dto.error 与 exited', () => {
    const manager = new TerminalManager({
      loadPty: () => ({
        spawn: () => {
          throw new Error('posix_spawnp failed.')
        }
      })
    })
    const created = manager.create(input)
    expect(created.status).toBe('exited')
    expect(created.error).toContain('posix_spawnp failed')
    expect(created.pid).toBeNull()
  })

  it('正常退出：转 exited 并保留退出码，会话仍在列表里', () => {
    const { manager, pty, states } = setup()
    const created = manager.create(input)

    pty.emitExit(0)

    const [session] = manager.list()
    expect(session.status).toBe('exited')
    expect(session.exitCode).toBe(0)
    expect(session.pid).toBeNull()
    expect(states.at(-1)).toBe(`exited:${created.title}`)
    // 「输出保留」的前提是会话对象还在
    expect(manager.list()).toHaveLength(1)
  })

  it('异常退出（带信号）也如实记录', () => {
    const { manager, pty } = setup()
    manager.create(input)
    pty.emitExit(137, 9)
    const [session] = manager.list()
    expect(session.status).toBe('exited')
    expect(session.exitCode).toBe(137)
    expect(session.exitSignal).toBe(9)
  })

  it('重启：重新 spawn、回到 running、退出码清空，标签与 cwd 不变', () => {
    const { manager, pty } = setup()
    const created = manager.create(input)
    manager.rename(created.id, '我的终端')
    pty.emitExit(0)

    const restarted = manager.restart(created.id)
    expect(restarted.status).toBe('running')
    expect(restarted.exitCode).toBeNull()
    expect(restarted.pid).toBe(4242)
    expect(restarted.title).toBe('我的终端')
    expect(restarted.cwd).toBe('/kb')
  })

  it('重命名去空白并限长；空串忽略', () => {
    const { manager } = setup()
    const created = manager.create(input)
    expect(manager.rename(created.id, '  新名字  ').title).toBe('新名字')
    expect(manager.rename(created.id, '   ').title).toBe('新名字')
    expect(manager.rename(created.id, 'x'.repeat(200)).title).toHaveLength(60)
  })

  it('关闭会话会结束进程并移出列表', () => {
    const { manager, pty } = setup()
    const created = manager.create(input)
    manager.close(created.id)
    expect(pty.kills.length).toBe(1)
    expect(manager.list()).toHaveLength(0)
  })

  it('dispose 结束所有会话并清空', () => {
    const { manager, pty } = setup()
    manager.create(input)
    manager.create({ ...input, cwd: '/kb/sub' })
    manager.dispose()
    expect(pty.kills.length).toBe(2)
    expect(manager.list()).toHaveLength(0)
  })

  it('dispose 之后创建会被拒绝', () => {
    const { manager } = setup()
    manager.dispose()
    expect(() => manager.create(input)).toThrow()
  })

  it('resize 做范围钳制，无变化时不打扰 PTY', () => {
    const { manager, pty } = setup()
    const created = manager.create({ ...input, cols: 80, rows: 24 })
    manager.resize(created.id, 120, 40)
    expect(pty.resizes).toEqual([{ cols: 120, rows: 40 }])
    manager.resize(created.id, 120, 40)
    expect(pty.resizes).toHaveLength(1)
    manager.resize(created.id, 99_999, 99_999)
    expect(pty.resizes.at(-1)).toEqual({ cols: 1000, rows: 500 })
    manager.resize(created.id, 0, 0)
    expect(pty.resizes.at(-1)).toEqual({ cols: 2, rows: 1 })
  })

  it('write 把数据转给 PTY', () => {
    const { manager, pty } = setup()
    const created = manager.create(input)
    manager.write(created.id, 'ls\r')
    expect(pty.writes).toEqual(['ls\r'])
  })

  it('会话标签重名时自动加序号', () => {
    const { manager } = setup()
    const first = manager.create(input)
    const second = manager.create({ ...input, cwd: '/kb/two' })
    expect(second.title).not.toBe(first.title)
    expect(second.title).toMatch(/\(\d\)$/)
  })
})

describe('流控（背压）', () => {
  const input = { knowledgeBaseId: 'kb-1', knowledgeBaseName: 'TNotes.kb', cwd: '/kb' }

  it('高吞吐：暂停 → 回执后恢复 → 数据完整不丢', async () => {
    vi.useFakeTimers()
    try {
      const { manager, pty, data } = setup({
        highWatermark: 10 * 1024,
        lowWatermark: 1024,
        flushIntervalMs: 5
      })
      const created = manager.create(input)

      // 单块就超过高水位：push 阶段（还没 flush）就应该暂停
      pty.emitData('x'.repeat(20 * 1024))
      expect(pty.isPaused()).toBe(true)
      expect(pty.pauseCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(10)
      expect(data).toHaveLength(1)
      expect(data[0].data).toHaveLength(20 * 1024)

      // 只回执一半：仍在低水位之上，保持暂停
      manager.ack(created.id, 10 * 1024)
      expect(pty.isPaused()).toBe(true)

      // 回执清空：恢复
      manager.ack(created.id, 10 * 1024)
      expect(pty.isPaused()).toBe(false)
      expect(pty.resumeCount()).toBe(1)

      // 再灌一批：暂停/恢复可反复发生，内容一字不差
      pty.emitData('a'.repeat(8 * 1024))
      pty.emitData('b'.repeat(8 * 1024))
      expect(pty.isPaused()).toBe(true)
      await vi.advanceTimersByTimeAsync(10)
      const delivered = data.map((item) => item.data).join('')
      expect(delivered).toHaveLength(20 * 1024 + 16 * 1024)
      manager.ack(created.id, 16 * 1024)
      expect(pty.isPaused()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('慢消费者：待发送 + 已发送未确认 一起算，队列被压在水位附近', async () => {
    vi.useFakeTimers()
    try {
      const { manager, pty, data } = setup({
        highWatermark: 8 * 1024,
        lowWatermark: 1024,
        flushIntervalMs: 5
      })
      const created = manager.create(input)

      // 完全不回执，连续灌 40 块
      for (let index = 0; index < 40; index += 1) pty.emitData('y'.repeat(1024))
      await vi.advanceTimersByTimeAsync(50)

      const snapshot = manager.backpressureSnapshot()[0]
      expect(snapshot.paused).toBe(true)
      expect(snapshot.unacked + snapshot.pending).toBeLessThanOrEqual(40 * 1024)
      // 只暂停一次，而不是每块都 pause
      expect(pty.pauseCount()).toBe(1)
      expect(data.length).toBeGreaterThan(0)

      manager.ack(created.id, snapshot.unacked)
      expect(pty.isPaused()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('合批发送不丢数据，字节数与内容一致', async () => {
    vi.useFakeTimers()
    try {
      const { manager, pty, data } = setup({ flushIntervalMs: 5 })
      const created = manager.create(input)
      pty.emitData('第一段')
      pty.emitData('第二段')
      await vi.advanceTimersByTimeAsync(10)
      expect(data).toHaveLength(1)
      expect(data[0].data).toBe('第一段第二段')
      expect(data[0].bytes).toBe(Buffer.byteLength('第一段第二段'))
      manager.ack(created.id, data[0].bytes)
    } finally {
      vi.useRealTimers()
    }
  })

  it('进程退出前会把残留输出冲刷出去', async () => {
    vi.useFakeTimers()
    try {
      const { manager, pty, data } = setup({ flushIntervalMs: 5 })
      manager.create(input)
      pty.emitData('最后一行')
      pty.emitExit(0)
      expect(data.map((item) => item.data).join('')).toBe('最后一行')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PTY 回调不许把异常抛回原生层（会 abort 整个应用）', () => {
  const input = { knowledgeBaseId: 'kb-1', knowledgeBaseName: 'TNotes.kb', cwd: '/kb' }

  // 真实崩溃栈：pty.node → Napi::ThreadSafeFunction::CallJS → __cxa_throw → abort。
  // 窗口销毁时 webContents.send 会抛，如果异常穿过 onData/onExit 回调就会崩进程。
  it('数据监听器抛异常：被吞掉、记日志，会话继续工作', async () => {
    vi.useFakeTimers()
    try {
      const fake = createFakePty()
      const manager = new TerminalManager({ loadPty: () => fake.module, flushIntervalMs: 5 })
      const created = manager.create(input)
      manager.onData(() => {
        throw new Error('webContents 已销毁')
      })

      expect(() => fake.emitData('boom')).not.toThrow()
      await vi.advanceTimersByTimeAsync(10)
      // 会话仍然可用：还能继续收数据、还能写
      expect(manager.list()[0].status).toBe('running')
      manager.write(created.id, 'ls\r')
      expect(fake.writes).toEqual(['ls\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('状态监听器抛异常：onExit 回调不崩，退出状态照常记录', () => {
    const fake = createFakePty()
    const manager = new TerminalManager({ loadPty: () => fake.module })
    manager.create(input)
    manager.onChanged(() => {
      throw new Error('窗口已关闭')
    })

    expect(() => fake.emitExit(0)).not.toThrow()
    expect(manager.list()[0].status).toBe('exited')
    expect(manager.list()[0].exitCode).toBe(0)
  })

  it('onData 订阅方抛异常不影响后续输出', async () => {
    vi.useFakeTimers()
    try {
      const fake = createFakePty()
      const manager = new TerminalManager({ loadPty: () => fake.module, flushIntervalMs: 5 })
      const seen: string[] = []
      let throwOnce = true
      manager.onData((event) => {
        if (throwOnce) {
          throwOnce = false
          throw new Error('第一次就炸')
        }
        seen.push(event.data)
      })
      manager.create(input)

      fake.emitData('第一段')
      await vi.advanceTimersByTimeAsync(10)
      fake.emitData('第二段')
      await vi.advanceTimersByTimeAsync(10)
      expect(seen).toEqual(['第二段'])
    } finally {
      vi.useRealTimers()
    }
  })
})
