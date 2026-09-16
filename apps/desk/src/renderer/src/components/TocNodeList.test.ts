// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DeskTocNode } from '../../../shared/contracts'
import TocNodeList from './TocNodeList.vue'
import { useWorkspaceStore } from '../stores/workspace'

const showContextMenu = vi.fn()

beforeEach(() => {
  setActivePinia(createPinia())
  showContextMenu.mockReset().mockResolvedValue({ ok: true, value: null })
  Object.defineProperty(window, 'desk', { configurable: true, value: { app: { showContextMenu } } })
})
afterEach(() => Reflect.deleteProperty(window, 'desk'))

const sourceNote: Extract<DeskTocNode, { type: 'note' }> = {
  type: 'note',
  uuid: 'note-a',
  title: '第一篇',
  dirName: '0001. 第一篇',
  noteIndex: '0001',
  tocLineIndex: 1,
  nodeId: 'note-a',
  completed: false,
  children: []
}

const targetNote: Extract<DeskTocNode, { type: 'note' }> = {
  type: 'note',
  uuid: 'note-b',
  title: '第二篇',
  dirName: '0002. 第二篇',
  noteIndex: '0002',
  tocLineIndex: 2,
  nodeId: 'note-b',
  completed: true,
  children: []
}

function mountList(nodes: DeskTocNode[] = [sourceNote, targetNote]): ReturnType<typeof mount> {
  return mount(TocNodeList, {
    props: { nodes, selectedNoteUuid: sourceNote.uuid }
  })
}

function dataTransferStub(): {
  effectAllowed: string
  dropEffect: string
  types: string[]
  setData: (type: string, value: string) => void
  getData: (type: string) => string
  setDragImage: () => void
} {
  const data = new Map<string, string>()
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    types: [] as string[],
    setData(type: string, value: string) {
      data.set(type, value)
      if (!this.types.includes(type)) this.types.push(type)
    },
    getData(type: string) {
      return data.get(type) ?? ''
    },
    setDragImage() {
      return undefined
    }
  }
}

