// 左侧三视图，加上头部的资源入口和 demos 列表（生产构建）。
//
// 不点击会启动 IDE 的条目。
//
// Run: node apps/desk/scripts/e2e-navigator-views.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createFixture, createRecorder, launchDesk, trackPageErrors, waitFor } from './e2e-lib.mjs'

const rec = createRecorder()
const fixture = createFixture('navigator-views', {
  notes: [{ index: '0001', title: '甲笔记', body: '# 0001. 甲笔记\n\n独特关键词橘子\n' }]
})
mkdirSync(join(fixture.kb, 'assets'))
const demos = join(fixture.kb, 'demos')
mkdirSync(demos, { recursive: true })
mkdirSync(join(demos, '0002. 后'))
mkdirSync(join(demos, '0001. 先', 'inner'), { recursive: true })
mkdirSync(join(demos, '001. 位数不够'))
mkdirSync(join(demos, 'notes'))
writeFileSync(join(demos, '0004. 文件.txt'), 'x')
writeFileSync(join(demos, 'readme.txt'), 'x')

const activeView = (page) => page.locator('.view-tab.active').first().getAttribute('data-view')

try {
  const app = await launchDesk(fixture)
  const page = await app.firstWindow()
  const errors = trackPageErrors(page)
  await page.waitForLoadState('domcontentloaded')
  await waitFor(
    async () => (await page.getByText(fixture.kbName, { exact: true }).count()) > 0,
    20000
  )
  await page.getByText(fixture.kbName, { exact: true }).first().click()
  await waitFor(async () => (await page.locator('.view-tab').count()) === 3, 20000)

  const views = await page
    .locator('.view-tab')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-view')))
  rec.record(
    '只有笔记目录、搜索、Git 三个视图',
    views.join(',') === 'toc,search,git',
    views.join(',')
  )
  rec.record('首次默认笔记目录', (await activeView(page)) === 'toc')
  rec.record('README 在笔记目录里', await page.locator('.toc-view .readme-entry').isVisible())
  rec.record(
    '没有完整文件树入口',
    (await page
      .locator('.view-tab[data-view="files"], .repo-file-tree, .monaco-file-pane')
      .count()) === 0
  )

  await page.locator('.view-tab[data-view="search"]').click()
  const searchInput = page.locator('.search-view input[type="search"]')
  await searchInput.fill('独特关键词橘子')
  const result = page.locator('.search-result', { hasText: '甲笔记' })
  rec.record(
    '搜索正文命中，点击仍打开笔记页',
    Boolean(await waitFor(async () => (await result.count()) > 0, 15000))
  )
  await result.first().click()
  rec.record(
    '笔记页仍是 CodeMirror',
    Boolean(
      await waitFor(
        async () => (await page.locator('.live-editor .cm-content:visible').count()) > 0
      )
    )
  )

  await page.locator('.view-tab[data-view="git"]').click()
  rec.record('Git 视图承接变更', await page.locator('.git-view .git-heading').isVisible())

  const assetsButton = page.locator('.header-actions button[aria-label="资源"]')
  rec.record('存在 assets/ 时显示资源入口', await assetsButton.isVisible())
  await assetsButton.click()
  rec.record(
    '资源入口打开已有资源页',
    Boolean(await waitFor(async () => (await page.locator('.kb-assets-pane:visible').count()) > 0))
  )
  await assetsButton.click()
  const assetTabs = await page.locator('.tab', { hasText: '资源' }).count()
  rec.record('再次点击不重复创建资源标签', assetTabs === 1, `tabs=${assetTabs}`)

  const demosButton = page.locator('.header-actions button[aria-label="demos"]')
  rec.record('存在 demos/ 时显示 demos 入口', await demosButton.isVisible())
  await demosButton.click()
  rec.record(
    '未配置 IDE 时只提示先配置，不展示列表',
    (await page.locator('.demos-notice').isVisible()) &&
      (await page.locator('.demos-view .demo-row').count()) === 0 &&
      (await page.locator('.demos-settings').isVisible())
  )
  await page.locator('.demos-settings').click()
  await page.locator('[data-settings-group="tools"] select').first().selectOption('vscode')
  const settingsPath = join(fixture.profile, '.tn-desk-config.json')
  rec.record(
    '在设置里选择 IDE 后写入配置',
    Boolean(
      await waitFor(() => {
        try {
          return JSON.parse(readFileSync(settingsPath, 'utf8')).ide === 'vscode'
        } catch {
          return false
        }
      }, 8000)
    )
  )
  await page.locator('[aria-label="关闭设置"]').click()
  const rows = await waitFor(async () => {
    const count = await page.locator('.demos-view .demo-row').count()
    if (count >= 3) return count
    // 设置保存回到渲染进程之前再点一次：未配置提示还在时，点击会改去拉列表
    if ((await page.locator('.demos-notice').count()) > 0) await demosButton.click()
    return null
  }, 8000)
  const labels = await page.locator('.demos-view .demo-row').allTextContents()
  rec.record(
    '配置 IDE 后展示列表：第一项是「打开 demos」，其后只按编号列出合规文件夹',
    Boolean(rows) &&
      labels.map((label) => label.trim()).join('|') === '打开 demos|0001. 先|0002. 后',
    labels.join('|')
  )
  rec.record(
    '打开 demos 列表没有新开内容标签',
    (await page.locator('.tab', { hasText: 'demos' }).count()) === 0
  )
  await page.locator('.view-tab[data-view="toc"]').click()
  rec.record(
    '切回笔记目录后 demos 列表收起',
    (await page.locator('.demos-view').count()) === 0 && (await activeView(page)) === 'toc'
  )

  await page.evaluate(() => localStorage.setItem('tnotes-desk-navigator-view', 'files'))
  await page.reload()
  await waitFor(async () => (await page.locator('.view-tab').count()) === 3, 20000)
  rec.record('旧的文件树视图记忆回到笔记目录', (await activeView(page)) === 'toc')

  const relevantErrors = errors.filter((text) => !/ResizeObserver loop/.test(text))
  rec.record('无页面错误', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '))
  await app.close()
} catch (error) {
  rec.record('未捕获异常', false, error instanceof Error ? error.stack : String(error))
} finally {
  rec.finish()
  fixture.cleanup()
}
