// @vitest-environment happy-dom

import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteEditorTab } from '../../../shared/contracts'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import FormatOverflowBar from './FormatOverflowBar.vue'
import NoteTabPane from './NoteTabPane.vue'

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
        // 完成开关要断言真实 DOM（位置 + 圆点），不能用自动 stub
        NoteDoneToggle: false,
        // 格式工具栏是抽出来的子组件，断言仍按真实 DOM
        NoteFormatToolbar: false
      }
    }
  })
  return { wrapper, workspace, rename, setNoteViewMode, editor }
}

beforeEach(() => {
  setActivePinia(createPinia())
})
afterEach(() => document.body.replaceChildren())

describe('note header', () => {
  it('puts formatting on the same row as the title and view modes', async () => {
    const { wrapper, editor } = setup()
    // 顺序：标题 | 【视图切换 + 格式工具栏】 | 右侧布局开关
    const toolbar = wrapper.get('.document-toolbar')
    expect(
      [...toolbar.element.children].map((node) => node.classList[0] ?? node.nodeName.toLowerCase())
    ).toEqual(['document-path', 'format-cluster', 'layout-toggles'])
    const toggle = wrapper.get('[data-testid="view-toggle"]')
    const formatBar = wrapper.getComponent(FormatOverflowBar).element
    expect(toggle.attributes('aria-label')).toBe('可视化编辑')
    expect(
      toggle.element.compareDocumentPosition(formatBar) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      wrapper
        .get('.layout-toggles')
        .findAll('button')
        .map((button) => button.attributes('aria-label'))
    ).toEqual(['标准页宽', '隐藏目录', '文档属性'])
    expect(wrapper.find('.save-button').exists()).toBe(false)
    const width = vi.spyOn(editor, 'toggleNotePageWidth')
    const outline = vi.spyOn(editor, 'toggleNoteOutlineVisible')
    const view = vi.spyOn(editor, 'setNoteViewMode')
    await wrapper.setProps({ tab: { ...tab, noteAssetsVisible: true } })
    expect(wrapper.get('[data-testid="note-properties-panel"]').exists()).toBe(true)
    expect(wrapper.get('.outline-toggle').classes()).toContain('active')
    expect(
      wrapper
        .get('.properties-tabs')
        .findAll('button')
        .map((button) => button.text())
    ).toEqual(['设置', '资源'])
    expect(wrapper.get('.properties-tab.active').text()).toBe('设置')
    expect(wrapper.get('#note-description-input').element.tagName).toBe('TEXTAREA')
    await wrapper.get('.page-width-toggle').trigger('click')
    await wrapper.get('.outline-toggle').trigger('click')
    await wrapper.get('[data-testid="view-toggle"]').trigger('click')
    expect(width).toHaveBeenCalledWith('tab-a')
    expect(outline).toHaveBeenCalledWith('tab-a')
    expect(view).toHaveBeenCalledWith('tab-a', 'source')
    await wrapper.setProps({ tab: { ...tab, noteAssetsVisible: true, outlineVisible: false } })
    expect(wrapper.get('.outline-toggle').classes()).not.toContain('active')
    expect(wrapper.get('.outline-toggle').attributes('aria-label')).toBe('显示目录')
    for (const viewMode of ['source', 'visual'] as const) {
      await wrapper.setProps({ tab: { ...tab, viewMode } })
      const bar = wrapper.getComponent(FormatOverflowBar)
      expect(bar.exists()).toBe(true)
      expect(bar.props('disabled')).toBe(false)
      expect(wrapper.find('.layout-toggles').exists()).toBe(true)
      expect(wrapper.find('.save-button').exists()).toBe(false)
    }
    wrapper.unmount()
  })

  it('视图开关是一个图标：点击后切到另一个视图，图标跟着换', async () => {
    const { wrapper, editor } = setup()
    const view = vi.spyOn(editor, 'setNoteViewMode')
    const toggle = () => wrapper.get('[data-testid="view-toggle"]')

    expect(toggle().attributes('aria-label')).toBe('可视化编辑')
    await toggle().trigger('click')
    expect(view).toHaveBeenLastCalledWith('tab-a', 'source')

    await wrapper.setProps({ tab: { ...tab, viewMode: 'source' } })
    expect(toggle().attributes('aria-label')).toBe('源码视图')
    await toggle().trigger('click')
    expect(view).toHaveBeenLastCalledWith('tab-a', 'visual')
    expect(view).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('只读文档仍然禁用格式操作（与视图模式无关）', async () => {
    const { wrapper } = setup(true)
    expect(wrapper.getComponent(FormatOverflowBar).props('disabled')).toBe(true)
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

  it('focuses and selects the title after the note is created', async () => {
    const editor = useEditorStore()
    editor.requestTitleEdit('kb-a', 'note-a')
    const { wrapper } = setup()
    await flushPromises()
    const input = wrapper.get<HTMLInputElement>('input.note-title-input')
    expect(input.element.value).toBe('概述')
    expect(document.activeElement).toBe(input.element)
    expect(input.element.selectionStart).toBe(0)
    expect(input.element.selectionEnd).toBe(input.element.value.length)
    wrapper.unmount()
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

  it('预览标签换成另一篇笔记时重新挂载编辑器，不把旧笔记的文档改成新笔记', async () => {
    const { wrapper, workspace } = setup()
    const first = wrapper.findComponent({ name: 'LivePreviewEditor' })
    expect(first.props('noteUuid')).toBe('note-a')
    const firstElement = first.element

    workspace.documents['kb-a:note-b'] = {
      ...workspace.documents['kb-a:note-a']!,
      document: {
        ...workspace.documents['kb-a:note-a']!.document,
        uuid: 'note-b',
        index: '0002',
        title: '另一篇',
        content: '---\nid: note-b\n---\n'
      },
      content: '---\nid: note-b\n---\n'
    }
    await wrapper.setProps({ tab: { ...tab, noteUuid: 'note-b', title: '另一篇' } })

    const second = wrapper.findComponent({ name: 'LivePreviewEditor' })
    expect(second.props('noteUuid')).toBe('note-b')
    expect(second.props('content')).toBe('---\nid: note-b\n---\n')
    expect(second.element).not.toBe(firstElement)
    wrapper.unmount()
  })
})

describe('视图切换', () => {
  it('没有未保存修改时正常切换视图', async () => {
    const { wrapper, setNoteViewMode } = setup()
    await wrapper.get('[data-testid="view-toggle"]').trigger('click')
    expect(setNoteViewMode).toHaveBeenCalledWith('tab-a', 'source')
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
      .findComponent({ name: 'LivePreviewEditor' })
      .vm.$emit('selectionChange', { empty: false, selectedText: '后台选中的字', blocks: [] })
    await flushReporter()
    expect(report).not.toHaveBeenCalled()

    // 成为活动分组（标签也是活动的）：正常写入，身份来自同一篇笔记
    editor.activeGroupId = 'group-a'
    wrapper
      .findComponent({ name: 'LivePreviewEditor' })
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
