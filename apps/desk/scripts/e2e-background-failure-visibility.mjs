// 第 4 项验收：面板容量满额时，**后台失败仍然可见**。
//
// 要点：这类失败没能建成可见任务（面板里没有它），所以必须有另外的入口：
//  - 不额外占用面板标签（任务标签数不变）；
//  - 设置 →「Git 与远端」里有汇总 + 「查看错误详情」能展开**真实错误原文**；
//  - 同一原因的重复失败只累加计数，不刷多条。
//
// Run: node apps/desk/scripts/e2e-background-failure-visibility.mjs
import {
  createFixture,
  createRecorder,
  launchDesk,
  openNote,
  trackPageErrors,
  waitFor
} from './e2e-lib.mjs'

const rec = createRecorder()
const fixture = createFixture('bg-failure-visible', {
  notes: [{ index: '0001', title: '可见性', body: ['# 可见性', '', '正文', ''].join('\n') }]
})

const app = await launchDesk(fixture, { env: { DESK_E2E_EXPOSE_INTERNALS: '1' } })
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

const inject = (message) =>
  page.evaluate(
    async ({ kbName, msg }) => {
      const result = await window.desk.backgroundFailures.injectForTest({
        knowledgeBaseId: kbName,
        kind: 'git-fetch',
        reason: '底部面板标签已达上限，无法再开一个后台任务标签',
        message: msg
      })
      return result
    },
    { kbName: fixture.kbName, msg: message }
  )

const openSettings = async () => {
  await page.getByRole('button', { name: '打开设置' }).first().click()
  await waitFor(async () => (await page.locator('.settings-panel').count()) > 0, 10000)
  // 分组是**切换显示**的：先切到「Git 与远端」
  await page.locator('.settings-nav .nav-item', { hasText: 'Git 与远端' }).first().click()
  await waitFor(async () => (await page.locator('.git-settings').count()) > 0, 10000)
}

try {
  await openNote(page, { kbName: fixture.kbName, title: '可见性' })
  await waitFor(async () => (await page.locator('.ProseMirror').count()) > 0, 20000)

  // 先注入一条"没有可见任务"的后台失败
  const injected = await inject('fatal: unable to access remote: 无法解析主机')
  rec.record(
    '注入一条没有可见任务的后台失败',
    Boolean(injected && injected.ok !== false),
    JSON.stringify(injected).slice(0, 120)
  )

  await openSettings()
  const panel = page.locator('[data-testid="git-background-failures"]')
  await new Promise((resolve) => setTimeout(resolve, 600))
  await waitFor(async () => (await panel.count()) > 0, 10000)
  rec.record('设置里出现「后台操作失败（未占用面板标签）」汇总', (await panel.count()) > 0, '')
  rec.record(
    '汇总里带出知识库、操作与失败原因',
    (await panel.innerText()).includes(fixture.kbName) &&
      (await panel.innerText()).includes('获取远端更新') &&
      (await panel.innerText()).includes('底部面板标签已达上限'),
    JSON.stringify((await panel.innerText()).slice(0, 160))
  )

  // 「查看错误详情」必须能展开**真实错误原文**
  await panel.getByRole('button', { name: '查看错误详情' }).first().click()
  await new Promise((resolve) => setTimeout(resolve, 300))
  const detail = await panel.locator('.git-failures__message').first().innerText()
  rec.record(
    '「查看错误详情」展开的是真实错误原文',
    detail.includes('fatal: unable to access remote: 无法解析主机'),
    JSON.stringify(detail.slice(0, 120))
  )
  // 没有额外占用面板标签：命令任务列表里**一条任务都没有**
  const taskCount = await page.evaluate(() => document.querySelectorAll('.command-task-tab').length)
  const storeTaskCount = await page.evaluate(() => {
    const w = window
    return w.__deskTaskCountForTest ?? null
  })
  rec.record(
    '后台失败没有额外占用面板标签（命令任务列表仍为空）',
    taskCount === 0,
    `面板任务标签=${taskCount} store=${storeTaskCount}`
  )

  // 同一原因重复发生：只累加计数，不刷多条
  await inject('fatal: unable to access remote: 无法解析主机')
  await inject('fatal: unable to access remote: 无法解析主机')
  await new Promise((resolve) => setTimeout(resolve, 500))
  const rows = await panel.locator('.git-failures__list > li').count()
  rec.record(
    '同原因重复失败只累加计数（不刷多条）',
    rows === 1 && (await panel.innerText()).includes('×3'),
    `条目数=${rows} 文本=${JSON.stringify((await panel.innerText()).slice(0, 120))}`
  )

  // 清空
  await panel.getByRole('button', { name: '清空' }).click()
  await new Promise((resolve) => setTimeout(resolve, 300))
  rec.record('可以清空', (await panel.count()) === 0, `count=${await panel.count()}`)

  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
  console.log('调试：页面错误', pageErrors.join(' | ').slice(0, 500))
} finally {
  await app.close()
  fixture.cleanup()
}

rec.finish()
