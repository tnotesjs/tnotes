// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KnowledgeBaseDescriptor, TabCloseChoice } from '../../../../shared/contracts'
import { useEditorStore } from '../editor'
import { createTabClosing, type ClosingResource } from './closeTabs'
import { registerPendingEdit } from '../../editor/markdown/pendingEdits'

const knowledgeBase: KnowledgeBaseDescriptor = {
  id: 'kb-a',
  configId: 'docs',
  name: 'docs',
  rootPath: '/tmp/docs',
  displayName: 'docs',
  icon: null,
  health: 'ready',
  diagnostics: [],
  noteCount: 3,
  snapshotRevision: 'v1'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function resource(key: string, initiallyDirty = true) {
  const dirty = ref(initiallyDirty)
  const saving = ref(false)
  const resume = vi.fn()
  const resource: ClosingResource = {
    key,
    title: key,
    dirty: () => dirty.value,
    saving: () => saving.value,
    pauseAutosave: vi.fn(() => resume),
    waitForSave: vi.fn(async () => undefined),
    save: vi.fn(async () => {
      dirty.value = false
    }),
    discard: vi.fn(async () => {
      dirty.value = false
    })
  }
  return { resource, dirty, saving, resume }
}

function setup(choice: TabCloseChoice = 'cancel') {
  const confirm = vi.fn(async () => ({ ok: true as const, value: choice }))
  Object.defineProperty(window, 'desk', {
    configurable: true,
    value: { app: { confirmTabClose: confirm }, web: { close: vi.fn() } }
  })
  const editor = useEditorStore()
  const resources = new Map<string, ClosingResource[]>()
  const error = ref<string | null>(null)
  const closing = createTabClosing({
    editor,
    error,
    status: ref(null),
    resourcesFor: (tab) => (tab.type === 'note' ? (resources.get(tab.noteUuid) ?? []) : [])
  })
  const open = (uuid: string, entries: ClosingResource[] = []) => {
    resources.set(uuid, entries)
    return editor.openNote(knowledgeBase, uuid, uuid, 'visual', undefined, 'permanent')
  }
  const ids = () => editor.groups.flatMap((group) => group.tabs.map((tab) => tab.id))
  return { ...closing, editor, resources, error, confirm, open, ids }
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => Reflect.deleteProperty(window, 'desk'))

describe('unsaved tab closing', () => {
  it('closes clean tabs without a prompt', async () => {
    const state = setup()
    const tab = state.open('A', [resource('A', false).resource])
    expect(await state.requestCloseTab(tab)).toBe(true)
    expect(state.ids()).toEqual([])
    expect(state.confirm).not.toHaveBeenCalled()
  })

  it('keeps all tabs and changes on cancel, and resumes autosave', async () => {
    const state = setup()
    const draft = resource('A')
    const a = state.open('A', [draft.resource])
    const b = state.open('B')
    expect(await state.requestCloseTabs('all')).toBe(false)
    expect(state.ids()).toEqual([a, b])
    expect(draft.dirty.value).toBe(true)
    expect(draft.resource.save).not.toHaveBeenCalled()
    expect(draft.resource.discard).not.toHaveBeenCalled()
    expect(draft.resume).toHaveBeenCalledOnce()
  })

  it('waits until saving succeeds before removing a tab', async () => {
    const state = setup('save')
    const draft = resource('A')
    const saved = deferred<void>()
    vi.mocked(draft.resource.save).mockImplementation(async () => {
      await saved.promise
      draft.dirty.value = false
    })
    const tab = state.open('A', [draft.resource])
    const close = state.requestCloseTab(tab)
    await vi.waitFor(() => expect(draft.resource.save).toHaveBeenCalledOnce())
    expect(state.closingTabs.value).toBe(true)
    expect(state.ids()).toEqual([tab])
    saved.resolve()
    expect(await close).toBe(true)
    expect(state.ids()).toEqual([])
    expect(state.closingTabs.value).toBe(false)
  })

  it('leaves the entire batch open when any save fails', async () => {
    const state = setup('save')
    const draft = resource('A')
    vi.mocked(draft.resource.save).mockRejectedValue(new Error('版本冲突'))
    const a = state.open('A', [draft.resource])
    const b = state.open('B')
    expect(await state.requestCloseTabs('all')).toBe(false)
    expect(state.error.value).toBe('版本冲突')
    expect(state.ids()).toEqual([a, b])
    expect(draft.dirty.value).toBe(true)
  })

  it('discards without saving and deduplicates files shared across tabs', async () => {
    const state = setup('discard')
    const draft = resource('shared.js')
    state.open('A', [draft.resource])
    state.open('B', [draft.resource])
    expect(await state.requestCloseTabs('all')).toBe(true)
    expect(state.confirm).toHaveBeenCalledExactlyOnceWith(['shared.js'])
    expect(draft.resource.discard).toHaveBeenCalledOnce()
    expect(draft.resource.save).not.toHaveBeenCalled()
    expect(state.ids()).toEqual([])
  })

  it('does not unpin a middle-clicked tab when canceled', async () => {
    const state = setup()
    const tab = state.open('A', [resource('A').resource])
    state.editor.setPinned(tab, true)
    expect(await state.requestCloseTab(tab, true)).toBe(false)
    expect(state.editor.activeTab).toMatchObject({ id: tab, pinned: true })
    state.confirm.mockResolvedValue({ ok: true, value: 'discard' })
    expect(await state.requestCloseTab(tab, true)).toBe(true)
    expect(state.ids()).toEqual([])
  })

  it('does not stack confirmations when another close is already pending', async () => {
    const state = setup()
    const decision = deferred<{ ok: true; value: TabCloseChoice }>()
    state.confirm.mockReturnValue(decision.promise)
    const tab = state.open('A', [resource('A').resource])
    const first = state.requestCloseTab(tab)
    await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledOnce())
    expect(await state.requestCloseTabs('all')).toBe(false)
    decision.resolve({ ok: true, value: 'cancel' })
    expect(await first).toBe(false)
    expect(state.confirm).toHaveBeenCalledOnce()
  })

  it('waits for an in-flight autosave and skips the prompt if it cleans the file', async () => {
    const state = setup()
    const draft = resource('A')
    draft.saving.value = true
    const saved = deferred<void>()
    vi.mocked(draft.resource.waitForSave).mockImplementation(async () => {
      await saved.promise
      draft.dirty.value = false
      draft.saving.value = false
    })
    const tab = state.open('A', [draft.resource])
    const closing = state.requestCloseTab(tab)
    await vi.waitFor(() => expect(draft.resource.pauseAutosave).toHaveBeenCalledOnce())
    expect(state.ids()).toEqual([tab])
    saved.resolve()
    expect(await closing).toBe(true)
    expect(state.confirm).not.toHaveBeenCalled()
  })

  it('keeps a tab open when new edits remain after saving', async () => {
    const state = setup('save')
    const draft = resource('A')
    vi.mocked(draft.resource.save).mockResolvedValue(undefined)
    const tab = state.open('A', [draft.resource])
    expect(await state.requestCloseTab(tab)).toBe(false)
    expect(state.ids()).toEqual([tab])
    expect(state.error.value).toContain('仍有未保存')
  })

  it('includes focused block edits before inspecting dirty state', async () => {
    const state = setup()
    const draft = resource('A', false)
    const tab = state.open('A', [draft.resource])
    const input = document.createElement('input')
    input.addEventListener('blur', () => {
      draft.dirty.value = true
    })
    document.body.append(input)
    input.focus()
    expect(await state.requestCloseTab(tab)).toBe(false)
    expect(state.confirm).toHaveBeenCalledOnce()
    input.remove()
  })

  it('treats a block-local draft as dirty and flushes it before prompting', async () => {
    const state = setup()
    const draft = resource('A', false)
    const tab = state.open('A', [draft.resource])
    let pending = true
    const registration = registerPendingEdit({
      knowledgeBaseId: () => knowledgeBase.id,
      noteUuid: () => 'A',
      dirty: () => pending,
      flush: () => {
        pending = false
        draft.dirty.value = true
      }
    })
    try {
      expect(state.isTabDirty(state.editor.activeTab!)).toBe(true)
      expect(await state.requestCloseTab(tab)).toBe(false)
      expect(state.confirm).toHaveBeenCalledWith(['A'])
      expect(draft.dirty.value).toBe(true)
    } finally {
      registration.dispose()
    }
  })

  it('closes other tabs in the same group and keeps the chosen tab plus pinned tabs', async () => {
    const state = setup()
    const a = state.open('A', [resource('A', false).resource])
    const b = state.open('B', [resource('B', false).resource])
    const c = state.open('C', [resource('C', false).resource])
    state.editor.setPinned(c, true)
    expect(await state.requestCloseOtherTabs(b)).toBe(true)
    expect(state.ids()).toEqual([b, c])
    expect(state.confirm).not.toHaveBeenCalled()
    expect(a).not.toBe(b)
  })

  it('keeps every tab when closing others is cancelled', async () => {
    const state = setup()
    const a = state.open('A', [resource('A').resource])
    const b = state.open('B', [resource('B', false).resource])
    expect(await state.requestCloseOtherTabs(b)).toBe(false)
    expect(state.ids()).toEqual([a, b])
    expect(state.confirm).toHaveBeenCalledWith(['A'])
  })

  it('excludes pinned and dirty tabs from close-saved, including dirty includes', async () => {
    const state = setup()
    const a = state.open('A', [resource('include.js').resource])
    const b = state.open('B')
    state.editor.setPinned(b, true)
    state.open('C')
    expect(state.isTabDirty(state.editor.activeGroup!.tabs.find((tab) => tab.id === a)!)).toBe(true)
    expect(await state.requestCloseTabs('saved')).toBe(true)
    expect(state.ids()).toEqual([a, b])
    expect(state.confirm).not.toHaveBeenCalled()
  })

  it('does not replace a preview tab that contains dirty included files', () => {
    const state = setup()
    state.resources.set('A', [resource('include.js').resource])
    const first = state.editor.openNote(knowledgeBase, 'A', 'A', 'visual')
    const second = state.editor.openNote(knowledgeBase, 'B', 'B', 'visual')
    expect(second).not.toBe(first)
    expect(state.ids()).toEqual([first, second])
  })
})
