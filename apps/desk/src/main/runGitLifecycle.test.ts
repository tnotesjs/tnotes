import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { runGit } from './gitManager'

/**
 * `runGit` 的进程生命周期（**可控子进程**，不依赖 git/网络）。
 *
 * "git 可执行文件"指向受控脚本，脚本按参数扮演我们要的进程形态：
 *  1. **正常完成要等输出收尾**——只等 exit 会丢尾部输出；
 *  2. **不能提前解除占用**——主进程先退出、孙进程还占着管道时不算完；
 *  3. **强杀兜底在主进程退出后仍执行**——否则孙进程就是真正的残留；
 * 外加运行期间输出缓存的上限、以及 onSpawn 登记（应用退出要能终止它）。
 */

const settingsMock = vi.hoisted(() => ({ gitPath: 'node' as string | null }))
vi.mock('./settings', () => ({ loadSettings: () => ({ gitPath: settingsMock.gitPath }) }))

const fixture = mkdtempSync(join(tmpdir(), 'desk-runGit-life-'))

const SUBPROCESS = join(fixture, 'controlled-child.mjs')
// 心跳文件的表达方式要区分两层：
//  - 父脚本里用 `mark` 变量；
//  - 孙进程是**另一个进程**（node -e <字符串>），它没有 `mark`，必须把值作为
//    字面量拼进去（这里踩过：孙进程里 mark 未定义，异常还被 catch 吞了）。
const BEAT_HOST = 'process.env.DESK_TEST_DIR'
const BEAT_NAME = 'process.env.DESK_BEAT_NAME'
const BEAT_IN_GRANDCHILD = `${BEAT_HOST} + "/" + ${BEAT_NAME} + ".beat"`
writeFileSync(
  SUBPROCESS,
  `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [mode = 'normal-exit', mark = 'MARK', bytes = '1000'] = process.argv.slice(2)

// 用 write 回调而不是 process.exit：后者会在管道排空前就把进程干掉，
// 大输出只写得出 64KB，测不到执行层的缓存上限。
if (mode === 'normal-exit') {
  process.stdout.write('BEGIN_' + mark + '\\n')
  process.stdout.write('x'.repeat(Number(bytes)))
  process.stdout.write('\\nEND_' + mark + '\\n', () => process.exit(0))
} else if (mode === 'normal-exit-huge') {
  process.stdout.write('HEAD\\n')
  process.stdout.write('y'.repeat(Number(bytes)))
  process.stdout.write('\\nTAIL_OK\\n', () => process.exit(0))
} else if (mode === 'close-streams-but-alive') {
  // 主进程：**先关掉输出流但继续运行**，并忽略 SIGTERM。
  // 用来验证"管道关了 ≠ 进程结束了"，以及继续写心跳证明它还活着。
  const live = setInterval(() => {
    try { writeFileSync(process.env.DESK_TEST_DIR + '/' + process.env.DESK_BEAT_NAME + '.beat', String(Date.now())) } catch {}
  }, 50)
  process.stdout.write('BEFORE_CLOSE_' + mark + '\\n', () => {
    process.stdout.end()
    process.stderr.end()
    void live
  })
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
} else if (mode === 'parent-exits-grandchild-closes-streams') {
  // 父进程退出；孙进程**关掉自己的输出流但继续写心跳**。
  // 用来验证"管道关了"不能当成"所属进程组清理完成"。
  const source = [
    'const fs = require("node:fs")',
    'process.on("SIGTERM", () => {})',
    'setInterval(() => { try { fs.writeFileSync(process.env.DESK_TEST_DIR + "/" + process.env.DESK_BEAT_NAME + ".beat", String(Date.now())) } catch {} }, 50)',
    'process.stdout.end()',
    'process.stderr.end()',
    'setInterval(() => {}, 1000)'
  ].join(';')
  // 注意不要 unref：父进程要一直活着等取消（它为子进程保留一个 ref，
  // 否则子进程一被回收、事件循环就空了，父进程会自己退出）。
  spawn(process.execPath, ['-e', source], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env
  })
  process.on('SIGTERM', () => process.exit(0))
  process.stdout.write('PARENT_' + mark + '\\n')
  // 父进程自己也写心跳：测试据此确认"父进程还活着"这个前提
  setInterval(() => {
    try { writeFileSync(process.env.DESK_TEST_DIR + '/' + process.env.DESK_BEAT_NAME + '.parent.beat', String(Date.now())) } catch {}
  }, 50)
  setInterval(() => {}, 1000)
} else {
  // 孙进程：留在父进程的进程组里（真实 git 的 git-remote-http 就是这样），
  // 忽略 SIGTERM，持续持有 stdout 管道；心跳文件用来判定它何时才真的消亡
  // （SIGKILL 下 exit 回调不保证执行）。
  // 不能 detached：脱离进程组就收不到组 SIGKILL，会变成真正的残留。
  const source = [
    'const fs = require("node:fs")',
    'process.on("SIGTERM", () => {})',
    'setInterval(() => { try { fs.writeFileSync(${BEAT_IN_GRANDCHILD}, String(Date.now())) } catch {} }, 50)',
    'setInterval(() => process.stdout.write("gc-tick\\\\n"), 100)',
    'setInterval(() => {}, 1000)'
  ].join(';')
  spawn(process.execPath, ['-e', source], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env
  }).unref()

  process.on('SIGTERM', () => process.exit(0))
  process.stdout.write('PARENT_' + mark + '\\n')
  setInterval(() => process.stdout.write('parent-tick\\n'), 100)
  setInterval(() => {}, 1000)
}
`,
  'utf8'
)

