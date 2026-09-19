// 第 11 项：Git 后台抓取的开关 / 并发 / 退避 / 聚合通知 / 时间显示。
//
// 全程只用**临时工作区 + 本地 bare remote**，绝不碰用户真实知识库：
//  - A 库：本地有效远端（file 传输）→ 手动 fetch 成功、后台抓取成功；
//  - B/C 库：指向不存在的本地 remote → 后台抓取必定失败，用来验失败聚合。
// 本机可能设了 http_proxy，`launchDesk` 与这里的 git 都强制 NO_PROXY=*；远端全是
// 本地路径，不依赖公网。
//
// 需要先构建：pnpm --filter desk exec electron-vite build
// Run: node apps/desk/scripts/e2e-git-background-fetch.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createFixture,
  createRecorder,
  deskDir,
  launchDesk,
  openNote,
  trackPageErrors,
  waitFor
} from './e2e-lib.mjs'

const HARD_TIMEOUT_MS = 180_000

const t = createFixture('git-bg-fetch', {
  notes: [{ index: '0001', title: 'A', body: '# A\n\n正文\n' }]
})
const recorder = createRecorder()
const record = recorder.record.bind(recorder)

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  NO_PROXY: '*',
  no_proxy: '*'
}
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim()

/** 建一个能被 Desk 识别的最小知识库目录（tnotes.json + TOC.md + 一篇笔记）。 */
function makeKnowledgeBase(name) {
  const root = join(t.workspace, name)
  mkdirSync(join(root, 'notes'), { recursive: true })
  writeFileSync(join(root, 'tnotes.json'), JSON.stringify({ title: name, name }))
  writeFileSync(join(root, 'TOC.md'), '- [ ] 0001. A\n')
  writeFileSync(
    join(root, 'notes', '0001. A.md'),
    `---\nid: 10000000-0000-4000-8000-0000000000${name.length}1\n---\n\n# 0001. A\n\n正文\n`
  )
  return root
}

function initRepo(root, remote, push) {
  git(['init', '-q', '-b', 'main'], root)
  git(['add', '-A'], root)
  git(['-c', 'user.email=e2e@local', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'init'], root)
  git(['remote', 'add', 'origin', remote], root)
  if (push) git(['push', '-q', '-u', 'origin', 'main'], root)
}

// ── 1. 夹具：本地 bare remote + 三个知识库 ──
const remoteDir = join(t.fixture, 'remotes')
mkdirSync(remoteDir, { recursive: true })
const remoteA = join(remoteDir, 'a.git')
git(['init', '-q', '--bare', '-b', 'main', remoteA], t.fixture)
initRepo(t.kb, remoteA, true)

const kbBName = 'TNotes.git-bg-b'
const kbCName = 'TNotes.git-bg-c'
const kbB = makeKnowledgeBase(kbBName)
const kbC = makeKnowledgeBase(kbCName)
initRepo(kbB, `file://${join(remoteDir, 'missing-b.git')}`, false)
initRepo(kbC, `file://${join(remoteDir, 'missing-c.git')}`, false)

// 显式写入默认关闭（并证明老/新配置都从 false 起步）
t.writeProfileConfig({ git: { autoFetch: false } })

const shots = join(deskDir, 'scripts', 'shots', 'git-background-fetch')
mkdirSync(shots, { recursive: true })

let app = null
let electronPid = null
const hardTimer = setTimeout(() => {
  console.error(`\nE2E 自超时（${HARD_TIMEOUT_MS}ms），强制退出`)
  try {
    if (electronPid) process.kill(electronPid, 'SIGKILL')
  } catch {
    /* 已经退出 */
  }
  process.exit(2)
}, HARD_TIMEOUT_MS)

const getGitStates = () =>
  page.evaluate(async () => {
    const result = await window.desk.git.list()
    return result && result.ok ? result.value : null
  })

const getTasks = () =>
  page.evaluate(async () => {
    const result = await window.desk.commandTask.list()
    return result && result.ok ? result.value : []
  })

let page

