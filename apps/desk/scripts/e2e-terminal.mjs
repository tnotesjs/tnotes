// 交互式终端的专项回归：真 pty、多会话、cwd 绑定到知识库。
//
// 单测把 PTY 全替换成替身（覆盖生命周期/背压/代次/回调安全），验不了
// 「Electron 里的原生 node-pty 真能起 shell」。这个套件只补这一层：
// 起真会话、把命令写进真 PTY、读回 shell 的真实输出。
//
// 需要先构建：pnpm --filter desk exec electron-vite build
// Run: node apps/desk/scripts/e2e-terminal.mjs
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-terminal-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'term-kb')
const notes = join(kb, 'notes')
mkdirSync(notes, { recursive: true })
mkdirSync(profile, { recursive: true })

writeFileSync(join(kb, 'tnotes.json'), JSON.stringify({ title: 'term-kb', name: 'term-kb' }))
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0042. 终端用笔记\n')
writeFileSync(
  join(notes, '0042. 终端用笔记.md'),
  '---\nid: 33333333-3333-4333-8333-333333333333\n---\n\n# 终端用笔记\n\n正文\n'
)
writeFileSync(join(profile, 'workspace.v1.json'), JSON.stringify({ path: workspace }))
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  JSON.stringify({
    version: 1,
    theme: 'light',
    defaultNoteView: 'visual',
    autosave: { enabled: false }
  })
)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const HARD_LIMIT_MS = 3 * 60_000
let hardLimitHit = false
const hardLimitTimer = setTimeout(() => {
  hardLimitHit = true
  console.log(`FAIL  自计时上限 ${HARD_LIMIT_MS}ms 到了，强制收尾`)
}, HARD_LIMIT_MS)
hardLimitTimer.unref?.()

async function waitFor(check, timeoutMs = 10000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (hardLimitHit) return null
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

const app = await _electron.launch({
  executablePath: require('electron'),
  args: ['out/main/index.js', `--user-data-dir=${profile}`],
  cwd: deskDir,
  timeout: 60000,
  env: {
    ...process.env,
    // 本地远端/本地服务都要直连，别被开发机的 http_proxy 接管
    NO_PROXY: '*',
    no_proxy: '*',
    ELECTRON_RUN_AS_NODE: undefined,
    ELECTRON_DISABLE_SANDBOX: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  }
})

const pageErrors = []
app.process().stdout?.on('data', () => {})
app.process().stderr?.on('data', () => {})
const page = await app.firstWindow()
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text())
})
await page.waitForLoadState('domcontentloaded')

/** xterm 是 DOM 渲染：直接读屏幕上的行，拿到 shell 的**真实输出**。 */
/**
 * xterm 是 DOM 渲染：读屏幕上的行，拿到 shell 的**真实输出**。
 *
 * 面板会为每个会话保留 body（用 v-show 隐藏），所以用页面内遍历把所有屏幕文本
 * 合起来看——验的是「shell 真的产出了这个标记」，与它挂在哪个 pane 无关。
 * 用 evaluate 而不是 Playwright 的 strict 定位器：多个 pane 是正常状态。
 */
const screenText = async () =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.xterm-rows'))
    return rows
      .map((row) => row.innerText || '')
      .filter((text) => text.trim().length > 0)
      .join('\n')
      .replace(/\u00a0/g, ' ')
  })

/** 把命令写进真 PTY（与键盘输入走同一条 `terminal.write`）。 */
async function runInTerminal(sessionId, command) {
  // generation 必须取**当前**的：它是主进程防止旧代次输入打进新进程的凭据，
  // 写错值会被拒绝（这里踩过：硬编码 1 时命令一个都没进 shell）。
  const generation = (await sessionIds()).find((item) => item.id === sessionId)?.generation
  if (!generation) throw new Error('取不到会话 generation')
  const sent = await page.evaluate(
    async ({ id, line, generation: gen }) => {
      // 即使被拒绝也要回传原因，否则失败只剩"没输出"
      const result = await window.desk.terminal.write(id, `${line}\r`, gen)
      return result.ok ? true : result.error.message
    },
    { id: sessionId, line: command, generation }
  )
  if (sent !== true) throw new Error(`terminal.write 失败：${sent}`)
}

/** 会话说：等就绪再写（真 pty 就绪前写入会丢）。 */
async function prepareSession(sessionId) {
  await waitFor(async () => (await sessionIds()).some((item) => item.id === sessionId), 15000)
  const ready = await waitForShellReady()
  if (!ready) throw new Error('终端一直没就绪')
}

const sessionIds = async () => {
  const listed = await page.evaluate(async () => {
    const result = await window.desk.terminal.list()
    return result.ok ? result.value : []
  })
  return listed
}

/** 发一条命令并等它的输出出现（用唯一标记避免撞上历史输出）。 */
/**
 * 等某个会话的 shell 真的就绪：屏幕上出现内容并且**连续两次不再变化**。
 *
 * 真 pty 下新建会话后要等 shell 起来；就绪前写进去的输入可能被丢在
 * PTY 行规程切换之前（实测：不等就绪时命令不产生任何回显）。
 */
async function waitForShellReady(timeoutMs = 20000) {
  let previous = ''
  let stable = 0
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !hardLimitHit) {
    const text = await screenText()
    if (text.trim().length > 0 && text === previous) {
      stable += 1
      if (stable >= 2) return text
    } else {
      stable = 0
    }
    previous = text
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return null
}

