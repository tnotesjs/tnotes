import { nextTick, ref, type Ref } from 'vue'

import type { EditorTab } from '../../../../shared/contracts'
import type { useEditorStore } from '../editor'
import { resultValue } from './helpers'
import { flushPendingEdits, hasPendingEdits } from '../../editor/markdown/pendingEdits'

export interface ClosingResource {
  key: string
  title: string
  dirty(): boolean
  saving(): boolean
  pauseAutosave(): () => void
  waitForSave(): Promise<void>
  save(): Promise<void>
  discard(): Promise<void>
}

interface CloseTabsContext {
  editor: ReturnType<typeof useEditorStore>
  resourcesFor(tab: EditorTab): ClosingResource[]
  error: Ref<string | null>
  status: Ref<string | null>
  /** 笔记的四位编号，用来找属于它的画布标签。 */
  noteIndex?(knowledgeBaseId: string, noteUuid: string): string | null
}

export function createTabClosing(ctx: CloseTabsContext) {
  const closingTabs = ref(false)

  function isTabDirty(tab: EditorTab): boolean {
    return (
      (tab.type !== 'web' && tab.type !== 'note-history' && tab.dirty) ||
      (tab.type === 'note' && hasPendingEdits(tab.knowledgeBaseId, tab.noteUuid)) ||
      ctx.resourcesFor(tab).some((resource) => resource.dirty())
    )
  }

  ctx.editor.setUnsavedChangesResolver(
    (tab) => isTabDirty(tab) || ctx.resourcesFor(tab).some((resource) => resource.saving())
  )

  /**
   * 提交块内草稿、等待进行中的保存，并按需询问保存/丢弃。
   * 返回 false 表示用户取消或缺省仍有未保存内容；resume 需要在调用方 finally 里恢复自动保存。
   */
  async function settleUnsavedChanges(
    targets: EditorTab[],
    resume: Array<() => void>
  ): Promise<boolean> {
    // Commit focused block editors into the shared document before inspecting dirty state.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    await nextTick()
    for (const tab of targets) {
      if (tab.type === 'note') flushPendingEdits(tab.knowledgeBaseId, tab.noteUuid)
    }
    await nextTick()
    const resources = [
      ...new Map(
        targets.flatMap(ctx.resourcesFor).map((resource) => [resource.key, resource])
      ).values()
    ].filter((resource) => resource.dirty() || resource.saving())
    for (const resource of resources) resume.push(resource.pauseAutosave())
    // An already-running save cannot be undone. Wait for its result and then inspect remaining edits.
    await Promise.all(resources.map((resource) => resource.waitForSave().catch(() => undefined)))
    const dirty = resources.filter((resource) => resource.dirty())
    if (dirty.length) {
      const choice = resultValue(
        await window.desk.app.confirmTabClose(dirty.map((resource) => resource.title))
      )
      if (choice === 'cancel') return false
      for (const resource of dirty) {
        if (!resource.dirty()) continue
        if (choice === 'save') await resource.save()
        else await resource.discard()
        if (resource.dirty()) throw new Error('仍有未保存的更改，已取消关闭标签页。')
      }
    }
    return !targets.flatMap(ctx.resourcesFor).some((resource) => resource.dirty())
  }

  /** 关窗 / 退出前调用：不关闭标签，只把内容处理干净；false 表示用户取消了退出。 */
  async function prepareToQuit(): Promise<boolean> {
    const resume: Array<() => void> = []
    try {
      const targets = ctx.editor.groups.flatMap((group) => group.tabs)
      const clean = await settleUnsavedChanges(targets, resume)
      if (!clean) ctx.status.value = '已取消退出：请先处理未保存的更改'
      return clean
    } catch (cause) {
      ctx.error.value = cause instanceof Error ? cause.message : String(cause)
      return false
    } finally {
      resume.forEach((restore) => restore())
    }
  }

  async function closeTargets(ids: string[], allowPinned = false): Promise<boolean> {
    if (closingTabs.value) return false
    closingTabs.value = true
    const resume: Array<() => void> = []
    const knowledgeBaseId = ctx.editor.activeKnowledgeBaseId
    try {
      const targets = ctx.editor.groups
        .flatMap((group) => group.tabs)
        .filter((tab) => ids.includes(tab.id) && (allowPinned || !tab.pinned))
      const clean = await settleUnsavedChanges(targets, resume)
      if (!clean) return false
      if (targets.flatMap(ctx.resourcesFor).some((resource) => resource.dirty())) {
        throw new Error('仍有未保存的更改，已取消关闭标签页。')
      }
      if (ctx.editor.activeKnowledgeBaseId !== knowledgeBaseId) return false
      // Close only after every decision succeeds, so cancel/save failures leave the whole batch open.
      for (const target of targets) {
        const group = ctx.editor.groups.find((group) =>
          group.tabs.some((tab) => tab.id === target.id)
        )
        if (!group) continue
        if (allowPinned && target.pinned) ctx.editor.setPinned(target.id, false)
        ctx.editor.close(group.id, target.id)
      }
      return true
    } catch (cause) {
      ctx.error.value = cause instanceof Error ? cause.message : String(cause)
      return false
    } finally {
      resume.forEach((restore) => restore())
      closingTabs.value = false
    }
  }

  function attachedIds(tab: EditorTab): string[] {
    if (tab.type !== 'note') return [tab.id]
    const index = ctx.noteIndex?.(tab.knowledgeBaseId, tab.noteUuid) ?? null
    const ids = [tab.id]
    for (const group of ctx.editor.groups) {
      for (const other of group.tabs) {
        if (
          other.type === 'mindmap' &&
          other.knowledgeBaseId === tab.knowledgeBaseId &&
          other.noteUuid === tab.noteUuid
        ) {
          ids.push(other.id)
        } else if (
          other.type === 'excalidraw' &&
          other.knowledgeBaseId === tab.knowledgeBaseId &&
          index &&
          other.ownerNoteIndex === index
        ) {
          ids.push(other.id)
        }
      }
    }
    return ids
  }

  function unpinAttached(noteId: string, ids: string[]): void {
    for (const id of ids) {
      if (id === noteId) continue
      const tab = ctx.editor.groups.flatMap((group) => group.tabs).find((item) => item.id === id)
      if (tab?.pinned) ctx.editor.setPinned(id, false)
    }
  }

  function requestCloseTab(tabId: string, allowPinned = false): Promise<boolean> {
    const tab = ctx.editor.groups.flatMap((group) => group.tabs).find((item) => item.id === tabId)
    if (!tab) return Promise.resolve(false)
    if (tab.pinned && !allowPinned) {
      ctx.status.value = '固定标签需要先解除固定才能关闭'
      return Promise.resolve(false)
    }
    const ids = attachedIds(tab)
    if (tab.type === 'note') unpinAttached(tab.id, ids)
    return closeTargets(ids, allowPinned)
  }

  function requestCloseOtherTabs(keepTabId: string): Promise<boolean> {
    const group = ctx.editor.groups.find((item) => item.tabs.some((tab) => tab.id === keepTabId))
    if (!group) return Promise.resolve(false)
    const keep = new Set(
      group.tabs.filter((tab) => tab.id === keepTabId || tab.pinned).map((tab) => tab.id)
    )
    const targets = group.tabs.filter((tab) => !keep.has(tab.id))
    const ids = new Set<string>()
    for (const tab of targets) {
      const attached = attachedIds(tab).filter((id) => !keep.has(id))
      if (tab.type === 'note') unpinAttached(tab.id, attached)
      for (const id of attached) ids.add(id)
    }
    return closeTargets([...ids])
  }

  function requestCloseTabs(mode: 'all' | 'saved' | 'web'): Promise<boolean> {
    const targets = ctx.editor.groups
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          !tab.pinned &&
          (mode === 'all' ||
            (mode === 'web' ? tab.type === 'web' : tab.type !== 'web' && !isTabDirty(tab)))
      )
    const ids = new Set<string>()
    for (const tab of targets) {
      if (tab.type === 'note') unpinAttached(tab.id, attachedIds(tab))
      for (const id of attachedIds(tab)) ids.add(id)
    }
    return closeTargets([...ids])
  }

  return {
    requestCloseTab,
    requestCloseTabs,
    requestCloseOtherTabs,
    isTabDirty,
    closingTabs,
    prepareToQuit
  }
}
