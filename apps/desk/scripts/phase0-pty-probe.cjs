/**
 * 阶段 0 探针：Electron + node-pty 可用性与环境验证。
 *
 * 判定原则：断言只认「输出行里带 TAG 的前缀」，不数回显、不依赖提示符文本
 * —— TTY 会回显输入，把回显当输出会把断言带偏（第一版探针就误判过一次：
 * `LINE=0/100` 其实是回显里的字面量）。
 *
 * 覆盖：
 *  A. node-pty 能否在本机 Electron 上加载并起真实交互式 shell；
 *  B. 环境变量「继承并补全」——用 `env` 回读，确认没有被覆盖；
 *  C. 中文输入输出往返（UTF-8 一致）；
 *  D. 可计数有限输出的完整性（1..100 逐行校验）；
 *  E. 持续高吞吐下的完整性（shell 侧与宿主侧对同一文件比对 md5）；
 *  F. `yes` 类洪水下 Ctrl+C 的响应能力；
 *  G. 退出后进程清理（无残留）。
 *
 * 用法（开发态）：
 *   node_modules/.bin/electron scripts/phase0-pty-probe.cjs [shell]
 * 用法（打包态，给 app 可执行文件设 ELECTRON_RUN_AS_NODE=1）：
 *   ELECTRON_RUN_AS_NODE=1 "dist/mac-arm64/TNotes Desk.app/Contents/MacOS/TNotes Desk" \
 *     scripts/phase0-pty-probe.cjs [shell]
 * 仅用于阶段 0 验证，不进入产品入口。
 */
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const { app } = require('electron')
const pty = require('node-pty')

// 不要用 `#` 开头：以 # 起头的词会被 bash/zsh 当注释，整行不输出（踩过一次）
const TAG = '@@MARK@@'
const CJK = '中文输入输出验证：知识库与终端 🚀'
const BULK = path.join(os.tmpdir(), 'phase0-bulk.txt')
const OUT = path.join(os.tmpdir(), 'phase0-pty-probe.log')
/** 把断言用的 shell 逻辑写成脚本文件再执行：彻底避开 PTY 里的引号转义问题。 */
const SCRIPT = path.join(os.tmpdir(), 'phase0-probe.sh')
const lines = []
const log = (...parts) => {
  const line = parts.join(' ')
  lines.push(line)
  console.log(line)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 取带 TAG 的输出行（去 ANSI、去 \r），返回冒号后的内容。 */
function tagged(output, key) {
  const rows = []
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
    const at = line.indexOf(`${TAG}${key}:`)
    if (at !== -1) rows.push(line.slice(at + TAG.length + key.length + 1).trim())
  }
  return rows
}

/** 与产品计划一致：优先 $SHELL，失败再退回系统可用 shell。 */
function detectShell() {
  const candidates = [
    process.argv[2],
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh'
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      /* 试下一个 */
    }
  }
  return '/bin/sh'
}

/** 继承并补全：只在缺失时补，不覆盖已有值。 */
function buildEnv() {
  const env = { ...process.env }
  const filled = []
  const fill = (key, value) => {
    if (!env[key]) {
      env[key] = value
      filled.push(`${key}=${value}`)
    }
  }
  fill('TERM', 'xterm-256color')
  fill('COLORTERM', 'truecolor')
  return { env, filled }
}

function writeScript(body) {
  const content = ['#!/bin/sh', ...body.split('\n'), ''].join('\n')
  fs.writeFileSync(SCRIPT, content, 'utf8')
  return SCRIPT
}

function spawnShell(shell, cwd, env) {
  return pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: 120, rows: 30, cwd, env })
}

/** 逐行写入：一次一大串会和行编辑器/回显搅在一起，逐行更接近真实交互。 */
async function feed(child, commands, gapMs = 60) {
  for (const command of commands) {
    child.write(`${command}\r`)
    await sleep(gapMs)
  }
}

function waitFor(child, predicate, timeoutMs) {
  return new Promise((resolve) => {
    let output = ''
    const timer = setTimeout(() => {
      sub.dispose()
      resolve({ ok: false, output })
    }, timeoutMs)
    const sub = child.onData((chunk) => {
      output += chunk
      if (predicate(output)) {
        clearTimeout(timer)
        sub.dispose()
        resolve({ ok: true, output })
      }
    })
  })
}

