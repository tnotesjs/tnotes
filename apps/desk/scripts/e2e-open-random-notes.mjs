// E2E: launch desk (built output) via Playwright Electron, open 3 random notes, screenshot each.
import assert from 'node:assert/strict'
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const DESK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(DESK_DIR, 'scripts/shots/notes')
mkdirSync(SHOTS, { recursive: true })

// 自建临时 fixture。以前这里把 workspace 指向 `apps/desk/playground`，而该目录被
// `apps/desk/.gitignore` 忽略、不在仓库里 → 知识库列表为空、脚本必然红灯（环境依赖）。
// 现在用 mkdtempSync 造「一个知识库 + 四篇顶层笔记」，profile 也放临时目录，避免复用
// `/tmp` 里残留的脏 profile。
const fixtureRoot = mkdtempSync(join(tmpdir(), 'desk-open-random-notes-'))
const workspace = join(fixtureRoot, 'workspace')
const profile = join(fixtureRoot, 'profile')
const kb = join(workspace, 'TNotes.docs')
const NOTES = [
  ['0001. Alpha', '10000000-0000-4000-8000-000000000001'],
  ['0002. Beta', '10000000-0000-4000-8000-000000000002'],
  ['0003. Gamma', '10000000-0000-4000-8000-000000000003'],
  ['0004. Delta', '10000000-0000-4000-8000-000000000004']
]
mkdirSync(join(kb, 'notes'), { recursive: true })
mkdirSync(profile, { recursive: true })
writeFileSync(join(kb, 'tnotes.json'), JSON.stringify({ title: 'docs' }, null, 2) + '\n')
writeFileSync(join(kb, 'TOC.md'), NOTES.map(([title]) => `- [ ] ${title}\n`).join(''))
for (const [title, id] of NOTES) {
  writeFileSync(
    join(kb, 'notes', `${title}.md`),
    `---\nid: ${id}\n---\n\n# ${title}\n\n内容 ${title}\n`
  )
}
writeFileSync(
  join(profile, 'workspace.v1.json'),
  JSON.stringify({ path: workspace }, null, 2) + '\n'
)
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  JSON.stringify(
    {
      version: 1,
      theme: 'dark',
      defaultNoteView: 'visual',
      autosave: { enabled: false, delayMs: 1000 }
    },
    null,
    2
  ) + '\n'
)

const app = await _electron.launch({
  executablePath: electronPath,
  args: ['out/main/index.js', `--user-data-dir=${profile}`],
  cwd: DESK_DIR,
  timeout: 60000,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
})

// This is a plain JS (.mjs) Playwright helper; the TS-only return-type rule is
// not applicable to it, so opting out for this function.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function pickRandom(items, n) {
  const pool = [...items]
  const out = []
  while (out.length < n && pool.length) {
    const i = Math.floor(Math.random() * pool.length)
    out.push(pool.splice(i, 1)[0])
  }
  return out
}

try {
  const win = await app.firstWindow({ timeout: 30000 })
  await win.waitForLoadState('domcontentloaded')

  // 1) select the "docs" knowledge base
  const docs = win.locator('.knowledge-item', { hasText: 'docs' }).first()
  await docs.waitFor({ timeout: 30000 })
  await docs.click()
  await win.waitForTimeout(1500)

  // 2) expand every group so all note rows are in the DOM
  const disclosure = win.locator('.toc-row .disclosure')
  const disclosureCount = await disclosure.count()
  for (let i = 0; i < disclosureCount; i++) {
    const d = disclosure.nth(i)
    if ((await d.getAttribute('aria-label')) === '展开') {
      await d.click().catch(() => {})
    }
  }
  await win.waitForTimeout(1200)

  // 3) gather visible note rows
  const rows = win.locator('.toc-row[data-note-uuid]')
  const rowCount = await rows.count()
  const visible = []
  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i)
    if (await row.isVisible().catch(() => false)) visible.push(row)
  }
  // fixture 是自建的，行数必须完全对得上：否则「空列表」也会被当成打开成功
  assert.equal(visible.length, NOTES.length, `可见笔记行应为 ${NOTES.length} 篇`)

  // 默认按顺序取前 3 篇（可复现）；需要真随机时设 E2E_SHUFFLE=1
  const chosen = process.env.E2E_SHUFFLE === '1' ? pickRandom(visible, 3) : visible.slice(0, 3)
  const opened = []
  for (let k = 0; k < chosen.length; k++) {
    const row = chosen[k]
    const label = row.locator('.node-label').first()
    const titleText = ((await label.innerText()) || '').trim()
    const noteUuid = await row.getAttribute('data-note-uuid')
    assert.ok(titleText.length > 0, `第 ${k + 1} 篇笔记的标题不应为空`)
    await label.click({ timeout: 15000 })
    // 真的打开了才截图：编辑器里出现该标题，且只有这一行处于 active。
    // 侧栏 label 把编号与名字分成两行（`0001\nAlpha`），编辑器里是 `# 0001. Alpha`，
    // 所以两边都去掉空白与标点后再比。
    const normalizedTitle = titleText.replace(/[^\p{L}\p{N}]/gu, '')
    assert.ok(normalizedTitle.length > 0, `第 ${k + 1} 篇笔记的标题不应为空`)
    await win.waitForFunction(
      (text) =>
        [...document.querySelectorAll('.live-editor .cm-content')].some(
          (el) => el.innerText.replace(/[^\p{L}\p{N}]/gu, '').includes(text) === true
        ),
      normalizedTitle,
      { timeout: 15000 }
    )
    assert.equal(
      await win.locator('.toc-row[data-note-uuid].active').count(),
      1,
      `${titleText}: 应有且只有一行笔记处于 active`
    )
    const file = join(SHOTS, `random-${k + 1}.png`)
    await win.screenshot({ path: file })
    opened.push({ k: k + 1, titleText, noteUuid, file })
  }

  console.log('OPENED_NOTES=' + JSON.stringify(opened, null, 2))
} finally {
  await app.close()
  rmSync(fixtureRoot, { recursive: true, force: true })
}
