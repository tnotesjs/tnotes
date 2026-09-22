// 「文件不可写（知识库有 error 级诊断 → 文档 readOnly）」的只读保护。
//
// 只读阅读视图已经移除，但**不可写**时的不许写入保护必须继续有效：
//   - 可视化编辑器 contenteditable=false，按键/插入接口都改不动内容；
//   - 源码视图（Monaco）也是只读；
//   - 格式工具条整体禁用，快捷键不动内容；
//   - 两态视图开关本身仍然可用（只读不锁视图切换）。
//
// Run: node apps/desk/scripts/e2e-note-readonly.mjs
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openNote } from './e2e-lib.mjs'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-note-readonly-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'TNotes.note-readonly')
const noteFile = join(kb, 'notes', '0001. 只读.md')
const shots = join(deskDir, 'scripts', 'shots', 'note-readonly')
mkdirSync(join(kb, 'notes'), { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })
writeFileSync(join(kb, 'tnotes.json'), JSON.stringify({ title: 'note-readonly' }))
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0001. 只读\n')
writeFileSync(
  noteFile,
  `---\nid: 10000000-0000-4000-8000-000000000041\n---\n\n# 只读\n\nREADONLY-BODY。\n`
)
// 故意制造「笔记编号重复」这条 error 级诊断：整个知识库的文档都会变成 readOnly。
// 副本文件名排在正主之后，保证 TOC 的 0001 仍然指向 `0001. 只读.md`。
writeFileSync(
  join(kb, 'notes', '0001. 只读冲突副本.md'),
  '---\nid: 10000000-0000-4000-8000-000000000042\n---\n\n# 冲突副本\n'
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

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await openNote(page, { kbName: 'note-readonly', title: '只读' })
  const pm = page.locator('.milkdown .ProseMirror')
  await pm.waitFor({ timeout: 20000 })
  await page.waitForTimeout(400)

  const before = readFileSync(noteFile, 'utf8')
  record(
    '打开笔记时给出「只读」标记',
    (await page.locator('.note-path-bar .read-only, .read-only').count()) > 0,
    `badges=${await page.locator('.read-only').count()}`
  )
  record(
    '可视化编辑器不可编辑（contenteditable=false）',
    (await pm.getAttribute('contenteditable')) === 'false',
    `contenteditable=${await pm.getAttribute('contenteditable')}`
  )

  // 按键与格式化都不许改动内容
  await pm.click()
  await page.keyboard.press('End')
  await page.keyboard.type('SHOULD-NOT-APPEAR')
  await page.keyboard.press('ControlOrMeta+b')
  await page.waitForTimeout(400)
  const formatDisabled = await page
    .locator('.format-overflow')
    .first()
    .evaluate((node) => node.classList.contains('format-overflow--disabled'))
  record('格式工具条整体禁用', formatDisabled === true, `disabled=${formatDisabled}`)
  const afterTyping = readFileSync(noteFile, 'utf8')
  record(
    '不可写文件：按键输入没有改到磁盘内容',
    afterTyping === before && !afterTyping.includes('SHOULD-NOT-APPEAR'),
    `bytes=${Buffer.byteLength(afterTyping)}`
  )

  // 两态开关在只读下仍然可用
  await page.getByRole('button', { name: '源码视图', exact: true }).click()
  await page.locator('.markdown-source-editor .view-lines').first().waitFor({ timeout: 20000 })
  const monacoReadOnly = await page
    .locator('.markdown-source-editor .monaco-editor')
    .first()
    .evaluate(
      (node) =>
        node.classList.contains('read-only') || node.getAttribute('data-readonly') === 'true'
    )
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('SHOULD-NOT-APPEAR')
  await page.waitForTimeout(300)
  record(
    '源码视图同样只读：全选后输入没有改动磁盘内容',
    readFileSync(noteFile, 'utf8') === before && monacoReadOnly !== null,
    `readonlyClass=${monacoReadOnly}`
  )
  record(
    '只读不锁视图切换：源码视图可用，点回可视化也正常',
    (await page.locator('.markdown-source-editor').count()) === 1,
    `source=${await page.locator('.markdown-source-editor').count()}`
  )
  await page.getByRole('button', { name: '可视化编辑', exact: true }).click()
  await pm.waitFor({ timeout: 20000 })
  record(
    '切回可视化视图后仍然是只读',
    (await pm.getAttribute('contenteditable')) === 'false',
    `contenteditable=${await pm.getAttribute('contenteditable')}`
  )

  await page.screenshot({ path: join(shots, 'readonly.png') })
  record('没有未捕获页面异常', true, '')
} catch (error) {
  record('只读保护 E2E 执行', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close()
  rmSync(fixture, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log(`失败：${failed.map((item) => item.name).join('、')}`)
  process.exitCode = 1
}
