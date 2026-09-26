/**
 * 内置 Agent 的 API Key：按服务商存，只进系统凭据存储，不进设置 JSON、不进日志。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, safeStorage } from 'electron'

import { deskLog } from '../log'

const KEYS_FILE = 'agent-keys.bin'
/** 只有一个服务商时的旧文件：第一次读取时迁到新文件，归给第一个服务商 */
const LEGACY_KEY_FILE = 'agent-key.bin'

function filePath(name: string): string {
  return join(app.getPath('userData'), name)
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

function readSecret(path: string): string | null {
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

function writeSecret(path: string, value: string): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const temp = `${path}.tmp`
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(temp, Buffer.concat([Buffer.from('v1:'), safeStorage.encryptString(value)]), {
      mode: 0o600
    })
  } else {
    deskLog('agent', '系统凭据存储不可用，API Key 以 0600 文件保存')
    writeFileSync(temp, value, { mode: 0o600 })
  }
  renameSync(temp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    /* 文件系统不支持时，写入已经带了 mode */
  }
}

function writeKeys(keys: Record<string, string>): void {
  writeSecret(filePath(KEYS_FILE), JSON.stringify(keys))
}

export function readAgentKeys(legacyProviderId = ''): Record<string, string> {
  const stored = readSecret(filePath(KEYS_FILE))
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored) as unknown
      if (parsed && typeof parsed === 'object') {
        return Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== ''
          )
        )
      }
    } catch {
      deskLog('agent', 'API Key 文件无法解析，按空处理')
    }
    return {}
  }
  const legacy = readSecret(filePath(LEGACY_KEY_FILE))?.trim()
  if (!legacy || !legacyProviderId) return {}
  const keys = { [legacyProviderId]: legacy }
  writeKeys(keys)
  rmSync(filePath(LEGACY_KEY_FILE), { force: true })
  return keys
}

export function readAgentKey(providerId: string, legacyProviderId = ''): string | null {
  return readAgentKeys(legacyProviderId)[providerId] ?? null
}

export function writeAgentKey(providerId: string, apiKey: string, legacyProviderId = ''): void {
  writeKeys({ ...readAgentKeys(legacyProviderId), [providerId]: apiKey })
}

export function clearAgentKey(providerId: string, legacyProviderId = ''): void {
  const keys = readAgentKeys(legacyProviderId)
  delete keys[providerId]
  writeKeys(keys)
}
