import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const environment = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.profile },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { loadSettings, saveSettings } from './settings'

import type { AppSettings } from '../shared/contracts'

beforeEach(() => {
  environment.profile = mkdtempSync(join(tmpdir(), 'desk-git-settings-'))
})

afterEach(() => {
  rmSync(environment.profile, { recursive: true, force: true })
})

describe('后台自动抓取开关（git.autoFetch）', () => {
  it('新配置默认关闭', () => {
    expect(loadSettings().git).toEqual({ autoFetch: false })
  })

  it('老配置文件没有 git 分组时补默认 false，且不影响其它字段', () => {
    writeFileSync(
      join(environment.profile, '.tn-desk-config.json'),
      JSON.stringify({ theme: 'dark', tabs: { maxOpenCount: 3 } })
    )
    const settings = loadSettings()
    expect(settings.git.autoFetch).toBe(false)
    expect(settings.theme).toBe('dark')
    expect(settings.tabs.maxOpenCount).toBe(3)
  })

  it('持久化开关，且不相关的更新不会重置它', () => {
    expect(saveSettings({ git: { autoFetch: true } }).git.autoFetch).toBe(true)
    expect(loadSettings().git.autoFetch).toBe(true)
    expect(saveSettings({ theme: 'light' }).git.autoFetch).toBe(true)
    expect(loadSettings().git.autoFetch).toBe(true)
  })

  it('逐字段合并：只提交部分 git 分组也不会丢字段', () => {
    saveSettings({ git: { autoFetch: true } })
    // 空分组提交保留当前值（分组逐字段合并语义）。运行时的 Partial 合并会走
    // normalizeStrict，这里用断言绕过 TS 的 Partial 不能省略必填字段。
    expect(saveSettings({ git: {} } as unknown as Partial<AppSettings>).git.autoFetch).toBe(true)
    expect(saveSettings({ git: { autoFetch: false } }).git.autoFetch).toBe(false)
  })
})
