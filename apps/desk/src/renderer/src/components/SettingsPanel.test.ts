// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_MCP_PORT, type AppSettings } from '../../../shared/contracts'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agentModels'
import { useWorkspaceStore } from '../stores/workspace'
import SettingsPanel from './SettingsPanel.vue'

const settings: AppSettings = {
  version: 1,
  theme: 'system',
  defaultNoteView: 'visual',
  defaultNotePageWidth: 'standard',
  noteOutline: 'shown',
  showPathBreadcrumb: true,
  headingNumberMaxDepth: 2,
  git: { autoFetch: false },
  mcp: { enabled: false, port: DEFAULT_MCP_PORT },
  agent: structuredClone(DEFAULT_AGENT_SETTINGS),
  appZoomPercent: 100,
  autosave: { enabled: true, delayMs: 800 },
  createNotePosition: 'top',
  workspaceLayout: 'kb-dir-content',
  ide: 'vscode',
  gitPath: null,
  nodePath: null,
  confirmBeforeCommit: false,
  tabs: {
    maxOpenCount: 10,
    wrap: true,
    autoRevealInToc: true,
    defaultWebUrl: 'https://github.com/tnotesjs'
  },
  bottomPanel: { maxTabs: 10 },
  toc: {
    showNoteIndex: true,
    showNoteStatus: true,
    changesCollapsedByDefault: true
  },
  imageUpload: {
    defaultTarget: 'local',
    github: {
      repository: '',
      branch: 'main',
      path: '/',
      cdnTemplate: '',
      fileNameFormat: '${YY}-${MM}-${DD}-${HH}-${mm}-${ss}'
    },
    optimize: {
      encoder: 'sharp',
      strength: 'medium',
      maxDimension: null,
      outputFormat: 'keep'
    }
  },
  updates: { autoCheck: true },
  pinnedKnowledgeBaseIds: [],
  pinnedNoteUuids: {},
  hiddenKnowledgeBases: [],
  knowledgeBases: {}
}

beforeEach(() => {
  setActivePinia(createPinia())
  useWorkspaceStore().applySettings(settings)
  Object.defineProperty(window, 'desk', {
    configurable: true,
    value: {
      settings: {
        imageTokenStatus: vi.fn(async () => ({
          ok: true,
          value: { configured: false, encryptionAvailable: true }
        })),
        readRaw: vi.fn(async () => ({ ok: true, value: '{}\n' }))
      },
      agent: {
        keyStatus: vi.fn(async () => ({
          ok: true,
          value: { encryptionAvailable: true, providers: {} }
        }))
      },
      mcp: {
        status: vi.fn(async () => ({
          ok: true,
          value: {
            enabled: false,
            running: false,
            url: null,
            token: '',
            error: null,
            sessions: 0
          }
        })),
        onChanged: vi.fn(() => () => undefined)
      }
    }
  })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'desk')
})

