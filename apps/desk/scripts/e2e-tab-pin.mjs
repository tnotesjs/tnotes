// 第 6 项验收：固定标签显示图钉，点击图钉只取消固定（不关闭标签）。
//
// Run: node apps/desk/scripts/e2e-tab-pin.mjs
import { createFixture, createRecorder, launchDesk, trackPageErrors, waitFor } from './e2e-lib.mjs'

const rec = createRecorder()
const fixture = createFixture('tab-pin', {
  notes: [
    { index: '0001', title: '甲', body: '# 甲\n\n正文甲\n' },
    { index: '0002', title: '乙', body: '# 乙\n\n正文乙\n' }
  ]
})

// 自计时上限（macOS 无 timeout）：跑飞时要留下已完成的部分而不是静默挂住
const HARD_LIMIT_MS = 3 * 60_000
const hardLimitTimer = setTimeout(() => {
  console.log(`FAIL  自计时上限 ${HARD_LIMIT_MS}ms 到了，强制收尾`)
}, HARD_LIMIT_MS)
hardLimitTimer.unref?.()

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

// 标签右键是**原生菜单**，Playwright 点不到；按仓库既有做法在主进程把菜单请求
// 换成固定动作（渲染端链路仍然真实执行）。
let menuAction = 'toggle-pin'
await app.evaluate(({ ipcMain }, action) => {
  ipcMain.removeHandler('context-menu:show')
  ipcMain.handle('context-menu:show', () => ({ ok: true, value: action }))
}, menuAction)

const pinnedRow = () => page.locator('.tabs-row.pinned-row')
const regularRow = () => page.locator('.tabs-row.regular-row')
const pinOf = (title) =>
  page.locator(`.tabs-row.pinned-row .tab:has-text("${title}") .pin-mark`).first()
const tabOf = (title) => page.locator(`.tab:has-text("${title}")`).first()

try {
  await page.waitForSelector('.kb-sidebar, aside', { timeout: 20000 })
  await waitFor(
    async () => (await page.getByText(fixture.kbName, { exact: true }).count()) > 0,
    20000
  )
  await page.getByText(fixture.kbName, { exact: true }).first().click()

  // 打开「甲」（笔记默认是预览态，会被下一篇替换），先用快捷键固定它
  const rowA = page.locator('.toc-row', { hasText: '甲' }).first()
  await waitFor(async () => (await rowA.count()) > 0, 20000)
  await rowA.click()
  await new Promise((resolve) => setTimeout(resolve, 500))
  // 右键 → 主进程菜单被替换为 toggle-pin（真实渲染端逻辑：showTabMenu 收到动作后
  // 调 editor.togglePinned）
  await tabOf('甲').click({ button: 'right' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  const pinnedViaMenu = await pinnedRow().locator('.tab').count()
  rec.record('右键菜单可固定（保留入口）', pinnedViaMenu === 1, `pinned=${pinnedViaMenu}`)

  // 再打开「乙」：甲已固定不会被替换
  const rowB = page.locator('.toc-row', { hasText: '乙' }).first()
  await waitFor(async () => (await rowB.count()) > 0, 20000)
  await rowB.click()
  await new Promise((resolve) => setTimeout(resolve, 500))
  const tabsBefore = await page.locator('.editor-group .tab').count()
  rec.record('两篇笔记都已打开', tabsBefore >= 2, `tabs=${tabsBefore}`)

  rec.record(
    '固定行与普通行同时存在',
    (await pinnedRow().count()) === 1 && (await regularRow().count()) === 1
  )
  const pinnedCount = await pinnedRow().locator('.tab').count()
  rec.record('固定后进入固定行', pinnedCount === 1, `pinned=${pinnedCount}`)

  // 图钉存在且带可访问名称
  const pin = pinOf('甲')
  const pinShown = (await pin.count()) > 0
  rec.record('固定标签显示图钉', pinShown)
  if (pinShown) {
    const label = await pin.getAttribute('aria-label')
    const title = await pin.getAttribute('title')
    rec.record(
      '图钉有可访问名称与悬浮提示',
      label === '取消固定标签' && Boolean(title),
      `aria=${label} title=${title}`
    )
    const role = await pin.getAttribute('role')
    rec.record('图钉可作为按钮操作', role === 'button', `role=${role}`)
  }
  rec.record(
    '固定标签排在最前（独立固定行）',
    (await pinnedRow().count()) === 1 && (await regularRow().count()) === 1
  )

  // 点击图钉：只取消固定，不关闭标签
  await pin.click()
  await new Promise((resolve) => setTimeout(resolve, 400))
  const pinnedAfter = await pinnedRow().locator('.tab').count()
  const tabsAfter = await page.locator('.editor-group .tab').count()
  const stillOpen = (await page.locator('.tab:has-text("甲")').count()) > 0
  rec.record('点图钉后取消固定', pinnedAfter === 0, `pinned=${pinnedAfter}`)
  rec.record(
    '取消固定不关闭标签',
    stillOpen && tabsAfter === tabsBefore,
    `tabs=${tabsAfter}/${tabsBefore}`
  )
  rec.record(
    '标签内容未受影响（甲仍在编辑区）',
    (await page.locator('.ProseMirror').first().innerText()).includes('正文甲')
  )

  // 取消固定后回到普通行，且可再次固定（开关可逆）
  rec.record(
    '取消固定后回到普通行',
    (await regularRow().locator('.tab:has-text("甲")').count()) > 0
  )
  await tabOf('甲').click({ button: 'right' })
  await new Promise((resolve) => setTimeout(resolve, 700))
  const pinnedAgain = await pinnedRow().locator('.tab').count()
  rec.record('可再次固定（开关可逆）', pinnedAgain === 1, `pinned=${pinnedAgain}`)
  if (pinnedAgain === 1) {
    const pin2 = pinOf('甲')
    await pin2.focus()
    await page.keyboard.press('Enter')
    await new Promise((resolve) => setTimeout(resolve, 400))
    rec.record('键盘也能通过图钉取消固定', (await pinnedRow().locator('.tab').count()) === 0)
    rec.record('取消固定后标签仍开着', (await page.locator('.tab:has-text("甲")').count()) > 0)
  }

  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
  console.log('调试：页面错误', pageErrors.join(' | ').slice(0, 500))
} finally {
  clearTimeout(hardLimitTimer)
  await app.close()
  fixture.cleanup()
}

rec.finish()
