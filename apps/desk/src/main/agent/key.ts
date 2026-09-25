/**
 * 内置 Agent 的 API Key：只进系统凭据存储，不进设置 JSON、不进日志。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, safeStorage } from 'electron'

import { deskLog } from '../log'

const KEY_FILE = 'agent-key.bin'

function keyPath(): string {
  return join(app.getPath('userData'), KEY_FILE)
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function readAgentKey(): string | null {
  const path = keyPath()
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path)
    if (safeStorage.isEncryptionAvailable() && raw.subarray(0, 3).toString('utf8') === 'v1:') {
      return safeStorage.decryptString(raw.subarray(3))
    }
    return raw.toString('utf8')
  } catch (error) {
    deskLog('agent', '读取 API Key 失败', {
      message: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

export function writeAgentKey(apiKey: string): void {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const path = keyPath()
  const temp = `${path}.tmp`
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(temp, Buffer.concat([Buffer.from('v1:'), safeStorage.encryptString(apiKey)]), {
      mode: 0o600
    })
  } else {
    deskLog('agent', '系统凭据存储不可用，API Key 以 0600 文件保存')
    writeFileSync(temp, apiKey, { mode: 0o600 })
  }
  renameSync(temp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    /* 文件系统不支持时，写入已经带了 mode */
  }
}

export function clearAgentKey(): void {
  const path = keyPath()
  if (existsSync(path)) rmSync(path)
}
