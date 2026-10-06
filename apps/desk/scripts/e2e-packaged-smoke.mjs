// 打包产物冒烟：装在 .app 里的 Desk 还能不能用 —— 编辑器渲染 + **站点预览真的出页面**。
//
// 为什么单独有一套：`out/` 版 e2e 验不到打包层。0.6.0 打包时实测的两个问题都只在这里出现：
//   1. 站点预览 500 `spawn ENOTDIR`：esbuild 从 app.asar 里 spawn 自己的二进制
//      （0.5.0 的旧安装包同样复现，属于长期存在的打包 bug）；
//   2. 关掉 asar 前还会遇到 `Cannot find module 'vue/server-renderer'`：SSR 的 ESM
//      解析读不了含 app.asar 的路径。
// 结论落在 electron-builder.cjs 的 `asar: false` + 平台二进制裁剪上，这套冒烟是它们的回归网。
//
// tier=manual：需要先有打包产物，默认不参与全量。
//   pnpm --filter desk build:unpack && pnpm --filter desk test:e2e --include-manual --only packaged
import { _electron } from 'playwright-core'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const appPath = join(deskDir, 'dist/mac-arm64/TNotes Desk.app')
const executablePath = process.argv[2] ?? join(appPath, 'Contents/MacOS/TNotes Desk')
if (!existsSync(executablePath)) {
  console.log(`SKIP  未找到打包产物（${appPath}）`)
  console.log('      先跑：pnpm --filter desk build:unpack')
  process.exit(0)
}
console.log(`被测应用：${executablePath}`)

const fixture = mkdtempSync(join(tmpdir(), 'desk-pack-smoke-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'TNotes.smoke')
mkdirSync(join(kb, 'notes'), { recursive: true })
mkdirSync(join(kb, 'assets'), { recursive: true })
mkdirSync(profile, { recursive: true })
writeFileSync(join(kb, 'tnotes.json'), `${JSON.stringify({ title: 'smoke' })}\n`)
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0001. smoke\n')
writeFileSync(
  join(kb, 'notes', '0001. smoke.md'),
  [
    '---',
    'id: smoke-1',
    '---',
    '',
    '# 打包冒烟标题',
    '',
    '::: tip 提示',
    '',
    '正文内容',
    '',
    ':::',
    '',
    '```js',
    'const a = 1',
    '```',
    ''
  ].join('\n')
)
writeFileSync(join(profile, 'workspace.v1.json'), `${JSON.stringify({ path: workspace })}\n`)
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  `${JSON.stringify({ version: 1, theme: 'light', defaultNoteView: 'visual', autosave: { enabled: false, delayMs: 800 } })}\n`
)

const app = await _electron.launch({
  executablePath,
  args: [`--user-data-dir=${profile}`],
  timeout: 120000,
  env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' }
})

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const fetchWhenReady = async (url, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
      lastError = `status ${res.status} :: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 900)}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() > deadline) {
      console.log(`  （取页面失败：${lastError}）`)
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  await page.getByText('smoke', { exact: true }).first().click()
  await page.waitForTimeout(2000)
  await page.locator('.toc-row', { hasText: '0001' }).first().locator('.node-label').click()
  await page.waitForTimeout(3000)

  const editorText = await page.evaluate(
    () =>
      [...document.querySelectorAll('.live-editor .cm-content')].find((el) => el.offsetParent !== null)
        ?.textContent ?? ''
  )
  check(
    '打包后可视化编辑器可用',
    editorText.includes('打包冒烟标题') && editorText.includes('正文内容'),
    JSON.stringify(editorText.slice(0, 30))
  )
  check('页面无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))

  const started = await page.evaluate(async () => {
    const boot = await window.desk.bootstrap()
    const id = boot.value.workspace.knowledgeBases[0]?.id
    const result = await window.desk.preview.start({ knowledgeBaseId: id })
    return {
      id,
      ok: result.ok,
      url: result.ok ? result.value.url : null,
      status: result.ok ? result.value.state.status : null,
      error: result.ok ? null : result.error?.message
    }
  })
  check(
    '站点预览启动（vite + esbuild 仍可用）',
    started.ok === true && Boolean(started.url),
    JSON.stringify(started)
  )

  if (started.url) {
    const response = await fetchWhenReady(started.url.replace('localhost', '127.0.0.1'))
    const html = response ? await response.text() : ''
    check(
      '预览页面能渲染出内容（esbuild/sass 链路通）',
      Boolean(response) && html.includes('打包冒烟标题'),
      `status=${response?.status ?? '-'} len=${html.length}`
    )
    await page.evaluate(async () => {
      const boot = await window.desk.bootstrap()
      await window.desk.preview.stop(boot.value.workspace.knowledgeBases[0].id)
    })
  }
} finally {
  await app.close()
  rmSync(fixture, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n打包冒烟：全部通过' : `\n打包冒烟：${failures} 项失败`)
if (failures > 0) process.exitCode = 1
