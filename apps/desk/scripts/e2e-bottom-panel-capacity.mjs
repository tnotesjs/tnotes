// 底部面板标签上限（第 7 项需求）的真实界面验证。
//
// 验的是「终端会话 + 命令任务合并计数」这条链路，单测覆盖不到的部分：
//   1. 开到上限（上限来自设置，本例 3）后再开会被拦，并弹出中文原因；
//   2. 达到上限但有已退出终端时，自动回收它、用掉这个名额（不结束运行中的进程）；
//   3. 手动关掉一个已结束的后再开成功；
//   4. 复用已有命令任务不占名额；
//   5. 把上限调低后，已有进程仍然活着，只是不能再新建；
//   6. 非法上限被拒（0 / 31），配置文件里的值不被改坏。
//
// 全部在 mkdtemp 的临时工作区 + 隔离 profile 里跑，绝不碰用户真实数据。
// 需要先构建：pnpm --filter desk exec electron-vite build
// Run: node apps/desk/scripts/e2e-bottom-panel-capacity.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createFixture,
  createRecorder,
  launchDesk,
  openNote,
  waitFor as pollUntil
} from './e2e-lib.mjs'

const LIMIT = 3
const NOTE = { index: '0042', title: '容量用例' }
/** 与主进程 TASK_TITLES 一致的展示标题（用来在界面里辨认标签） */
const TASK_TITLES = { 'launch-ide': '启动 IDE', 'git-fetch': '获取远端更新' }
const fixture = createFixture('bottom-panel-capacity', { notes: [NOTE] })
fixture.writeProfileConfig({
  // 用 3 而不是默认 10：少起几个真 shell，验证的规则完全一样
  bottomPanel: { maxTabs: LIMIT }
})

const recorder = createRecorder()
const { record } = recorder

// ── 自计时上限（macOS 没有 timeout）：跑飞时必须留下已通过的部分，而不是静默挂住 ──
const HARD_LIMIT_MS = 5 * 60_000
let hardLimitHit = false
let releaseHardLimit = () => {}
const hardLimitReached = new Promise((resolve) => {
  releaseHardLimit = resolve
})
const hardLimitTimer = setTimeout(() => {
  hardLimitHit = true
  console.log(`FAIL  自计时上限 ${HARD_LIMIT_MS}ms 到了，强制收尾`)
  releaseHardLimit(null)
}, HARD_LIMIT_MS)
hardLimitTimer.unref?.()

/** 复用 e2e-lib 的轮询，但到自计时上限立刻返回 null，主流程自然走到收尾。 */
async function waitFor(check, timeoutMs = 10000, intervalMs = 120) {
  if (hardLimitHit) return null
  return Promise.race([pollUntil(check, timeoutMs, intervalMs), hardLimitReached])
}

/** 只杀本 fixture 的残留主进程：不能误伤用户或其它 agent 正在跑的实例。 */
function killLeftoverMainProcesses() {
  try {
    const output = execFileSync(
      'pgrep',
      ['-f', `out/main/index.js --user-data-dir=${fixture.profile}`],
      { encoding: 'utf8' }
    )
    for (const line of output.split('\n')) {
      const pid = Number(line.trim())
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* 已经退出 */
        }
      }
    }
  } catch {
    /* pgrep 没匹配到就是不残留 */
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const app = await launchDesk(fixture)
const pageErrors = []
const page = await app.firstWindow()
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text())
})
await page.waitForLoadState('domcontentloaded')

const sessions = () =>
  page.evaluate(async () => {
    const result = await window.desk.terminal.list()
    return result.ok ? result.value : []
  })
const tasks = () =>
  page.evaluate(async () => {
    const result = await window.desk.commandTask.list()
    return result.ok ? result.value : []
  })
const toasts = () => page.locator('.toast').allInnerTexts()
const waitForToast = (keyword, timeoutMs = 10000) =>
  waitFor(
    async () => (await toasts()).find((text) => text.includes(keyword)) ?? null,
    timeoutMs,
    150
  )

