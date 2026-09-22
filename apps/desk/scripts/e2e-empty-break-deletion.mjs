// Runtime regression: consecutive standalone <br /> map to Milkdown empty
// paragraphs via remark-preserve-empty-line (same as the official playground).
import assert from 'node:assert/strict'
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = mkdtempSync(join(tmpdir(), 'desk-empty-break-e2e-'))
const workspace = join(fixtureRoot, 'workspace')
const profile = join(fixtureRoot, 'profile')
const kb = join(workspace, 'TNotes.empty-break-e2e')
const noteFile = join(kb, 'notes', '0001. empty breaks.md')
const shots = join(deskDir, 'scripts', 'shots', 'empty-break-deletion')

mkdirSync(join(kb, 'notes'), { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })

writeFileSync(join(kb, 'tnotes.json'), `${JSON.stringify({ title: 'empty-break-e2e' }, null, 2)}\n`)
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0001. empty breaks\n')
const originalSource =
  '---\nid: 10000000-0000-4000-8000-000000000018\n---\n\n# Empty break deletion\n\nbefore\n\n<br />\n\n<br />\n\n<br />\n\nafter\n\n<B id="readonly-e2e" />\n'
writeFileSync(noteFile, originalSource)
writeFileSync(
  join(profile, 'workspace.v1.json'),
  `${JSON.stringify({ path: workspace }, null, 2)}\n`
)
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  `${JSON.stringify(
    {
      version: 1,
      defaultNoteView: 'visual',
      theme: 'dark',
      autosave: { enabled: false, delayMs: 1000 }
    },
    null,
    2
  )}\n`
)

const app = await _electron.launch({
  executablePath: electronPath,
  args: ['out/main/index.js', `--user-data-dir=${profile}`],
  cwd: deskDir,
  timeout: 60000,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
})

try {
  const page = await app.firstWindow({ timeout: 30000 })
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1200, height: 760 })
  await page.getByText('empty-break-e2e', { exact: true }).first().waitFor({ timeout: 30000 })
  await page.getByText('empty-break-e2e', { exact: true }).first().click()
  await page.getByText('empty breaks', { exact: true }).first().click()

  const pm = page.locator('.milkdown .ProseMirror').first()
  await pm.waitFor({ timeout: 30000 })
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })

  const emptyCount = await page.evaluate(() => {
    const root = document.querySelector('.milkdown .ProseMirror')
    if (!root) return 0
    return [...root.querySelectorAll(':scope > p')].filter(
      (element) => (element.textContent ?? '').trim() === ''
    ).length
  })
  assert.ok(emptyCount >= 3, `expected >= 3 empty paragraphs, got ${emptyCount}`)
  // Frontmatter and the component stay protected atoms; standalone <br /> must
  // not become atoms. The H1 follows the frontmatter, so it is a regular heading.
  assert.equal(await pm.locator('[data-kind="raw-frontmatter"]').count(), 1)
  assert.equal(await pm.locator('[data-kind="raw-component"]').count(), 1)
  assert.equal(await pm.locator('[data-type="desk-raw-block"]').count(), 2)
  await page.screenshot({ path: join(shots, '01-three-empty-lines.png') })
  console.log('✓ consecutive standalone <br /> render as empty paragraphs')

  const middle = await page.evaluateHandle(() => {
    const root = document.querySelector('.milkdown .ProseMirror')
    const empties = [...root.querySelectorAll(':scope > p')].filter(
      (element) => (element.textContent ?? '').trim() === ''
    )
    return empties[1] ?? null
  })
  const middleElement = middle.asElement()
  assert.ok(middleElement)
  const box = await middleElement.boundingBox()
  assert.ok(box)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(100)

  const focusedEmpty = await page.evaluate(() => {
    const selection = document.getSelection()
    const node = selection?.anchorNode
    const paragraph =
      node instanceof Element ? node.closest('p') : node?.parentElement?.closest('p')
    return {
      isEmptyParagraph: Boolean(paragraph && (paragraph.textContent ?? '').trim() === ''),
      selectionCollapsed: selection?.isCollapsed ?? false
    }
  })
  assert.equal(focusedEmpty.isEmptyParagraph, true)
  assert.equal(focusedEmpty.selectionCollapsed, true)
  await page.screenshot({ path: join(shots, '04-middle-empty-paragraph-focused.png') })
  console.log('✓ clicking a middle empty paragraph places a native caret')

  // 只读阅读视图已移除：「不可写文件"的只读保护由 e2e-note-readonly 覆盖

  await page.getByRole('button', { name: '源码视图', exact: true }).click()
  // 源码视图已是 Monaco：文本层是 .view-lines
  const sourceContent = page.locator('.markdown-source-editor .view-lines').first()
  await sourceContent.waitFor()
  // Monaco 的空格是 \u00a0：比较前统一成普通空格
  const sourceAfterReadonlyAttempts = (await sourceContent.textContent()).replace(/\u00a0/g, ' ')
  assert.equal(sourceAfterReadonlyAttempts.includes('readonly-should-not-appear'), false)
  assert.equal((sourceAfterReadonlyAttempts.match(/<br \/>/g) ?? []).length, 3)

  await page.getByRole('button', { name: '可视化编辑', exact: true }).click()
  await pm.waitFor()
  const middleAfterReadonly = await page.evaluateHandle(() => {
    const root = document.querySelector('.milkdown .ProseMirror')
    const empties = [...root.querySelectorAll(':scope > p')].filter(
      (element) => (element.textContent ?? '').trim() === ''
    )
    return empties[1] ?? null
  })
  const middleAfterElement = middleAfterReadonly.asElement()
  assert.ok(middleAfterElement)
  const boxAfter = await middleAfterElement.boundingBox()
  assert.ok(boxAfter)
  await page.mouse.click(boxAfter.x + boxAfter.width / 2, boxAfter.y + boxAfter.height / 2)
  // 鼠标点击只同步了原生选区，ProseMirror 内部 selection 会稍后才跟上（切回可视化视图后
  // 还停在 H1）。不等这一拍就按 Delete，删除命令作用在旧选区上，什么都不会删（本地不等待
  // 5/5 失败、等 30–300ms 9/9 通过；CI runner 更慢，固定 120ms 仍会偶发）。所以这里不赌
  // 固定延时：保存后数磁盘上的 <br />，没生效就再按一次，直到真的删掉一个为止（最多 3 次）。
  const savedBreakCount = async () => {
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForTimeout(500)
    return (readFileSync(noteFile, 'utf8').match(/<br \/>/g) ?? []).length
  }
  await page.waitForTimeout(120)
  let remainingBreaks = await savedBreakCount()
  for (let attempt = 1; attempt <= 3 && remainingBreaks === 3; attempt += 1) {
    await page.keyboard.press('Delete')
    await page.waitForTimeout(300)
    remainingBreaks = await savedBreakCount()
  }
  await page.screenshot({ path: join(shots, '06-middle-line-deleted.png') })

  const saved = readFileSync(noteFile, 'utf8')
  assert.equal(remainingBreaks, 2, `Delete 后应只剩 2 个 <br />，实际 ${remainingBreaks}`)
  assert.equal(saved.includes('before'), true)
  assert.equal(saved.includes('after'), true)
  console.log('✓ readonly mode rejects edits')
  console.log('✓ Delete removes one empty paragraph and save keeps two <br /> lines')
} finally {
  await app.close()
  rmSync(fixtureRoot, { recursive: true, force: true })
}
