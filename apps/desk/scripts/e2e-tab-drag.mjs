// Tab drop previews and cleanup, against an isolated temporary KB/profile.
import assert from 'node:assert/strict'
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-tab-drag-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'TNotes.tab-drag')
const shots = join(deskDir, 'scripts', 'shots', 'tab-drag')
mkdirSync(kb, { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })
writeFileSync(join(kb, 'tnotes.json'), JSON.stringify({ title: 'tab-drag' }))
mkdirSync(join(kb, 'notes'), { recursive: true })
const names = ['drag-A', 'drag-B', 'drag-C']
const sources = []
const toc = names.map((name, index) => {
  const base = `${String(index + 1).padStart(4, '0')}. ${name}`
  const source =
    `---\nid: 10000000-0000-4000-8000-00000000009${index}\n---\n\n` +
    `# ${name}\n\n` +
    Array.from({ length: 25 }, (_, i) => `Line ${i + 1}: preserved note content.\n`).join('\n')
  const path = join(kb, 'notes', `${base}.md`)
  writeFileSync(path, source)
  sources.push({ path, source })
  return `- [ ] ${base}`
})
writeFileSync(join(kb, 'TOC.md'), `${toc.join('\n')}\n`)
writeFileSync(join(profile, 'workspace.v1.json'), JSON.stringify({ path: workspace }))
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  JSON.stringify({
    version: 1,
    theme: 'dark',
    defaultNoteView: 'source',
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
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByText('tab-drag', { exact: true }).first().click()
  for (const name of names) await page.getByText(name, { exact: true }).first().dblclick()
  const groups = page.locator('.editor-group')
  const first = groups.first()
  const initialIds = await first
    .locator('.tab')
    .evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabId))
  const body = first.locator('.editor-group-body')
  const tab = first.locator('.tab').filter({ hasText: 'drag-A' })
  // A pinned row makes the header taller than the old hard-coded 35px offset.
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.focus()
    const primary = process.platform === 'darwin' ? 'meta' : 'control'
    for (const [keyCode, modifiers] of [
      ['k', [primary]],
      ['Enter', [primary, 'shift']]
    ]) {
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }
  })
  await first.locator('.pinned-row').waitFor()
  assert.ok((await first.locator('.tabs-bar').boundingBox()).height >= 70)
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const begin = async () => {
    await tab.dispatchEvent('dragstart', { dataTransfer: transfer })
    await first.locator('.tab-drag-surface').waitFor()
  }
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const over = async (group, x, y, type = 'dragover') => {
    const bounds = await group.locator('.editor-group-body').boundingBox()
    await group.locator('.tab-drag-surface').dispatchEvent(type, {
      dataTransfer: transfer,
      clientX: bounds.x + bounds.width * x,
      clientY: bounds.y + bounds.height * y
    })
  }
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const cleared = async () => {
    await page.locator('.tab-drop-preview').waitFor({ state: 'detached' })
    await page.locator('.tab-drag-surface').first().waitFor({ state: 'detached' })
  }
  await begin()
  assert.equal(await page.locator('.tab-drop-preview').count(), 0)
  for (const [x, y, direction] of [
    [0.05, 0.5, 'left'],
    [0.95, 0.5, 'right'],
    [0.5, 0.05, 'top'],
    [0.5, 0.95, 'bottom']
  ]) {
    await over(first, x, y)
    const preview = page.locator(`.tab-drop-preview.${direction}`)
    await preview.waitFor()
    assert.equal(await page.locator('.tab-drop-preview').count(), 1)
    assert.equal(await preview.innerText(), '')
    const [rect, area] = await Promise.all([preview.boundingBox(), body.boundingBox()])
    const horizontal = direction === 'left' || direction === 'right'
    // 窗格够宽时内容区不该有横向滚动条（滚动条会占掉高度，预览框跟着变矮）
    const box = await body.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      clientHeight: node.clientHeight,
      offsetHeight: node.offsetHeight
    }))
    assert.ok(
      box.scrollWidth <= box.clientWidth + 1,
      `${direction} 内容区不应出现横向溢出 ${JSON.stringify(box)}`
    )
    assert.ok(
      Math.abs(rect.width - area.width * (horizontal ? 0.5 : 1)) < 2,
      `${direction} width rect=${JSON.stringify(rect)} area=${JSON.stringify(area)} ${JSON.stringify(box)}`
    )
    assert.ok(
      Math.abs(rect.height - area.height * (horizontal ? 1 : 0.5)) < 2,
      `${direction} height rect=${JSON.stringify(rect)} area=${JSON.stringify(area)} ${JSON.stringify(box)}`
    )
    assert.ok(rect.y >= area.y)
    assert.equal(
      await preview.evaluate((element) => getComputedStyle(element).pointerEvents),
      'none'
    )
  }
  await page.screenshot({ path: join(shots, 'bottom-preview-dark.png') })
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  await page.screenshot({ path: join(shots, 'bottom-preview-light.png') })
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.keyboard.press('Escape')
  await cleared()
  console.log(
    '✓ only the hovered half is previewed, with no labels or full-page dimming; Escape clears it'
  )

  for (const ending of ['dragend', 'outside-drop', 'blur']) {
    await begin()
    await over(first, 0.5, 0.95)
    if (ending === 'outside-drop')
      await page.locator('.titlebar').dispatchEvent('drop', { dataTransfer: transfer })
    else if (ending === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    else await tab.dispatchEvent('dragend', { dataTransfer: transfer })
    await cleared()
  }
  await begin()
  await over(first, 0.5, 0.95)
  await page.locator('.titlebar').dispatchEvent('dragover', { dataTransfer: transfer })
  assert.equal(await page.locator('.tab-drop-preview').count(), 0)
  await tab.dispatchEvent('dragend', { dataTransfer: transfer })
  await cleared()
  const textDrag = await page.evaluateHandle(() => {
    const data = new DataTransfer()
    data.setData('text/plain', 'interior block')
    return data
  })
  await body.dispatchEvent('dragover', { dataTransfer: textDrag })
  assert.equal(await page.locator('.tab-drop-preview, .tab-drag-surface').count(), 0)
  console.log(
    '✓ dragend, outside drop, blur and leaving valid regions clear guides; content drags do not activate them'
  )

  // Native pointer drag: verify the actual gesture, not only synthetic events.
  const tabRect = await tab.boundingBox()
  const area = await body.boundingBox()
  await page.mouse.move(tabRect.x + tabRect.width / 2, tabRect.y + tabRect.height / 2)
  await page.mouse.down()
  await page.mouse.move(area.x + area.width / 2, area.y + area.height * 0.95, { steps: 20 })
  await page.locator('.tab-drop-preview.bottom').waitFor({ timeout: 5000 })
  await page.mouse.up()
  await cleared()
  await page.waitForFunction(() => document.querySelectorAll('.editor-group').length === 2)
  assert.equal(await groups.nth(0).locator('.tab').count(), 2)
  assert.equal(await groups.nth(1).locator('.tab').count(), 1)
  assert.equal(await groups.nth(1).locator('.tab').getAttribute('data-tab-id'), initialIds[0])
  const afterIds = await page
    .locator('.editor-group .tab')
    .evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabId))
  assert.deepEqual(afterIds.toSorted(), initialIds.toSorted())
  console.log(
    '✓ actual pointer drag splits below and moves the original tab without duplication or stale overlays'
  )

  // Merge it back across groups; the source group disappears during drop.
  await groups.nth(1).locator('.tab').dispatchEvent('dragstart', { dataTransfer: transfer })
  await over(groups.nth(0), 0.5, 0.5)
  await page.locator('.tab-drop-preview.center').waitFor()
  await over(groups.nth(0), 0.5, 0.5, 'drop')
  await cleared()
  assert.equal(await groups.count(), 1)
  assert.equal(await page.locator('.editor-group .tab').count(), 3)
  assert.equal(await page.locator('.tab .dirty-dot').count(), 0)
  for (const { path, source } of sources) assert.equal(readFileSync(path, 'utf8'), source)
  await page.screenshot({ path: join(shots, 'after-drop.png') })
  console.log(
    '✓ cross-group center drop merges, cleans up even when the source unmounts, and leaves note contents unchanged'
  )
} catch (error) {
  const page = await app.firstWindow()
  await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => undefined)
  throw error
} finally {
  await app.close()
  rmSync(fixture, { recursive: true, force: true })
}