try {
  app = await launchDesk(t)
  electronPid = app.process()?.pid ?? null
  page = await app.firstWindow()
  const pageErrors = trackPageErrors(page)
  await openNote(page, { kbName: t.kbName, title: 'A' })

  // ── 2. 等三个库的 Git 状态就绪 ──
  const statesReady = await waitFor(async () => {
    const states = await getGitStates()
    return states && states.length === 3 && states.every((state) => state.initialized)
      ? states
      : null
  }, 30000)
  record(
    '三个知识库的 Git 状态就绪',
    Boolean(statesReady),
    statesReady ? statesReady.map((state) => state.knowledgeBaseName).join('、') : '超时'
  )
  const kbAId = statesReady?.find((state) => state.knowledgeBaseName === t.kbName)?.knowledgeBaseId
  const kbBId = statesReady?.find((state) => state.knowledgeBaseName === kbBName)?.knowledgeBaseId
  const kbCId = statesReady?.find((state) => state.knowledgeBaseName === kbCName)?.knowledgeBaseId
  record(
    '三个知识库都能定位到 id',
    Boolean(kbAId && kbBId && kbCId),
    `${kbAId} / ${kbBId} / ${kbCId}`
  )

  // ── 3. 默认关闭：后台一个 fetch 都不发 ──
  await page.waitForTimeout(2500)
  const idleStates = await getGitStates()
  record(
    '默认关闭时后台不抓取（lastFetchedAt 全为 null）',
    idleStates.every((state) => state.lastFetchedAt === null),
    idleStates.map((state) => `${state.knowledgeBaseName}=${state.lastFetchedAt}`).join('、')
  )
  const idleTasks = await getTasks()
  record(
    '默认关闭时没有任何命令任务（后台 fetch 不产生任务）',
    idleTasks.length === 0,
    `tasks=${idleTasks.length}`
  )

  // ── 4. 手动 fetch 在关闭状态下仍然可用 ──
  const manual = await page.evaluate(async (knowledgeBaseId) => {
    const result = await window.desk.git.fetch(knowledgeBaseId)
    return result
  }, kbAId)
  record(
    '开关关闭时手动 fetch 仍成功',
    manual?.ok === true && manual.value?.conflict === false,
    JSON.stringify(manual?.ok === true ? manual.value?.message : manual?.error)
  )
  const manualLastFetched = (await getGitStates()).find(
    (state) => state.knowledgeBaseId === kbAId
  )?.lastFetchedAt
  record('手动 fetch 更新了上次远端检查时间', Boolean(manualLastFetched), String(manualLastFetched))

  // ── 5. 设置面板显示上次成功远端检查时间 ──
  const openSettings = async (groupLabel) => {
    await page.keyboard.press('ControlOrMeta+Shift+p')
    const palette = page.locator('.command-palette__input')
    await palette.waitFor({ timeout: 15000 })
    await palette.fill('>open-settings')
    await page.locator('.command-palette__item', { hasText: '设置' }).first().click()
    await page.locator('.settings-panel').waitFor({ timeout: 15000 })
    await page.locator('.settings-nav .nav-item', { hasText: groupLabel }).click()
  }

  await openSettings('Git 与远端')
  const lastCheckLocator = page.locator('[data-testid="git-last-check"]')
  await lastCheckLocator.waitFor({ timeout: 10000 })
  const lastCheckBefore = (await lastCheckLocator.innerText()).trim()
  record(
    '设置面板显示上次成功远端检查时间（不是「从未」）',
    lastCheckBefore !== '从未' && /\d/.test(lastCheckBefore),
    lastCheckBefore
  )
  const autoFetchBox = page.locator('[data-testid="git-auto-fetch"]')
  record('自动抓取开关默认未勾选', !(await autoFetchBox.isChecked()), '')
  await page.screenshot({ path: join(shots, 'settings-default-off.png') })

  // ── 6. 打开开关：后台抓取发生，两个坏库失败并聚合成一条通知 ──
  await autoFetchBox.check()
  // 设置面板 400ms 防抖后写盘 → 主进程 applyBackgroundFetchPreference 立即安排一轮
  const backgroundRounds = await waitFor(async () => {
    const tasks = await getTasks()
    const background = tasks.filter((task) => task.background && task.kind === 'git-fetch')
    const failed = background.filter(
      (task) => task.status === 'failed' || task.status === 'timeout'
    )
    return failed.length >= 2 ? { background, failed } : null
  }, 30000)
  record(
    '打开开关后后台自动抓取发生（三个库各一条后台任务）',
    backgroundRounds?.background.length === 3,
    `background tasks=${backgroundRounds?.background.length ?? 0}`
  )
  record(
    '后台失败按真实分类结算、保留输出、时长非假 0ms',
    Boolean(
      backgroundRounds &&
      backgroundRounds.failed.every(
        (task) =>
          task.finishedAt !== null &&
          task.finishedAt >= task.startedAt &&
          task.logBytes > 0 &&
          Boolean(task.error)
      )
    ),
    JSON.stringify(
      backgroundRounds?.failed.map((task) => ({
        kb: task.knowledgeBaseName,
        status: task.status,
        ms: task.finishedAt - task.startedAt,
        bytes: task.logBytes,
        error: (task.error ?? '').slice(0, 60)
      })) ?? []
    )
  )

  const aggregateToasts = await waitFor(async () => {
    const texts = await page.locator('.toast', { hasText: '获取远端更新失败' }).allInnerTexts()
    return texts.length > 0 ? texts : null
  }, 20000)
  record(
    '多个知识库同时失败只弹一条聚合通知',
    aggregateToasts?.length === 1,
    JSON.stringify(aggregateToasts)
  )
  record(
    '聚合通知列出失败的知识库（per-KB 明细仍可点「查看输出」）',
    Boolean(
      aggregateToasts?.[0]?.includes(kbBName) &&
      aggregateToasts?.[0]?.includes(kbCName) &&
      aggregateToasts?.[0]?.includes('查看输出')
    ),
    aggregateToasts?.[0] ?? ''
  )
  await page.screenshot({ path: join(shots, 'aggregated-failure-toast.png') })

  // ── 7. 开关持久化 + 时间显示更新 ──
  const savedConfig = JSON.parse(readFileSync(join(t.profile, '.tn-desk-config.json'), 'utf8'))
  record(
    '开关持久化到配置文件（git.autoFetch=true）',
    savedConfig.git?.autoFetch === true,
    JSON.stringify(savedConfig.git)
  )
  const afterBackground = (await getGitStates()).find((state) => state.knowledgeBaseId === kbAId)
  record(
    '后台抓取成功后上次检查时间前进',
    Boolean(afterBackground?.lastFetchedAt) && afterBackground.lastFetchedAt > manualLastFetched,
    `${manualLastFetched} → ${afterBackground?.lastFetchedAt}`
  )
  const lastCheckAfter = (await lastCheckLocator.innerText()).trim()
  record(
    '设置面板的时间显示在后台抓取后仍有效',
    lastCheckAfter !== '从未' && /\d/.test(lastCheckAfter),
    lastCheckAfter
  )

  // ── 8. 关掉开关：不再新增后台抓取 ──
  const backgroundBeforeOff = (await getTasks()).filter(
    (task) => task.background && task.kind === 'git-fetch'
  ).length
  await autoFetchBox.uncheck()
  await page.waitForTimeout(2500)
  const backgroundAfterOff = (await getTasks()).filter(
    (task) => task.background && task.kind === 'git-fetch'
  ).length
  record(
    '关闭开关后不再新增后台抓取',
    backgroundAfterOff === backgroundBeforeOff,
    `${backgroundBeforeOff} → ${backgroundAfterOff}`
  )

  record('全流程无页面错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
} catch (error) {
  record('运行未完成（未捕获异常）', false, String(error).split('\n')[0])
  console.error(error)
} finally {
  // 关闭不能无限等：某些情况下 Electron 主进程会卡住（窗口未销毁 / 退出守卫），
  // 这里给它 15s，然后按 pid 强杀。**在这之前不要清掉 hardTimer**，否则整脚本
  // 就没人兜底了。
  const closed = app
    ? await Promise.race([
        app
          .close()
          .then(() => true)
          .catch(() => false),
        new Promise((resolve) => setTimeout(() => resolve(false), 15000))
      ])
    : true
  try {
    if (electronPid) process.kill(electronPid, 'SIGKILL')
  } catch {
    /* 已经退出 */
  }
  clearTimeout(hardTimer)
  t.cleanup()
  if (!closed) console.log('（app.close() 超时，已按 pid 强杀）')
  recorder.finish()
  console.log(`screenshots: ${shots}`)
}
