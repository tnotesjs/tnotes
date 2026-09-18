/**
 * node-pty 的 macOS/Linux 预构建里带一个 `spawn-helper` 可执行文件，但 npm 打包
 * 不会保留可执行位——安装后它是 `-rw-r--r--`，于是 `pty.spawn()` 在 macOS 上报
 * `Error: posix_spawnp failed.`（Linux 同理）。实测：仅在本地 `chmod 755` 之后，
 * Electron 39 里就能正常起交互式 shell。
 *
 * 这个脚本在每次安装后把预构建里的可执行文件补回权限位，让结果可复现——
 * 否则每个开发者和 CI 都会撞上同一个错误。只碰 node-pty 自己的 prebuilds 目录，
 * 找不到就安静跳过（包没装/换了结构都不该让安装失败）。
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** 需要可执行位的文件名（Windows 的 .exe 不需要，但一并尝试无害）。 */
const EXECUTABLES = new Set(['spawn-helper', 'winpty-agent.exe'])

function prebuildsRoot() {
  try {
    // 解析到真实路径：pnpm 下是 .pnpm/<pkg>/node_modules/node-pty
    return join(dirname(require.resolve('node-pty/package.json')), 'prebuilds')
  } catch {
    return null
  }
}

function fixDir(dir, fixed) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      fixDir(full, fixed)
      continue
    }
    if (!EXECUTABLES.has(entry.name)) continue
    const mode = statSync(full).mode & 0o777
    if ((mode & 0o111) === 0o111) continue
    chmodSync(full, 0o755)
    fixed.push(full)
  }
}

const root = prebuildsRoot()
if (root && existsSync(root)) {
  const fixed = []
  fixDir(root, fixed)
  if (fixed.length > 0) {
    console.log(`[postinstall] 修复 node-pty 预构建可执行位（${fixed.length} 个文件）`)
    for (const file of fixed) console.log(`  chmod 755 ${file}`)
  }
}
