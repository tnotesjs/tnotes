// Header layout and inline rename, using only an isolated temporary KB/profile.
import assert from 'node:assert/strict'
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-note-header-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'TNotes.note-header')
const noteFile = join(kb, 'notes', '0001. 概述.md')
const noteUuid = '10000000-0000-4000-8000-000000000032'
const shots = join(deskDir, 'scripts', 'shots', 'note-header')
mkdirSync(join(kb, 'notes'), { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })
writeFileSync(join(kb, 'tnotes.json'), JSON.stringify({ title: 'note-header' }))
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0001. 概述\n')
writeFileSync(
  noteFile,
  `---\nid: ${noteUuid}\n---\n\n# 0001. 概述\n\n## 正文\n\nInitial content.\n`
)
writeFileSync(join(profile, 'workspace.v1.json'), JSON.stringify({ path: workspace }))
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  JSON.stringify({
    version: 1,
    theme: 'light',
    defaultNoteView: 'visual',
    prettier: false,
    autosave: { enabled: false, delayMs: 1000 }
  })
)

const app = await _electron.launch({
  executablePath: require('electron'),
  args: ['out/main/index.js', `--user-data-dir=${profile}`],
  cwd: deskDir,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
})

/**
 * 两态视图是整体开关：点任意一个图标都会切到"另一个视图"。
 * 需要"确保在某个视图"时，先看高亮，只有当前不是目标才点一次。
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function ensureView(page, mode) {
  const current = await page
    .locator('.view-switcher button.active')
    .first()
    .getAttribute('aria-label')
  if (current !== mode) await page.getByRole('button', { name: mode, exact: true }).click()
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function waitUntil(predicate) {
  const deadline = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for disk changes')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

try {
  const page = await app.firstWindow()
  // 固定到足够宽的窗口：窄窗口下页宽/分隔线会收进溢出菜单，布局断言会失去意义
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000)
  })
  await page.waitForTimeout(500)
  await page.waitForLoadState('domcontentloaded')
  await page.getByText('note-header', { exact: true }).first().click()
  await page.getByText('概述', { exact: true }).first().click()
  const pm = page.locator('.milkdown .ProseMirror')
  await pm.waitFor()
  const title = page.getByRole('button', { name: '重命名笔记', exact: true })
  const input = page.getByRole('textbox', { name: '笔记名称', exact: true })
  for (const mode of ['可视化编辑', '源码视图']) {
    // 两态是**一个整体开关**：进入目标视图要先确保当前不是它
    const current = await page
      .locator('.view-switcher button.active')
      .first()
      .getAttribute('aria-label')
    if (current !== mode) {
      await page.getByRole('button', { name: mode, exact: true }).click()
    }
    assert.equal(await page.locator('.note-pane .save-button').count(), 0)
    // 标题行从左到右固定是：标题 | 视图切换 | 竖线 | 格式工具条 | 布局开关。
    // 布局开关**始终展示**（原先窄面板会整组连竖线一起隐藏），所以四块都要可见；
    // 会随宽度变化的只有格式工具条**内部**的条目（多出来的收进「…」），工具条本身始终在。
    const bounds = await page.locator('.document-toolbar').evaluate((bar) => {
      // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
      const rectOf = (selector) => {
        const node = bar.querySelector(selector)
        if (!node) return null
        const rect = node.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return { hidden: true }
        return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom }
      }
      const toolbar = bar.getBoundingClientRect()
      return {
        toolbar: { y: toolbar.y, bottom: toolbar.bottom, right: toolbar.right },
        title: rectOf('.document-path'),
        views: rectOf('.view-switcher'),
        divider: rectOf('.view-divider'),
        format: rectOf('.format-overflow'),
        layout: rectOf('.layout-controls')
      }
    })
    const rowPieces = [bounds.title, bounds.views, bounds.divider, bounds.format, bounds.layout]
    assert.ok(rowPieces.every((piece) => piece && !piece.hidden))
    assert.ok(
      rowPieces.every(
        (piece) => piece.y >= bounds.toolbar.y - 1 && piece.bottom <= bounds.toolbar.bottom + 1
      )
    )
    assert.ok(bounds.title.right <= bounds.views.x)
    assert.ok(bounds.views.right <= bounds.divider.x)
    assert.ok(bounds.divider.right <= bounds.format.x)
    assert.ok(bounds.format.right <= bounds.layout.x)
    assert.ok(bounds.toolbar.right - bounds.layout.right < 20)
    // 格式化工具条已改成 FormatOverflowBar（内部按钮/图标由单测覆盖），
    // 这里只验它在三种视图下的存在性与禁用状态，以及它落在标题行下方
    const formatBar = page.locator('.format-overflow')
    assert.equal(await formatBar.count(), 1)
    const formatDisabled = await formatBar
      .first()
      .evaluate((node) => node.classList.contains('format-overflow--disabled'))
    // 两态都不再是"只读"：文件不可写时才禁用格式（另有 e2e-note-readonly 覆盖）
    assert.equal(formatDisabled, false)
    if (mode === '可视化编辑') {
      const format = await formatBar.first().boundingBox()
      assert.ok(format.width > 0)
    }
    // 高亮与滑块位置跟当前视图一致
    assert.equal(
      await page.locator('.view-switcher button.active').first().getAttribute('aria-label'),
      mode
    )
    assert.equal(
      await page
        .locator('.view-switcher__thumb')
        .evaluate((node) => node.classList.contains('is-source')),
      mode === '源码视图'
    )
    await page.screenshot({ path: join(shots, `${mode}.png`) })
  }

  // 整体开关：点"自己那一侧"的图标也会切到另一个视图
  await page.getByRole('button', { name: '可视化编辑', exact: true }).click() // 源码 → 可视化
  await pm.waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: '可视化编辑', exact: true }).click() // 可视化 → 源码
  await page.locator('.markdown-source-editor .view-lines').first().waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: '源码视图', exact: true }).click() // 源码 → 可视化
  await pm.waitFor({ timeout: 20000 })
  assert.equal(
    await page.locator('.view-switcher button.active').first().getAttribute('aria-label'),
    '可视化编辑'
  )
  console.log('✓ 视图开关：点任意一个图标都切到另一个视图，高亮/滑块跟随当前视图')
  console.log('✓ 标题行：路径 | 视图切换 | 格式工具条 | 布局开关 同一行，右侧贴边，无保存按钮')
  // 格式工具条内部的按钮/溢出/标题菜单/表格行为已由 FormatOverflowBar 与
  // NoteTabPane 的单测覆盖；这里的端到端只保留标题行布局、视图模式与重命名链路。

  await title.click()
  assert.equal(await input.inputValue(), '概述')
  assert.equal(await page.locator('.document-path .note-index').innerText(), '0001.')
  assert.equal(await input.evaluate((element) => document.activeElement === element), true)
  await input.fill('取消的名称')
  await input.press('Escape')
  assert.equal(await title.innerText(), '概述')
  await title.click()
  await input.fill('   ')
  await page.locator('.view-divider').click()
  assert.equal(await title.innerText(), '概述')

  // Make a real unsaved body edit, then rename on blur. Renaming must save it first.
  await ensureView(page, '可视化编辑')
  await pm.getByText('Initial content.', { exact: true }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' KEEP-DRAFT')
  await page.waitForFunction(() => document.querySelector('.tab.is-dirty, .tab .dirty-dot'))
  await title.click()
  await input.fill('  新的名称  ')
  await page.screenshot({ path: join(shots, 'inline-title.png') })
  assert.equal(existsSync(noteFile), true)
  await page.locator('.view-divider').click()
  const renamedNoteFile = join(kb, 'notes', '0001. 新的名称.md')
  await waitUntil(() => existsSync(renamedNoteFile))
  await page.waitForFunction(
    () => document.querySelector('.note-title-button')?.textContent.trim() === '新的名称'
  )
  assert.equal(existsSync(noteFile), false)
  assert.match(readFileSync(renamedNoteFile, 'utf8'), /KEEP-DRAFT/)
  assert.match(readFileSync(join(kb, 'TOC.md'), 'utf8'), /0001\. 新的名称/)
  assert.match(readFileSync(renamedNoteFile, 'utf8'), new RegExp(`^id: ${noteUuid}$`, 'm'))
  assert.equal(await page.locator('.tab').filter({ hasText: '新的名称' }).count(), 1)
  assert.equal(
    (await page.locator('.toc-nodes .node-label').filter({ hasText: '新的名称' }).count()) > 0,
    true
  )
  assert.equal(await page.locator('.document-path .note-index').innerText(), '0001.')
  console.log(
    '✓ blur trims/renames the note file, TOC and tab; index/UUID and unsaved text preserved'
  )

  // 重命名与视图模式无关（元数据不被视图锁住）：在源码视图下也能改标题
  await ensureView(page, '源码视图')
  await title.click()
  await input.fill('最终名称')
  await input.press('Enter')
  const finalNoteFile = join(kb, 'notes', '0001. 最终名称.md')
  await waitUntil(() => existsSync(finalNoteFile))
  await page.waitForFunction(
    () => document.querySelector('.note-title-button')?.textContent.trim() === '最终名称'
  )
  await ensureView(page, '可视化编辑')
  await pm.waitFor({ timeout: 20000 })
  await pm.getByText(/KEEP-DRAFT/).click()
  await page.keyboard.type(' SHORTCUT-SAVED')
  await page.waitForFunction(() => document.querySelector('.tab.is-dirty, .tab .dirty-dot'))
  await page.keyboard.press('ControlOrMeta+s')
  await waitUntil(() => readFileSync(finalNoteFile, 'utf8').includes('SHORTCUT-SAVED'))
  const widthToggle = page.getByRole('button', { name: '标准页宽', exact: true })
  if (await widthToggle.count()) {
    await widthToggle.click()
    await page.getByRole('button', { name: '超宽显示', exact: true }).waitFor()
  } else {
    // 窄窗口下页宽开关收进溢出菜单；点击行为由 NoteTabPane 单测覆盖
    console.log('（页宽开关在溢出菜单里，本机宽度不适合做端到端点击）')
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.screenshot({ path: join(shots, 'renamed-dark.png') })
  console.log('✓ Enter 重命名 / 页宽开关 / Cmd+S 保存仍然正常')
} catch (error) {
  const page = await app.firstWindow()
  await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => undefined)
  throw error
} finally {
  await app.close()
  rmSync(fixture, { recursive: true, force: true })
}
