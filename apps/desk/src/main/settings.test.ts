import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const environment = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.profile },
  // deskLog 会遍历窗口广播日志
  BrowserWindow: { getAllWindows: () => [] }
}))

import { loadSettings, saveSettings, writeSettingsRaw } from './settings'

beforeEach(() => {
  environment.profile = mkdtempSync(join(tmpdir(), 'desk-zoom-settings-'))
})

afterEach(() => {
  rmSync(environment.profile, { recursive: true, force: true })
})

describe('persisted app zoom', () => {
  it('defaults new and existing profiles to 100 without resetting other preferences', () => {
    expect(loadSettings().appZoomPercent).toBe(100)
    writeFileSync(
      join(environment.profile, '.tn-desk-config.json'),
      JSON.stringify({ theme: 'dark' })
    )
    expect(loadSettings()).toMatchObject({ theme: 'dark', appZoomPercent: 100 })
  })

  it('persists zoom, clamps bounds, and preserves zoom during unrelated updates', () => {
    expect(saveSettings({ appZoomPercent: 135 }).appZoomPercent).toBe(135)
    expect(loadSettings().appZoomPercent).toBe(135)
    expect(saveSettings({ theme: 'dark' }).appZoomPercent).toBe(135)
    expect(saveSettings({ appZoomPercent: 0 }).appZoomPercent).toBe(50)
    expect(saveSettings({ appZoomPercent: 300 }).appZoomPercent).toBe(200)
    expect(writeSettingsRaw('{"appZoomPercent": 240}').appZoomPercent).toBe(200)
  })

  it('rejects nonnumeric and nonfinite updates without changing the saved settings', () => {
    saveSettings({ appZoomPercent: 120 })
    const path = join(environment.profile, '.tn-desk-config.json')
    const before = readFileSync(path, 'utf8')
    for (const value of ['invalid', null, Infinity, NaN]) {
      expect(() => saveSettings({ appZoomPercent: value as number })).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(before)
    }
  })
})

describe('配置文件字段级容错', () => {
  const path = () => join(environment.profile, '.tn-desk-config.json')

  it('单个字段非法时只回退该字段，其余偏好保留', () => {
    writeFileSync(
      path(),
      JSON.stringify({ theme: 'dark', appZoomPercent: 135, tabs: { maxOpenCount: 0, wrap: false } })
    )
    const settings = loadSettings()

    expect(settings.theme).toBe('dark')
    expect(settings.appZoomPercent).toBe(135)
    expect(settings.tabs.maxOpenCount).toBe(10) // 非法值回默认
    expect(settings.tabs.wrap).toBe(false)
  })

  it('整个分组非法时只回退该分组', () => {
    writeFileSync(
      path(),
      JSON.stringify({ theme: 'light', autosave: 'nonsense', toc: { showNoteIndex: 'oops' } })
    )
    const settings = loadSettings()

    expect(settings.theme).toBe('light')
    expect(settings.autosave).toEqual({ enabled: true, delayMs: 1000 })
    expect(settings.toc.showNoteIndex).toBe(true)
  })

  it('丢弃历史 emoji 配置：不再有这两个字段，也不当作非法配置', () => {
    writeFileSync(
      path(),
      JSON.stringify({ theme: 'light', toc: { doneEmoji: '✅', undoneEmoji: '⏰' } })
    )
    const settings = loadSettings()

    expect(settings.theme).toBe('light')
    expect(settings.toc).toEqual({
      showNoteIndex: true,
      showNoteStatus: true,
      changesCollapsedByDefault: true
    })
    // 未知键由 schema 剥掉，不算「非法字段」，所以不会留下 .invalid.bak
    expect(existsSync(`${path()}.invalid.bak`)).toBe(false)
  })

  it('顶层无法解析的 JSON 仍回默认值', () => {
    writeFileSync(path(), '{ this is not json')
    expect(loadSettings().theme).toBe('system')
  })

  it('丢弃字段时保留一份 .invalid.bak 便于还原', () => {
    writeFileSync(path(), JSON.stringify({ theme: 'dark', appZoomPercent: 'oops' }))
    loadSettings()
    const backup = JSON.parse(readFileSync(`${path()}.invalid.bak`, 'utf8'))
    expect(backup.appZoomPercent).toBe('oops')
  })

  it('合法的配置文件不产生备份', () => {
    writeFileSync(path(), JSON.stringify({ theme: 'dark' }))
    loadSettings()
    expect(() => readFileSync(`${path()}.invalid.bak`, 'utf8')).toThrow()
  })

  it('旧的 quality / oxipngLevel 仍会迁移成 strength（容错不影响迁移）', () => {
    writeFileSync(
      path(),
      JSON.stringify({ imageUpload: { optimize: { encoder: 'sharp', quality: 60 } } })
    )
    expect(loadSettings().imageUpload.optimize.strength).toBe('high')

    writeFileSync(
      path(),
      JSON.stringify({ imageUpload: { optimize: { encoder: 'oxipng', oxipngLevel: 6 } } })
    )
    expect(loadSettings().imageUpload.optimize.strength).toBe('high')
  })
})

