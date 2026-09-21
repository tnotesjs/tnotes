// 可视化视图里「特殊块」的边界光标与删除行为（验收第 5 项）。
//
// 验收确认的两套规则（对称）：
//   块后紧邻段落开头 + Backspace → 块右下角**可见光标**（内容不变）；再按一次 → 删整块
//   块前紧邻段落末尾 + Delete    → 块左上角可见光标（内容不变）；再按一次 → 删整块
// 中间**没有**「整块选中」的中间态；长按重复事件不额外拦截（连按就是"落点 → 删块"）。
//
// 证据来源：`window.__deskNavProbe()`（编辑器自己的只读巡检探针，读的是 PM state：
// 选区类型 / 贴哪一侧 / 贴着哪类块）+ DOM 里的可见光标元素 + 顶层块清单。
//
// Run: node apps/desk/scripts/e2e-boundary-delete.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
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

const BODY = [
  '前段', // 1
  '',
  '::: tip 提示标题', // 3
  '提示正文', // 4
  ':::', // 5
  '',
  'TIP 后段', // 7
  '',
  '![图](../assets/a.svg)', // 9
  '',
  '图后段', // 11
  '',
  '```js', // 13
  'const a = 1', // 14
  '```', // 15
  '',
  '码后段', // 17
  '',
  '::: code-group', // 19
  '```js', // 20
  'const b = 2', // 21
  '```', // 22
  ':::', // 23
  '',
  '组后段', // 25
  ''
]

const fixture = createFixture('boundary-delete', {
  notes: [{ index: '0001', title: '边界', body: BODY.join('\n') }]
})
mkdirSync(join(fixture.kb, 'assets'), { recursive: true })
writeFileSync(
  join(fixture.kb, 'assets', 'a.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#5b8def"/></svg>'
)
const shots = join(deskDir, 'scripts', 'shots', 'boundary-delete')
mkdirSync(shots, { recursive: true })

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

/** 编辑器里的只读探针（读 PM state，不靠 DOM 几何猜块） */
const probe = async () => page.evaluate(() => window.__deskNavProbe?.() ?? null)
const outline = async () => page.evaluate(() => window.__deskNavOutline?.() ?? [])
const boundaryCaretSides = async () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.desk-block-boundary-caret')].map(
      (node) => node.getAttribute('data-side') ?? ''
    )
  )
const outlineKinds = async () => (await outline()).map((block) => block.kind)

const caretToParagraphStart = async (text) => {
  const line = page.getByText(text, { exact: true }).first()
  await line.click()
  await page.keyboard.press('Home')
  await page.waitForTimeout(150)
}
const caretToParagraphEnd = async (text) => {
  const line = page.getByText(text, { exact: true }).first()
  await line.click()
  await page.keyboard.press('End')
  await page.waitForTimeout(150)
}

/** 一个「块后段落开头 Backspace」的完整剧本 */
const checkBackspaceAfter = async (label, paragraphText, expectedBoundaryKind) => {
  const before = await outlineKinds()
  await caretToParagraphStart(paragraphText)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(250)
  const first = await probe()
  const sides = await boundaryCaretSides()
  rec.record(
    `${label}：第一下只把光标落到块边界（可见光标 + 无整块选中态）`,
    first?.selection === 'BlockBoundaryCaret' &&
      first?.side === 'after' &&
      first?.boundaryKind === expectedBoundaryKind &&
      sides.includes('after'),
    `probe=${JSON.stringify(first)} sides=${JSON.stringify(sides)}`
  )
  rec.record(
    `${label}：第一下不改内容`,
    JSON.stringify(await outlineKinds()) === JSON.stringify(before),
    `before=${JSON.stringify(before)} after=${JSON.stringify(await outlineKinds())}`
  )

  await page.keyboard.press('Backspace')
  await page.waitForTimeout(250)
  const after = await outlineKinds()
  // 精确对照：顶层块清单应当**只**少掉光标贴着的那一块（去掉它的下标）
  const index = typeof first?.block === 'number' ? first.block : -1
  const expected = index >= 0 ? [...before.slice(0, index), ...before.slice(index + 1)] : []
  rec.record(
    `${label}：第二下只删掉整块（其它块一个不动）`,
    index >= 0 && JSON.stringify(after) === JSON.stringify(expected),
    `index=${index} kind=${expectedBoundaryKind} after=${JSON.stringify(after)}`
  )

  await page.keyboard.press('ControlOrMeta+z')
  await page.waitForTimeout(350)
  const restored = await outlineKinds()
  rec.record(
    `${label}：一次撤销恢复整块`,
    JSON.stringify(restored) === JSON.stringify(before),
    `restored=${JSON.stringify(restored)}`
  )
}

