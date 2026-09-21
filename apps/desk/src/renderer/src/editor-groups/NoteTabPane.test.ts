// @vitest-environment happy-dom

import { defineComponent } from 'vue'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteEditorTab } from '../../../shared/contracts'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import FormatOverflowBar from './FormatOverflowBar.vue'
import NoteTabPane from './NoteTabPane.vue'

/**
 * 可视化编辑器的可控替身：显式 stub，能暴露草稿 API（shallowMount 的自动 stub 不会）。
 * 自动 stub 会丢掉 setup/expose，导致「复制当前修改 / 定位」这类要走编辑器能力的路径测不到。
 */
const editorStubState = { hasUnsavedDraft: false, draft: 'DRAFT', revealResult: true }
const MilkdownStub = defineComponent({
  name: 'MilkdownStub',
  template: '<div class="milkdown-stub" />',
  setup(_props, { expose }) {
    expose({
      flush: () => undefined,
      hasUnsavedDraft: () => editorStubState.hasUnsavedDraft,
      exportDraft: () => editorStubState.draft,
      revealDisplayLimited: () => editorStubState.revealResult
    })
  }
})

vi.mock('../markdown/MilkdownMarkdownEditor.vue', () => ({ default: { template: '<div />' } }))
const sourceStubState = { revealedLine: null as number | null }
const SourceStub = defineComponent({
  name: 'SourceStub',
  template: '<div class="source-stub" />',
  setup(_props, { expose }) {
    expose({
      revealLine: (line: number) => {
        sourceStubState.revealedLine = line
        return true
      },
      flush: () => undefined
    })
  }
})
vi.mock('../markdown/MarkdownSourceEditor.vue', () => ({ default: { template: '<div />' } }))

