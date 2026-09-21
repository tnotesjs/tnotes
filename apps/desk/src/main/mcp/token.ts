/**
 * 连接令牌：生成 + 落盘（优先系统凭据存储）+ 轮换。
 *
 * 要求（验收第 6 节）：
 * - 随机、放在请求头、不放 URL；
 * - **不进日志 / 笔记 / KB 配置**；
 * - 重启后保持稳定（同一次安装里复用同一个令牌）；
 * - 轮换后旧凭据立刻失效（由调用方关闭现有会话）。
 *
 * 落盘优先用 Electron 的 `safeStorage`（macOS 走 Keychain、Windows 走 DPAPI、
 * Linux 走 libsecret/kwallet），它可用时只有本机当前用户能解出明文。
 * 系统凭据存储不可用时退化为 0600 权限的普通文件，并在日志里**只记录这件事**，
 * 不记录令牌本身。
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, safeStorage } from 'electron'

import { deskLog } from '../log'

const TOKEN_FILE = 'mcp-token.bin'

/** 32 字节随机 → base64url（43 字符，无 URL 不安全字符） */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

function tokenPath(): string {
  return join(app.getPath('userData'), TOKEN_FILE)
}

/** 读已有令牌；没有 / 解不开就返回 null（由调用方生成新的） */
export function readToken(): string | null {
  const path = tokenPath()
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path)
    if (safeStorage.isEncryptionAvailable()) {
      // 加密文件以 v1 前缀标记，避免和旧的明文文件混淆
      if (raw.subarray(0, 3).toString('utf8') === 'v1:') {
        return safeStorage.decryptString(raw.subarray(3))
      }
      // 明文遗留（上一版没有 safeStorage）：直接当明文读，下一次写入会升级成加密
      return raw.toString('utf8')
    }
    return raw.toString('utf8')
  } catch (error) {
    deskLog('mcp', '读取连接令牌失败，将重新生成', {
      message: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

export function writeToken(token: string): void {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const path = tokenPath()
  const temp = `${path}.tmp`
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(temp, Buffer.concat([Buffer.from('v1:'), safeStorage.encryptString(token)]), {
      mode: 0o600
    })
  } else {
    deskLog('mcp', '系统凭据存储不可用，连接令牌以 0600 文件保存（不写日志）')
    writeFileSync(temp, token, { mode: 0o600 })
  }
  renameSync(temp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // 某些文件系统不支持改权限：写盘时已带 mode，忽略
  }
}

/** 取当前令牌，没有就生成并落盘（保证重启后稳定） */
export function ensureToken(): string {
  const existing = readToken()
  if (existing && existing.length >= 32) return existing
  const token = generateToken()
  writeToken(token)
  return token
}

/** 轮换：生成新令牌并落盘，返回新值（调用方负责让旧会话失效） */
export function rotateToken(): string {
  const token = generateToken()
  writeToken(token)
  return token
}

/** 恒定时间比较，避免按字符提前返回泄露前缀 */
export function tokenMatches(expected: string, provided: string | null): boolean {
  if (!provided || provided.length === 0) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) a[index] ^= b[index]
  // a 已被就地异或：全 0 表示完全相同
  for (let index = 0; index < a.length; index += 1) diff |= a[index]
  return diff === 0
}