/** xterm 是 DOM 渲染：把屏幕上所有行的文本拼起来，判断 shell 是否已经就绪。 */
const screenText = () =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.xterm-rows'))
    return rows
      .map((row) => row.innerText || '')
      .filter((text) => text.trim().length > 0)
      .join('\n')
      .replace(/\u00a0/g, ' ')
  })

/** shell 就绪前写入的输入会丢（PTY 行规程还没切过来）：等屏幕内容连续两次不变。 */
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

async function writeToTerminal(sessionId, data) {
  const list = await sessions()
  const target = list.find((session) => session.id === sessionId)
  if (!target) throw new Error('要写入的会话不存在')
  const sent = await page.evaluate(
    async ({ id, line, generation }) => {
      const result = await window.desk.terminal.write(id, line, generation)
      return result.ok ? true : result.error.message
    },
    { id: sessionId, line: data, generation: target.generation }
  )
  if (sent !== true) throw new Error(`terminal.write 失败：${sent}`)
}

const sessionIds = async () => (await sessions()).map((session) => session.id)

async function clickNewTerminal() {
  const button = page.locator('button[aria-label="新建终端"]')
  await button.click()
}

async function waitForSessionCount(count, timeoutMs = 20000) {
  return waitFor(async () => ((await sessions()).length === count ? true : null), timeoutMs, 150)
}

