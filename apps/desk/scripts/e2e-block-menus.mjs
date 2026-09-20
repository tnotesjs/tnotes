// All block kinds share the six-dot menu. Uses only a temporary KB/profile.
import assert from 'node:assert/strict'
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-block-menus-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'TNotes.block-menus')
const noteFile = join(kb, 'notes', '0001. menus.md')
const shots = join(deskDir, 'scripts', 'shots', 'block-menus')
mkdirSync(join(kb, 'notes'), { recursive: true })
mkdirSync(join(kb, 'assets'), { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })
writeFileSync(join(kb, 'tnotes.json'), JSON.stringify({ title: 'block-menus' }))
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0001. menus\n')
const markdown = [
  '# Menus',
  '<!-- region:toc -->\n- [1. 概述](#1-概述)\n<!-- endregion:toc -->',
  '## 1. 概述',
  '<B id="menu-component" />',
  'Paragraph **bold** and `code`.',
  '- Item one\n  - Child item\n- Item two',
  '3. Ordered first\n4. Ordered second',
  '- [x] Task done\n- [ ] Task pending',
  '> Quoted text',
  '```js\nconst value = 1\n```',
  '| Column |\n| --- |\n| Cell |',
  '![Pixel](../assets/pixel.svg)',
  '---',
  'Last paragraph',
  ''
].join('\n\n')
const source = `---\nid: 10000000-0000-4000-8000-000000000022\n---\n\n${markdown}`
writeFileSync(noteFile, source)
writeFileSync(
  join(kb, 'assets', 'pixel.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>'
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
// Stub renderer clipboard writes so the user's clipboard is never changed.
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    window.blockMenuClipboard = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.blockMenuClipboard = text
        }
      }
    })
  })
  await page.getByText('block-menus', { exact: true }).first().click()
  await page.getByText('menus', { exact: true }).first().click()
  const pm = page.locator('.milkdown .ProseMirror')
  await pm.waitFor()
  const heading = pm.locator('h2')
  const headingText = await heading.innerText()
  // Set only the starting browser caret; every movement under test is a real key.
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  async function setHeadingCaret(offset) {
    await heading.scrollIntoViewIfNeeded()
    await pm.focus()
    await heading.evaluate((element, offset) => {
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()
      window.getSelection().setBaseAndExtent(text, offset, text, offset)
    }, offset)
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
  }
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  async function expectHeadingCaret(offset) {
    await page.waitForFunction((offset) => {
      const selection = window.getSelection()
      return (
        selection.isCollapsed &&
        selection.focusNode?.parentElement?.closest('h2') &&
        selection.focusOffset === offset &&
        !document.querySelector('.desk-generated-toc.ProseMirror-selectednode')
      )
    }, offset)
  }
  for (let offset = headingText.length; offset > 0; offset -= 1) {
    await setHeadingCaret(offset)
    await page.keyboard.press('ArrowLeft')
    await expectHeadingCaret(offset - 1)
  }
  for (let offset = 0; offset < headingText.length; offset += 1) {
    await setHeadingCaret(offset)
    await page.keyboard.press('ArrowRight')
    await expectHeadingCaret(offset + 1)
  }
  // 新模型：方向键进入相邻特殊块时先落到「块前/块后光标」（不再整块选中）。
  await setHeadingCaret(0)
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(
    () => document.querySelector('.desk-block-boundary-caret')?.dataset.side === 'after'
  )
  await page.keyboard.press('ArrowRight')
  await expectHeadingCaret(0)
  await setHeadingCaret(headingText.length)
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(
    () => document.querySelector('.desk-block-boundary-caret')?.dataset.side === 'before'
  )
  await page.keyboard.press('ArrowLeft')
  await expectHeadingCaret(headingText.length)
  await page.keyboard.press('Shift+ArrowLeft')
  assert.equal(await page.evaluate(() => window.getSelection().toString()), '述')
  await setHeadingCaret(0)
  await page.keyboard.press('Shift+ArrowRight')
  assert.equal(await page.evaluate(() => window.getSelection().toString()), '1')
  const tocToggle = pm.locator('.desk-generated-toc__toggle')
  await tocToggle.click()
  await setHeadingCaret(headingText.length)
  await page.keyboard.press('ArrowLeft')
  await expectHeadingCaret(headingText.length - 1)
  await page.screenshot({ path: join(shots, 'heading-arrow-left.png') })
  await tocToggle.click()
  assert.equal(readFileSync(noteFile, 'utf8'), source)
  console.log(
    '✓ heading arrows move character-by-character; only true boundaries select adjacent blocks; Shift selection stays native'
  )

  const handle = page.locator('.milkdown-block-handle')
  const menu = page.getByRole('menu', { name: '块操作' })
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  async function openMenu(target) {
    await target.scrollIntoViewIfNeeded()
    // 文本选区会让 Crepe 的格式工具条（.milkdown-toolbar[data-show=true]）浮在块上并拦截指针
    // 事件。实测（/tmp 探针）：Escape 与移开鼠标都收不掉，清掉 DOM 选区或点段落才会隐藏；
    // 而直接点目标块可能被代码块行手柄等浮层挡住，所以先清选区，必要时退回到点画布留白。
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    const toolbarHidden = await page
      .waitForFunction(
        () => document.querySelector('.milkdown-toolbar[data-show="true"]') === null,
        undefined,
        { timeout: 2000 }
      )
      .then(() => true)
      .catch(() => false)
    if (!toolbarHidden) {
      await page
        .locator('.milkdown-markdown-editor__canvas')
        .click({ position: { x: 10, y: 10 } })
        .catch(() => undefined)
      await page.waitForTimeout(150)
    }
    const box = await target.boundingBox()
    // 块上的浮层会拦截指针：格式工具条（文本选区时出现）与**图片描述浮层**
    // （描述框已移出 figure、绝对定位在图片下沿，见 deskImageView.ts；实测它会盖住
    // 图片块的下沿，让"块整体被覆盖"的候选点全部落在它上面）。
    // 这里把所有可能挡路的浮层都收集起来，命中任一个就换下一个候选点。
    /** @type {{ x: number, y: number, width: number, height: number }[]} */
    const overlays = []
    const toolbar = page.locator('.milkdown-toolbar[data-show="true"]')
    if ((await toolbar.count()) > 0) {
      const toolbarBox = await toolbar.boundingBox()
      if (toolbarBox) overlays.push(toolbarBox)
    }
    const captionRow = page.locator('.desk-image__caption-row:visible')
    if ((await captionRow.count()) > 0) {
      const rowBox = await captionRow.first().boundingBox()
      if (rowBox) overlays.push(rowBox)
    }
    const covered = (point) => {
      const x = box.x + point.x
      const y = box.y + point.y
      return overlays.some(
        (overlay) =>
          x >= overlay.x &&
          x <= overlay.x + overlay.width &&
          y >= overlay.y &&
          y <= overlay.y + overlay.height
      )
    }
    const candidates = [
      { x: Math.min(10, box.width / 2), y: Math.min(10, box.height / 2) },
      { x: Math.min(10, box.width / 2), y: Math.max(box.height - 6, 1) },
      { x: box.width / 2, y: box.height / 2 },
      { x: box.width / 2, y: Math.min(10, Math.max(box.height / 4, 1)) }
    ].filter((point) => !covered(point))
    if (candidates.length === 0) {
      throw new Error('块整体被浮层（格式工具条 / 图片描述浮层）覆盖，找不到可 hover 的点')
    }
    let shown = false
    for (const position of candidates) {
      await target.hover({ position })
      // BlockProvider throttles mousemove and animates the handle position.
      await page.waitForTimeout(450)
      if ((await handle.getAttribute('data-show')) === 'true') {
        shown = true
        break
      }
    }
    assert.equal(shown, true, 'hover 后块手柄应显示')
    assert.equal(await handle.locator('.operation-item:visible').count(), 1)
    await handle.locator('.operation-item:last-child').click()
    await menu.waitFor({ timeout: 5000 })
    assert.deepEqual(
      (await menu.getByRole('menuitem').allTextContents()).map((text) =>
        text.replace('›', '').trim()
      ),
      ['删除', '复制', '剪切', '在下方添加']
    )
  }
  const paragraph = pm.locator(':scope > p').filter({ hasText: /^Paragraph/ })
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const item = (text) =>
    pm
      .locator('li')
      .filter({ has: page.locator('p', { hasText: text }) })
      .last()
  const cases = [
    ['paragraph', paragraph, /Paragraph \*\*bold\*\* and `code`\./],
    ['heading', heading, /## 1\. 概述/],
    ['list-item', item('Item one'), /- Item one\n {2}- Child item/],
    ['nested-list-item', item('Child item'), /- Child item/],
    ['ordered-list-item', item('Ordered second'), /4\. Ordered second/],
    ['task-list-item', item('Task done'), /- \[x\] Task done/],
    ['blockquote', pm.locator('blockquote'), /> Quoted text/],
    ['code', pm.locator('.milkdown-code-block'), /```js\nconst value = 1\n```/],
    ['table', pm.locator('table').filter({ hasText: 'Column' }).last(), /\| Column \|/],
    [
      'image',
      pm.locator(':scope > p').filter({ has: page.locator('img') }),
      /!\[Pixel\]\(\.\.\/assets\/pixel\.svg\)/
    ],
    ['separator', pm.locator('hr'), /^(?:-{3,}|\*{3,}|_{3,})\s*$/],
    ['component', pm.locator('[data-kind="raw-component"]'), /<B id="menu-component" \/>/]
  ]
  for (const [kind, target, expected] of cases) {
    console.log('Checking block menu:', kind)
    await openMenu(target)
    await page.screenshot({ path: join(shots, `${kind}.png`) })
    await menu.getByRole('menuitem', { name: '复制', exact: true }).click()
    await menu.waitFor({ state: 'detached' })
    const copied = await page.evaluate(() => window.blockMenuClipboard)
    assert.match(copied, expected, `${kind} Markdown copy`)
    if (kind.includes('list-item'))
      assert.doesNotMatch(copied, /Item two|Ordered first|Task pending/)
  }
  assert.equal(readFileSync(noteFile, 'utf8'), source)
  console.log('✓ every visible six-dot button opens the same menu and copies its Markdown')

  await openMenu(item('Item one'))
  await menu.getByRole('menuitem', { name: '删除', exact: true }).click()
  await menu.waitFor({ state: 'detached' })
  assert.equal(await item('Item one').count(), 0)
  assert.equal(await item('Child item').count(), 0)
  assert.equal(await item('Item two').count(), 1)
  await page.keyboard.press('ControlOrMeta+Z')
  await item('Item one').waitFor()

  await openMenu(paragraph)
  await menu.getByRole('menuitem', { name: '剪切', exact: true }).click()
  await menu.waitFor({ state: 'detached' })
  assert.match(await page.evaluate(() => window.blockMenuClipboard), /Paragraph \*\*bold\*\*/)
  assert.equal(await paragraph.count(), 0)
  assert.equal(await pm.locator('h2').count(), 1)
  await page.keyboard.press('ControlOrMeta+Z')
  await paragraph.waitFor()
  console.log(
    '✓ delete/cut target the selected ordinary block; adjacent blocks survive and undo restores'
  )

  await openMenu(item('Item two'))
  await menu.getByRole('menuitem', { name: /在下方添加/ }).hover()
  const slash = page.locator('.milkdown-slash-menu')
  await slash.waitFor({ state: 'visible' })
  await slash.locator('li[data-index]').filter({ hasText: '提示块' }).click()
  await menu.waitFor({ state: 'detached' })
  // 提示块 ≠ raw container：tip/info/warning/danger 按设计插入 deskCallout（结构化 callout
  // 节点），只有非 callout 名的 `:::` 容器才投影成 [data-kind="raw-container"]。
  await pm.locator('[data-type="desk-callout"][data-callout="tip"]').waitFor()
  console.log('✓ list items also support the add-below submenu')
} catch (error) {
  const page = await app.firstWindow()
  await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => undefined)
  throw error
} finally {
  await app.close()
  rmSync(fixture, { recursive: true, force: true })
}