async function main() {
  const shell = detectShell()
  const { env, filled } = buildEnv()
  const cwd = os.homedir()
  log(
    `electron=${process.versions.electron} node=${process.versions.node} mode=${process.env.ELECTRON_RUN_AS_NODE ? 'packaged' : 'dev'}`
  )
  log(`shell=${shell} cwd=${cwd}`)
  log(`env 补全项=${filled.length ? filled.join(', ') : '(无，全部继承)'}`)

  // ---- A/B/C/D：有限输出、环境回读、中文往返 ----
  {
    const child = spawnShell(shell, cwd, env)
    const collected = []
    const sub = child.onData((chunk) => collected.push(chunk))
    log(`A pid=${child.pid}`)
    writeScript(
      [
        `echo ${TAG}START:ok`,
        `i=1; while [ $i -le 100 ]; do echo ${TAG}N:$i; i=$((i+1)); done`,
        `printenv LANG LC_ALL TERM COLORTERM | sed "s/^/${TAG}ENV:/"`,
        `echo ${TAG}PATHSEG:$(printenv PATH | tr : '\\n' | wc -l | tr -d ' ')`,
        `echo ${TAG}CJK:${CJK}`,
        `echo ${TAG}END:ok`
      ].join('\n')
    )
    if (!fs.existsSync(SCRIPT) || fs.statSync(SCRIPT).size === 0) {
      log(`探针自身错误：脚本未生成或为空 (${SCRIPT})`)
    }
    await feed(child, [`sh ${SCRIPT}`, 'exit'])
    const { output } = await waitFor(child, (out) => tagged(out, 'END').length > 0, 20000)
    sub.dispose()
    // 只认 waitFor 的累计缓冲：它订阅早于命令下发，本身就是全量；
    // 再拼 collected 会把同一份数据算两遍（踩过：100 行读成 200 行）。
    const all = output
    const numbered = tagged(all, 'N')
      .filter((v) => /^\d+$/.test(v))
      .map(Number)
    log(`A 会话: start=${tagged(all, 'START').length > 0} end=${tagged(all, 'END').length > 0}`)
    log(
      `D 有限输出: 读回 ${numbered.length}/100 行，1..100 连续=${numbered.length === 100 && numbered.every((v, i) => v === i + 1)}`
    )
    log(
      `B shell 视角环境: ${tagged(all, 'ENV').join(' | ')} | PATH 段数=${tagged(all, 'PATHSEG')[0]}`
    )
    const cjk = tagged(all, 'CJK')[0]
    log(`C 中文往返: ${cjk === CJK ? '一致' : `不一致 → ${JSON.stringify(cjk)}`}`)
    child.kill()
    await sleep(300)
  }

  // ---- E：高吞吐 + md5 双端比对 ----
  {
    const child = spawnShell(shell, cwd, env)
    const collected = []
    const sub = child.onData((chunk) => collected.push(chunk))
    const started = Date.now()
    writeScript(
      [
        `seq 1 200000 > ${BULK}`,
        `hash=$(md5 -q ${BULK} 2>/dev/null || md5sum ${BULK} | cut -d' ' -f1)`,
        `echo ${TAG}HASH:$hash`,
        `echo ${TAG}BULKDONE:ok`
      ].join('\n')
    )
    if (!fs.existsSync(SCRIPT) || fs.statSync(SCRIPT).size === 0) {
      log(`探针自身错误：脚本未生成或为空 (${SCRIPT})`)
    }
    await feed(child, [`sh ${SCRIPT}`, 'exit'])
    const { output } = await waitFor(child, (out) => tagged(out, 'BULKDONE').length > 0, 60000)
    const elapsed = Date.now() - started
    sub.dispose()
    const all = output
    const shellHash = tagged(all, 'HASH').find((v) => /^[0-9a-f]{32}$/.test(v)) ?? '<未捕获>'
    const hostHash = fs.existsSync(BULK)
      ? crypto.createHash('md5').update(fs.readFileSync(BULK)).digest('hex')
      : '<无文件>'
    const size = fs.existsSync(BULK) ? fs.statSync(BULK).size : -1
    log(
      `E 高吞吐: 文件=${(size / 1024 / 1024).toFixed(2)}MB 用时=${elapsed}ms 捕获输出=${(all.length / 1024).toFixed(0)}KB md5(shell)=${shellHash} md5(host)=${hostHash} ${shellHash === hostHash ? '一致' : '不一致'}`
    )
    child.kill()
    await sleep(300)
  }

  // ---- F：洪水下 Ctrl+C ----
  {
    const child = spawnShell(shell, cwd, env)
    let bytes = 0
    const sub = child.onData((chunk) => {
      bytes += chunk.length
    })
    await sleep(400)
    child.write('yes FLOOD\r')
    await sleep(1500)
    const before = bytes
    child.write('\x03')
    await sleep(600)
    const after = bytes
    child.write(`echo ${TAG}AFTERINT:ok\r`)
    const { ok } = await waitFor(child, (out) => tagged(out, 'AFTERINT').length > 0, 5000)
    sub.dispose()
    log(
      `F 洪水中断: 中断前 ${(before / 1024 / 1024).toFixed(1)}MB / 600ms 后 ${(after / 1024 / 1024).toFixed(1)}MB（增量 ${after - before} 字节，应≈0）；Ctrl+C 后 shell 可用=${ok}`
    )
    child.kill()
    await sleep(300)
  }

  // ---- G：退出清理 ----
  {
    const child = spawnShell(shell, cwd, env)
    const pid = child.pid
    let exitCode = '<未收到>'
    child.onExit((e) => {
      exitCode = e.exitCode
    })
    child.write('exit\r')
    await sleep(1200)
    const alive = (() => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })()
    log(`G 退出清理: pid=${pid} exitCode=${exitCode} 仍存活=${alive}`)
  }

  // ---- 打包态：PATH 与登录 shell 解析 ----
  if (process.env.ELECTRON_RUN_AS_NODE) {
    let loginPath = '<未获取>'
    try {
      loginPath = execFileSync(shell, ['-lic', 'echo $PATH'], { encoding: 'utf8' }).trim()
    } catch (error) {
      loginPath = `<失败: ${error.message}>`
    }
    log(`打包态: 继承 PATH 段数=${(env.PATH ?? '').split(':').length}`)
    log(`打包态: 登录 shell 解析 PATH 段数=${loginPath.split(':').length}`)
    log(`打包态: HOME=${env.HOME ?? '<空>'} SHELL=${env.SHELL ?? '<空>'}`)
  }

  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
  log(`日志: ${OUT}`)
  app.exit(0)
}

app
  .whenReady()
  .then(main)
  .catch((error) => {
    log(`探针失败: ${error && error.stack ? error.stack : String(error)}`)
    fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
    app.exit(1)
  })