/** 一个「块前段落末尾 Delete」的完整剧本 */
const checkDeleteBefore = async (label, paragraphText, expectedBoundaryKind) => {
  const before = await outlineKinds()
  await caretToParagraphEnd(paragraphText)
  await page.keyboard.press('Delete')
  await page.waitForTimeout(250)
  const first = await probe()
  const sides = await boundaryCaretSides()
  rec.record(
    `${label}：第一下只把光标落到块边界（可见光标 + 无整块选中态）`,
    first?.selection === 'BlockBoundaryCaret' &&
      first?.side === 'before' &&
      first?.boundaryKind === expectedBoundaryKind &&
      sides.includes('before'),
    `probe=${JSON.stringify(first)} sides=${JSON.stringify(sides)}`
  )
  await page.keyboard.press('Delete')
  await page.waitForTimeout(250)
  const after = await outlineKinds()
  const index = typeof first?.block === 'number' ? first.block : -1
  const expected = index >= 0 ? [...before.slice(0, index), ...before.slice(index + 1)] : []
  rec.record(
    `${label}：第二下只删掉整块（其它块一个不动）`,
    index >= 0 && JSON.stringify(after) === JSON.stringify(expected),
    `index=${index} kind=${expectedBoundaryKind} after=${JSON.stringify(after)}`
  )
  await page.keyboard.press('ControlOrMeta+z')
  await page.waitForTimeout(350)
  rec.record(
    `${label}：一次撤销恢复整块`,
    JSON.stringify(await outlineKinds()) === JSON.stringify(before),
    `restored=${JSON.stringify(await outlineKinds())}`
  )
}

try {
  await openNote(page, { kbName: fixture.kbName, title: '边界' })
  await waitFor(async () => (await page.locator('.milkdown .ProseMirror').count()) > 0, 20000)
  await page.evaluate(() => {
    window.__DESK_NAV_PROBE = true
  })
  const initial = await outline()
  rec.record(
    '探针就绪：文档顶层块符合夹具预期',
    initial.length > 0 && initial.some((block) => block.kind === 'deskCallout'),
    `blocks=${JSON.stringify(initial.map((block) => block.kind))}`
  )
  await page.screenshot({ path: join(shots, 'boundary-before.png') })

  // 1. 提示块（callout）：块后段首 Backspace
  await checkBackspaceAfter('提示块后', 'TIP 后段', 'deskCallout')
  // 2. 图片（独立成段）：块后段首 Backspace
  await checkBackspaceAfter('图片后', '图后段', 'paragraph')
  // 3. 普通代码块：块后段首 Backspace（修复前会进代码内部文字末尾）
  await checkBackspaceAfter('代码块后', '码后段', 'code_block')
  // 4. 代码组：块前段尾 Delete（向前删除）
  await checkDeleteBefore('代码组前', '码后段', 'deskRawBlock')

  // 5. 段内还有字时先正常删字（不接管）
  const paragraph = page.getByText('TIP 后段', { exact: true }).first()
  await paragraph.click()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(250)
  const control = await probe()
  rec.record(
    '段内还有字时先正常删字（不落到块边界）',
    control?.selection !== 'BlockBoundaryCaret',
    `probe=${JSON.stringify(control)} text=${await paragraph.textContent()}`
  )
  await page.keyboard.press('ControlOrMeta+z')
  await page.waitForTimeout(250)

  await page.screenshot({ path: join(shots, 'boundary-after.png') })
  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(shots, 'boundary-failure.png') }).catch(() => {})
} finally {
  await app.close()
  fixture.cleanup()
}

rec.finish()
