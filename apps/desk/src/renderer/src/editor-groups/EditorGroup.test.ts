// @vitest-environment happy-dom

import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeBaseDescriptor } from '../../../shared/contracts'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import EditorGroup from './EditorGroup.vue'

const knowledgeBase: KnowledgeBaseDescriptor = {
  id: 'kb-a',
  configId: 'docs',
  name: 'docs',
  rootPath: '/tmp/docs',
  displayName: 'docs',
  icon: null,
  health: 'ready',
  diagnostics: [],
  noteCount: 2,
  snapshotRevision: 'v1'
}
const showContextMenu = vi.fn()

beforeEach(() => {
  setActivePinia(createPinia())
  showContextMenu.mockReset().mockResolvedValue({ ok: true, value: null })
  Object.defineProperty(window, 'desk', { configurable: true, value: { app: { showContextMenu } } })
})
afterEach(() => Reflect.deleteProperty(window, 'desk'))

describe('native tab context menu', () => {
  it('tracks the focused group when focus moves by keyboard instead of mouse', async () => {
    const editor = useEditorStore()
    editor.openNote(knowledgeBase, 'a', 'A', 'visual', undefined, 'permanent')
    const left = editor.activeGroup!
    editor.openNote(knowledgeBase, 'b', 'B', 'visual', 'right', 'permanent')
    expect(editor.activeGroupId).not.toBe(left.id)
    const wrapper = shallowMount(EditorGroup, { props: { group: left } })
    await wrapper.find('.tab').trigger('focusin')
    expect(editor.activeGroupId).toBe(left.id)
    wrapper.unmount()
  })

  it('closes the right-clicked tab through the unsaved-change guard, not the active tab', async () => {
    const editor = useEditorStore()
    const workspace = useWorkspaceStore()
    const a = editor.openNote(knowledgeBase, 'a', 'A', 'visual', undefined, 'permanent')
    const b = editor.openNote(knowledgeBase, 'b', 'B', 'visual', undefined, 'permanent')
    const close = vi.spyOn(workspace, 'requestCloseTab').mockResolvedValue(false)
    const wrapper = shallowMount(EditorGroup, { props: { group: editor.activeGroup! } })
    showContextMenu.mockResolvedValue({ ok: true, value: 'close' })
    await wrapper.findAll('.tab')[0].trigger('contextmenu')
    await flushPromises()
    expect(showContextMenu).toHaveBeenCalledExactlyOnceWith({
      kind: 'tab',
      tabType: 'note',
      pinned: false
    })
    expect(close).toHaveBeenCalledExactlyOnceWith(a)
    expect(editor.activeTab?.id).toBe(b)
    expect(editor.activeGroup?.tabs).toHaveLength(2)
    expect(wrapper.find('.tab-context-menu').exists()).toBe(false)
    wrapper.unmount()
  })

  it('leaves a pinned web tab unchanged when the native menu is dismissed', async () => {
    const editor = useEditorStore()
    const workspace = useWorkspaceStore()
    editor.switchKnowledgeBase(knowledgeBase.id)
    const id = editor.openWeb('https://example.com')
    editor.setPinned(id, true)
    const close = vi.spyOn(workspace, 'requestCloseTab').mockResolvedValue(false)
    const wrapper = shallowMount(EditorGroup, { props: { group: editor.activeGroup! } })
    await wrapper.find('.tab').trigger('contextmenu')
    await flushPromises()
    expect(showContextMenu).toHaveBeenCalledExactlyOnceWith({
      kind: 'tab',
      tabType: 'web',
      pinned: true
    })
    expect(close).not.toHaveBeenCalled()
    expect(editor.activeTab).toMatchObject({ id, pinned: true })
    wrapper.unmount()
  })

  it('routes batch close through the shared confirmation flow', async () => {
    const editor = useEditorStore()
    const workspace = useWorkspaceStore()
    editor.openNote(knowledgeBase, 'a', 'A', 'visual', undefined, 'permanent')
    const close = vi.spyOn(workspace, 'requestCloseTabs').mockResolvedValue(false)
    const wrapper = shallowMount(EditorGroup, { props: { group: editor.activeGroup! } })
    showContextMenu.mockResolvedValue({ ok: true, value: 'close-all' })
    await wrapper.find('.tab').trigger('contextmenu')
    await flushPromises()
    expect(close).toHaveBeenCalledExactlyOnceWith('all')
    wrapper.unmount()
  })

  it('shows the note assets from the tab menu without toggling them back off', async () => {
    const editor = useEditorStore()
    const a = editor.openNote(knowledgeBase, 'a', 'A', 'visual', undefined, 'permanent')
    const b = editor.openNote(knowledgeBase, 'b', 'B', 'visual', undefined, 'permanent')
    // 面板已经开着：命令语义要求保持显示（若实现成 toggle，这里会被关掉）
    editor.setNoteAssetsVisible(a, true)
    const group = editor.activeGroup!
    const wrapper = shallowMount(EditorGroup, { props: { group } })
    showContextMenu.mockResolvedValue({ ok: true, value: 'show-note-assets' })
    // 右键的是第一个标签，而当前活跃标签是 b：应先切回 a
    await wrapper.findAll('.tab')[0].trigger('contextmenu')
    await flushPromises()
    // 读**当前**布局里的状态（activate 会重建分组对象，不能读动作前抓到的引用）
    const liveTabs = () => editor.groups.find((item) => item.id === group.id)!.tabs
    expect(editor.activeTab?.id).toBe(a)
    expect(liveTabs().find((tab) => tab.id === a)?.noteAssetsVisible).toBe(true)
    expect(liveTabs().find((tab) => tab.id === b)?.noteAssetsVisible).toBe(false)
    wrapper.unmount()
  })
})