describe('保存时格式化（Prettier）', () => {
  it('默认关闭，用户显式开关都按选择持久化', () => {
    expect(loadSettings().prettier).toBe(false)

    expect(saveSettings({ prettier: true }).prettier).toBe(true)
    expect(loadSettings().prettier).toBe(true)

    expect(saveSettings({ prettier: false }).prettier).toBe(false)
    expect(loadSettings().prettier).toBe(false)
  })
})

describe('选区浮动工具条开关', () => {
  const path = () => join(environment.profile, '.tn-desk-config.json')

  it('全新配置默认关闭', () => {
    expect(loadSettings().editor).toEqual({ selectionToolbar: false })
  })

  it('老配置没有 editor 分组时补默认 false，且不清掉其它偏好', () => {
    // 老用户的真实等价场景：升级前的配置文件里没有这个字段。
    writeFileSync(
      path(),
      JSON.stringify({
        version: 1,
        theme: 'dark',
        tabs: { maxOpenCount: 5, wrap: false, autoRevealInToc: true },
        toc: { showNoteIndex: false, showNoteStatus: true, changesCollapsedByDefault: true }
      })
    )
    const settings = loadSettings()

    expect(settings.editor.selectionToolbar).toBe(false)
    expect(settings.theme).toBe('dark')
    expect(settings.tabs.maxOpenCount).toBe(5)
    expect(settings.toc.showNoteIndex).toBe(false)
    // 缺字段由 schema 的 .default() 补齐，不算「非法字段」，不应留下备份。
    expect(existsSync(`${path()}.invalid.bak`)).toBe(false)
  })

  it('配置里 editor 分组存在但缺字段 / 整组非法时也回默认 false', () => {
    writeFileSync(path(), JSON.stringify({ editor: {} }))
    expect(loadSettings().editor.selectionToolbar).toBe(false)

    writeFileSync(path(), JSON.stringify({ editor: 'nonsense' }))
    expect(loadSettings().editor.selectionToolbar).toBe(false)

    writeFileSync(path(), JSON.stringify({ editor: { selectionToolbar: 'oops' } }))
    expect(loadSettings().editor.selectionToolbar).toBe(false)
  })

  it('用户显式开关会持久化，且不被其它字段更新覆盖', () => {
    expect(saveSettings({ editor: { selectionToolbar: true } }).editor.selectionToolbar).toBe(true)
    expect(loadSettings().editor.selectionToolbar).toBe(true)

    saveSettings({ theme: 'dark' })
    expect(loadSettings().editor.selectionToolbar).toBe(true)

    expect(saveSettings({ editor: { selectionToolbar: false } }).editor.selectionToolbar).toBe(
      false
    )
    expect(loadSettings().editor.selectionToolbar).toBe(false)
  })
})