describe('SettingsPanel Markdown quick-input catalog', () => {
  it('defaults the note page width control to standard', () => {
    const wrapper = mount(SettingsPanel)
    const field = wrapper
      .findAll('label.field')
      .find((candidate) => candidate.text().includes('笔记默认页宽'))

    expect(field?.find('select').element.value).toBe('standard')
    const reset = wrapper.get('.reset-group')
    expect(reset.attributes('aria-label')).toBe('重置设置')
    expect(reset.find('svg').exists()).toBe(true)
    expect(reset.text()).toBe('')
  })

  it('defaults the note outline control to shown', () => {
    const wrapper = mount(SettingsPanel)
    const field = wrapper
      .findAll('label.field')
      .find((candidate) => candidate.text().includes('笔记内目录'))
    const select = field?.find('select')

    expect(select?.element.value).toBe('shown')
    expect(select?.findAll('option').map((option) => option.text())).toEqual(['显示', '隐藏'])
  })

  it('uses dropdowns for the breadcrumb and autosave, and disables the delay when autosave is off', async () => {
    const wrapper = mount(SettingsPanel)
    const field = (label: string) =>
      wrapper.findAll('label.field').find((candidate) => candidate.find('span').text() === label)
    const breadcrumb = field('显示路径面包屑')?.find('select')
    const autosave = field('自动保存')?.find('select')
    const delay = field('自动保存延迟')?.find('input')

    expect(breadcrumb?.findAll('option').map((option) => option.text())).toEqual(['显示', '隐藏'])
    expect(breadcrumb?.element.value).toBe('shown')
    expect(autosave?.findAll('option').map((option) => option.text())).toEqual(['开启', '关闭'])
    expect(autosave?.element.value).toBe('on')
    expect((delay?.element as HTMLInputElement).value).toBe('800')
    expect((delay?.element as HTMLInputElement).disabled).toBe(false)

    await autosave?.setValue('off')

    expect((delay?.element as HTMLInputElement).disabled).toBe(true)
  })

  it('lists every command palette command for lookup', async () => {
    const wrapper = mount(SettingsPanel)
    const commandsNav = wrapper
      .findAll('button.nav-item')
      .find((item) => item.text().includes('命令'))
    expect(commandsNav).toBeTruthy()
    await commandsNav?.trigger('click')

    const text = wrapper.text()
    expect(text).toContain('命令清单')
    expect(text).toContain('全部折叠标题')
    expect(text).toContain('折叠 1–6 级标题')
    expect(text).not.toContain('折叠 1 级标题')
    expect(text).toContain('主题：跟随系统')
    expect(text).toContain('主题：浅色')
    expect(text).toContain('主题：深色')
    expect(text).toContain('theme')
    expect(text).toContain('打开设置')
    expect(wrapper.find('[aria-label="筛选命令"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('lists the shortcuts the current editor actually handles', async () => {
    const wrapper = mount(SettingsPanel)
    const shortcutsNav = wrapper
      .findAll('button.nav-item')
      .find((item) => item.text().includes('快捷键'))
    expect(shortcutsNav).toBeTruthy()
    await shortcutsNav?.trigger('click')

    const text = wrapper.text()
    expect(text).not.toContain('Markdown 快速输入')
    expect(text).toContain('引用')
    expect(text).toContain('⌥ ⌘ U')
    expect(text).toContain('高亮')
    expect(text).toContain('⌘ Shift H')
    expect(text).toContain('插入链接')
    expect(text).toContain('⌘ Shift K')
    expect(text).toContain('切换终端面板')
    expect(text).toContain('⌘ J')
    expect(text).toContain('打开内置 Agent')
    expect(text).toContain('⌘ L')
  })
})

describe('SettingsPanel live app zoom', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    let saved = structuredClone(settings)
    window.desk.settings.update = vi.fn(async (next) => {
      saved = { ...saved, ...next }
      return { ok: true, value: saved } as const
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('shows current zoom and never overwrites shortcuts with a stale settings draft', async () => {
    const store = useWorkspaceStore()
    await store.setAppZoom(120)
    const wrapper = mount(SettingsPanel)
    const input = wrapper.get<HTMLInputElement>('[aria-label="应用缩放百分比"]')
    expect(input.element.value).toBe('120')
    // The ordinary settings draft is still debounced when zoom is changed by a shortcut.
    await wrapper.get('select').setValue('dark')
    await store.adjustAppZoom(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(store.settings).toMatchObject({ theme: 'dark', appZoomPercent: 130 })
    expect(input.element.value).toBe('130')
    await wrapper.get('[aria-label="放大应用"]').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(store.settings?.appZoomPercent).toBe(140)
    await wrapper.get('.reset-group').trigger('click')
    await vi.advanceTimersByTimeAsync(500)
    expect(store.settings?.appZoomPercent).toBe(100)
    expect(input.element.value).toBe('100')
    wrapper.unmount()
  })
})

describe('SettingsPanel 编辑器', () => {
  it('不再提供已失效的选区浮动工具条', () => {
    const wrapper = mount(SettingsPanel)
    const editorNav = wrapper
      .findAll('button.nav-item')
      .some((item) => item.text().includes('编辑器'))
    expect(editorNav).toBe(false)
    expect(wrapper.text()).not.toContain('选区浮动工具条')
  })
})

describe('SettingsPanel section scroll', () => {
  it('shows form groups in one scroll and keeps config and shortcuts on their own pages', async () => {
    const wrapper = mount(SettingsPanel)

    expect(wrapper.find('[data-settings-group="general"]').exists()).toBe(true)
    expect(wrapper.find('[data-settings-group="toc"]').exists()).toBe(true)
    expect(wrapper.find('.config-editor').exists()).toBe(false)

    const configNav = wrapper
      .findAll('button.nav-item')
      .find((item) => item.text().includes('配置文件'))
    await configNav?.trigger('click')
    expect(wrapper.find('.config-editor').exists()).toBe(true)
    expect(wrapper.find('[data-settings-group="general"]').exists()).toBe(false)

    const generalNav = wrapper
      .findAll('button.nav-item')
      .find((item) => item.text().includes('常规'))
    await generalNav?.trigger('click')
    expect(wrapper.find('[data-settings-group="general"]').exists()).toBe(true)
    expect(wrapper.find('.config-editor').exists()).toBe(false)
    wrapper.unmount()
  })

  it('highlights the form group that has reached the top of the scroll', async () => {
    const wrapper = mount(SettingsPanel)
    const content = wrapper.get('.settings-content')
    vi.spyOn(content.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 500))
    const tops = [0, 20, 400, 800, 1200, 1600, 2000, 2400]
    const sections = wrapper.findAll('[data-settings-group]')
    expect(sections.map((item) => item.attributes('data-settings-group'))).toEqual([
      'general',
      'tabs',
      'toc',
      'tools',
      'git',
      'image',
      'agent',
      'mcp'
    ])
    sections.forEach((section, index) => {
      vi.spyOn(section.element, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, tops[index] ?? 0, 400, 200)
      )
    })

    await content.trigger('scroll')

    expect(wrapper.get('.nav-item.active').text()).toContain('标签与导航')
    wrapper.unmount()
  })

  it('scrolls a form group into view from the side nav', async () => {
    const wrapper = mount(SettingsPanel)
    const content = wrapper.get('.settings-content').element
    const scrollTo = vi.fn()
    content.scrollTo = scrollTo
    const tocNav = wrapper
      .findAll('button.nav-item')
      .find((item) => item.text().includes('目录管理'))
    await tocNav?.trigger('click')

    expect(wrapper.get('.nav-item.active').text()).toContain('目录管理')
    expect(scrollTo).toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('SettingsPanel 目录管理', () => {
  it('不再提供 emoji 配置，只保留完成状态开关', async () => {
    const wrapper = mount(SettingsPanel)
    const tocNav = wrapper
      .findAll('button.nav-item')
      .find((item) => item.text().includes('目录管理'))
    expect(tocNav).toBeTruthy()
    await tocNav!.trigger('click')

    const text = wrapper.text()
    expect(text).not.toContain('已完成 emoji')
    expect(text).not.toContain('未完成 emoji')
    expect(text).toContain('显示完成状态标识')
  })
})

describe('SettingsPanel GitHub image-bed config', () => {
  it('renders the GitHub config only after selecting the GitHub target', async () => {
    const wrapper = mount(SettingsPanel)
    const imageNav = wrapper
      .findAll('button.nav-item')
      .find((item) => item.text().includes('图片与图床'))
    expect(imageNav).toBeTruthy()
    await imageNav?.trigger('click')

    // 本地 assets：不渲染 GitHub 详细配置，只保留压缩块
    expect(
      wrapper
        .findAll('.sub-block')
        .some((block) => block.find('.sub-heading strong').text() === 'GitHub 图床配置')
    ).toBe(false)
    expect(wrapper.findAll('.sub-block').some((block) => block.text().includes('图片压缩'))).toBe(
      true
    )

    // 切到 GitHub：配置块出现，且未填完时给出回退提示
    await wrapper.get('.target-choice input[value="github"]').setValue('github')
    const githubBlock = wrapper
      .findAll('.sub-block')
      .find((block) => block.find('.sub-heading strong').text() === 'GitHub 图床配置')
    expect(githubBlock).toBeTruthy()
    expect(githubBlock?.text()).toContain('尚未完成配置')
  })
})
