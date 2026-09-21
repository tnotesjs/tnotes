// 源码视图（Monaco）的标题 / 代码块折叠，以及命令面板里那几个折叠命令的**按视图分发**。
//
// 覆盖：
// - 真实点行号槽的折叠箭头：标题折到下一个同级或更高级标题之前；围栏折**整块**（反引号与波浪线）
// - 代码里的 `# 伪标题` 不产生折叠范围（不是章节）
// - 命令面板「全部折叠标题」只折标题，**不折代码块**（不能悄悄变成"折叠所有块"）
// - 切到可视化视图后命令落到可视化编辑器的折叠上（原来的行为不回归）
// - 换标签页后命令只作用于当前活动编辑器
// - 折叠是显示状态：不改文件、不标脏
//
// Run: node apps/desk/scripts/e2e-source-folding.mjs
import { mkdirSync, readFileSync } from 'node:fs'
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

const rec = createRecorder()

/**
 * 代码块放在最前面：这样「折叠全部标题」不会把它连带折进去
 * （它不在任何标题章节里），"只折标题不折代码块"才可断言。
 */
const BODY = [
  '```js', // 1 围栏起始
  '# 代码里的伪标题', // 2 伪标题：不该有折叠范围
  'const a = 1', // 3
  '```', // 4 围栏结束
  '正文 F', // 5
  '~~~text', // 6 波浪线围栏
  '波浪线里的内容', // 7
  '~~~', // 8
  '正文 G', // 9
  '# 一级标题', // 10
  '正文 A', // 11
  '## 二级标题', // 12
  '正文 B', // 13
  '### 三级标题', // 14
  '正文 C', // 15
  '## 二级之二', // 16
  '正文 D', // 17
  '# 一级之二', // 18
  '正文 E', // 19
  ''
]

const fixture = createFixture('src-folding', {
  notes: [
    { index: '0001', title: '折叠', body: BODY.join('\n') },
    { index: '0002', title: '另一篇', body: '# 另一篇\n\n正文 X\n' }
  ]
})
const noteFile = fixture.notePath('0001', '折叠')
const shots = join(deskDir, 'scripts', 'shots', 'source-folding')
mkdirSync(shots, { recursive: true })

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

/** 当前渲染出来的行文本（Monaco 用 \u00a0 画空白，比较前还原） */
const visibleLines = async () =>
  page
    .locator('.markdown-source-editor:visible')
    .first()
    .evaluate((root) =>
      [...root.querySelectorAll('.view-line')].map((node) =>
        (node.textContent ?? '').replace(/\u00a0/g, ' ')
      )
    )

const isVisible = (lines, needle) => lines.some((line) => line.includes(needle))

/** 量出某一行行号槽里的折叠箭头位置（先悬停让箭头显形） */
const foldControlAt = async (lineText) => {
  const line = page
    .locator('.markdown-source-editor:visible .view-line', { hasText: lineText })
    .first()
  const box = await line.boundingBox()
  if (box) await page.mouse.move(box.x - 40, box.y + box.height / 2)
  await page.waitForTimeout(200)
  return page.evaluate((text) => {
    // 隐藏标签页的源码编辑器还在 DOM 里（v-show），必须挑可见的那个
    const root = [...document.querySelectorAll('.markdown-source-editor')].find(
      (node) => node.offsetParent !== null
    )
    const lineEl = [...(root?.querySelectorAll('.view-line') ?? [])].find((node) =>
      (node.textContent ?? '').replace(/\u00a0/g, ' ').includes(text)
    )
    if (!lineEl) return { found: false, reason: 'line' }
    const rect = lineEl.getBoundingClientRect()
    const overlays = [...(root?.querySelectorAll('.margin-view-overlays > div') ?? [])]
    const overlay = overlays.find((node) => {
      const other = node.getBoundingClientRect()
      return Math.abs(other.top + other.height / 2 - (rect.top + rect.height / 2)) < 4
    })
    if (!overlay) return { found: false, reason: 'overlay' }
    const icon = overlay.querySelector(
      '.codicon-folding-expanded, .codicon-folding-manual-expanded, .codicon-folding-collapsed, .codicon-folding-manual-collapsed'
    )
    if (!icon) return { found: false, reason: 'icon' }
    const iconRect = icon.getBoundingClientRect()
    return {
      found: true,
      cls: String(icon.className),
      x: iconRect.x + iconRect.width / 2,
      y: iconRect.y + iconRect.height / 2
    }
  }, lineText)
}

