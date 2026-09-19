// Desk E2E 共用夹具：隔离的 workspace + profile + 测试知识库 + 启动的 Electron 实例。
//
// 设计目标（本轮多次界面验证都要用）：
//  - **不碰用户数据**：一切都在 mkdtemp 的临时目录里，profile 也隔离（--user-data-dir）；
//  - 不依赖 playground 或 /Users 下的真实知识库；
//  - 失败时能保留现场（KEEP_FIXTURE=1）以便人工看。
//
// 用法：
//   const t = createFixture('my-e2e', { notes: [{ index: '0001', title: 'A', body: 'x' }] })
//   t.writeProfileConfig({ autosave: { enabled: false } })
//   const app = await launchDesk(t)
//   const page = await app.firstWindow()
//   ...
//   await app.close(); t.cleanup()
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
export const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 建一个隔离环境。
 *
 * @param {string} name  临时目录前缀（便于在 /tmp 里辨认）
 * @param {object} [options]
 * @param {Array<{index:string,title:string,body?:string,uuid?:string}>} [options.notes] 初始笔记
 * @param {string} [options.kbName] 知识库目录名，默认 `TNotes.<name>`
 */
export function createFixture(name, options = {}) {
  const fixture = mkdtempSync(join(tmpdir(), `desk-${name}-`))
  const workspace = join(fixture, 'workspace')
  const profile = join(fixture, 'profile')
  const kbName = options.kbName ?? `TNotes.${name}`
  const kb = join(workspace, kbName)
  const notesDir = join(kb, 'notes')
  mkdirSync(notesDir, { recursive: true })
  mkdirSync(profile, { recursive: true })

  const notes = options.notes ?? []
  writeFileSync(join(kb, 'tnotes.json'), JSON.stringify({ title: kbName, name: kbName }))
  writeFileSync(
    join(kb, 'TOC.md'),
    `${notes.map((note) => `- [ ] ${note.index}. ${note.title}`).join('\n')}\n`
  )
  notes.forEach((note, order) => {
    const uuid = note.uuid ?? `10000000-0000-4000-8000-${String(order + 1).padStart(12, '0')}`
    const body = note.body ?? `# ${note.index}. ${note.title}\n\n正文\n`
    writeFileSync(
      join(notesDir, `${note.index}. ${note.title}.md`),
      `---\nid: ${uuid}\n---\n\n${body}`
    )
  })

  /** 写 profile 下的应用配置（合并到默认值之上） */
  const writeProfileConfig = (config = {}) => {
    writeFileSync(
      join(profile, '.tn-desk-config.json'),
      JSON.stringify({
        version: 1,
        theme: 'light',
        defaultNoteView: 'visual',
        prettier: false,
        autosave: { enabled: false, delayMs: 1000 },
        ...config
      })
    )
  }
  /** 指定 profile 里记录的工作区根目录（默认就是本 fixture 的 workspace） */
  const writeWorkspace = (path = workspace) => {
    writeFileSync(join(profile, 'workspace.v1.json'), JSON.stringify({ path }))
  }

  writeProfileConfig()
  writeWorkspace()

  return {
    name,
    fixture,
    workspace,
    profile,
    kb,
    kbName,
    notesDir,
    /** 某篇笔记的绝对路径 */
    notePath: (index, title) => join(notesDir, `${index}. ${title}.md`),
    writeProfileConfig,
    writeWorkspace,
    cleanup: () => {
      if (process.env.KEEP_FIXTURE === '1') {
        console.log(`fixture 保留在 ${fixture}`)
        return
      }
      rmSync(fixture, { recursive: true, force: true })
    }
  }
}

/** 启动一个隔离的 Desk 实例（加载 out/ 构建产物）。 */
export async function launchDesk(fixture, options = {}) {
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['out/main/index.js', `--user-data-dir=${fixture.profile}`],
    cwd: deskDir,
    timeout: options.timeout ?? 60000,
    env: {
      ...process.env,
      // 本机可能设了 http_proxy：会让打到本地服务和本地远端的请求被代理接管
      NO_PROXY: '*',
      no_proxy: '*',
      ELECTRON_RUN_AS_NODE: undefined,
      ELECTRON_DISABLE_SANDBOX: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  })
  return app
}

/** 收集页面错误，便于断言"没有未捕获异常" */
export function trackPageErrors(page) {
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  return errors
}

/** 轮询等待；超时返回 null（由调用方断言，避免抛出难读的栈） */
export async function waitFor(check, timeoutMs = 10000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** 打开指定知识库的某篇笔记（走真实 UI：点侧栏知识库 → 点目录行） */
export async function openNote(page, { kbName, title }) {
  await page.waitForSelector('.kb-sidebar, aside', { timeout: 20000 })
  await waitFor(async () => (await page.getByText(kbName, { exact: true }).count()) > 0, 20000)
  await page.getByText(kbName, { exact: true }).first().click()
  const row = page.locator('.toc-row', { hasText: title }).first()
  await waitFor(async () => (await row.count()) > 0, 20000)
  await row.click()
  await waitFor(async () => (await page.locator('.ProseMirror').count()) > 0, 20000)
}

/** 简单的结果记录器（与本仓既有 e2e 脚本风格一致） */
export function createRecorder() {
  const results = []
  return {
    results,
    record(name, ok, detail = '') {
      results.push({ name, ok: Boolean(ok), detail })
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    },
    /** 打印汇总并设置退出码；返回是否有失败 */
    finish() {
      const failed = results.filter((item) => !item.ok)
      console.log(`\n${results.length - failed.length}/${results.length} 通过`)
      if (failed.length > 0) {
        console.log(`失败：${failed.map((item) => item.name).join('、')}`)
        process.exitCode = 1
      }
      return failed.length > 0
    }
  }
}
