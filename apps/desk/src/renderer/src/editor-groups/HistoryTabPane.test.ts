// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../history/HistoryNotePreview.vue', () => ({
  default: {
    name: 'HistoryNotePreviewStub',
    props: ['commit'],
    template: '<div data-stub-preview />'
  }
}))

import HistoryTabPane from './HistoryTabPane.vue'
import { useEditorStore } from '../stores/editor'

import type {
  AppSettings,
  HistoryListResultDto,
  KnowledgeBaseDescriptor
} from '../../../shared/contracts'

const settings: AppSettings = {
  version: 1,
  theme: 'system',
  density: 'comfortable',
  defaultNoteView: 'visual',
  defaultNotePageWidth: 'standard',
  noteTocDisplay: 'expanded',
  appZoomPercent: 100,
  autosave: { enabled: true, delayMs: 800 },
  createNotePosition: 'top',
  workspaceLayout: 'kb-dir-content',
  prettier: true,
  ide: 'vscode',
  gitPath: null,
  nodePath: null,
  confirmBeforeCommit: false,
  tabs: { maxOpenCount: 10, wrap: true, autoRevealInToc: true },
  toc: {
    showNoteIndex: true,
    showNoteStatus: true,
    changesCollapsedByDefault: true
  },
  imageUpload: {
    defaultTarget: 'local',
    github: { repository: '', branch: 'main', path: '/', cdnTemplate: '', tokenConfigured: false },
    remote: { target: 'local', cdnTemplate: '' },
    quality: 80,
    format: 'auto'
  }
} as AppSettings

const knowledgeBase: KnowledgeBaseDescriptor = {
  id: 'kb-1',
  displayName: 'KB',
  rootPath: '/tmp/kb-1',
  icon: null,
  noteCount: 1,
  lastOpenedAt: null
} as KnowledgeBaseDescriptor

const OID = 'a'.repeat(40)
const OID_2 = 'b'.repeat(40)

function page(overrides: Partial<HistoryListResultDto> = {}): HistoryListResultDto {
  return {
    head: OID,
    shallow: false,
    hasMore: false,
    commits: [
      {
        oid: OID,
        shortOid: 'aaaaaaa',
        committedAt: 1_700_000_000,
        authorName: 'T',
        subject: 'docs: 更新正文与资源',
        parents: [],
        changedPaths: ['notes/0042. A.md', 'assets/0042-a.png'],
        isMerge: false,
        touchesIndex: true
      }
    ],
    ...overrides
  }
}

let listResult: { ok: true; value: HistoryListResultDto } | { ok: false; error: unknown }
const list = vi.fn(async () => listResult)

beforeEach(() => {
  setActivePinia(createPinia())
  useEditorStore().configure(settings)
  listResult = { ok: true, value: page() }
  list.mockClear()
  ;(window as unknown as { desk: unknown }).desk = {
    history: {
      list,
      readNote: vi.fn(async () => ({ ok: false, error: { code: 'X', message: '不该被调用' } }))
    }
  }
})

async function openPane() {
  const editor = useEditorStore()
  const tabId = editor.openNoteHistory(knowledgeBase, { noteIndex: '0042', commit: OID })
  const tab = editor.groups.flatMap((group) => group.tabs).find((item) => item.id === tabId)!
  const wrapper = mount(HistoryTabPane, {
    props: { tab: tab as never, active: true, groupId: editor.activeGroupId }
  })
  await flushPromises()
  return { wrapper, editor, tabId }
}

describe('历史标签页（列表与门禁）', () => {
  it('条目显示变更概览，选中版本后可以打开影响范围确认', async () => {
    const { wrapper } = await openPane()
    const entry = wrapper.get('[data-history-commits] button')
    expect(entry.text()).toContain('正文 1 · 资源 1')
    // 按钮可用，并说明会先备份再写回
    const restore = wrapper.get('[data-history-restore]')
    expect(restore.attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-history-restore-reason]').text()).toContain('备份提交')
  })

  it('浅克隆给出本地历史不完整的提示', async () => {
    listResult = { ok: true, value: page({ shallow: true }) }
    const { wrapper } = await openPane()
    expect(wrapper.get('[data-history-shallow]').text()).toContain('浅克隆')
  })

  it('没有历史时仍可浏览，恢复入口提示先选版本', async () => {
    listResult = { ok: true, value: page({ commits: [] }) }
    const { wrapper } = await openPane()
    expect(wrapper.find('[data-history-empty]').exists()).toBe(true)
    expect(wrapper.get('[data-history-restore]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-history-restore-reason]').text()).toContain('选择一个历史版本')
  })

  it('读取失败显示错误并且不假装有历史', async () => {
    listResult = { ok: false, error: { code: 'NOT_A_REPO', message: '不是 Git 仓库' } }
    const { wrapper } = await openPane()
    expect(wrapper.get('[data-history-list-error]').text()).toContain('不是 Git 仓库')
    expect(wrapper.find('[data-history-commits]').exists()).toBe(false)
  })

  it('刷新保留仍在列表里的选中版本，选中已消失时回到最新一条', async () => {
    const { wrapper, editor, tabId } = await openPane()
    expect(editor.groups.flatMap((group) => group.tabs)[0]).toMatchObject({ commit: OID })

    // 刷新：选中的 OID 还在 → 保持不变
    await wrapper.get('[data-history-refresh]').trigger('click')
    await flushPromises()
    expect(list).toHaveBeenCalledTimes(2)
    expect(editor.groups.flatMap((group) => group.tabs)[0]).toMatchObject({ commit: OID })

    // 选中版本消失（新 HEAD 上已不存在）→ 选中最新一条
    editor.selectHistoryCommit(tabId, 'c'.repeat(40))
    listResult = {
      ok: true,
      value: page({
        head: OID_2,
        commits: [
          {
            oid: OID_2,
            shortOid: 'bbbbbbb',
            committedAt: 1_700_000_100,
            authorName: 'T',
            subject: 'docs: 新提交',
            parents: [],
            changedPaths: ['notes/0042. A.md'],
            isMerge: false,
            touchesIndex: true
          }
        ]
      })
    }
    await wrapper.get('[data-history-refresh]').trigger('click')
    await flushPromises()
    expect(editor.groups.flatMap((group) => group.tabs)[0]).toMatchObject({ commit: OID_2 })
  })
})