/**
 * 在**当前活动会话**里跑一条命令并读回它屏幕上的输出。
 *
 * 只在活动会话上读：xterm 在隐藏容器里不会把写入渲染到 DOM 屏幕，切标签再回读
 * 需要额外的重绘时序（实测不稳）。所以每次要读输出前，都让目标会话成为活动会话
 * ——创建新会话天然如此；这也是最接近用户实际操作的路径。
 */
async function expectOutput(sessionId, marker, timeoutMs = 20000) {
  const active = await page.evaluate(async () => {
    const result = await window.desk.terminal.list()
    return result.ok ? result.value.length : 0
  })
  await runInTerminal(sessionId, `echo "${marker}"`)
  const seen = await waitFor(async () => (await screenText()).includes(marker), timeoutMs, 250)
  return { seen: Boolean(seen), active }
}

try {
  await page.waitForSelector('.kb-sidebar, aside', { timeout: 20000 })
  await waitFor(async () => (await page.getByText('term-kb', { exact: true }).count()) > 0, 20000)
  await page.getByText('term-kb', { exact: true }).first().click()

  // 打开底部面板（命令任务与交互式终端共用一个面板）
  await page.locator('.terminal-toggle').click()
  await waitFor(async () => (await page.locator('.terminal-panel').count()) > 0, 8000)
  record('S0 底部面板可打开', (await page.locator('.terminal-panel').count()) > 0)

  // ── S1 新建终端会话：真 node-pty 起 shell，能看到真实输出 ──
  // 面板打开时会自动建一个会话；这里不再额外点「+」，保持它是活动会话，
  // 输出的读取才是稳定的（见 expectOutput 的说明）。
  const created = await waitFor(async () => (await sessionIds()).length > 0, 20000)
  record('S1 新建终端会话（真 pty）', Boolean(created), `会话数=${(await sessionIds()).length}`)
  const first = (await sessionIds())[0]
  await prepareSession(first.id)
  const marker = `DESK_TERM_${Date.now()}`
  const gotOutput = await expectOutput(first.id, marker)
  record(
    'S1b 命令写进真 PTY 并读回 shell 的真实输出',
    gotOutput.seen,
    gotOutput.seen ? marker : `屏幕=${JSON.stringify((await screenText()).slice(-160))}`
  )
  record('S1c 会话状态为 running', first.status === 'running', `status=${first.status}`)

  // ── S2 cwd 绑定到知识库根目录 ──
  await runInTerminal(first.id, 'pwd')
  const pwdSeen = await waitFor(async () => (await screenText()).includes(kb), 15000, 250)
  record('S2 新会话的工作目录是知识库根目录', Boolean(pwdSeen), `期望包含 ${kb}`)

  // ── S3 多会话：新会话同样是真 pty，且与旧会话并存 ──
  await page.locator('button[aria-label="新建终端"]').click()
  const twoSessions = await waitFor(async () => (await sessionIds()).length === 2, 20000)
  record(
    'S3 可以同时存在多个终端会话',
    Boolean(twoSessions),
    `会话数=${(await sessionIds()).length}`
  )
  const tabs = await page.locator('.terminal-tab:not(.command-tab):not(.shell-tab)').count()
  record('S3b 每个会话一个标签', tabs === 2, `标签数=${tabs}`)
  const second = (await sessionIds())[1]
  await prepareSession(second.id)
  const markerB = `DESK_B_${Date.now()}`
  const secondWorks = await expectOutput(second.id, markerB)
  record('S3c 新会话能执行命令', secondWorks.seen, markerB)
  record(
    'S3d 旧会话仍在列表且仍在运行',
    (await sessionIds()).some((item) => item.id === first.id && item.status === 'running')
  )

  // ── S4 关闭会话：移出列表，另一个不受影响 ──
  await page.evaluate(async (id) => {
    await window.desk.terminal.close(id)
  }, second.id)
  const closed = await waitFor(async () => (await sessionIds()).length === 1, 15000)
  record('S4 关闭会话后移出列表', Boolean(closed), `会话数=${(await sessionIds()).length}`)
  record(
    'S4b 关掉一个会话不影响另一个（仍在运行）',
    (await sessionIds()).some((item) => item.id === first.id && item.status === 'running')
  )

  // ── S5 代次守卫：旧代次的输入不得打进 shell ──
  const wrongGeneration = await page.evaluate(
    async ({ id, generation }) => {
      const result = await window.desk.terminal.write(id, 'echo SHOULD_NOT_RUN\r', generation + 99)
      return result.ok ? 'accepted' : result.error.message
    },
    { id: first.id, generation: first.generation }
  )
  const staleMarker = `DESK_STALE_${Date.now()}`
  const staleSent = await page.evaluate(
    async ({ id, marker }) => {
      const result = await window.desk.terminal.write(id, `echo ${marker}\r`, 99)
      return result.ok
    },
    { id: first.id, marker: staleMarker }
  )
  const staleRendered = await waitFor(
    async () => (await screenText()).includes(staleMarker),
    3000,
    250
  )
  record(
    'S5 旧代次的输入被拒绝（不会打进 shell）',
    wrongGeneration !== 'accepted' && !staleSent && !staleRendered,
    String(wrongGeneration)
  )

  record('S6 全程没有未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))
} catch (error) {
  record('S 断言执行', false, error instanceof Error ? error.message : String(error))
  console.log('调试：页面错误', pageErrors.join(' | ').slice(0, 600))
} finally {
  clearTimeout(hardLimitTimer)
  await app.close()
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log(`失败：${failed.map((item) => item.name).join('、')}`)
  process.exitCode = 1
}
if (process.env.KEEP_FIXTURE !== '1') rmSync(fixture, { recursive: true, force: true })
else console.log(`fixture 保留在 ${fixture}`)
