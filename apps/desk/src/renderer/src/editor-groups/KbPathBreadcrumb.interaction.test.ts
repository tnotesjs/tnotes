// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import KbPathBreadcrumb from './KbPathBreadcrumb.vue'

import type {
  DeskResult,
  DeskTocNode,
  KbFileEntryDto,
  KnowledgeBaseDescriptor,
  KnowledgeBaseDetail
} from '../../../shared/contracts'

const knowledgeBase: KnowledgeBaseDescriptor = {
  id: 'kb-a',
  configId: 'cfg-a',
  name: 'hello-algo',
  rootPath: '/tmp/hello-algo',
  displayName: 'hello-algo',
  icon: null,
  health: 'ready',
  diagnostics: [],
  noteCount: 1,
  snapshotRevision: 'rev-1'
}

const rootEntries: KbFileEntryDto[] = [
  { name: 'notes', relPath: 'notes', kind: 'directory', bytes: null, textLike: false },
  { name: 'README.md', relPath: 'README.md', kind: 'file', bytes: 2048, textLike: true },
  { name: '.gitignore', relPath: '.gitignore', kind: 'file', bytes: 64, textLike: true },
  { name: 'assets', relPath: 'assets', kind: 'directory', bytes: null, textLike: false }
]

const notesEntries: KbFileEntryDto[] = [
  {
    name: '0001. hello-algo.md',
    relPath: 'notes/0001. hello-algo.md',
    kind: 'file',
    bytes: 128,
    textLike: true
  },
  { name: 'sub', relPath: 'notes/sub', kind: 'directory', bytes: null, textLike: false },
  { name: 'cover.png', relPath: 'notes/cover.png', kind: 'file', bytes: 4096, textLike: false }
]

const assetsEntries: KbFileEntryDto[] = [
  {
    name: '0001-x.excalidraw',
    relPath: 'assets/0001-x.excalidraw',
    kind: 'file',
    bytes: 512,
    textLike: false
  }
]

const detail: KnowledgeBaseDetail = {
  ...knowledgeBase,
  toc: [
    {
      type: 'note',
      uuid: 'uuid-0001',
      title: 'hello-algo',
      dirName: '0001. hello-algo',
      noteIndex: '0001',
      tocLineIndex: 0,
      nodeId: 'node-0001',
      completed: false,
      children: []
    }
  ]
}

function ok<T>(value: T): DeskResult<T> {
  return { ok: true, value }
}

function mountBreadcrumb(relPath: string): ReturnType<typeof mount> {
  return mount(KbPathBreadcrumb, {
    attachTo: document.body,
    props: { knowledgeBaseId: 'kb-a', relPath, fallbackName: 'hello-algo' },
    global: { stubs: { teleport: true } }
  })
}

let listMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  const workspace = useWorkspaceStore()
  workspace.overview = {
    path: '/tmp',
    knowledgeBases: [knowledgeBase],
    allKnowledgeBases: [knowledgeBase]
  }
  listMock = vi.fn(async (request: { relPath: string }): Promise<DeskResult<unknown>> => {
    if (request.relPath === '') return ok({ relPath: '', entries: rootEntries })
    if (request.relPath === 'notes') return ok({ relPath: 'notes', entries: notesEntries })
    if (request.relPath === 'assets') return ok({ relPath: 'assets', entries: assetsEntries })
    return ok({ relPath: request.relPath, entries: [] })
  })
  Object.defineProperty(window, 'desk', {
    configurable: true,
    value: {
      kbFiles: { list: listMock, read: vi.fn() },
      knowledgeBases: { read: vi.fn(async () => ok(detail)) }
    }
  })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'desk')
  document.body.replaceChildren()
})

