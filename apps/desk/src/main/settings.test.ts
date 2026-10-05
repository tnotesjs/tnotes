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

  it('drops a previously saved density field on the next save', () => {
    writeFileSync(path(), JSON.stringify({ theme: 'dark', density: 'compact' }))
    const loaded = loadSettings()
    expect(loaded).not.toHaveProperty('density')
    expect(loaded.theme).toBe('dark')
    saveSettings({ theme: 'light' })
    const saved = JSON.parse(readFileSync(path(), 'utf8')) as { theme?: string; density?: string }
    expect(saved.theme).toBe('light')
    expect(saved.density).toBeUndefined()
  })

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
    expect(settings).not.toHaveProperty('toc')
  })

  it('忽略已移除的目录显示配置，也不当作非法配置', () => {
    writeFileSync(
      path(),
      JSON.stringify({
        theme: 'light',
        toc: {
          showNoteIndex: false,
          showNoteStatus: false,
          changesCollapsedByDefault: false,
          doneEmoji: '✅',
          undoneEmoji: '⏰'
        }
      })
    )
    const settings = loadSettings()

    expect(settings.theme).toBe('light')
    expect(settings).not.toHaveProperty('toc')
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

  it('缺省显示路径面包屑，也可以改成隐藏', () => {
    expect(loadSettings().showPathBreadcrumb).toBe(true)
    writeFileSync(path(), JSON.stringify({ theme: 'dark' }))
    expect(loadSettings().showPathBreadcrumb).toBe(true)
    expect(saveSettings({ showPathBreadcrumb: false }).showPathBreadcrumb).toBe(false)
    expect(loadSettings().showPathBreadcrumb).toBe(false)
  })

  it('缺省显示笔记标题，也可以改成隐藏', () => {
    expect(loadSettings().showNoteTitle).toBe(true)
    writeFileSync(path(), JSON.stringify({ theme: 'dark' }))
    expect(loadSettings().showNoteTitle).toBe(true)
    expect(saveSettings({ showNoteTitle: false }).showNoteTitle).toBe(false)
    expect(loadSettings().showNoteTitle).toBe(false)
  })
})

describe('新网页标签的默认地址', () => {
  const path = () => join(environment.profile, '.tn-desk-config.json')
  const tabs = {
    maxOpenCount: 10,
    wrap: true,
    autoRevealInToc: true,
    defaultWebUrl: 'https://github.com/tnotesjs'
  }

  it('缺省是 GitHub 组织页；老配置没这个字段时补上，且保留其它标签设置', () => {
    expect(loadSettings().tabs.defaultWebUrl).toBe('https://github.com/tnotesjs')
    writeFileSync(path(), JSON.stringify({ theme: 'dark', tabs: { maxOpenCount: 4, wrap: false } }))
    const loaded = loadSettings()
    expect(loaded.tabs.defaultWebUrl).toBe('https://github.com/tnotesjs')
    expect(loaded.tabs.maxOpenCount).toBe(4)
    expect(loaded.tabs.wrap).toBe(false)
    expect(loaded.theme).toBe('dark')
  })

  it('可以改成其它网页地址，并在之后的保存里保留', () => {
    const saved = saveSettings({
      tabs: { ...tabs, defaultWebUrl: 'https://example.com/docs' }
    })
    expect(saved.tabs.defaultWebUrl).toBe('https://example.com/docs')
    saveSettings({ theme: 'light' })
    expect(loadSettings().tabs.defaultWebUrl).toBe('https://example.com/docs')
  })

  it('没写协议时补 https，空着或不是网页地址时回到默认', () => {
    expect(
      saveSettings({ tabs: { ...tabs, defaultWebUrl: 'github.com/tnotesjs/tnotes' } }).tabs
        .defaultWebUrl
    ).toBe('https://github.com/tnotesjs/tnotes')
    expect(saveSettings({ tabs: { ...tabs, defaultWebUrl: '  ' } }).tabs.defaultWebUrl).toBe(
      'https://github.com/tnotesjs'
    )
    expect(
      saveSettings({ tabs: { ...tabs, defaultWebUrl: 'javascript:alert(1)' } }).tabs.defaultWebUrl
    ).toBe('https://github.com/tnotesjs')
  })
})

describe('已移除的笔记内目录三项', () => {
  const path = () => join(environment.profile, '.tn-desk-config.json')

  it('旧的 hidden/collapsed/expanded 被忽略，大纲默认改为显示', () => {
    writeFileSync(path(), JSON.stringify({ theme: 'dark', noteTocDisplay: 'collapsed' }))
    const loaded = loadSettings()
    expect(loaded).not.toHaveProperty('noteTocDisplay')
    expect(loaded.noteOutline).toBe('shown')
    expect(loaded.theme).toBe('dark')
    saveSettings({ noteOutline: 'hidden' })
    const saved = JSON.parse(readFileSync(path(), 'utf8')) as {
      noteOutline?: string
      noteTocDisplay?: string
    }
    expect(saved.noteOutline).toBe('hidden')
    expect(saved.noteTocDisplay).toBeUndefined()
  })
})

describe('已移除的保存时 Prettier', () => {
  const path = () => join(environment.profile, '.tn-desk-config.json')

  it('旧配置里的 prettier 被忽略，下次保存时从文件里丢掉', () => {
    writeFileSync(path(), JSON.stringify({ theme: 'dark', prettier: true }))
    const loaded = loadSettings()
    expect(loaded).not.toHaveProperty('prettier')
    expect(loaded.theme).toBe('dark')
    saveSettings({ theme: 'light' })
    const saved = JSON.parse(readFileSync(path(), 'utf8')) as { theme?: string; prettier?: boolean }
    expect(saved.theme).toBe('light')
    expect(saved.prettier).toBeUndefined()
  })
})

describe('已移除的选区浮动工具条配置', () => {
  const path = () => join(environment.profile, '.tn-desk-config.json')

  it('旧配置里的 editor 分组被忽略，不清掉其它偏好，也不留下备份', () => {
    writeFileSync(
      path(),
      JSON.stringify({
        version: 1,
        theme: 'dark',
        editor: { selectionToolbar: true },
        tabs: { maxOpenCount: 5, wrap: false, autoRevealInToc: true }
      })
    )
    const settings = loadSettings()

    expect(settings).not.toHaveProperty('editor')
    expect(settings.theme).toBe('dark')
    expect(settings.tabs.maxOpenCount).toBe(5)
    expect(existsSync(`${path()}.invalid.bak`)).toBe(false)

    saveSettings({ theme: 'light' })
    const stored = JSON.parse(readFileSync(path(), 'utf8')) as Record<string, unknown>
    expect(stored.editor).toBeUndefined()
    expect(stored.theme).toBe('light')
  })
})

describe('置顶列表', () => {
  it('缺省为空，保存时保留顺序并去掉重复项', () => {
    expect(loadSettings().pinnedKnowledgeBaseIds).toEqual([])
    expect(loadSettings().pinnedNoteUuids).toEqual({})
    const saved = saveSettings({
      pinnedKnowledgeBaseIds: ['kb-b', 'kb-a', 'kb-b', ''],
      pinnedNoteUuids: { 'kb-b': ['note-2', 'note-1', 'note-2'], ' ': [] }
    })
    expect(saved.pinnedKnowledgeBaseIds).toEqual(['kb-b', 'kb-a'])
    expect(saved.pinnedNoteUuids).toEqual({ 'kb-b': ['note-2', 'note-1'] })
    expect(loadSettings().pinnedKnowledgeBaseIds).toEqual(['kb-b', 'kb-a'])
  })
})
