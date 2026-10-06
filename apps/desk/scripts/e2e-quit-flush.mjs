// P1-4 行为验证：红叉 / 关窗时必须先 flush 未保存内容再退出。
// 隔离 profile + 临时知识库；自动保存关闭，因此内容是「脏」的。
// Run: node apps/desk/scripts/e2e-quit-flush.mjs   （需先 electron-vite build）
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAcceptanceKb } from './acceptance-fixture.mjs'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-quit-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'acceptance-kb')
mkdirSync(workspace, { recursive: true })
mkdirSync(profile, { recursive: true })
await writeAcceptanceKb(kb)
writeFileSync(join(profile, 'workspace.v1.json'), JSON.stringify({ path: workspace }))
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  JSON.stringify({
    version: 1,
    theme: 'light',
    defaultNoteView: 'visual',
    prettier: false,
    // 关掉自动保存：编辑内容保持 dirty，才能验证关窗前的 flush
    autosave: { enabled: false, delayMs: 1000 }
  })
)

const TYPED = '退出前应该被保存的内容'
const notePath = join(kb, 'notes', '0002. 重复与合并.md')
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
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

try {
  const page = await app.firstWindow({ timeout: 30000 })
  await page.waitForLoadState('domcontentloaded')
  await page.getByText('acceptance-kb', { exact: true }).first().click()
  await page.waitForTimeout(1500)
  await page.locator('.toc-row', { hasText: '重复与合并' }).first().click()
  await page.locator('.live-editor .cm-content').first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(600)
  await page.locator('.editor-surface:visible').first().click()
  await page.keyboard.type(TYPED)
  await page.waitForTimeout(400)
  record('前置：笔记处于未保存状态', !readFileSync(notePath, 'utf8').includes(TYPED))

  // 主进程侧：把「未保存的更改」对话框自动回答成「保存」，然后模拟点红叉
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    BrowserWindow.getAllWindows()[0]?.close()
  })

  let saved = false
  for (let attempt = 0; attempt < 60 && !saved; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      saved = readFileSync(notePath, 'utf8').includes(TYPED)
    } catch {
      saved = false
    }
  }
  record('关窗时先把未保存内容落盘', saved, saved ? '' : '笔记文件里没有新输入的内容')

  let windowsLeft = 1
  for (let attempt = 0; attempt < 40 && windowsLeft > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    // 窗口关闭后 page 已失效，只能用主进程侧探测
    windowsLeft = await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
      .catch(() => 0)
  }
  record('flush 完成后窗口才真正关闭', windowsLeft === 0, `剩余窗口 ${windowsLeft}`)
} finally {
  await app.close().catch(() => {})
  if (!process.env.KEEP_FIXTURE) rmSync(fixture, { recursive: true, force: true })
  console.log(`\n${results.every((item) => item.ok) ? 'ALL PASS' : 'HAS FAILURES'}`)
  process.exitCode = results.every((item) => item.ok) ? 0 : 1
}