const clickFold = async (lineText) => {
  const control = await foldControlAt(lineText)
  if (!control.found) return control
  await page.mouse.click(control.x, control.y)
  await page.waitForTimeout(350)
  return control
}

const openSourceView = async () => {
  await page
    .getByRole('button', { name: '源码视图', exact: true })
    .filter({ visible: true })
    .first()
    .click()
  return waitFor(
    async () => (await page.locator('.markdown-source-editor:visible .view-lines').count()) > 0,
    20000
  )
}

/** 用命令面板跑一个折叠命令（真实 UI 路径） */
const runPaletteCommand = async (title) => {
  await page.keyboard.press('ControlOrMeta+Shift+P')
  await page.waitForTimeout(400)
  const input = page.locator('.command-palette__input')
  await input.waitFor()
  await input.fill(`>${title}`)
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
}

try {
  await openNote(page, { kbName: fixture.kbName, title: '折叠' })
  rec.record('源码视图已打开（Monaco 文本层就绪）', Boolean(await openSourceView()))
  await page.waitForTimeout(400)

  const before = readFileSync(noteFile, 'utf8')

  // ── 1. 行号槽的折叠箭头：代码围栏折整块、代码里的伪标题不是章节 ──
  const fenceControl = await foldControlAt('```js')
  const fakeHeadingControl = await foldControlAt('# 代码里的伪标题')
  rec.record(
    '围栏起始行有折叠箭头，代码块里的伪标题没有',
    fenceControl.found && !fakeHeadingControl.found,
    `fence=${JSON.stringify(fenceControl)} fake=${JSON.stringify(fakeHeadingControl)}`
  )

  const fenceClicked = await clickFold('```js')
  const afterFence = await visibleLines()
  rec.record(
    '折叠箭头：代码围栏折掉整块（含块内伪标题与结尾围栏），块后正文仍在',
    fenceClicked.found &&
      !isVisible(afterFence, '# 代码里的伪标题') &&
      !isVisible(afterFence, 'const a = 1') &&
      isVisible(afterFence, '正文 F'),
    `lines=${JSON.stringify(afterFence.slice(0, 8))}`
  )
  await page.screenshot({ path: join(shots, 'fold-code-block.png') })

  // 展开回来，继续下面的标题用例
  await clickFold('```js')
  rec.record('再次点箭头可展开代码块', isVisible(await visibleLines(), 'const a = 1'))

  // ── 2. 标题：折到下一个同级或更高级标题之前 ──
  const headingClicked = await clickFold('# 一级标题')
  const afterHeading = await visibleLines()
  rec.record(
    '折叠箭头：一级标题折掉它到「下一个一级标题」之前的全部内容',
    headingClicked.found &&
      !isVisible(afterHeading, '正文 A') &&
      !isVisible(afterHeading, '## 二级标题') &&
      !isVisible(afterHeading, '### 三级标题') &&
      isVisible(afterHeading, '# 一级之二') &&
      isVisible(afterHeading, '正文 E'),
    `lines=${JSON.stringify(afterHeading.slice(0, 10))}`
  )
  await page.screenshot({ path: join(shots, 'fold-heading.png') })

  // ── 3. 波浪线围栏同样折整块 ──
  const tildeClicked = await clickFold('~~~text')
  const afterTilde = await visibleLines()
  rec.record(
    '波浪线围栏也折整块',
    tildeClicked.found &&
      !isVisible(afterTilde, '波浪线里的内容') &&
      isVisible(afterTilde, '正文 G'),
    `lines=${JSON.stringify(afterTilde.slice(0, 8))}`
  )
  await clickFold('~~~text')
  await clickFold('# 一级标题')
  await page.waitForTimeout(300)

  // ── 4. 命令面板「全部折叠标题」：只折标题，不折代码块 ──
  await runPaletteCommand('全部折叠标题')
  const afterFoldAll = await visibleLines()
  rec.record(
    '命令面板「全部折叠标题」：标题章节都折了',
    !isVisible(afterFoldAll, '正文 A') &&
      !isVisible(afterFoldAll, '## 二级标题') &&
      isVisible(afterFoldAll, '# 一级标题') &&
      isVisible(afterFoldAll, '# 一级之二'),
    `lines=${JSON.stringify(afterFoldAll.slice(0, 8))}`
  )
  rec.record(
    '命令面板「全部折叠标题」：**没有**顺手折掉代码块（保持标题语义）',
    isVisible(afterFoldAll, 'const a = 1') && isVisible(afterFoldAll, '波浪线里的内容'),
    `codeVisible=${isVisible(afterFoldAll, 'const a = 1')}`
  )
  await page.screenshot({ path: join(shots, 'fold-all-command.png') })

  await runPaletteCommand('全部展开标题')
  const afterUnfoldAll = await visibleLines()
  rec.record(
    '命令面板「全部展开标题」把标题章节都展开',
    isVisible(afterUnfoldAll, '正文 A') &&
      isVisible(afterUnfoldAll, '## 二级标题') &&
      isVisible(afterUnfoldAll, '正文 E'),
    `lines=${JSON.stringify(afterUnfoldAll.slice(0, 10))}`
  )

  // ── 5. 按级别折叠只动该级标题 ──
  await runPaletteCommand('折叠 2 级标题')
  const afterFoldLevel2 = await visibleLines()
  rec.record(
    '「折叠 2 级标题」只折 2 级章节：一级章节的正文仍在，2 级章节的正文被折',
    isVisible(afterFoldLevel2, '正文 A') &&
      !isVisible(afterFoldLevel2, '正文 B') &&
      !isVisible(afterFoldLevel2, '正文 D'),
    `lines=${JSON.stringify(afterFoldLevel2.slice(0, 10))}`
  )
  await runPaletteCommand('展开 2 级标题')
  rec.record('「展开 2 级标题」把 2 级章节展开回来', isVisible(await visibleLines(), '正文 B'))

  // ── 6. 折叠是显示状态：不改文件、不标脏 ──
  rec.record(
    '折叠 / 展开没有改写磁盘文件',
    readFileSync(noteFile, 'utf8') === before,
    `chars=${before.length}`
  )
  const dirty = await page.locator('.tab .dirty-dot:visible').count()
  rec.record('折叠 / 展开没有把标签标脏', dirty === 0, `dirtyDots=${dirty}`)

  // ── 7. 切到可视化视图：命令落到可视化编辑器的标题折叠上（原行为不回归） ──
  await page
    .getByRole('button', { name: '可视化编辑', exact: true })
    .filter({ visible: true })
    .first()
    .click()
  await waitFor(async () => (await page.locator('.milkdown .ProseMirror').count()) > 0, 20000)
  await runPaletteCommand('全部折叠标题')
  const visualCollapsed = await page.locator('.desk-heading-section--collapsed').count()
  rec.record(
    '可视化视图下同一命令折的是可视化编辑器（章节被折叠的节点数 > 0）',
    visualCollapsed > 0,
    `collapsedSections=${visualCollapsed}`
  )
  await page.screenshot({ path: join(shots, 'fold-visual.png') })
  await runPaletteCommand('全部展开标题')
  rec.record(
    '可视化视图下「全部展开标题」恢复',
    (await page.locator('.desk-heading-section--collapsed').count()) === 0
  )

  // ── 8. 换标签页后命令只作用于当前活动编辑器 ──
  await openSourceView()
  await runPaletteCommand('全部折叠标题')
  const firstFolded = !isVisible(await visibleLines(), '正文 A')
  await page.locator('.toc-row', { hasText: '另一篇' }).first().click()
  await page.waitForTimeout(800)
  await openSourceView()
  // 等到**可见**的那个编辑器真的换成「另一篇」再断言
  await waitFor(async () => isVisible(await visibleLines(), '正文 X'), 10000)
  const secondBefore = await visibleLines()
  await runPaletteCommand('全部折叠标题')
  const secondAfter = await visibleLines()
  rec.record(
    '换标签页后命令作用于当前活动编辑器（另一篇的标题被折）',
    firstFolded && isVisible(secondBefore, '正文 X') && !isVisible(secondAfter, '正文 X'),
    `firstFolded=${firstFolded} second=before:${isVisible(secondBefore, '正文 X')} after:${isVisible(secondAfter, '正文 X')}`
  )

  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(shots, 'fold-failure.png') }).catch(() => {})
} finally {
  await app.close()
  fixture.cleanup()
}

rec.finish()
