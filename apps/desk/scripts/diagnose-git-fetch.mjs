// 「应用内 git fetch」与「终端里 git fetch」的差异诊断（只用临时仓库 + 本地远端）。
//
// 目的：如果应用里抓取失败而终端里成功，要能定位到**具体机制**，而不是笼统地说
// "网络问题"。这个脚本把候选变量逐个做对照实验：
//
//   E1 传输等价：file:// 本地 bare remote —— app 风格 spawn vs 终端 shell，都成功
//   E2 代理/环境等价：本机 dumb HTTP（127.0.0.1）—— 两边都成功（NO_PROXY=*）
//   E3 超时差异：慢远端（首次响应延迟 > 15s）
//        · app 后台预算 15s（gitManager 的 BACKGROUND_FETCH_TIMEOUT_MS）→ 被杀，静默失败
//        · 终端无超时 → 成功
//      （手动 fetch 预算 60s。这里用真实 15s 值，不复刻 60s 以免脚本太久）
//   E4 凭据/交互差异：远端要求 Basic 认证
//        · app 风格（GIT_TERMINAL_PROMPT=0 + stdin=ignore）→ 报 "could not read Username"
//        · app 风格 + 可用的 GIT_ASKPASS → 成功；说明差的是"凭据从哪来"，不是 git 命令本身
//
// 全是只读检查（--dry-run）；不碰用户知识库；输出里不打印任何凭据或带 token 的 URL。
// Run: node apps/desk/scripts/diagnose-git-fetch.mjs
import { execFileSync, spawn } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  chmodSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'desk-git-diag-'))
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  NO_PROXY: '*',
  no_proxy: '*'
}
// 清掉从 IDE 终端继承来的 askpass 变量：否则「应用风格能否弹凭据提示」这条
// 对照会被宿主环境污染（Cursor 的 askpass 需要 IPC socket，可能直接挂住）。
for (const key of [
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'VSCODE_GIT_ASKPASS_NODE',
  'VSCODE_GIT_ASKPASS_MAIN',
  'VSCODE_GIT_IPC_HANDLE'
]) {
  delete ENV[key]
}
const git = (args, cwd = root) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim()

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
}

// 自超时：任何一个子进程卡住都不能让脚本永远挂着（输出先落盘再退出）
const hardTimer = setTimeout(() => {
  console.error('\n诊断自超时，强制退出')
  process.exit(3)
}, 150_000)

/** 应用内 `runGit` 的 spawn 形状：stdin=ignore、GIT_TERMINAL_PROMPT=0、LC_ALL=C、自成进程组。 */
const APP_ENV = { ...ENV, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

function run(command, args, { cwd, env, detached = true, budgetMs }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
      windowsHide: true
    })
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => {
      try {
        if (detached && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }, budgetMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, ms: Date.now() - started, stdout, stderr })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, signal: null, ms: Date.now() - started, stdout, stderr: String(error) })
    })
  })
}

/** 只读的 fetch 检查：`--dry-run` 不写远端引用。 */
const appStyleFetch = (cwd, budgetMs) =>
  run('git', ['fetch', '--prune', '--dry-run'], { cwd, env: APP_ENV, budgetMs })
/** 终端风格：登录 shell、继承终端环境、无超时（由脚本预算兜底）。 */
const terminalStyleFetch = (cwd, budgetMs) =>
  run('/bin/zsh', ['-lc', 'git fetch --prune --dry-run'], {
    cwd,
    env: { ...ENV },
    detached: false,
    budgetMs
  })

