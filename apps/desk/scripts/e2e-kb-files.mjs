// 知识库文本文件入口（只读）：笔记页的面包屑 → 打开库根配置（.gitignore / README / package.json）
// → 只读 Monaco 标签页；notes/ 下的笔记仍走既有笔记会话；二进制与画布只给提示。
// 需要先构建：pnpm --filter desk exec electron-vite build
// Run: node apps/desk/scripts/e2e-kb-files.mjs
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-kb-files-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'kb-files')
const notes = join(kb, 'notes')
const assets = join(kb, 'assets')
const shots = join(deskDir, 'scripts', 'shots', 'kb-files')
mkdirSync(notes, { recursive: true })
mkdirSync(assets, { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })

const NOTE_BODY = [
  '---',
  'id: 33333333-3333-4333-8333-333333333333',
  '---',
  '',
  '# 笔记',
  '',
  '正文段落。',
  ''
].join('\n')
writeFileSync(
  join(kb, 'tnotes.json'),
  `${JSON.stringify({ name: 'kb-files', title: 'kb-files' })}\n`
)
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0001. 笔记\n')
writeFileSync(join(notes, '0001. 笔记.md'), NOTE_BODY)
writeFileSync(join(kb, 'README.md'), '# 知识库说明\n\n这是根目录 README。\n')
writeFileSync(join(kb, '.gitignore'), 'node_modules/\n.tnotes/dist\n')
writeFileSync(join(kb, 'package.json'), '{\n  "name": "kb-files"\n}\n')
mkdirSync(join(kb, '.github', 'workflows'), { recursive: true })
writeFileSync(join(kb, '.github', 'workflows', 'deploy.yml'), 'name: deploy\non: push\n')
// 拒绝名单与二进制：都不该出现在列表里 / 打不开
mkdirSync(join(kb, 'node_modules', 'pkg'), { recursive: true })
writeFileSync(join(kb, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
mkdirSync(join(kb, '.git'), { recursive: true })
writeFileSync(join(kb, '.git', 'config'), '[core]\n')
mkdirSync(join(kb, '.tnotes', 'dist'), { recursive: true })
writeFileSync(join(kb, '.tnotes', 'dist', 'index.html'), '<html></html>\n')
writeFileSync(join(assets, '0001-pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
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
  await page.getByText('kb-files', { exact: true }).first().click()
  await page.waitForTimeout(1200)
  await page.locator('.toc-row', { hasText: '笔记' }).first().click()
  const pane = page.locator('.tab-content:visible .milkdown .ProseMirror').first()
  await pane.waitFor({ timeout: 30000 })
  await page.waitForTimeout(500)

  // class 是加在组件根元素上的：真实 DOM 是 <nav class="kb-path-breadcrumb note-path-bar">
  const breadcrumb = () => page.locator('.note-path-bar:visible').first()
  /** Monaco 把空格渲染成 \u00a0，读文本前先归一 */
  const textOf = async (locator) => (await locator.innerText()).replace(/\u00a0/g, ' ')
  const segments = () => breadcrumb().locator('.kb-path-segment')
  const menu = () => page.locator('.kb-path-menu:visible').first()
  const rows = () => menu().locator('.kb-path-row')

  // 1) 笔记页有面包屑，且末段是当前笔记
  await breadcrumb().waitFor({ timeout: 15000 })
  const segmentTexts = await segments().allInnerTexts()
  record(
    '笔记页显示「库名 › notes › 笔记名」面包屑',
    segmentTexts.length >= 3 &&
      segmentTexts[0]?.includes('kb-files') &&
      segmentTexts.some((text) => text.includes('notes')) &&
      segmentTexts.at(-1)?.includes('0001'),
    JSON.stringify(segmentTexts)
  )
  await page.screenshot({ path: join(shots, 'breadcrumb.png') })

  // 2) 点库名 → 列出库根；拒绝名单不出现在列表里
  await segments().first().click()
  await menu().waitFor({ timeout: 10000 })
  const rootRows = await rows().allInnerTexts()
  const rootLabels = rootRows.join('\n')
  record(
    '点库名列出库根条目，且过滤 .git / node_modules / .tnotes/dist',
    rootLabels.includes('README.md') &&
      rootLabels.includes('.gitignore') &&
      rootLabels.includes('package.json') &&
      rootLabels.includes('notes') &&
      !rootLabels.includes('node_modules') &&
      !rootLabels.includes('.tnotes'),
    JSON.stringify(rootRows.slice(0, 12))
  )

  // 3) 打开根目录 README.md → 只读 CodeMirror 文本标签页
  await menu().locator('.kb-path-filter').fill('README')
  await rows().first().click()
  const textPane = page.locator('.text-file-pane:visible').first()
  await textPane.waitFor({ timeout: 20000 })
  const editorReady = await waitFor(
    async () => (await textPane.locator('.cm-editor').count()) === 1,
    30000
  )
  const headerText = await textPane.locator('.pane-header').innerText()
  const visibleText = await textOf(textPane.locator('.cm-content'))
  record(
    'README.md 走只读 CodeMirror 标签页（有只读徽标与语言标签）',
    Boolean(editorReady) &&
      headerText.includes('README.md') &&
      headerText.includes('只读') &&
      headerText.includes('Markdown') &&
      visibleText.includes('# 知识库说明'),
    `header=${JSON.stringify(headerText)}`
  )
  await page.screenshot({ path: join(shots, 'text-file.png') })

  // 4) 只读：编辑器不接受输入
  const editorBox = await textPane.locator('.cm-content').boundingBox()
  await page.mouse.click(editorBox.x + 40, editorBox.y + 10)
  await page.keyboard.type('SHOULD-NOT-APPEAR')
  await page.waitForTimeout(300)
  record(
    '只读文本文件不接受键盘输入',
    !(await textOf(textPane.locator('.cm-content'))).includes('SHOULD-NOT-APPEAR')
  )

  // 5) 文本标签页里也能用面包屑跳到 .gitignore
  const fileBreadcrumb = page.locator('.text-file-pane:visible .path').first()
  await fileBreadcrumb.locator('.kb-path-segment').first().click()
  await menu().waitFor({ timeout: 10000 })
  await menu().locator('.kb-path-filter').fill('.gitignore')
  await rows().first().click()
  const gitignorePane = page.locator('.text-file-pane:visible').first()
  const gitignoreReady = await waitFor(
    async () => (await gitignorePane.locator('.cm-content').innerText()).includes('node_modules/'),
    30000
  )
  record(
    '从文本页面包屑打开 .gitignore（无扩展名也按文本判定）',
    Boolean(gitignoreReady),
    `text=${JSON.stringify((await textOf(gitignorePane.locator('.cm-content'))).slice(0, 40))}`
  )

  // 6) 点目录逐层进入：.github → workflows → deploy.yml
  await gitignorePane.locator('.kb-path-segment').first().click()
  await menu().waitFor({ timeout: 10000 })
  await menu().locator('.kb-path-filter').fill('.github')
  await rows().first().click()
  await waitFor(async () => (await menu().innerText()).includes('workflows'), 10000)
  await menu().locator('.kb-path-filter').fill('workflows')
  await rows().first().click()
  await waitFor(async () => (await menu().innerText()).includes('deploy.yml'), 10000)
  await menu().locator('.kb-path-filter').fill('deploy')
  await rows().first().click()
  const ymlReady = await waitFor(
    async () =>
      (await textOf(page.locator('.text-file-pane:visible .cm-content').first())).includes(
        'name: deploy'
      ),
    30000
  )
  record('目录可逐层进入并打开 .github/workflows/deploy.yml', Boolean(ymlReady))

  // 7) 二进制文件：只给提示、不打开新标签页
  await page.locator('.text-file-pane:visible .kb-path-segment').first().click()
  await menu().waitFor({ timeout: 10000 })
  await menu().locator('.kb-path-filter').fill('assets')
  await rows().first().click()
  await waitFor(async () => (await menu().innerText()).includes('0001-pic.png'), 10000)
  const tabCountBefore = await page.locator('.tab').count()
  await menu().locator('.kb-path-filter').fill('0001-pic')
  await rows().first().click()
  await page.waitForTimeout(800)
  record(
    '二进制文件不打开新标签页',
    (await page.locator('.tab').count()) === tabCountBefore,
    `tabs ${tabCountBefore} → ${await page.locator('.tab').count()}`
  )

  // 8) notes/ 下的笔记仍走既有笔记会话（不新建文本标签页）
  // 上一步打开的是文本文件标签页：先回到笔记标签页，再从面包屑逐层进入 notes/
  await page.locator('.toc-row', { hasText: '笔记' }).first().click()
  await pane.waitFor({ timeout: 20000 })
  const noteBreadcrumb = page.locator('.note-path-bar:visible').first()
  const tabsBeforeNote = await page.locator('.tab').count()
  // 点库名 → 列库根 → 点 notes 目录（目录项是"继续进入"）→ 列 notes/ → 点笔记文件
  await noteBreadcrumb.locator('.kb-path-segment').first().click()
  await menu().waitFor({ timeout: 10000 })
  await menu().locator('.kb-path-filter').fill('notes')
  await rows().first().click()
  await waitFor(async () => (await menu().innerText()).includes('0001'), 10000)
  await menu().locator('.kb-path-filter').fill('0001')
  await rows().first().click()
  await page.waitForTimeout(1200)
  record(
    '面包屑打开 notes/ 下的笔记时复用既有笔记会话（不新开文本标签页）',
    (await page.locator('.tab').count()) === tabsBeforeNote &&
      (await page.locator('.text-file-pane:visible').count()) === 0,
    `tabs ${tabsBeforeNote} → ${await page.locator('.tab').count()}`
  )

  // 9) 笔记源码视图是同一个 CodeMirror，且不因文本文件功能回归
  await page.getByRole('button', { name: '源码视图', exact: true }).first().click()
  const sourceEditor = page.locator('.live-editor:visible').first()
  const sourceReady = await waitFor(
    async () => (await sourceEditor.locator('.cm-editor.cm-lp-source').count()) === 1,
    30000
  )
  const sourceText = await textOf(sourceEditor.locator('.cm-content'))
  record(
    '笔记源码视图是 CodeMirror 且仍渲染正文',
    Boolean(sourceReady) && sourceText.includes('正文段落。') && sourceText.includes('# 笔记'),
    `text=${JSON.stringify(sourceText.slice(0, 40))}`
  )
  await page.screenshot({ path: join(shots, 'source-codemirror.png') })

  record('全流程无页面错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  record(
    'fixture 未被改写（只读浏览不动磁盘）',
    readFileSync(join(kb, 'README.md'), 'utf8') === '# 知识库说明\n\n这是根目录 README。\n' &&
      readFileSync(join(kb, '.gitignore'), 'utf8') === 'node_modules/\n.tnotes/dist\n'
  )
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
