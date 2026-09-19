// 外部修改与未保存冲突的专项回归。
//
// 机制：Desk 打开笔记时拿到 revision，保存时把它作为 expectedRevision 发回去；
// 若期间文件被**外部**改过，主进程判定 revision 不一致 → REVISION_CONFLICT。
// 这个套件验的就是这条真实链路（单测只覆盖了渲染端收到该错误后的行为）。
//
// 需要先构建：pnpm --filter desk exec electron-vite build
// Run: node apps/desk/scripts/e2e-external-change.mjs
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-external-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'ext-kb')
const notes = join(kb, 'notes')
const noteFile = join(notes, '0042. 会被外部改的笔记.md')
mkdirSync(notes, { recursive: true })
mkdirSync(profile, { recursive: true })

const ORIGINAL =
  '---\nid: 44444444-4444-4444-8444-444444444444\n---\n\n# 会被外部改的笔记\n\n原始正文\n'
writeFileSync(join(kb, 'tnotes.json'), JSON.stringify({ title: 'ext-kb', name: 'ext-kb' }))
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0042. 会被外部改的笔记\n')
writeFileSync(noteFile, ORIGINAL)
writeFileSync(join(profile, 'workspace.v1.json'), JSON.stringify({ path: workspace }))
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  JSON.stringify({
    version: 1,
    theme: 'light',
    defaultNoteView: 'visual',
    // 关掉自动保存：什么时候保存由测试说了算
    autosave: { enabled: false, delayMs: 1000 }
  })
)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const HARD_LIMIT_MS = 3 * 60_000
let hardLimitHit = false
const hardLimitTimer = setTimeout(() => {
  hardLimitHit = true
  console.log(`FAIL  自计时上限 ${HARD_LIMIT_MS}ms 到了，强制收尾`)
}, HARD_LIMIT_MS)
hardLimitTimer.unref?.()

async function waitFor(check, timeoutMs = 10000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (hardLimitHit) return null
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
    NO_PROXY: '*',
    no_proxy: '*',
    ELECTRON_RUN_AS_NODE: undefined,
    ELECTRON_DISABLE_SANDBOX: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  }
})

const pageErrors = []
const page = await app.firstWindow()
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text())
})
await page.waitForLoadState('domcontentloaded')

const conflictBanner = () => page.locator('.conflict-banner')
const notePathBar = () => page.locator('.note-path-bar')
const editorText = async () =>
  (await page
    .locator('.ProseMirror, .milkdown')
    .first()
    .innerText()
    .catch(() => '')) || ''

try {
  await page.waitForSelector('.kb-sidebar, aside', { timeout: 20000 })
  await waitFor(async () => (await page.getByText('ext-kb', { exact: true }).count()) > 0, 20000)
  await page.getByText('ext-kb', { exact: true }).first().click()

  // ── E1 打开笔记：编辑器载入磁盘内容 ──
  const row = page.locator('.toc-row', { hasText: '会被外部改的笔记' }).first()
  await waitFor(async () => (await row.count()) > 0, 20000)
  await row.click()
  const opened = await waitFor(async () => (await notePathBar().count()) > 0, 20000)
  record('E1 笔记能在编辑器里打开', Boolean(opened))
  const loaded = await waitFor(async () => (await editorText()).includes('原始正文'), 15000, 250)
  record('E1b 编辑器载入的是磁盘内容', Boolean(loaded))

  // ── E2a 先在编辑器里真的输入：冲突场景要求 Desk 侧有未保存编辑 ──
  // （文档不脏时保存是空操作，不会去比对 revision——那不是冲突场景）
  await page.locator('.ProseMirror, .milkdown').first().click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('本地未保存的一笔')
  const dirty = await waitFor(
    async () => (await editorText()).includes('本地未保存的一笔'),
    8000,
    200
  )
  record('E2a 编辑器里产生未保存编辑', Boolean(dirty))

  // ── E2 外部改盘：不经过 Desk 直接改文件 ──
  const externallyChanged = ORIGINAL.replace('原始正文', '外部改过的正文')
  writeFileSync(noteFile, externallyChanged)
  record(
    'E2 外部改动已写入磁盘（测试前提）',
    readFileSync(noteFile, 'utf8').includes('外部改过的正文')
  )

  // ── E3 在 Desk 里保存：必须检测到冲突，而不是把外部改动覆盖掉 ──
  await page.keyboard.press('ControlOrMeta+s')
  const bannerShown = await waitFor(async () => (await conflictBanner().count()) > 0, 20000)
  record(
    'E3 保存时检测到外部改动：弹出冲突横幅（没有静默覆盖）',
    Boolean(bannerShown),
    bannerShown ? (await conflictBanner().innerText()).split('\n')[0] : '没有横幅'
  )
  const onDiskAfterSave = readFileSync(noteFile, 'utf8')
  record(
    'E3b 冲突时磁盘内容没有被 Desk 覆盖',
    onDiskAfterSave.includes('外部改过的正文'),
    onDiskAfterSave.includes('外部改过的正文') ? '外部内容仍在' : '被覆盖了'
  )
  record(
    'E3d 冲突时 Desk 侧的本地编辑没有被丢掉',
    (await editorText()).includes('本地未保存的一笔'),
    (await editorText()).slice(-60).replace(/\n/g, ' ')
  )
  record(
    'E3c 横幅给出两个明确出口',
    (await conflictBanner().getByText('载入磁盘').count()) > 0 &&
      (await conflictBanner().getByText('保留编辑内容').count()) > 0
  )

  // ── E4 「载入磁盘」：编辑器跟上磁盘，横幅消失 ──
  await conflictBanner().getByText('载入磁盘').click()
  const reloaded = await waitFor(
    async () => (await editorText()).includes('外部改过的正文'),
    15000,
    250
  )
  record('E4「载入磁盘」后编辑器显示外部内容', Boolean(reloaded))
  const bannerGone = await waitFor(async () => (await conflictBanner().count()) === 0, 10000)
  record('E4b 载入磁盘后冲突横幅消失', Boolean(bannerGone))

  // ── E5 冲突状态下再次保存不得覆盖磁盘 ──
  await page.keyboard.press('ControlOrMeta+s')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  record(
    'E5 载入磁盘后保存不会把外部内容改回去',
    readFileSync(noteFile, 'utf8').includes('外部改过的正文')
  )

  record('E6 全程没有未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))
} catch (error) {
  record('E 断言执行', false, error instanceof Error ? error.message : String(error))
  console.log('调试：页面错误', pageErrors.join(' | ').slice(0, 600))
} finally {
  clearTimeout(hardLimitTimer)
  await app.close()
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log(`失败：${failed.map((item) => item.name).join('、')}`)
  process.exitCode = 1
}
if (process.env.KEEP_FIXTURE !== '1') rmSync(fixture, { recursive: true, force: true })
else console.log(`fixture 保留在 ${fixture}`)
