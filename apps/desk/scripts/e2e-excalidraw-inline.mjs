// 笔记里的画布图片：`![画布](../assets/NNNN-x.svg)` 按普通图片处理（可拖拽改尺寸、
// 描述、对齐），同名 `.excalidraw` 在时多一项「编辑」→ 打开画布标签页；
// 编辑期间笔记里那张图实时跟着变，标签页开着时图上显示「编辑中」。
// 需要先构建：pnpm --filter desk exec electron-vite build
// Run: node apps/desk/scripts/e2e-excalidraw-inline.mjs
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
const fixture = mkdtempSync(join(tmpdir(), 'desk-canvas-inline-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'canvas-inline')
const notes = join(kb, 'notes')
const assets = join(kb, 'assets')
const canvasPath = join(assets, '0001-drawing.excalidraw')
const derivedPath = join(assets, '0001-drawing.svg')
/** 普通 SVG（没有同名 .excalidraw）：必须仍然只是一张图片 */
const plainSvgPath = join(assets, '0001-plain.svg')
const notePath = join(notes, '0001. 画布组件.md')
const shots = join(deskDir, 'scripts', 'shots', 'excalidraw-inline')
mkdirSync(notes, { recursive: true })
mkdirSync(assets, { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })

const SCENE = `${JSON.stringify(
  {
    type: 'excalidraw',
    version: 2,
    source: 'desk-inline-fixture',
    elements: [
      {
        id: 'rect-1',
        type: 'rectangle',
        x: 80,
        y: 60,
        width: 200,
        height: 120,
        angle: 0,
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
        fillStyle: 'hachure',
        strokeWidth: 2,
        roughness: 1,
        opacity: 100,
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false
      }
    ],
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {}
  },
  null,
  2
)}\n`
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect width="240" height="140" fill="#ffffff"/></svg>\n'

writeFileSync(canvasPath, SCENE)
writeFileSync(derivedPath, PLACEHOLDER_SVG)
writeFileSync(
  plainSvgPath,
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="40" fill="#ccc"/></svg>\n'
)
writeFileSync(
  join(kb, 'tnotes.json'),
  `${JSON.stringify({ name: 'canvas-inline', title: 'canvas-inline' })}\n`
)
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0001. 画布组件\n')
const NOTE_BODY = [
  '---',
  'id: 11111111-1111-4111-8111-111111111111',
  '---',
  '',
  '# 画布组件',
  '',
  '组件上方段落。',
  '',
  '![画布](../assets/0001-drawing.svg)',
  '',
  '普通 SVG：',
  '',
  '![普通图](../assets/0001-plain.svg)',
  ''
].join('\n')
writeFileSync(notePath, NOTE_BODY)
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
const readDerived = () => readFileSync(derivedPath, 'utf8')
const countElements = () => {
  try {
    return JSON.parse(readFileSync(canvasPath, 'utf8')).elements.length
  } catch {
    return -1
  }
}
const filesWith = (extension) =>
  readdirSync(assets)
    .filter((name) => name.endsWith(extension))
    .sort()
const canvasFiles = () => filesWith('.excalidraw')
const derivedFiles = () => filesWith('.svg')

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

try {
  const page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', (error) => pageErrors.push(String(error.message ?? error)))
  await page.waitForLoadState('domcontentloaded')
  await page.getByText('canvas-inline', { exact: true }).first().click()
  await page.waitForTimeout(1200)
  await page.locator('.toc-row', { hasText: '画布组件' }).first().click()
  const pane = page.locator('.tab-content:visible .milkdown .ProseMirror').first()
  await pane.waitFor({ timeout: 30000 })
  await page.waitForTimeout(600)

  /** 笔记里的两张图：画布图（有同名 .excalidraw）与普通 SVG */
  const canvasFigure = () => page.locator('figure.desk-image:visible').first()
  const plainFigure = () => page.locator('figure.desk-image:visible').nth(1)
  const canvasImage = () => canvasFigure().locator('.desk-image__frame > img').first()

  // 1) 只读渲染：笔记里就是一张普通 <img>，不挂任何 Excalidraw 实例
  const imageReady = await waitFor(async () => {
    const src = await canvasImage().getAttribute('src')
    return src?.startsWith('tnotes-asset://') ? src : null
  }, 20000)
  record(
    '笔记里的画布就是一张普通图片（渲染不挂 Excalidraw）',
    Boolean(imageReady) &&
      imageReady.includes('.svg') &&
      (await page.locator('.ProseMirror .excalidraw').count()) === 0 &&
      (await pane.locator('.excalidraw__canvas').count()) === 0,
    `src=${imageReady?.slice(0, 60)}`
  )
  record(
    '图片交互仍在：拖拽把手 + 宽高 / 描述 / 对齐',
    (await canvasFigure().locator('.desk-image__handle').count()) === 4 &&
      (await canvasFigure().locator('[data-label="宽高"]').count()) === 1 &&
      (await canvasFigure().locator('[data-label="描述"]').count()) === 1 &&
      (await canvasFigure().locator('[data-label="对齐"]').count()) === 1
  )

  // 2) 只有画布图有「编辑」：普通 SVG 没有
  await canvasFigure().click()
  await page.waitForTimeout(300)
  const canvasHasEdit = await canvasFigure().locator('.desk-image__canvas-edit').isVisible()
  await plainFigure().click()
  await page.waitForTimeout(300)
  const plainEditCount = await plainFigure().locator('.desk-image__canvas-edit:visible').count()
  record(
    '「编辑」只对有同名 .excalidraw 的图出现',
    canvasHasEdit && plainEditCount === 0,
    `canvas=${canvasHasEdit} plain=${plainEditCount}`
  )

  // 3) 描述写回：只改这一行
  const beforeCaption = readNote()
  await canvasFigure().click()
  await page.waitForTimeout(200)
  await canvasFigure().locator('[data-label="描述"]').click()
  // 描述框已移出 figure（6dc6d04 起挂在编辑器 canvas 上，见 deskImageView.ts 的
  // resolveCaptionHost），所以不能用 figure 后代选择器；用页面级选择器 + 显式聚焦。
  const caption = page.locator('input.desk-image__caption').first()
  await caption.click()
  await caption.fill('架构图')
  await caption.press('Enter')
  const captionWritten = await waitFor(
    () => readNote().includes('![架构图](../assets/0001-drawing.svg)'),
    10000
  )
  const afterCaption = readNote()
  const beforeLines = beforeCaption.split('\n')
  const afterLines = afterCaption.split('\n')
  const changedLines = afterLines
    .map((line, index) => (line === beforeLines[index] ? null : index))
    .filter((index) => index != null)
  record(
    '改描述只改图片那一行（其它字节完全不动）',
    Boolean(captionWritten) &&
      afterLines.length === beforeLines.length &&
      changedLines.length === 1 &&
      canvasFiles().length === 1,
    `changed=${JSON.stringify(changedLines)}`
  )

  // 4) 点「编辑」→ 打开画布标签页；笔记里不出现任何就地编辑器
  await canvasFigure().click()
  await page.waitForTimeout(200)
  await canvasFigure().locator('.desk-image__canvas-edit').click()
  const tabOpened = await waitFor(
    async () => (await page.locator('.tab', { hasText: '.excalidraw' }).count()) === 1,
    15000
  )
  const canvas = page.locator('.tab-content:visible .excalidraw__canvas.interactive').first()
  await canvas.waitFor({ timeout: 60000 })
  await page.waitForTimeout(1200)
  record(
    '点「编辑」打开画布标签页（笔记里没有就地编辑器）',
    Boolean(tabOpened) && (await pane.locator('.excalidraw').count()) === 0
  )
  await page.screenshot({ path: join(shots, 'canvas-tab.png') })

  // 5) 在标签页里画一笔：源文件写盘 + 派生 SVG 重导出 + 笔记里的图实时更新
  const derivedBeforeDraw = readDerived()
  await page.locator('[data-testid="toolbar-rectangle"]').first().click({ force: true })
  const box = await canvas.boundingBox()
  const x = box.x + box.width * 0.4
  const y = box.y + box.height * 0.35
  await page.mouse.move(x, y, { steps: 4 })
  await page.waitForTimeout(150)
  await page.mouse.down()
  for (let step = 1; step <= 4; step += 1) {
    await page.mouse.move(x + step * 24, y + step * 14)
    await page.waitForTimeout(70)
  }
  await page.mouse.up()
  const written = await waitFor(() => countElements() === 2, 15000)
  record('画布编辑实时写盘（元素 1 → 2）', Boolean(written), `elements=${countElements()}`)

  // 回到笔记：那张图应当已经换成内存里导出的 data URL（观感上"立刻"）
  await page.locator('.toc-row', { hasText: '画布组件' }).first().click()
  await pane.waitFor({ timeout: 20000 })
  const liveSrc = await waitFor(async () => {
    const src = await canvasImage().getAttribute('src')
    return src?.startsWith('data:image/svg+xml') ? src : null
  }, 15000)
  record(
    '编辑期间笔记里的图实时更新（内存导出，不等落盘）',
    Boolean(liveSrc),
    `src=${liveSrc?.slice(0, 40)}`
  )
  const editingBadge = await canvasFigure().locator('.desk-image__editing').isVisible()
  const editingBadgeText = await canvasFigure().locator('.desk-image__editing').textContent()
  record(
    '画布标签页开着时图上显示「编辑中」',
    editingBadge && (editingBadgeText ?? '').includes('编辑中'),
    `text=${JSON.stringify(editingBadgeText)}`
  )
  await page.screenshot({ path: join(shots, 'note-live-preview.png') })

  // 6) 关掉标签页：笔消失，派生 SVG 已按最新内容重导出
  await page.locator('.tab', { hasText: '.excalidraw' }).first().click()
  await page.locator('.tab', { hasText: '.excalidraw' }).locator('.tab-close').first().click()
  await page.waitForTimeout(1500)
  const tabClosed = await waitFor(
    async () => (await page.locator('.tab', { hasText: '.excalidraw' }).count()) === 0,
    10000
  )
  await page.locator('.toc-row', { hasText: '画布组件' }).first().click()
  await pane.waitFor({ timeout: 20000 })
  const badgeGone = await waitFor(
    async () => (await canvasFigure().locator('.desk-image__editing').isVisible()) === false,
    10000
  )
  record('关掉标签页后「编辑中」消失', Boolean(tabClosed) && Boolean(badgeGone))
  const derivedUpdated = await waitFor(() => readDerived() !== derivedBeforeDraw, 20000)
  record(
    '派生 SVG 按最新画布内容重导出（笔记里那张图不再是占位图）',
    Boolean(derivedUpdated) && derivedFiles()[0] === '0001-drawing.svg',
    `bytes=${readDerived().length}`
  )

  // 7) 画布内容变化不改笔记源码；画布文件与派生图各只有一份
  record(
    '画布内容变化不改笔记源码',
    readNote().includes('![架构图](../assets/0001-drawing.svg)'),
    ''
  )
  record(
    '资源各只有一份（源画布 + 同名派生 SVG）',
    canvasFiles().length === 1 && derivedFiles().length === 2,
    `canvas=${JSON.stringify(canvasFiles())} svg=${JSON.stringify(derivedFiles())}`
  )
  record('全流程无页面错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  record('fixture 未被意外删除', existsSync(notePath) && existsSync(canvasPath))
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