describe('TocNodeList', () => {
  it('marks completion with the shared dot, not an emoji', () => {
    const wrapper = mountList()
    const toggles = wrapper.findAll('.done-toggle')
    expect(toggles).toHaveLength(2)
    // Shape carries the state (hollow ring vs filled dot) — see the styles.
    expect(toggles[0]!.classes()).not.toContain('done')
    expect(toggles[1]!.classes()).toContain('done')
    // Every toggle carries the dot element and its own accessible label.
    expect(wrapper.findAll('.done-dot')).toHaveLength(2)
    expect(toggles[0]!.attributes('aria-label')).toBe('标记为完成')
    expect(toggles[1]!.attributes('aria-label')).toBe('标记为未完成')
    // No emoji text is rendered anywhere in the list.
    expect(wrapper.text()).not.toMatch(/[✅⏰]/)
    wrapper.unmount()
  })

  it('keeps only the add-child control beside a row', () => {
    const wrapper = mountList()
    const firstRow = wrapper.findAll('.toc-row')[0]

    expect(firstRow.findAll(':scope > .row-action')).toHaveLength(1)
    expect(firstRow.find('.row-menu').exists()).toBe(false)
    expect(firstRow.find('.add-note-action').attributes('aria-label')).toBe('添加子笔记')
    expect(firstRow.find('.row-menu-popover').exists()).toBe(false)
    wrapper.unmount()
  })

  it('emits an inside move when a note is dropped in the middle of another row', async () => {
    const wrapper = mountList()
    const rows = wrapper.findAll('.toc-row')
    const transfer = dataTransferStub()
    const targetElement = rows[1].element as HTMLElement
    Object.defineProperty(targetElement, 'offsetHeight', { configurable: true, value: 30 })
    targetElement.getBoundingClientRect = () =>
      ({ top: 0, bottom: 30, left: 0, right: 200, width: 200, height: 30, x: 0, y: 0 }) as DOMRect

    await rows[0].trigger('dragstart', { dataTransfer: transfer })
    await rows[1].trigger('dragover', { clientY: 15, dataTransfer: transfer })
    expect(rows[1].classes()).toContain('drop-inside')
    await rows[1].trigger('drop', { clientY: 15, dataTransfer: transfer })

    expect(wrapper.emitted('move')).toEqual([[sourceNote, targetNote, 'inside']])
  })

  it('does not move a group into one of its descendants', async () => {
    const group: Extract<DeskTocNode, { type: 'group' }> = {
      type: 'group',
      title: '分组',
      tocLineIndex: 0,
      nodeId: 'group-a',
      folderPath: ['分组'],
      children: [targetNote]
    }
    const wrapper = mountList([group])
    const rows = wrapper.findAll('.toc-row')
    const transfer = dataTransferStub()
    const targetElement = rows[1].element as HTMLElement
    Object.defineProperty(targetElement, 'offsetHeight', { configurable: true, value: 30 })
    targetElement.getBoundingClientRect = () =>
      ({ top: 0, bottom: 30, left: 0, right: 200, width: 200, height: 30, x: 0, y: 0 }) as DOMRect

    await rows[0].trigger('dragstart', { dataTransfer: transfer })
    await rows[1].trigger('dragover', { clientY: 15, dataTransfer: transfer })
    await rows[1].trigger('drop', { clientY: 15, dataTransfer: transfer })

    expect(wrapper.emitted('move')).toBeUndefined()
  })

  it('keeps a note open on double click instead of requesting a rename', async () => {
    const wrapper = mountList()

    await wrapper.find('.node-label:not(.group)').trigger('dblclick')

    expect(wrapper.emitted('selectPermanent')).toEqual([[sourceNote]])
    expect(wrapper.emitted('requestRename')).toBeUndefined()
  })

  it('opens a native note menu instead of an HTML overlay and does nothing on dismissal', async () => {
    const wrapper = mountList()
    const workspace = useWorkspaceStore()
    workspace.selectedKnowledgeBaseId = 'kb-a'
    const copy = vi.spyOn(workspace, 'copyNoteDirectoryPath').mockResolvedValue(undefined)

    await wrapper.find('.toc-row').trigger('contextmenu', { clientX: 40, clientY: 60 })
    await flushPromises()

    expect(showContextMenu).toHaveBeenCalledExactlyOnceWith({
      kind: 'note',
      pinned: false,
      completed: false
    })
    expect(document.body.querySelector('.note-context-menu')).toBeNull()
    expect(copy).not.toHaveBeenCalled()
    expect(wrapper.emitted('openIde')).toBeUndefined()
    wrapper.unmount()
  })

  it('dispatches the chosen action for the right-clicked note', async () => {
    const wrapper = mountList()
    const workspace = useWorkspaceStore()
    workspace.selectedKnowledgeBaseId = 'kb-a'
    const copy = vi.spyOn(workspace, 'copyNoteDirectoryPath').mockResolvedValue(undefined)
    showContextMenu.mockResolvedValue({ ok: true, value: 'copy-path' })
    await wrapper.findAll('.toc-row')[1].trigger('contextmenu')
    await flushPromises()
    expect(copy).toHaveBeenCalledExactlyOnceWith({
      knowledgeBaseId: 'kb-a',
      noteUuid: targetNote.uuid
    })
    wrapper.unmount()
  })

  it.each(['note', 'group'] as const)(
    'removes the more button but retains add-child for %s rows',
    (kind) => {
      const node: DeskTocNode =
        kind === 'note'
          ? sourceNote
          : {
              type: 'group',
              title: '分组',
              nodeId: 'group-a',
              tocLineIndex: 0,
              folderPath: ['分组'],
              children: []
            }
      const wrapper = mountList([node])
      expect(wrapper.find('[aria-label="更多操作"], .row-menu, .row-menu-popover').exists()).toBe(
        false
      )
      expect(wrapper.find('[aria-label="添加子笔记"]').exists()).toBe(true)
      wrapper.unmount()
    }
  )

  it.each(['note', 'group'] as const)(
    'dispatches merged actions for the right-clicked %s',
    async (kind) => {
      const node: DeskTocNode =
        kind === 'note'
          ? { ...sourceNote, completed: true }
          : {
              type: 'group',
              title: '分组',
              nodeId: 'group-a',
              tocLineIndex: 0,
              folderPath: ['分组'],
              children: []
            }
      const wrapper = mountList([node])
      useWorkspaceStore().selectedKnowledgeBaseId = 'kb-a'
      for (const action of [
        'rename',
        'add-before',
        'add-after',
        'request-delete',
        ...(kind === 'note' ? ['open-split', 'toggle-done'] : [])
      ]) {
        showContextMenu.mockResolvedValue({ ok: true, value: action })
        await wrapper.find('.toc-row').trigger('contextmenu')
        await flushPromises()
      }
      expect(showContextMenu).toHaveBeenCalledWith(
        kind === 'note' ? { kind: 'note', pinned: false, completed: true } : { kind: 'group' }
      )
      expect(wrapper.emitted('requestRename')).toEqual([[node]])
      expect(wrapper.emitted('requestCreate')).toEqual([
        [node, 'before'],
        [node, 'after']
      ])
      // Only the confirmation request is emitted; no file deletion happens in the menu.
      expect(wrapper.emitted('requestDelete')).toEqual([[node]])
      expect(wrapper.emitted('selectSplit')).toEqual(kind === 'note' ? [[node]] : undefined)
      expect(wrapper.emitted('toggleDone')).toEqual(kind === 'note' ? [[node]] : undefined)
      wrapper.unmount()
    }
  )

  it('opens the menu for a collapsed group without expanding it, and dismissal has no effects', async () => {
    const group: DeskTocNode = {
      type: 'group',
      title: '分组',
      nodeId: 'group-a',
      tocLineIndex: 0,
      folderPath: ['分组'],
      children: [sourceNote]
    }
    const wrapper = mountList([group])
    useWorkspaceStore().selectedKnowledgeBaseId = 'kb-a'
    await wrapper.find('.node-label.group').trigger('click')
    await wrapper.find('.toc-row').trigger('contextmenu')
    await flushPromises()
    expect(showContextMenu).toHaveBeenCalledExactlyOnceWith({ kind: 'group' })
    expect(wrapper.find('[data-note-uuid="note-a"]').exists()).toBe(false)
    expect(wrapper.emitted('requestDelete')).toBeUndefined()
    expect(wrapper.emitted('requestRename')).toBeUndefined()
    wrapper.unmount()
  })

  it('forwards right-click actions from nested note rows to the root list', async () => {
    const group: DeskTocNode = {
      type: 'group',
      title: '分组',
      nodeId: 'group-a',
      tocLineIndex: 0,
      folderPath: ['分组'],
      children: [sourceNote]
    }
    const wrapper = mountList([group])
    useWorkspaceStore().selectedKnowledgeBaseId = 'kb-a'
    showContextMenu.mockResolvedValue({ ok: true, value: 'rename' })
    await wrapper.find('[data-note-uuid="note-a"]').trigger('contextmenu')
    await flushPromises()
    expect(showContextMenu).toHaveBeenCalledOnce()
    expect(wrapper.emitted('requestRename')).toEqual([[sourceNote]])
    wrapper.unmount()
  })

  it('does not request a rename when double-clicking a group', async () => {
    const group: Extract<DeskTocNode, { type: 'group' }> = {
      type: 'group',
      title: '分组',
      tocLineIndex: 0,
      nodeId: 'group-a',
      folderPath: ['分组'],
      children: [sourceNote]
    }
    const wrapper = mountList([group])

    await wrapper.find('.node-label.group').trigger('dblclick')

    expect(wrapper.emitted('requestRename')).toBeUndefined()
  })

  it('expands collapsed parents when a focused note is requested', async () => {
    const group: Extract<DeskTocNode, { type: 'group' }> = {
      type: 'group',
      title: '分组',
      tocLineIndex: 0,
      nodeId: 'group-a',
      folderPath: ['分组'],
      children: [targetNote]
    }
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    const wrapper = mount(TocNodeList, {
      props: { nodes: [group], selectedNoteUuid: null, focusRequestId: 0 }
    })

    await wrapper.find('.disclosure').trigger('click')
    expect(wrapper.find('[data-note-uuid="note-b"]').exists()).toBe(false)

    await wrapper.setProps({ selectedNoteUuid: targetNote.uuid, focusRequestId: 1 })
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalled())

    expect(wrapper.find('[data-note-uuid="note-b"]').exists()).toBe(true)
  })
})
