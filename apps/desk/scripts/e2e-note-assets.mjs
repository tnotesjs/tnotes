// 笔记级资源面板：显示引用的资源 / 编号匹配的资源、缩略图与放大预览、复制相对路径、
// 定位正文引用、一键插入图片、删除无效资源、修复编号不匹配（重命名 + 改引用）。
// 需要先构建：pnpm --filter desk exec electron-vite build
// Run: node apps/desk/scripts/e2e-note-assets.mjs
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-note-assets-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'note-assets')
const notes = join(kb, 'notes')
const assets = join(kb, 'assets')
const notePath = join(notes, '0007. 笔记.md')
const shots = join(deskDir, 'scripts', 'shots', 'note-assets')
mkdirSync(notes, { recursive: true })
mkdirSync(assets, { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })

/** 1×1 PNG（内容无所谓，只验证流程与文件级结果） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

writeFileSync(
  join(kb, 'tnotes.json'),
  `${JSON.stringify({ name: 'note-assets', title: 'note-assets' })}\n`
)
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0007. 笔记\n')
writeFileSync(
  notePath,
  [
    '---',
    'id: 77777777-7777-4777-8777-777777777777',
    '---',
    '',
    '# 笔记',
    '',
    '![本笔记的图](../assets/0007-used.png)',
    '',
    '![外来的图](../assets/0001-foreign.png)',
    '',
    '![画布](../assets/0007-canvas.svg)',
    '',
    '![丢了的图](../assets/0007-gone.png)',
    ''
  ].join('\n')
)
writeFileSync(join(assets, '0007-used.png'), PNG)
writeFileSync(join(assets, '0007-orphan.png'), PNG)
// 专门用来验证"删除无效资源"的资源：不会被插入正文，始终保持"编号匹配但没被引用"
writeFileSync(join(assets, '0007-doomed.png'), PNG)
writeFileSync(join(assets, '0001-foreign.png'), PNG)
writeFileSync(join(assets, '0007-gone.png'), PNG) // 先建后删，制造"引用缺失"
writeFileSync(join(assets, '0007-canvas.excalidraw'), '{"type":"excalidraw","elements":[]}\n')
writeFileSync(
  join(assets, '0007-canvas.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>\n'
)
// 孤儿画布：两半都没被引用 → 两半都算无效资源，应当能一起删掉
writeFileSync(join(assets, '0007-lonely.excalidraw'), '{"type":"excalidraw","elements":[]}\n')
writeFileSync(
  join(assets, '0007-lonely.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>\n'
)
rmSync(join(assets, '0007-gone.png'))
writeFileSync(join(profile, 'workspace.v1.json'), JSON.stringify({ path: workspace }))
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  JSON.stringify({
    version: 1,
    theme: 'light',
    defaultNoteView: 'visual',
    prettier: false,
    autosave: { enabled: true, delayMs: 300 }
  })
)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const readNote = () => readFileSync(notePath, 'utf8')
const assetNames = () => readdirSync(assets).sort()

async function waitFor(check, timeoutMs = 12000, intervalMs = 150) {
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

try {
  const page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', (error) => pageErrors.push(String(error.message ?? error)))
  // 布局开关组（页宽/目录/本笔记资源）在**面板**窄于 1080px 时整组隐藏（既有响应式规则）。
  // Electron 里 window 尺寸不走 page.setViewportSize，得直接 setBounds。
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 20, y: 20, width: 1800, height: 1100 })
  })
  await page.waitForLoadState('domcontentloaded')
  await page.getByText('note-assets', { exact: true }).first().click()
  await page.waitForTimeout(1200)
  await page.locator('.toc-row', { hasText: '笔记' }).first().click()
  const pane = page.locator('.tab-content:visible .milkdown .ProseMirror').first()
  await pane.waitFor({ timeout: 30000 })
  await page.waitForTimeout(600)

  // 1) 工具栏最右的开关 → 右侧文档属性栏出现（内含本笔记资源）
  const toggle = page.locator('[data-testid="note-properties-toggle"]').first()
  await toggle.waitFor({ timeout: 15000 })
  await toggle.click()
  const panel = page.locator('.note-assets-panel').first()
  await panel.waitFor({ timeout: 15000 })
  const panelCount = await page.locator('[data-testid="note-properties-panel"]').count()
  record('点工具栏图标展开「文档属性」侧栏', panelCount === 1, `panels=${panelCount}`)
  await page.screenshot({ path: join(shots, 'panel.png') })

  const rowFor = (name) => panel.locator('li').filter({ hasText: name }).first()
  await waitFor(async () => (await panel.innerText()).includes('0007-used.png'), 15000)
  const panelText = await panel.innerText()

  // 2) 三组信息都在：引用 / 编号匹配 / 引用缺失
  record(
    '列出引用的资源与编号匹配的资源，并标出引用缺失',
    panelText.includes('0007-used.png') &&
      panelText.includes('0007-orphan.png') &&
      panelText.includes('0007-doomed.png') &&
      panelText.includes('0001-foreign.png') &&
      panelText.includes('0007-gone.png'),
    JSON.stringify(panelText.slice(0, 200))
  )

  // 3) 无效资源（编号匹配但没被引用）才有删除按钮；画布两半不算无效
  const orphanDelete = rowFor('0007-doomed.png').getByRole('button', {
    name: '删除资源 0007-doomed.png'
  })
  const usedDelete = rowFor('0007-used.png').getByRole('button', {
    name: '删除资源 0007-used.png'
  })
  const canvasDeleteCount = await panel
    .getByRole('button', { name: /删除资源 0007-canvas/ })
    .count()
  const lonelyDelete = rowFor('0007-lonely.svg').getByRole('button', {
    name: '删除资源 0007-lonely.svg'
  })
  record(
    '无效资源给删除按钮；被引用的资源与画布（同名 .svg 被引用）都不给',
    (await orphanDelete.count()) === 1 &&
      (await usedDelete.count()) === 0 &&
      canvasDeleteCount === 0 &&
      (await lonelyDelete.count()) === 1,
    `orphan=${await orphanDelete.count()} used=${await usedDelete.count()} canvas=${canvasDeleteCount} lonely=${await lonelyDelete.count()}`
  )

  // 4) 编号不匹配的被引用资源给修复按钮
  const fixButton = rowFor('0001-foreign.png').getByRole('button', {
    name: '修复 0001-foreign.png 的编号前缀'
  })
  record('编号不匹配的引用资源给「修复编号」按钮', (await fixButton.count()) === 1)

  // 5) 复制相对路径（相对笔记文件）
  await rowFor('0007-used.png')
    .getByRole('button', { name: '复制 0007-used.png 的相对路径' })
    .click()
  const copied = await waitFor(async () => {
    const text = await app.evaluate(({ clipboard }) => clipboard.readText())
    return text === '../assets/0007-used.png' ? text : null
  }, 8000)
  record('复制路径给的是相对笔记文件的相对路径', copied === '../assets/0007-used.png', `${copied}`)

  // 6) 定位引用：可视化视图里选中那张图的节点
  await rowFor('0007-used.png')
    .getByRole('button', { name: '定位到正文中 0007-used.png 的引用' })
    .click()
  const located = await waitFor(
    // 可视化视图里图片节点用 is-selected 表达选中（PM 的 ProseMirror-selectednode 不一定在）
    async () =>
      (await page.locator('.desk-image.is-selected, .ProseMirror-selectednode').count()) > 0,
    8000
  )
  record('定位引用：正文里对应的图片节点被选中', Boolean(located))

  // 7) 一键插入：把未引用的 0007-orphan.png 插进正文
  const beforeInsert = readNote()
  await rowFor('0007-orphan.png')
    .getByRole('button', { name: '插入 0007-orphan.png 到当前笔记' })
    .click()
  const inserted = await waitFor(() => readNote().includes('../assets/0007-orphan.png'), 12000)
  record(
    '一键插入图片：笔记里出现该资源的引用',
    Boolean(inserted) && readNote() !== beforeInsert,
    JSON.stringify(readNote().slice(-80))
  )

  // 8) 修复编号：重命名 + 主进程改引用
  await rowFor('0001-foreign.png')
    .getByRole('button', { name: '修复 0001-foreign.png 的编号前缀' })
    .click()
  await page.waitForTimeout(500)
  const confirmFix = panel.getByRole('button', { name: /确认修复/ })
  if ((await confirmFix.count()) > 0) await confirmFix.first().click()
  const fixed = await waitFor(
    () =>
      existsSync(join(assets, '0007-foreign.png')) && !existsSync(join(assets, '0001-foreign.png')),
    25000
  )
  const noteAfterFix = await waitFor(
    () => (readNote().includes('../assets/0007-foreign.png') ? readNote() : null),
    15000
  )
  record(
    '修复编号：资源改名成 0007- 前缀，笔记里的引用同步改写',
    Boolean(fixed) && Boolean(noteAfterFix) && !String(noteAfterFix).includes('0001-foreign'),
    `assets=${JSON.stringify(assetNames())}`
  )

  // 9) 删除无效资源（两步行内确认）
  await rowFor('0007-doomed.png').getByRole('button', { name: '删除资源 0007-doomed.png' }).click()
  await page.waitForTimeout(300)
  const confirmDelete = panel.getByRole('button', { name: '确认删除 0007-doomed.png' })
  record('删除是两步行内确认（先出确认按钮）', (await confirmDelete.count()) === 1)
  await confirmDelete.click()
  const recycled = await waitFor(() => !existsSync(join(assets, '0007-doomed.png')), 25000)
  record(
    '确认后资源被回收（不再出现在 assets/），其它资源不受影响',
    Boolean(recycled) &&
      existsSync(join(assets, '0007-used.png')) &&
      existsSync(join(assets, '0001-foreign.png')) === false,
    `assets=${JSON.stringify(assetNames())}`
  )

  // 9b) 删无效画布：两半一起回收（以前真相源被主进程拦下，会报错）
  await rowFor('0007-lonely.svg').getByRole('button', { name: '删除资源 0007-lonely.svg' }).click()
  await page.waitForTimeout(300)
  const confirmPair = panel.getByRole('button', { name: '确认删除 0007-lonely.svg' })
  await confirmPair.click()
  const pairRecycled = await waitFor(
    () =>
      !existsSync(join(assets, '0007-lonely.svg')) &&
      !existsSync(join(assets, '0007-lonely.excalidraw')),
    25000
  )
  const pairErrorText = await panel
    .locator('[data-note-assets-action-error]')
    .innerText()
    .catch(() => '')
  record(
    '删无效画布：`.svg` 与 `.excalidraw` 一起回收，不报错',
    Boolean(pairRecycled) && pairErrorText === '',
    `assets=${JSON.stringify(assetNames())} error=${JSON.stringify(pairErrorText)}`
  )

  // 10) 关掉面板
  await page.getByRole('button', { name: '关闭文档属性' }).click()
  const closed = await waitFor(
    async () => (await page.locator('[data-testid="note-properties-panel"]').count()) === 0,
    8000
  )
  record('点关闭按钮收起侧栏', Boolean(closed))

  record('全流程无页面错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  await page.screenshot({ path: join(shots, 'after-actions.png') })
} catch (error) {
  record('运行未完成（未捕获异常）', false, String(error).split('\n')[0])
  throw error
} finally {
  await app.close().catch(() => {})
  if (!process.env.KEEP_FIXTURE) rmSync(fixture, { recursive: true, force: true })
  const passed = results.length > 0 && results.every((item) => item.ok)
  console.log(`\n${passed ? 'ALL PASS' : 'HAS FAILURES'}（${results.length} 项）`)
  console.log(`screenshots: ${shots}`)
  process.exitCode = passed ? 0 : 1
}
