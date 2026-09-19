// 命令操作与底部终端面板联动：手动 Git 操作变成命令任务标签（真实 git 子进程）。
//
// 验的是「面板 ↔ 主进程 ↔ 真实 git」这条链路，单测覆盖不到的部分：
//   1. 手动操作真的在面板里建出任务标签，并显示 git 的真实输出；
//   2. 同库同种操作**复用同一个标签**（重复点击不再起第二次）；
//   3. 失败后重试走完整业务流程（推送会重新保存），并真的把提交推上去；
//   4. 排队中的任务被取消时，**不碰**同库正在跑的那一个（跨任务隔离）。
//
// 需要先构建：pnpm --filter desk exec electron-vite build
// Run: node apps/desk/scripts/e2e-command-task.mjs
import { _electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-command-task-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'ct-kb')
const notes = join(kb, 'notes')
const remote = join(fixture, 'remote.git')
const shots = join(deskDir, 'scripts', 'shots', 'command-task')
mkdirSync(notes, { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Desk E2E',
  GIT_AUTHOR_EMAIL: 'e2e@tnotes.local',
  GIT_COMMITTER_NAME: 'Desk E2E',
  GIT_COMMITTER_EMAIL: 'e2e@tnotes.local'
}
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', env: GIT_ENV }).trim()
}
function inKb(...args) {
  return git('-C', kb, ...args)
}
function inRemote(...args) {
  return git('-C', remote, ...args)
}

// ── fixture：一个带裸远端的知识库，初始提交已经推上去，另有一笔未提交改动 ──
writeFileSync(join(kb, 'tnotes.json'), JSON.stringify({ title: 'ct-kb', name: 'ct-kb' }))
writeFileSync(
  join(kb, 'TOC.md'),
  ['- [ ] 0042. 有未提交改动', '- [ ] 0043. 已提交干净'].join('\n') + '\n'
)
const noteBody = (uuid, title) => `---\nid: ${uuid}\n---\n\n# ${title}\n\n正文\n`
writeFileSync(
  join(notes, '0042. 有未提交改动.md'),
  noteBody('11111111-1111-4111-8111-111111111111', '有未提交改动')
)
writeFileSync(
  join(notes, '0043. 已提交干净.md'),
  noteBody('22222222-2222-4222-8222-222222222222', '已提交干净')
)
git('init', '-q', '--bare', '-b', 'main', remote)
inKb('init', '-q', '-b', 'main')
inKb('config', 'user.email', 'e2e@tnotes.local')
inKb('config', 'user.name', 'Desk E2E')
inKb('add', '-A')
inKb('commit', '-q', '-m', 'feat: 初始')
inKb('remote', 'add', 'origin', remote)
inKb('push', '-q', '-u', 'origin', 'main')
// 0042：提交后再改一笔 → 工作区未提交（推送流程要把它提交并推上去）
writeFileSync(
  join(notes, '0042. 有未提交改动.md'),
  `${noteBody('11111111-1111-4111-8111-111111111111', '有未提交改动')}\n未提交的一笔\n`
)

writeFileSync(join(profile, 'workspace.v1.json'), JSON.stringify({ path: workspace }))
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  JSON.stringify({
    version: 1,
    theme: 'light',
    defaultNoteView: 'visual',
    prettier: false,
    autosave: { enabled: false, delayMs: 1000 },
    // 关掉「提交前确认」，让 ⇡ 直接走完整推送流程
    confirmBeforeCommit: false
  })
)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function waitFor(check, timeoutMs = 10000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
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
    ELECTRON_RUN_AS_NODE: undefined,
    ELECTRON_DISABLE_SANDBOX: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  }
})

const pageErrors = []
const mainLogs = []
app.process().stdout?.on('data', (chunk) => mainLogs.push(String(chunk)))
app.process().stderr?.on('data', (chunk) => mainLogs.push(String(chunk)))
const page = await app.firstWindow()
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text())
})
await page.waitForLoadState('domcontentloaded')