describe('KbPathBreadcrumb', () => {
  it('renders the path from the knowledge-base root', () => {
    const wrapper = mountBreadcrumb('notes/0001. hello-algo.md')
    expect(wrapper.findAll('.kb-path-segment').map((button) => button.text())).toEqual([
      'hello-algo',
      'notes',
      '0001. hello-algo.md'
    ])
    expect(wrapper.get('.kb-path-segment.is-current').text()).toBe('0001. hello-algo.md')
    wrapper.unmount()
  })

  it('lists the clicked segment parent directory and auto-focuses the filter', async () => {
    const wrapper = mountBreadcrumb('notes/0001. hello-algo.md')
    // 点「notes」段 = 展开它的父目录（库根），同级条目就是 notes / README.md …
    await wrapper.findAll('.kb-path-segment')[1].trigger('click')
    await flushPromises()
    expect(listMock).toHaveBeenCalledWith({ knowledgeBaseId: 'kb-a', relPath: '' })
    expect(wrapper.findAll('.kb-path-row').map((row) => row.text())).toEqual([
      'notes',
      'README.md2.0 KB',
      '.gitignore64 B',
      'assets'
    ])
    expect(document.activeElement).toBe(wrapper.get('.kb-path-filter').element)

    // 点当前文件名 = 展开 notes，当前文件预高亮
    await wrapper.findAll('.kb-path-segment')[2].trigger('click')
    await flushPromises()
    expect(listMock).toHaveBeenLastCalledWith({ knowledgeBaseId: 'kb-a', relPath: 'notes' })
    expect(wrapper.findAll('.kb-path-row').map((row) => row.text())).toEqual([
      '0001. hello-algo.md128 B',
      'sub',
      'cover.png4.0 KB'
    ])
    expect(wrapper.get('.kb-path-row.is-active').text()).toContain('0001. hello-algo.md')
    wrapper.unmount()
  })

  it('filters, moves with arrows and opens the highlighted file with Enter', async () => {
    const wrapper = mountBreadcrumb('notes/0001. hello-algo.md')
    const editor = useEditorStore()
    const openTextFile = vi.spyOn(editor, 'openTextFile').mockReturnValue('tab-1')
    await wrapper.findAll('.kb-path-segment')[0].trigger('click')
    await flushPromises()
    await wrapper.get('.kb-path-filter').setValue('readme')
    expect(wrapper.findAll('.kb-path-row')).toHaveLength(1)
    await wrapper.get('.kb-path-filter').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(openTextFile).toHaveBeenCalledWith(knowledgeBase, 'README.md')
    expect(wrapper.find('.kb-path-menu').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens notes/ markdown through the note session when the TOC matches', async () => {
    const wrapper = mountBreadcrumb('notes/0001. hello-algo.md')
    const workspace = useWorkspaceStore()
    const editor = useEditorStore()
    const openNote = vi.spyOn(workspace, 'openNoteByUuid').mockResolvedValue()
    const openTextFile = vi.spyOn(editor, 'openTextFile').mockReturnValue('tab-1')
    await wrapper.findAll('.kb-path-segment')[2].trigger('click')
    await flushPromises()
    await wrapper.get('.kb-path-row').trigger('click')
    await flushPromises()
    expect(openNote).toHaveBeenCalledWith('kb-a', 'uuid-0001')
    expect(openTextFile).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('enters a subdirectory instead of opening it', async () => {
    const wrapper = mountBreadcrumb('notes/0001. hello-algo.md')
    const editor = useEditorStore()
    const openTextFile = vi.spyOn(editor, 'openTextFile').mockReturnValue('tab-1')
    await wrapper.findAll('.kb-path-segment')[2].trigger('click')
    await flushPromises()
    const directoryRow = wrapper.findAll('.kb-path-row').find((row) => row.text() === 'sub')
    await directoryRow!.trigger('click')
    await flushPromises()
    expect(listMock).toHaveBeenLastCalledWith({ knowledgeBaseId: 'kb-a', relPath: 'notes/sub' })
    expect(openTextFile).not.toHaveBeenCalled()
    expect(wrapper.find('.kb-path-menu').exists()).toBe(true)
    expect(wrapper.get('.kb-path-empty').text()).toBe('没有匹配的条目')
    wrapper.unmount()
  })

  it('refuses excalidraw with a pointer to the assets panel', async () => {
    const wrapper = mountBreadcrumb('assets/0001-x.excalidraw')
    const workspace = useWorkspaceStore()
    const editor = useEditorStore()
    const openTextFile = vi.spyOn(editor, 'openTextFile').mockReturnValue('tab-1')
    await wrapper.findAll('.kb-path-segment')[2].trigger('click')
    await flushPromises()
    await wrapper.get('.kb-path-row').trigger('click')
    await flushPromises()
    expect(openTextFile).not.toHaveBeenCalled()
    expect(workspace.status).toContain('资源面板')
    wrapper.unmount()
  })

  it('refuses known binary files with a status message', async () => {
    const wrapper = mountBreadcrumb('notes/cover.png')
    const workspace = useWorkspaceStore()
    const editor = useEditorStore()
    const openTextFile = vi.spyOn(editor, 'openTextFile').mockReturnValue('tab-1')
    await wrapper.findAll('.kb-path-segment')[2].trigger('click')
    await flushPromises()
    await wrapper.get('.kb-path-filter').setValue('cover.png')
    await wrapper.get('.kb-path-filter').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(openTextFile).not.toHaveBeenCalled()
    expect(workspace.status).toContain('不是文本文件')
    wrapper.unmount()
  })

  it('closes with Escape and returns focus to the trigger segment', async () => {
    const wrapper = mountBreadcrumb('notes/0001. hello-algo.md')
    const trigger = wrapper.findAll('.kb-path-segment')[1]
    await trigger.trigger('click')
    await flushPromises()
    await wrapper.get('.kb-path-filter').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('.kb-path-menu').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('opens the knowledge-base root from the first segment', async () => {
    const wrapper = mountBreadcrumb('notes/0001. hello-algo.md')
    await wrapper.findAll('.kb-path-segment')[0].trigger('click')
    await flushPromises()
    expect(listMock).toHaveBeenCalledWith({ knowledgeBaseId: 'kb-a', relPath: '' })
    expect(wrapper.findAll('.kb-path-row').map((row) => row.text())).toContain('README.md2.0 KB')
    wrapper.unmount()
  })
})

describe('KbPathBreadcrumb long path folding', () => {
  let resizeCallbacks: ResizeObserverCallback[] = []

  class FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback)
    }
    observe(): void {
      void 0
    }
    unobserve(): void {
      void 0
    }
    disconnect(): void {
      void 0
    }
    takeRecords(): ResizeObserverEntry[] {
      return []
    }
  }

  beforeEach(() => {
    resizeCallbacks = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('folds middle levels into an ellipsis whose dropdown reaches them', async () => {
    const wrapper = mountBreadcrumb('notes/sub/deep/file.md')
    resizeCallbacks.forEach((callback) =>
      callback([{ contentRect: { width: 300 } } as ResizeObserverEntry], {} as ResizeObserver)
    )
    await flushPromises()
    expect(wrapper.findAll('.kb-path-segment').map((button) => button.text())).toEqual([
      'hello-algo',
      '…',
      'file.md'
    ])
    await wrapper.get('.kb-path-segment.is-ellipsis').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.kb-path-row').map((row) => row.text())).toEqual([
      'notes目录',
      'sub目录',
      'deep目录'
    ])
    // 从被折叠的层级直接进入：锚点保持省略号，下拉换成该层的父目录条目
    await wrapper
      .findAll('.kb-path-row')
      .find((row) => row.text() === 'sub目录')!
      .trigger('click')
    await flushPromises()
    expect(listMock).toHaveBeenLastCalledWith({ knowledgeBaseId: 'kb-a', relPath: 'notes' })
    wrapper.unmount()
  })
})

describe('KbPathBreadcrumb note done toggle', () => {
  it('toggles the open note through the store, mirroring its completed state', async () => {
    const workspace = useWorkspaceStore()
    workspace.knowledgeBase = detail
    const toggleDone = vi.spyOn(workspace, 'toggleDone').mockResolvedValue()
    const wrapper = mountBreadcrumb('notes/0001. hello-algo.md')

    const toggle = wrapper.get('.done-toggle')
    // 与目录里的圆点同一个组件、同一套 class
    expect(toggle.find('.done-dot').exists()).toBe(true)
    expect(toggle.classes()).not.toContain('done')
    expect(toggle.attributes('aria-label')).toBe('标记为完成')

    await toggle.trigger('click')
    expect(toggleDone).toHaveBeenCalledTimes(1)
    // 交给 store 的是 TOC 里的活节点，不是快照：uuid + 当前 completed 都要在
    expect(toggleDone.mock.calls[0]![0]).toMatchObject({
      type: 'note',
      uuid: 'uuid-0001',
      completed: false
    })
    wrapper.unmount()
  })

  it('shows the filled dot when the note is already done', () => {
    const workspace = useWorkspaceStore()
    workspace.knowledgeBase = {
      ...detail,
      toc: [{ ...(detail.toc[0] as Extract<DeskTocNode, { type: 'note' }>), completed: true }]
    }
    const wrapper = mountBreadcrumb('notes/0001. hello-algo.md')
    const toggle = wrapper.get('.done-toggle')
    expect(toggle.classes()).toContain('done')
    expect(toggle.attributes('aria-label')).toBe('标记为未完成')
    wrapper.unmount()
  })

  it('has no toggle for files that are not TOC notes', () => {
    const workspace = useWorkspaceStore()
    workspace.knowledgeBase = detail
    // notes/ 之外的文件
    const textFile = mountBreadcrumb('README.md')
    expect(textFile.find('.done-toggle').exists()).toBe(false)
    textFile.unmount()
    // notes/ 下但编号不在 TOC 里（被当文本打开的那种）
    const unknownNote = mountBreadcrumb('notes/0099. 不在目录里.md')
    expect(unknownNote.find('.done-toggle').exists()).toBe(false)
    unknownNote.unmount()
  })
})