afterAll(() => {
  try {
    execFileSync('pkill', ['-f', 'controlled-child.mjs'], { stdio: 'ignore' })
  } catch {
    /* 没有残留 */
  }
  rmSync(fixture, { recursive: true, force: true })
})

beforeEach(() => {
  settingsMock.gitPath = 'node'
  process.env.DESK_TEST_DIR = fixture
})

/** 等条件成立；用轮询而不是固定等待 */
async function waitUntil(check: () => boolean, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

const beatOf = (mark: string): number => {
  const path = join(fixture, `${mark}.beat`)
  return existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0
}

describe('runGit 生命周期（可控子进程）', () => {
  it('正常退出：等输出收尾，尾部输出完整', async () => {
    const mark = `N${Date.now()}`
    const chunks: string[] = []
    const result = await runGit(fixture, [SUBPROCESS, 'normal-exit', mark, '20000'], 15000, {
      observer: { output: (_stream, chunk) => chunks.push(chunk) }
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`BEGIN_${mark}`)
    // 只等 exit、不等流收尾时会丢这一行
    expect(result.stdout).toContain(`END_${mark}`)
    expect(chunks.join('')).toContain(`END_${mark}`)
  }, 30000)

  it('正常退出：超过执行层上限的大输出只保留尾部，且尾部信息不丢', async () => {
    const bytes = 3 * 1024 * 1024
    let observedBytes = 0
    const result = await runGit(
      fixture,
      [SUBPROCESS, 'normal-exit-huge', 'X', String(bytes)],
      30000,
      {
        observer: {
          output: (stream, chunk) => {
            if (stream === 'stdout') observedBytes += chunk.length
          }
        }
      }
    )

    expect(result.code).toBe(0)
    // 保留的是**尾部**（丢弃最旧的），尾部信息必须在
    expect(result.stdout).toContain('TAIL_OK')
    // 运行期间缓存被限制在 2MB 量级，而不是把 3MB 全留着
    expect(result.stdout.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 64)
    // 观察者是流式的：确实收到了远超上限的字节（证明上限作用在缓存上）
    expect(observedBytes).toBeGreaterThan(2 * 1024 * 1024 + 64)
  }, 60000)

  it('主进程响应 SIGTERM 退出、孙进程忽略 SIGTERM 并持有管道：不提前结算、强杀兜底仍执行、最终无残留、保留终止前输出', async () => {
    const mark = `C${Date.now()}`
    process.env.DESK_BEAT_NAME = mark
    const chunks: string[] = []
    let kill: (() => void) | null = null
    let unregistered = false

    const running = runGit(
      fixture,
      [SUBPROCESS, 'parent-exits-child-holds', mark],
      // 超时给足：这样"提前解除占用"只可能来自错误的 exit 结算
      120000,
      {
        onSpawn: {
          register: (fn) => {
            kill = fn
          },
          unregister: () => {
            unregistered = true
          }
        },
        observer: { output: (_stream, chunk) => chunks.push(chunk) }
      }
    )

    let settled = false
    void running.then(() => {
      settled = true
    })

    // ① 登记必须真的发生（应用退出路径就靠它）
    expect(await waitUntil(() => kill !== null)).toBe(true)
    expect(await waitUntil(() => chunks.join('').includes(`PARENT_${mark}`))).toBe(true)
    // 孙进程必须真的活着（心跳在更新），场景才成立
    expect(await waitUntil(() => beatOf(mark) > 0)).toBe(true)
    const first = beatOf(mark)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(beatOf(mark)).toBeGreaterThan(first)
    expect(settled).toBe(false)

    // ② 触发终止（模拟 gitManager.dispose / 应用退出调注册的终止器）
    const terminatedAt = Date.now()
    // 注意：必须显式取一次再调——直接 `kill()` 会被 TS 收窄成 never
    const terminate = kill as unknown as (() => void) | null
    if (!terminate) throw new Error('终止器未注册')
    terminate()

    // 父进程会很快退出，但孙进程忽略 SIGTERM、仍持有管道：
    // 这时候结算就是"提前解除任务占用"。
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(settled).toBe(false)
    expect(unregistered).toBe(false)
    const beatAt800 = beatOf(mark)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(beatOf(mark)).toBeGreaterThan(beatAt800)

    // ③ 强杀兜底之后才收敛（退出码由宿主的 kill 决定，dispose 路径不看它），
    //    并保留终止前的输出
    const result = await running
    const elapsed = Date.now() - terminatedAt
    // 终止必须真的发生（而不是"看起来结束了"）
    expect(['canceled', 'timeout']).toContain(
      result.stderr.includes('取消') ? 'canceled' : 'timeout'
    )
    expect(chunks.join('')).toContain(`PARENT_${mark}`)
    expect(settled).toBe(true)
    expect(unregistered).toBe(true)
    // 不早于强杀兜底（SIGTERM→3s→SIGKILL→输出收尾）
    expect(elapsed).toBeGreaterThanOrEqual(3000)

    // ④ 无残留：孙进程的心跳必须已经停止
    const beatAtSettle = beatOf(mark)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(beatOf(mark)).toBe(beatAtSettle)
  }, 90000)

  it('取消信号：进入取消后也要等输出收尾，最终以 canceled 语义结算', async () => {
    const mark = `A${Date.now()}`
    process.env.DESK_BEAT_NAME = mark
    const controller = new AbortController()
    const chunks: string[] = []
    const running = runGit(fixture, [SUBPROCESS, 'parent-exits-child-holds', mark], 120000, {
      signal: controller.signal,
      observer: { output: (_stream, chunk) => chunks.push(chunk) }
    })

    expect(await waitUntil(() => chunks.join('').includes(`PARENT_${mark}`))).toBe(true)
    expect(await waitUntil(() => beatOf(mark) > 0)).toBe(true)

    const abortedAt = Date.now()
    controller.abort()
    // 等它结算（不能挂在别处）
    const result = await running
    // 取消语义：code 130 且原因写明"已取消"（超时才会是 124）
    expect(result.code).toBe(130)
    expect(result.stderr).toContain('已取消')
    // 同样不早于强杀兜底：孙进程忽略 SIGTERM，必须等 SIGKILL 才可能真正收尾
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(3000)
  }, 90000)

  it('主进程先关闭输出流但仍存活并忽略 SIGTERM：取消后不得提前结算', async () => {
    const mark = `S${Date.now()}`
    process.env.DESK_BEAT_NAME = mark
    const controller = new AbortController()
    const chunks: string[] = []
    const running = runGit(fixture, [SUBPROCESS, 'close-streams-but-alive', mark], 120000, {
      signal: controller.signal,
      observer: { output: (_stream, chunk) => chunks.push(chunk) }
    })

    let settled = false
    void running.then(() => {
      settled = true
    })

    // 输出流已经关了（能看到关闭前写的内容），但进程还活着（心跳在更新）
    expect(await waitUntil(() => chunks.join('').includes(`BEFORE_CLOSE_${mark}`))).toBe(true)
    expect(await waitUntil(() => beatOf(mark) > 0)).toBe(true)
    const beat1 = beatOf(mark)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(beatOf(mark)).toBeGreaterThan(beat1)
    // 管道关了但进程没退出：这时**不能**结算（这正是本用例要钉的）
    expect(settled).toBe(false)

    const abortedAt = Date.now()
    controller.abort()

    // 取消之后进程仍忽略 SIGTERM 并继续跑：不得因为"已发出终止 / 管道已关"就结算
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(settled).toBe(false)
    const beatAfterAbort = beatOf(mark)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(beatOf(mark)).toBeGreaterThan(beatAfterAbort)

    // 直到强杀兜底真的把进程收掉，才进入终态
    const result = await running
    expect(result.code).toBe(130)
    expect(result.stderr).toContain('已取消')
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(3000)
    // 保留关闭输出流之前的内容
    expect(chunks.join('')).toContain(`BEFORE_CLOSE_${mark}`)
    // 无残留：心跳停止
    const beatAtSettle = beatOf(mark)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(beatOf(mark)).toBe(beatAtSettle)
  }, 90000)

  it('父进程退出、孙进程关闭输出流但仍写心跳：不得因管道关闭就解除占用，清理完成才进终态', async () => {
    const mark = `G${Date.now()}`
    process.env.DESK_BEAT_NAME = mark
    const controller = new AbortController()
    const chunks: string[] = []
    const running = runGit(
      fixture,
      [SUBPROCESS, 'parent-exits-grandchild-closes-streams', mark],
      120000,
      {
        signal: controller.signal,
        observer: { output: (_stream, chunk) => chunks.push(chunk) }
      }
    )

    let settled = false
    void running.then(() => {
      settled = true
    })

    expect(await waitUntil(() => chunks.join('').includes(`PARENT_${mark}`))).toBe(true)
    // 孙进程活着（心跳在跳），但它已经关掉了自己的输出流
    expect(await waitUntil(() => beatOf(mark) > 0)).toBe(true)
    const beat1 = beatOf(mark)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(beatOf(mark)).toBeGreaterThan(beat1)
    // 管道关了、主进程也会在取消后退出，但进程组里还有孙进程：
    // 这时候结算就是"因管道关闭而解除占用"
    expect(settled).toBe(false)

    // 用取消信号触发终止（同时验证取消语义；dispose 路径另有专门用例）
    const terminatedAt = Date.now()
    controller.abort()

    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(settled).toBe(false)
    // 孙进程必须还在（忽略 SIGTERM），证明"管道关了 ≠ 清理完成"
    const beatAt800 = beatOf(mark)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(beatOf(mark)).toBeGreaterThan(beatAt800)

    const result = await running
    expect(Date.now() - terminatedAt).toBeGreaterThanOrEqual(3000)
    expect(result.code).toBe(130)
    expect(result.stderr).toContain('已取消')
    // 清理完成后才进终态，且无残留
    const beatAtSettle = beatOf(mark)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(beatOf(mark)).toBe(beatAtSettle)
  }, 90000)

  it('清理超时到点但进程组探测仍存在：不得结算、不得注销登记，也不得伪造清理成功', async () => {
    const mark = `U${Date.now()}`
    const controller = new AbortController()
    const chunks: string[] = []
    let groupAlive = true
    let unconfirmed = 0
    let unregistered = false

    const running = runGit(fixture, [SUBPROCESS, 'normal-exit', mark, '50'], 120000, {
      signal: controller.signal,
      // 确定性装置：进程组"是否还在"由测试说了算（真实进程组何时消失取决于系统）
      probeProcessGroup: () => groupAlive,
      onCleanupUnconfirmed: () => {
        unconfirmed += 1
      },
      onSpawn: {
        register: () => {},
        unregister: () => {
          unregistered = true
        }
      },
      observer: { output: (_stream, chunk) => chunks.push(chunk) }
    })

    let settled = false
    void running.then(() => {
      settled = true
    })

    // 主进程跑完就退出了，输出也收尾了 —— 两个条件都满足
    expect(await waitUntil(() => chunks.join('').includes(`END_${mark}`))).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    // 触发终止流程：清理超时（兜底）只在终止流程里才有意义
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(settled).toBe(false)

    // 但进程组探测持续说"还在"：推进时间**超过**清理超时（3500ms）
    await new Promise((resolve) => setTimeout(resolve, 4000))
    expect(unconfirmed).toBeGreaterThan(0) // 如实上报了"清理未确认"
    expect(settled).toBe(false) // 关键：不得因为时间到了就结算
    expect(unregistered).toBe(false) // 进程跟踪必须保留（这一轮不会被重试重复启动）

    // 让探测返回 ESRCH：这时才允许完成
    groupAlive = false
    const result = await running
    expect(result.cleanupConfirmed).toBe(true)
    expect(unregistered).toBe(true)
    expect(settled).toBe(true)
  }, 90000)

  it('正常退出时注册的终止器也会被注销（不留悬挂的 kill 引用）', async () => {
    let registered = false
    let unregistered = false
    const result = await runGit(fixture, [SUBPROCESS, 'normal-exit', 'R', '100'], 15000, {
      onSpawn: {
        register: () => {
          registered = true
        },
        unregister: () => {
          unregistered = true
        }
      },
      observer: { output: () => {} }
    })
    expect(result.code).toBe(0)
    expect(registered).toBe(true)
    expect(unregistered).toBe(true)
  }, 30000)

  it('没有注册表时也能正常工作（onSpawn 可选）', async () => {
    const result = await runGit(fixture, [SUBPROCESS, 'normal-exit', 'NONE', '10'], 15000, {
      observer: { output: () => {} }
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('END_NONE')
  }, 30000)
})