try {
  // ── S0 打开笔记与底部面板 ──
  await openNote(page, { kbName: fixture.kbName, title: NOTE.title })
  await page.locator('.terminal-toggle').click()
  await waitFor(async () => (await page.locator('.terminal-panel').count()) > 0, 8000)
  const opened = await waitForSessionCount(1, 20000)
  record('S0 打开底部面板：自动建出 1 个终端会话', Boolean(opened))
  const first = (await sessions())[0]
  await waitForShellReady()
  // 真实可控的本地进程（不联网）：验证「回收/调低上限都不碰运行中的会话」
  await writeToTerminal(first.id, 'node -e "setTimeout(()=>{}, 120000)"\r')
  record(
    'S0b 会话里跑起一个本地可控的真实进程（node -e setTimeout）',
    (await sessions()).some((session) => session.id === first.id && session.status === 'running')
  )

  // ── S1 开到上限：终端会话合并计数 ──
  await clickNewTerminal()
  await waitForSessionCount(2)
  await clickNewTerminal()
  const atLimit = await waitForSessionCount(LIMIT)
  record(
    `S1 开到上限（${LIMIT} 个终端会话）`,
    Boolean(atLimit),
    `会话数=${(await sessions()).length}`
  )
  const beforeBlock = await sessionIds()
  const allRunning = (await sessions()).every((session) => session.status === 'running')
  record('S1b 上限内全部是运行中的会话', allRunning)

  // ── S2 再开被拦：阻止创建 + 中文提示 ──
  await clickNewTerminal()
  const blockToast = await waitForToast('全部在运行')
  record(
    'S2 达到上限且全部在运行时新建被拦，并给出中文提示',
    Boolean(blockToast),
    blockToast ?? `toasts=${JSON.stringify(await toasts())}`
  )
  const blocked = (await sessionIds()).length === beforeBlock.length
  record('S2b 被拦后没有多出会话（没有先执行再报错）', blocked)

  // ── S3 达到上限但有已退出终端：自动回收最老的那个，用掉名额 ──
  const toExit = (await sessions())[LIMIT - 1]
  await writeToTerminal(toExit.id, 'exit\r')
  const exited = await waitFor(
    async () => {
      const list = await sessions()
      return list.find((session) => session.id === toExit.id)?.status === 'exited' ? true : null
    },
    20000,
    200
  )
  record('S3 让最后一个会话退出（产生可回收的已退出终端）', Boolean(exited))

  await clickNewTerminal()
  const recycled = await waitFor(
    async () => {
      const list = await sessions()
      const ids = list.map((session) => session.id)
      return ids.length === LIMIT &&
        !ids.includes(toExit.id) &&
        list.some((s) => s.status === 'running')
        ? true
        : null
    },
    25000,
    200
  )
  record('S3b 已退出的标签被自动回收，新会话占了这个名额', Boolean(recycled))
  // 主进程发来的移除通知必须让界面把旧标签也拿掉（否则会留下点不动的空标签）
  const tabCount = await page.locator('.terminal-tab:not(.command-tab):not(.shell-tab)').count()
  record('S3c 界面同步移除了被回收的标签', tabCount === LIMIT, `标签数=${tabCount}`)
  const firstPid = (await sessions()).find((session) => session.id === first.id)?.pid
  record(
    'S3d 回收的是已退出会话，运行中的会话（含真实进程）未被结束',
    Boolean(firstPid) && isProcessAlive(firstPid),
    `pid=${firstPid}`
  )

  // ── S4 手动关掉一个已结束的，再开成功 ──
  // 用最后一个（普通 shell 提示符）：第一个会话里 node 还在前台跑着，exit 到不了 shell
  const manualExit = (await sessions())[LIMIT - 1]
  await writeToTerminal(manualExit.id, 'exit\r')
  await waitFor(
    async () =>
      (await sessions()).find((session) => session.id === manualExit.id)?.status === 'exited'
        ? true
        : null,
    20000,
    200
  )
  await page.locator('.terminal-tab.exited .terminal-tab-close').first().click()
  const afterManualClose = await waitForSessionCount(LIMIT - 1, 15000)
  record('S4 手动关掉一个已结束的标签（数量降到上限以下）', Boolean(afterManualClose))
  await clickNewTerminal()
  const reopened = await waitForSessionCount(LIMIT, 20000)
  record('S4b 关掉一个已结束的再新建成功', Boolean(reopened))

  // ── S5 命令任务与终端会话合并计数；复用不占名额 ──
  const kb = (await sessions())[0]
  const claim = (kind) =>
    page.evaluate(
      async ({ knowledgeBaseId, kind, title, cwd }) => {
        const result = await window.desk.commandTask.claim({
          knowledgeBaseId,
          kind,
          title,
          cwd
        })
        return result.ok
          ? { ok: true, value: result.value }
          : { ok: false, message: result.error.message }
      },
      { knowledgeBaseId: kb.knowledgeBaseId, kind, title: TASK_TITLES[kind], cwd: kb.cwd }
    )

  // 先腾一个名额（关掉一个运行中的会话），否则连第一个任务都建不出来
  await page.evaluate(async (id) => window.desk.terminal.close(id), (await sessions())[0].id)
  await waitForSessionCount(LIMIT - 1, 15000)

  const firstClaim = await claim('launch-ide')
  const totalAfterClaim = (await sessions()).length + (await tasks()).length
  record(
    'S5 命令任务标签与终端会话合并计数（总数仍在上限内）',
    firstClaim.ok && totalAfterClaim === LIMIT,
    `总数=${totalAfterClaim}`
  )
  const commandTabShown = await waitFor(
    async () => ((await page.locator('.terminal-tab.command-tab').count()) === 1 ? true : null),
    8000,
    150
  )
  record('S5a 命令任务标签出现在底部面板里', Boolean(commandTabShown))

  const reuseClaim = await claim('launch-ide')
  record(
    'S5b 复用同一 (知识库, 种类) 不占新名额：达到上限仍然成功',
    reuseClaim.ok && firstClaim.ok && reuseClaim.value.id === firstClaim.value.id,
    `id=${reuseClaim.ok ? reuseClaim.value.id : reuseClaim.message}`
  )
  const afterReuse = (await sessions()).length + (await tasks()).length
  const tabsAfterReuse = await page.locator('.terminal-tab.command-tab').count()
  record(
    'S5c 复用后总数与标签数都不变',
    afterReuse === LIMIT && tabsAfterReuse === 1,
    `总数=${afterReuse} 标签=${tabsAfterReuse}`
  )

  const newKindClaim = await claim('git-fetch')
  record(
    'S5d 达到上限时新种类任务被拦（终端占的名额也算数）',
    !newKindClaim.ok && /全部在运行/.test(newKindClaim.message ?? ''),
    newKindClaim.ok ? '未被拦' : newKindClaim.message
  )
  record(
    'S5e 被拦后没有多出命令任务标签',
    (await page.locator('.terminal-tab.command-tab').count()) === 1
  )

  // 已结束的任务同样可回收：结束 launch-ide 后，新种类任务占的正是它腾出的名额
  if (firstClaim.ok) {
    await page.evaluate(
      async ({ taskId, run }) => window.desk.commandTask.finish(taskId, run, 'done', null),
      { taskId: firstClaim.value.id, run: firstClaim.value.run }
    )
  }
  const recycledClaim = await claim('git-fetch')
  const recycledTabs = await waitFor(
    async () => {
      const labels = await page.locator('.terminal-tab.command-tab').allInnerTexts()
      return labels.length === 1 && labels[0].includes(TASK_TITLES['git-fetch']) ? true : null
    },
    10000,
    150
  )
  record(
    'S5f 已结束的命令任务被回收，新标签占了这个名额（界面同步替换）',
    recycledClaim.ok &&
      recycledClaim.value.kind === 'git-fetch' &&
      Boolean(recycledTabs) &&
      !(await tasks()).some((task) => task.id === firstClaim.value?.id),
    `kind=${recycledClaim.ok ? recycledClaim.value.kind : recycledClaim.message}`
  )

  // ── S6 调低上限不杀进程 ──
  const runningBefore = (await sessions()).filter((session) => session.status === 'running')
  const pidsBefore = runningBefore
    .map((session) => session.pid)
    .filter((pid) => Number.isInteger(pid))
  const lowered = await page.evaluate(async () =>
    window.desk.settings.update({ bottomPanel: { maxTabs: 1 } })
  )
  record('S6 把上限从 3 调低到 1', lowered.ok === true)
  await new Promise((resolve) => setTimeout(resolve, 500))

  const runningAfter = (await sessions()).filter((session) => session.status === 'running')
  const survived = pidsBefore.length > 0 && pidsBefore.every((pid) => isProcessAlive(pid))
  record(
    'S6b 调低上限后已有进程仍然活着（没有被 kill）',
    survived && runningAfter.length === runningBefore.length,
    `pids=${JSON.stringify(pidsBefore)}`
  )
  const idsBefore = runningBefore.map((session) => session.id)
  record(
    'S6c 调低上限不会被当成回收时机',
    JSON.stringify(runningAfter.map((session) => session.id)) === JSON.stringify(idsBefore)
  )

  await clickNewTerminal()
  const overLimitToast = await waitForToast('上限已调低为 1')
  record(
    'S6d 上限调低后不能再新建，并说明原因',
    Boolean(overLimitToast),
    overLimitToast ?? `toasts=${JSON.stringify(await toasts())}`
  )
  record('S6e 被拦后没有多出会话', JSON.stringify(await sessionIds()) === JSON.stringify(idsBefore))

  // ── S7 非法上限被拒，配置文件里的值不被改坏 ──
  const rejectedZero = await page.evaluate(async () =>
    window.desk.settings.update({ bottomPanel: { maxTabs: 0 } })
  )
  const rejectedOver = await page.evaluate(async () =>
    window.desk.settings.update({ bottomPanel: { maxTabs: 31 } })
  )
  record('S7 非法上限 0 被拒（不会把面板锁死）', rejectedZero.ok === false)
  record('S7b 超过上界 31 被拒（上界 30）', rejectedOver.ok === false)
  const persisted = JSON.parse(readFileSync(join(fixture.profile, '.tn-desk-config.json'), 'utf8'))
  record(
    'S7c 非法值没有写进配置文件（仍是上一次合法的 1）',
    persisted.bottomPanel?.maxTabs === 1,
    `bottomPanel=${JSON.stringify(persisted.bottomPanel)}`
  )

  record('S8 全程没有未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))
} catch (error) {
  record('S 断言执行', false, error instanceof Error ? error.message : String(error))
  console.log('调试：页面错误', pageErrors.join(' | ').slice(0, 600))
} finally {
  clearTimeout(hardLimitTimer)
  try {
    await app.close()
  } catch (error) {
    console.log('app.close 失败：', error instanceof Error ? error.message : String(error))
  }
  // macOS 没有 timeout：兜底杀掉本 fixture 残留的主进程（只按 profile 精确匹配）
  killLeftoverMainProcesses()
  fixture.cleanup()
}

recorder.finish()