function startServer(dir, { delayOnceMs = 0, requireAuth = false } = {}) {
  const expected = `Basic ${Buffer.from('diag:diag').toString('base64')}`
  let delayed = false
  const server = createServer((request, response) => {
    const respond = () => {
      if (requireAuth && request.headers.authorization !== expected) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="diag"' })
        response.end('auth required')
        return
      }
      const urlPath = decodeURIComponent((request.url ?? '/').split('?')[0])
      const filePath = normalize(join(dir, urlPath))
      if (!filePath.startsWith(dir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        response.writeHead(404)
        response.end('not found')
        return
      }
      response.writeHead(200)
      createReadStream(filePath).pipe(response)
    }
    // 只延迟第一条请求：模拟"连得上但很慢"，而不是每个对象都慢（后者会让对照跑很久）
    if (delayOnceMs > 0 && !delayed) {
      delayed = true
      setTimeout(respond, delayOnceMs)
      return
    }
    respond()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}

async function experiment() {
  console.log(`临时诊断目录：${root}\n`)
  // 本地 bare remote + 一个带提交的 seed
  git(['init', '-q', '--bare', '-b', 'main', join(root, 'remote.git')])
  const seed = join(root, 'seed')
  git(['init', '-q', '-b', 'main', seed])
  git(
    [
      '-c',
      'user.email=d@iag',
      '-c',
      'user.name=diag',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    ],
    seed
  )
  git(['remote', 'add', 'origin', join(root, 'remote.git')], seed)
  git(['push', '-q', 'origin', 'HEAD:main'], seed)

  // E1 ── file:// 本地 bare remote
  const fileRepo = join(root, 'file-repo')
  git(['clone', '-q', '-b', 'main', join(root, 'remote.git'), fileRepo])
  const e1app = await appStyleFetch(fileRepo, 30_000)
  const e1term = await terminalStyleFetch(fileRepo, 30_000)
  check(
    'E1 file:// 传输：应用风格与终端都成功（传输本身无差异）',
    e1app.code === 0 && e1term.code === 0,
    `app code=${e1app.code} ${e1app.ms}ms；terminal code=${e1term.code} ${e1term.ms}ms`
  )

  // E2 ── 本机 dumb HTTP（NO_PROXY=* 绕过 http_proxy）
  git(['-C', join(root, 'remote.git'), 'update-server-info'])
  const webRoot = join(root, 'www')
  // webRoot 必须先存在，`cp -R remote.git webRoot` 才会落成 webRoot/remote.git
  // （否则是把 remote.git 的内容直接铺在 webRoot 根下，URL 全部 404）。
  mkdirSync(webRoot, { recursive: true })
  execFileSync('cp', ['-R', join(root, 'remote.git'), webRoot], { env: ENV })
  const fast = await startServer(webRoot)
  const httpRepo = join(root, 'http-repo')
  // 注意：不能在这里用同步 clone 打到**本进程内**的 HTTP 服务——execFileSync 会
  // 阻塞事件循环，服务无法响应，直接死锁。先用 file 协议克隆再改 remote。
  git(['clone', '-q', '-b', 'main', join(root, 'remote.git'), httpRepo])
  git(['remote', 'set-url', 'origin', `http://127.0.0.1:${fast.port}/remote.git`], httpRepo)
  const e2app = await appStyleFetch(httpRepo, 30_000)
  const e2term = await terminalStyleFetch(httpRepo, 30_000)
  check(
    'E2 本机 HTTP（NO_PROXY=*）：应用风格与终端都成功（代理/环境不构成差异）',
    e2app.code === 0 && e2term.code === 0,
    `app code=${e2app.code} ${e2app.ms}ms；terminal code=${e2term.code} ${e2term.ms}ms；stderr=${(e2app.stderr || e2term.stderr).trim().split('\n').pop()?.slice(0, 100)}`
  )
  await fast.close()

  // E3 ── 慢远端：后台 15s 超时 vs 终端无超时
  const DELAY_MS = 17_000
  const slowBudgetMs = 15_000 // = gitManager.ts 的 BACKGROUND_FETCH_TIMEOUT_MS
  const slow = await startServer(webRoot, { delayOnceMs: DELAY_MS })
  const slowRepo = join(root, 'slow-repo')
  git(['clone', '-q', '-b', 'main', join(root, 'remote.git'), slowRepo])
  git(['remote', 'set-url', 'origin', `http://127.0.0.1:${slow.port}/remote.git`], slowRepo)
  const e3background = await appStyleFetch(slowRepo, slowBudgetMs)
  check(
    `E3 后台 fetch 超时=${slowBudgetMs}ms、远端首包延迟=${DELAY_MS}ms：应用后台被超时杀掉（失败且无输出）`,
    e3background.code === null || e3background.code === 124 || e3background.signal === 'SIGKILL',
    `code=${e3background.code} signal=${e3background.signal} ${e3background.ms}ms stderr=${e3background.stderr.trim().slice(0, 80)}`
  )
  await slow.close()
  const slowAgain = await startServer(webRoot, { delayOnceMs: DELAY_MS })
  git(['remote', 'set-url', 'origin', `http://127.0.0.1:${slowAgain.port}/remote.git`], slowRepo)
  const e3terminal = await terminalStyleFetch(slowRepo, DELAY_MS + 30_000)
  check(
    'E3 同一慢远端、终端（无超时）：成功',
    e3terminal.code === 0,
    `code=${e3terminal.code} ${e3terminal.ms}ms stderr=${e3terminal.stderr.trim().split('\n').pop()?.slice(0, 100)}`
  )
  await slowAgain.close()

  // E4 ── 需要认证的远端：非交互环境拿不到凭据
  const auth = await startServer(webRoot, { requireAuth: true })
  const authRepo = join(root, 'auth-repo')
  git(['clone', '-q', '-b', 'main', join(root, 'remote.git'), authRepo])
  git(['remote', 'set-url', 'origin', `http://127.0.0.1:${auth.port}/remote.git`], authRepo)
  const e4app = await appStyleFetch(authRepo, 30_000)
  check(
    'E4 需要认证时应用风格失败（非交互：不能弹提示）',
    e4app.code !== 0 &&
      /could not read Username|terminal prompts disabled|Authentication failed/i.test(e4app.stderr),
    `code=${e4app.code} stderr=${e4app.stderr.trim().split('\n').pop()?.slice(0, 120)}`
  )
  const askpass = join(root, 'askpass.sh')
  writeFileSync(
    askpass,
    '#!/bin/sh\ncase "$1" in *Username*) echo diag;; *Password*) echo diag;; esac\n'
  )
  chmodSync(askpass, 0o755)
  const e4askpass = await run('git', ['fetch', '--prune', '--dry-run'], {
    cwd: authRepo,
    env: { ...APP_ENV, GIT_ASKPASS: askpass },
    budgetMs: 30_000
  })
  check(
    'E4 同一远端 + 可用 GIT_ASKPASS：应用风格成功（差的是凭据来源，不是 git 命令）',
    e4askpass.code === 0,
    `code=${e4askpass.code} ${e4askpass.ms}ms stderr=${e4askpass.stderr.trim().split('\n').pop()?.slice(0, 100)}`
  )
  await auth.close()

  // E5 ── PATH 变化时 git 的解析：GUI 启动（Finder/Dock）拿到的是最小 PATH，
  // 可能找不到 Homebrew 的 git。这台机器两种 PATH 都落到同一个 /usr/bin/git，
  // 所以**没有**复现差异；但结论要按实测写，不能假设。
  const minimalPathEnv = { ...ENV, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  const whichAmbient = execFileSync('/bin/sh', ['-c', 'command -v git'], {
    env: ENV,
    encoding: 'utf8'
  }).trim()
  const whichMinimal = execFileSync('/bin/sh', ['-c', 'command -v git'], {
    env: minimalPathEnv,
    encoding: 'utf8'
  }).trim()
  const versionAmbient = (
    await run('git', ['--version'], {
      cwd: root,
      env: ENV,
      budgetMs: 10_000
    })
  ).stdout.trim()
  const versionMinimal = (
    await run('git', ['--version'], {
      cwd: root,
      env: minimalPathEnv,
      budgetMs: 10_000
    })
  ).stdout.trim()
  check(
    'E5 最小 PATH（模拟 GUI 启动）与终端 PATH 解析到同一个 git',
    whichAmbient === whichMinimal && versionAmbient === versionMinimal,
    `ambient=${whichAmbient}（${versionAmbient}）；minimal=${whichMinimal}（${versionMinimal}）`
  )

  // E6 ── 代理是共享 env：有 http_proxy、没有 NO_PROXY 时 app 与终端**行为一致**
  // （这台机器 http_proxy=127.0.0.1:7897；两边都走同一个代理，不是应用特有差异）
  const proxyEnv = {
    ...ENV,
    http_proxy: process.env.http_proxy ?? 'http://127.0.0.1:7897',
    https_proxy: process.env.https_proxy ?? 'http://127.0.0.1:7897',
    ALL_PROXY: process.env.ALL_PROXY ?? 'socks5://127.0.0.1:7897'
  }
  delete proxyEnv.NO_PROXY
  delete proxyEnv.no_proxy
  const proxied = await startServer(webRoot)
  git(['remote', 'set-url', 'origin', `http://127.0.0.1:${proxied.port}/remote.git`], httpRepo)
  const e6app = await run('git', ['fetch', '--prune', '--dry-run'], {
    cwd: httpRepo,
    env: { ...proxyEnv, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    budgetMs: 12_000
  })
  const e6term = await run('/bin/zsh', ['-lc', 'git fetch --prune --dry-run'], {
    cwd: httpRepo,
    env: proxyEnv,
    detached: false,
    budgetMs: 12_000
  })
  check(
    'E6 有代理、无 NO_PROXY：应用风格与终端结果一致（代理差异来自 env，不是应用）',
    e6app.code === e6term.code,
    `app code=${e6app.code} ${e6app.ms}ms；terminal code=${e6term.code} ${e6term.ms}ms`
  )
  await proxied.close()
}

try {
  await experiment()
} finally {
  clearTimeout(hardTimer)
  rmSync(root, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项符合预期`)
process.exitCode = failed.length > 0 ? 1 : 0