/** 从主进程读命令任务列表（IPC 直接返回 DTO，不依赖界面渲染）。 */
const tasks = async () => {
  const listed = await page.evaluate(async () => {
    const result = await window.desk.commandTask.list()
    return result.ok ? result.value : []
  })
  return listed
}
const taskOf = async (kind) => (await tasks()).find((item) => item.kind === kind) ?? null

try {
  // 0) 知识库与 Git 状态就绪（configure 有 2 秒防抖）
  await page.waitForSelector('.kb-sidebar, aside', { timeout: 20000 })
  const kbRow = await waitFor(
    async () => (await page.getByText('ct-kb', { exact: true }).count()) > 0,
    20000
  )
  record('T0 知识库被发现', Boolean(kbRow))
  await page.getByText('ct-kb', { exact: true }).first().click()
  const gitReady = await waitFor(async () => {
    const state = await page.evaluate(async () => {
      const result = await window.desk.git.list()
      return result.ok ? result.value.length : 0
    })
    return state > 0
  }, 20000)
  record('T0b Git 状态就绪', Boolean(gitReady))

  // 打开底部面板：命令任务标签就长在这里
  await page.locator('.terminal-toggle').click()
  await waitFor(async () => (await page.locator('.terminal-panel').count()) > 0, 8000)
  record('T1 底部面板可以打开', (await page.locator('.terminal-panel').count()) > 0)

  // ── T2 拉取：面板里出现任务标签，显示 git 的真实输出，成功结算 ──
  await page.locator('button[aria-label="获取并拉取远端更新"]').click()
  const pullTab = await waitFor(
    async () => (await page.locator('.terminal-tab.command-tab').count()) > 0,
    20000
  )
  record('T2 手动操作在面板里建出命令任务标签', Boolean(pullTab))
  const pullDone = await waitFor(async () => {
    const task = await taskOf('git-pull')
    return task && task.status === 'done' ? task : null
  }, 60000)
  record(
    'T2b 拉取任务成功结算（真实 git 子进程）',
    Boolean(pullDone),
    pullDone ? `stage=${pullDone.stageLabel}` : `status=${(await taskOf('git-pull'))?.status}`
  )
  const pullLog = await page.locator('.command-task-row').allInnerTexts()
  record(
    'T2c 面板显示实际执行的 git 命令行与真实输出',
    Boolean(pullDone?.command?.includes('git')) && pullLog.length > 0,
    `command=${pullDone?.command} | 首行=${pullLog[0]?.slice(0, 60)}`
  )
  await page.screenshot({ path: join(shots, '01-pull-done.png') })

  // ── T3 推送：完整流程（保存 → 提交 → push），提交真的进了裸远端 ──
  const noteBefore = inKb('rev-parse', 'HEAD')
  await page.locator('button[aria-label="提交并推送当前变更"]').click()
  const pushDone = await waitFor(async () => {
    const task = await taskOf('git-push')
    return task && task.status === 'done' ? task : null
  }, 60000)
  const remoteAfter = inRemote('rev-parse', 'HEAD')
  const headAfter = inKb('rev-parse', 'HEAD')
  record('T3 推送任务成功结算', Boolean(pushDone), pushDone ? 'done' : '未完成')
  record(
    'T3b 未提交改动被提交并真的推到了远端',
    headAfter !== noteBefore && remoteAfter === headAfter,
    `本地 ${headAfter.slice(0, 7)} / 远端 ${remoteAfter.slice(0, 7)}`
  )
  record('T3c 工作区已干净', inKb('status', '--porcelain') === '')

  // ── T4 同库同种操作复用同一个标签：再次拉取不会多出一个标签 ──
  const tabsBefore = await page.locator('.terminal-tab.command-tab').count()
  await page.locator('button[aria-label="获取并拉取远端更新"]').click()
  await waitFor(async () => {
    const task = await taskOf('git-pull')
    return task && task.status === 'done' && task.finishedAt
  }, 60000)
  const tabsAfter = await page.locator('.terminal-tab.command-tab').count()
  record(
    'T4 同一 (知识库, 操作) 只有一个标签，重复执行不新增',
    tabsAfter === tabsBefore,
    `${tabsBefore} → ${tabsAfter}`
  )

  // ── 关于「取消排队中的任务不得误杀同库正在跑的任务」──
  // 这一条**不在 E2E 里断言**：要稳定复现"同库两个任务、后者在 gitManager 队列里排队"，
  // 就得让前者的 fetch 一直挂着；而任何真实远端都会自己失败（实测这个不可路由地址
  // 约 5s），窗口太窄，E2E 会变成碰运气。该语义由 gitManager.test.ts 与
  // ipc/commandTask.test.ts 的确定性用例覆盖（均已验证"撤掉修复即变红"）。

  // ── T5 失败后重试走完整流程：把远端临时弄坏再恢复 ──
  writeFileSync(
    join(notes, '0042. 有未提交改动.md'),
    `${noteBody('11111111-1111-4111-8111-111111111111', '有未提交改动')}\n第二笔未提交\n`
  )
  const remoteMoved = `${remote}.hidden`
  execFileSync('mv', [remote, remoteMoved])
  await page.locator('button[aria-label="提交并推送当前变更"]').click()
  const pushFailed = await waitFor(async () => {
    const task = await taskOf('git-push')
    return task && task.status === 'failed' ? task : null
  }, 90000)
  record('T5 远端不可达时推送标 failed（不是成功）', Boolean(pushFailed), pushFailed?.error ?? '')
  const tabsAfterFail = await page.locator('.terminal-tab.command-tab').count()
  // 失败时本地可能已经产生提交（保存→add→commit 都成功，只有 push 失败）。
  // 所以**不能**只看"重试有没有产生新提交"，要看"重试前远端缺的，重试后补齐了"。
  const localShaAtFail = inKb('rev-parse', 'HEAD')
  // 恢复远端，再确认「重试前远端确实还没有这个提交」
  execFileSync('mv', [remoteMoved, remote])
  let remoteMissingBeforeRetry = false
  try {
    inRemote('cat-file', '-e', `${localShaAtFail}^{commit}`)
  } catch {
    remoteMissingBeforeRetry = true
  }
  await page.locator('.command-task-actions button', { hasText: '重试' }).first().click()
  const retryDone = await waitFor(async () => {
    const task = await taskOf('git-push')
    return task && task.status === 'done' && task.run > (pushFailed?.run ?? 0) ? task : null
  }, 90000)
  const localShaAfterRetry = inKb('rev-parse', 'HEAD')
  let remoteHasIt = false
  try {
    inRemote('cat-file', '-e', `${localShaAfterRetry}^{commit}`)
    remoteHasIt = true
  } catch {
    remoteHasIt = false
  }
  record('T5b 重试后成功，且运行次数递增', Boolean(retryDone), `run=${retryDone?.run}`)
  record(
    'T5c 失败时留在本地的提交，重试后真的被推到远端',
    remoteMissingBeforeRetry && localShaAfterRetry === localShaAtFail && remoteHasIt,
    `失败时本地 ${localShaAtFail.slice(0, 7)}（远端缺=${remoteMissingBeforeRetry}）→ 远端现在有=${remoteHasIt}`
  )
  record(
    'T5d 重试没有新增标签（仍是同一个任务）',
    (await page.locator('.terminal-tab.command-tab').count()) === tabsAfterFail
  )
  await page.screenshot({ path: join(shots, '02-retry-done.png') })

  record('T6 全程没有未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))
} catch (error) {
  record('T 断言执行', false, error instanceof Error ? error.message : String(error))
  console.log('调试：主进程日志', mainLogs.join('').slice(-2000))
  console.log('调试：页面错误', pageErrors.join(' | ').slice(0, 800))
} finally {
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