const tab: NoteEditorTab = {
  id: 'tab-a',
  type: 'note',
  knowledgeBaseId: 'kb-a',
  knowledgeBaseName: 'docs',
  icon: null,
  noteUuid: 'note-a',
  title: '概述',
  viewMode: 'visual',
  pageWidth: 'standard',
  dirty: false,
  pinned: false
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(readOnly = false) {
  const workspace = useWorkspaceStore()
  const editor = useEditorStore()
  workspace.documents['kb-a:note-a'] = {
    document: {
      knowledgeBaseId: 'kb-a',
      uuid: 'note-a',
      index: '0001',
      title: '概述',
      dirName: '0001. 概述',
      fileName: '0001. 概述.md',
      relPath: 'notes/0001. 概述.md',
      filePath: '/tmp/notes/0001. 概述.md',
      content: '## 概述',
      revision: 'v1',
      config: { done: false },
      readOnly
    },
    content: '## 概述',
    dirty: false,
    saving: false,
    externalConflict: false,
    preserveSourceOnSave: false,
    unsavedDraft: false
  }
  const rename = vi.spyOn(workspace, 'renameNote').mockResolvedValue()
  const setNoteViewMode = vi.spyOn(editor, 'setNoteViewMode')
  const wrapper = shallowMount(NoteTabPane, {
    attachTo: document.body,
    props: { tab: { ...tab }, groupId: 'group-a', active: true },
    global: {
      renderStubDefaultSlot: true,
      stubs: {
        MilkdownMarkdownEditor: MilkdownStub,
        MarkdownSourceEditor: SourceStub,
        // 完成开关要断言真实 DOM（位置 + 圆点），不能用自动 stub
        NoteDoneToggle: false
      }
    }
  })
  return { wrapper, workspace, rename, setNoteViewMode, editor }
}

beforeEach(() => {
  setActivePinia(createPinia())
  editorStubState.hasUnsavedDraft = false
  editorStubState.draft = 'DRAFT'
  editorStubState.revealResult = true
  sourceStubState.revealedLine = null
})
afterEach(() => document.body.replaceChildren())

describe('note header', () => {
  it('puts formatting on the same row as the title and view modes', async () => {
    const { wrapper, editor } = setup()
    // 顺序即验收要求：标题 / 【视图切换 | 格式工具栏】 / 布局开关
    const toolbar = wrapper.get('.document-toolbar')
    expect(
      [...toolbar.element.children].map((node) => node.classList[0] ?? node.nodeName.toLowerCase())
    ).toEqual([
      'document-path',
      'view-switcher',
      'view-divider',
      'format-overflow-bar-stub',
      'layout-controls'
    ])
    expect(
      wrapper
        .get('.view-switcher')
        .findAll('button')
        .map((button) => button.attributes('aria-label'))
    ).toEqual(['可视化编辑', '只读视图', '源码视图'])
    expect(
      wrapper
        .get('.layout-controls')
        .findAll('button')
        .map((button) => button.attributes('aria-label'))
    ).toEqual(['标准页宽', '隐藏目录', '显示本笔记资源'])
    expect(wrapper.get('.view-divider').element.previousElementSibling).toBe(
      wrapper.get('.view-switcher').element
    )
    expect(wrapper.get('.outline-toggle').classes()).toContain('active')
    expect(wrapper.find('.save-button').exists()).toBe(false)
    const width = vi.spyOn(editor, 'toggleNotePageWidth')
    const outline = vi.spyOn(editor, 'toggleNoteOutlineVisible')
    const view = vi.spyOn(editor, 'setNoteViewMode')
    await wrapper.get('.page-width-toggle').trigger('click')
    await wrapper.get('.outline-toggle').trigger('click')
    await wrapper.get('[aria-label="源码视图"]').trigger('click')
    expect(width).toHaveBeenCalledWith('tab-a')
    expect(outline).toHaveBeenCalledWith('tab-a')
    expect(view).toHaveBeenCalledWith('tab-a', 'source')
    await wrapper.setProps({ tab: { ...tab, outlineVisible: false } })
    expect(wrapper.get('.outline-toggle').classes()).not.toContain('active')
    expect(wrapper.get('.outline-toggle').attributes('aria-label')).toBe('显示目录')
    for (const viewMode of ['source', 'readonly', 'visual'] as const) {
      await wrapper.setProps({ tab: { ...tab, viewMode } })
      const bar = wrapper.getComponent(FormatOverflowBar)
      expect(bar.exists()).toBe(true)
      expect(bar.props('disabled')).toBe(viewMode === 'readonly')
      expect(wrapper.find('.layout-controls').exists()).toBe(true)
      expect(wrapper.find('.save-button').exists()).toBe(false)
    }
    wrapper.unmount()
  })

  it('puts the done toggle right before the note index and routes it to the store', async () => {
    const { wrapper, workspace } = setup()
    const toggleDone = vi.spyOn(workspace, 'toggleDone').mockResolvedValue()
    const index = wrapper.get('.note-index')
    const toggle = wrapper.get('.done-toggle')
    // 位置就是验收指的那一格：紧贴编号左侧
    expect(index.element.previousElementSibling).toBe(toggle.element)
    // 与目录树同一个组件、同一套 class
    expect(toggle.find('.done-dot').exists()).toBe(true)
    expect(toggle.classes()).not.toContain('done')
    expect(toggle.attributes('aria-label')).toBe('标记为完成')
    await toggle.trigger('click')
    expect(toggleDone).toHaveBeenCalledExactlyOnceWith({ uuid: 'note-a', completed: false })
    wrapper.unmount()
  })

  it('shows the filled dot for a done note and disables the toggle for a read-only one', async () => {
    const { wrapper, workspace } = setup()
    workspace.documents['kb-a:note-a']!.document.config.done = true
    await flushPromises()
    expect(wrapper.get('.done-toggle').classes()).toContain('done')
    wrapper.unmount()

    const readOnly = setup(true)
    expect(readOnly.wrapper.get('.done-toggle').attributes('disabled')).toBeDefined()
    readOnly.wrapper.unmount()
  })

  it('edits only the title and submits a trimmed name on blur', async () => {
    const { wrapper, rename } = setup()
    await wrapper.get('.note-title-button').trigger('click')
    const input = wrapper.get('input')
    expect(input.element.value).toBe('概述')
    expect(document.activeElement).toBe(input.element)
    expect(input.element.selectionEnd).toBe(2)
    expect(wrapper.get('.note-index').text()).toBe('0001.')
    await input.setValue('  新的名称  ')
    expect(rename).not.toHaveBeenCalled()
    await input.trigger('blur')
    await flushPromises()
    expect(rename).toHaveBeenCalledExactlyOnceWith('kb-a', 'note-a', '新的名称')
    expect(wrapper.find('input').exists()).toBe(false)
    wrapper.unmount()
  })

  it.each(['', '   ', '  概述  '])('ignores empty or unchanged titles: %j', async (value) => {
    const { wrapper, rename } = setup()
    await wrapper.get('.note-title-button').trigger('click')
    await wrapper.get('input').setValue(value)
    await wrapper.get('input').trigger('blur')
    expect(rename).not.toHaveBeenCalled()
    expect(wrapper.get('.note-title-button').text()).toBe('概述')
    wrapper.unmount()
  })

  it('cancels with Escape and ignores IME Enter until composition ends', async () => {
    const { wrapper, rename } = setup()
    await wrapper.get('.note-title-button').trigger('click')
    await wrapper.get('input').setValue('取消修改')
    await wrapper.get('input').trigger('keydown', { key: 'Escape' })
    expect(rename).not.toHaveBeenCalled()
    expect(wrapper.find('input').exists()).toBe(false)
    await wrapper.get('.note-title-button').trigger('click')
    await wrapper.get('input').setValue('确认修改')
    await wrapper.get('input').trigger('keydown', { key: 'Enter', isComposing: true })
    expect(rename).not.toHaveBeenCalled()
    expect(wrapper.find('input').exists()).toBe(true)
    await wrapper.get('input').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(rename).toHaveBeenCalledExactlyOnceWith('kb-a', 'note-a', '确认修改')
    wrapper.unmount()
  })

  it('reports rename failures and leaves the original title intact', async () => {
    const { wrapper, rename, workspace } = setup()
    rename.mockRejectedValue(new Error('名称不合法'))
    await wrapper.get('.note-title-button').trigger('click')
    await wrapper.get('input').setValue('invalid/name')
    await wrapper.get('input').trigger('blur')
    await flushPromises()
    expect(workspace.error).toBe('名称不合法')
    expect(wrapper.get('.note-title-button').text()).toBe('概述')
    expect(wrapper.get('.note-title-button').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('does not rename a read-only document', async () => {
    const { wrapper, rename } = setup(true)
    expect(wrapper.get('.note-title-button').attributes('disabled')).toBeDefined()
    await wrapper.get('.note-title-button').trigger('click')
    expect(wrapper.find('input').exists()).toBe(false)
    expect(rename).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps formatting visible but disabled for a read-only document', () => {
    const { wrapper } = setup(true)
    expect(wrapper.getComponent(FormatOverflowBar).props('disabled')).toBe(true)
    wrapper.unmount()
  })
})

describe('保存被拦下时的提示与切换（A+B）', () => {
  it('有未保存修改时提示常驻：说清「原文件未改动 / 修改仍在编辑器里」', async () => {
    const { wrapper, workspace } = setup()
    workspace.documents['kb-a:note-a']!.unsavedDraft = true
    workspace.documents['kb-a:note-a']!.dirty = true
    await flushPromises()

    const banner = wrapper.get('.note-draft-banner')
    expect(banner.text()).toContain('当前修改尚未保存')
    expect(banner.text()).toContain('原文件未改动')
    expect(banner.text()).toContain('当前修改仍保留在编辑器中')
    // 出口只有「复制当前修改 / 复制诊断信息」：没有任何绕过保护的切换入口
    const labels = banner.findAll('button').map((button) => button.text())
    expect(labels).toEqual(['复制当前修改', '复制诊断信息'])
    expect(banner.text()).toContain('切换视图会丢弃它们，所以已被拦下')
  })

  it('草稿解决后提示自动消失', async () => {
    const { wrapper, workspace } = setup()
    workspace.documents['kb-a:note-a']!.unsavedDraft = true
    await flushPromises()
    expect(wrapper.find('.note-draft-banner').exists()).toBe(true)

    workspace.documents['kb-a:note-a']!.unsavedDraft = false
    await flushPromises()
    expect(wrapper.find('.note-draft-banner').exists()).toBe(false)
  })

  it('没有未保存修改时正常切换视图', async () => {
    const { wrapper, setNoteViewMode } = setup()
    await wrapper.get('button[aria-label="源码视图"]').trigger('click')
    expect(setNoteViewMode).toHaveBeenCalledWith('tab-a', 'source')
    expect(wrapper.find('.note-draft-banner').exists()).toBe(false)
  })

  it('受阻后切视图：拒绝切换（不能销毁编辑器丢掉修改），并说明原因', async () => {
    const { wrapper, setNoteViewMode, workspace } = setup()
    // 用真实的吞并检测构造「转换不完整」：草稿把原文里独立的 222 并进了提示块
    workspace.documents['kb-a:note-a']!.content = '::: tip T\n\n111\n\n:::\n\n222\n'
    workspace.documents['kb-a:note-a']!.unsavedDraft = true
    editorStubState.hasUnsavedDraft = true
    editorStubState.draft = '::: tip T\n\n111\n222\n\n:::'
    await flushPromises()

    await wrapper.get('button[aria-label="源码视图"]').trigger('click')

    expect(setNoteViewMode).not.toHaveBeenCalled()
    expect(wrapper.find('.note-draft-banner').exists()).toBe(true)
    expect(String(workspace.status)).toContain('未切换视图')
  })

  it('同块数替换（特殊原文 → 新增内容）也拒绝切换（验收反例）', async () => {
    const { wrapper, setNoteViewMode, workspace } = setup()
    // 原文：标题 + 特殊原文；草稿：标题 + 新增内容 —— 块数一致，旧实现会放行
    workspace.documents['kb-a:note-a']!.content = '# 标题\n\n::: unknown-widget\n'
    workspace.documents['kb-a:note-a']!.unsavedDraft = true
    editorStubState.hasUnsavedDraft = true
    editorStubState.draft = '# 标题\n\n我刚写的一段\n'

    await wrapper.get('button[aria-label="源码视图"]').trigger('click')
    await flushPromises()

    expect(setNoteViewMode).not.toHaveBeenCalled()
    expect(wrapper.find('.note-draft-banner').exists()).toBe(true)
    expect(workspace.documents['kb-a:note-a']!.content).toBe('# 标题\n\n::: unknown-widget\n')
  })

  it('任何情况下都没有绕过保护的切换入口（复制不改变可否切换）', async () => {
    const { wrapper, setNoteViewMode, workspace } = setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    workspace.documents['kb-a:note-a']!.unsavedDraft = true
    editorStubState.hasUnsavedDraft = true
    editorStubState.draft = '被拦下的草稿内容'
    await flushPromises()

    // 复制成功
    await wrapper.get('.note-draft-banner').findAll('button')[0]!.trigger('click')
    await wrapper.get('.note-copy-preview footer button:last-child').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)

    // 复制之后依然不能切
    await wrapper.get('button[aria-label="源码视图"]').trigger('click')
    await flushPromises()
    expect(setNoteViewMode).not.toHaveBeenCalled()
    expect(workspace.documents['kb-a:note-a']!.unsavedDraft).toBe(true)
  })
})

describe('以源码显示提示 + 复制当前修改预览（第二批）', () => {
  const items = [
    { index: 3, line: 12, kind: 'paragraph', snippet: '::: unknown' },
    { index: 5, line: 30, kind: 'table', snippet: '| A | B |' }
  ]

  it('多处同类问题只给汇总，展开后才列出行号/类型/片段', async () => {
    const { wrapper } = setup()
    wrapper.findComponent(MilkdownStub).vm.$emit('displayLimitedChange', items)
    await flushPromises()

    const notice = wrapper.get('.note-display-limited')
    expect(notice.text()).toContain('有 2 处内容以源码显示')
    expect(notice.text()).toContain('查看 2 处')
    expect(wrapper.find('.note-display-limited__list').exists()).toBe(false)

    await notice.get('button').trigger('click')
    const list = wrapper.get('.note-display-limited__list')
    expect(list.text()).toContain('第 12 行')
    expect(list.text()).toContain('第 30 行')
    expect(list.text()).toContain('::: unknown')
  })

  it('清单清空后提示收起', async () => {
    const { wrapper } = setup()
    const editor = wrapper.findComponent(MilkdownStub)
    editor.vm.$emit('displayLimitedChange', items)
    await flushPromises()
    expect(wrapper.find('.note-display-limited').exists()).toBe(true)

    editor.vm.$emit('displayLimitedChange', [])
    await flushPromises()
    expect(wrapper.find('.note-display-limited').exists()).toBe(false)
  })

  it('列表里点「定位」会调用编辑器的定位能力（就近入口）', async () => {
    const { wrapper, workspace } = setup()
    wrapper.findComponent(MilkdownStub).vm.$emit('displayLimitedChange', items)
    await flushPromises()
    await wrapper.get('.note-display-limited button').trigger('click')
    await wrapper.get('.note-display-limited__list li:first-child button').trigger('click')

    expect(String(workspace.status ?? '')).not.toContain('没找到')
  })

  it('定位失败（文档已改动）时给出提示', async () => {
    const { wrapper, workspace } = setup()
    editorStubState.revealResult = false
    wrapper.findComponent(MilkdownStub).vm.$emit('displayLimitedChange', items)
    await flushPromises()
    await wrapper.get('.note-display-limited button').trigger('click')
    await wrapper.get('.note-display-limited__list li:first-child button').trigger('click')

    expect(String(workspace.status)).toContain('没找到')
  })

  it('复制当前修改先出预览，确认后才写剪贴板', async () => {
    const { wrapper, workspace } = setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    workspace.documents['kb-a:note-a']!.unsavedDraft = true
    await flushPromises()

    await wrapper.get('.note-draft-banner button:not(:disabled)').trigger('click')
    const preview = wrapper.get('.note-copy-preview')
    expect(preview.text()).toContain('未经完整性校验')
    expect(writeText).not.toHaveBeenCalled()

    await preview.get('footer button:last-child').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.note-copy-preview').exists()).toBe(false)
  })

  it('预览里取消不会写剪贴板', async () => {
    const { wrapper, workspace } = setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    workspace.documents['kb-a:note-a']!.unsavedDraft = true
    await flushPromises()

    await wrapper.get('.note-draft-banner button:not(:disabled)').trigger('click')
    await wrapper.get('.note-copy-preview footer button:first-child').trigger('click')
    await flushPromises()

    expect(writeText).not.toHaveBeenCalled()
    expect(wrapper.find('.note-copy-preview').exists()).toBe(false)
  })
})

describe('批次 3：说明 / 源码定位 / 诊断信息', () => {
  const items = [{ index: 3, line: 12, kind: 'paragraph', snippet: '::: unknown' }]

  it('第一次遇到时说明默认展开；点「知道了」后收起，再点「这是什么？」又展开', async () => {
    const { wrapper } = setup()
    wrapper.findComponent(MilkdownStub).vm.$emit('displayLimitedChange', items)
    await flushPromises()

    const notice = wrapper.get('.note-display-limited')
    expect(notice.find('.note-display-limited__explainer').exists()).toBe(true)
    expect(notice.text()).toContain('内容不会丢')

    await notice.get('.note-display-limited__explainer button').trigger('click')
    expect(notice.find('.note-display-limited__explainer').exists()).toBe(false)

    const explainerButton = notice
      .findAll('button')
      .find((button) => button.text().includes('这是什么？'))
    await explainerButton!.trigger('click')
    expect(notice.find('.note-display-limited__explainer').exists()).toBe(true)
  })

  it('「编辑源码」切到源码视图并跳到该行', async () => {
    const { wrapper, setNoteViewMode } = setup()
    wrapper.findComponent(MilkdownStub).vm.$emit('displayLimitedChange', items)
    await flushPromises()
    await wrapper.get('.note-display-limited__head button').trigger('click')
    const row = wrapper.get('.note-display-limited__list li')
    await row.findAll('button')[1].trigger('click')
    // 父组件随后把 viewMode 换成 source：源码编辑器挂载完成才定位
    await wrapper.setProps({ tab: { ...tab, viewMode: 'source' } })
    await flushPromises()

    expect(setNoteViewMode).toHaveBeenCalledWith('tab-a', 'source')
    expect(sourceStubState.revealedLine).toBe(12)
  })

  it('有受阻草稿时不切源码，只给提示（不销毁编辑器）', async () => {
    const { wrapper, setNoteViewMode, workspace } = setup()
    wrapper.findComponent(MilkdownStub).vm.$emit('displayLimitedChange', items)
    workspace.documents['kb-a:note-a']!.unsavedDraft = true
    await flushPromises()
    await wrapper.get('.note-display-limited__head button').trigger('click')
    await wrapper.get('.note-display-limited__list li').findAll('button')[1].trigger('click')

    expect(setNoteViewMode).not.toHaveBeenCalled()
    expect(String(workspace.status)).toContain('先处理编辑器的修改')
  })

  it('复制诊断信息：先预览（含路径与片段），确认才写剪贴板', async () => {
    const { wrapper, workspace } = setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    workspace.documents['kb-a:note-a']!.unsavedDraft = true
    await flushPromises()

    const buttons = await wrapper.get('.note-draft-banner').findAll('button')
    await buttons[1]!.trigger('click')
    const preview = wrapper.get('.note-copy-preview')
    expect(preview.text()).toContain('复制诊断信息')
    expect(preview.text()).toContain('notes/0001. 概述.md')
    expect(preview.text()).toContain('unsavedDraft')
    expect(writeText).not.toHaveBeenCalled()

    await preview.get('footer button:last-child').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0]![0]).toContain('notes/0001. 概述.md')
  })
})

/**
 * 本机 MCP 的选区快照来源：只有"活动分组 + 活动标签"的编辑器能写入。
 * 后台分组（多分组布局里另一个编辑器）的选区变化必须被丢掉，不能覆盖活动编辑器的快照。
 */
describe('本机 MCP 选区上报', () => {
  const flushReporter = async (): Promise<void> => {
    await flushPromises()
    // 上报有 80ms 节流；等过它才能断言"写了 / 没写"
    await new Promise((resolve) => setTimeout(resolve, 160))
  }

  it('只有活动分组里的活动标签能写入快照', async () => {
    const report = vi.fn(async () => ({ ok: true, value: { accepted: true } }))
    const clear = vi.fn(async () => ({ ok: true, value: { cleared: true } }))
    window.desk = { selection: { report, clear } } as unknown as typeof window.desk
    const { wrapper, workspace, editor } = setup()
    workspace.knowledgeBase = {
      id: 'kb-a',
      name: 'docs',
      displayName: 'docs',
      rootPath: '/tmp/kb'
    } as never

    // 活动分组是别处：后台编辑器的选区变化一律不写入
    editor.activeGroupId = 'group-b'
    wrapper
      .findComponent(MilkdownStub)
      .vm.$emit('selectionChange', { empty: false, selectedText: '后台选中的字', blocks: [] })
    await flushReporter()
    expect(report).not.toHaveBeenCalled()

    // 成为活动分组（标签也是活动的）：正常写入，身份来自同一篇笔记
    editor.activeGroupId = 'group-a'
    wrapper
      .findComponent(MilkdownStub)
      .vm.$emit('selectionChange', { empty: false, selectedText: '活动选中的字', blocks: [] })
    await flushReporter()
    expect(report).toHaveBeenCalledTimes(1)
    const request = report.mock.calls[0]![0] as {
      note: { id: string }
      capture: { selectedText: string; collector: string }
    }
    expect(request.capture.selectedText).toBe('活动选中的字')
    expect(request.capture.collector).toBe('visual')
    expect(request.note.id).toBe('note-a')
  })
})
