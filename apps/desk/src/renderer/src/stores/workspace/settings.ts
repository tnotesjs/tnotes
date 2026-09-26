import { ref, type Ref } from 'vue'

import type { useEditorStore } from '../editor'

import type { AppSettings } from '../../../../shared/contracts'
import { clampAppZoom, APP_ZOOM_DEFAULT, APP_ZOOM_STEP } from '../../../../shared/appZoom'
import { listsEqual, pinToFront, unpinId } from '../../../../shared/pinList'

import { resultValue } from './helpers'

export interface SettingsContext {
  editor: ReturnType<typeof useEditorStore>
  settings: Ref<AppSettings | null>
}

export function createSettings(ctx: SettingsContext) {
  let writeQueue: Promise<unknown> = Promise.resolve()
  let zoomRevision = 0
  let confirmedZoom = APP_ZOOM_DEFAULT
  const zoomFeedbackSequence = ref(0)

  function updateSettings(next: Partial<AppSettings>): Promise<AppSettings> {
    const revision = zoomRevision
    const writing = writeQueue.then(async () => {
      const updated = resultValue(await window.desk.settings.update(next))
      confirmedZoom = updated.appZoomPercent
      // A slow settings response must not undo more recent keyboard/button input.
      const visible =
        revision !== zoomRevision && ctx.settings.value
          ? { ...updated, appZoomPercent: ctx.settings.value.appZoomPercent }
          : updated
      ctx.settings.value = visible
      ctx.editor.configure(visible)
      return updated
    })
    writeQueue = writing.catch(() => undefined)
    return writing
  }

  function applySettings(next: AppSettings): void {
    confirmedZoom = next.appZoomPercent
    ctx.settings.value = next
    ctx.editor.configure(next)
  }

  async function setAppZoom(value: number): Promise<void> {
    if (!ctx.settings.value || !Number.isFinite(value)) return
    zoomFeedbackSequence.value += 1
    const appZoomPercent = clampAppZoom(value)
    if (appZoomPercent === ctx.settings.value.appZoomPercent) return
    const revision = ++zoomRevision
    ctx.settings.value = { ...ctx.settings.value, appZoomPercent }
    try {
      await updateSettings({ appZoomPercent })
    } catch (cause) {
      if (revision === zoomRevision && ctx.settings.value) {
        ctx.settings.value = { ...ctx.settings.value, appZoomPercent: confirmedZoom }
      }
      throw cause
    }
  }

  function adjustAppZoom(direction: -1 | 1): Promise<void> {
    const current = ctx.settings.value?.appZoomPercent ?? APP_ZOOM_DEFAULT
    return setAppZoom(current + direction * APP_ZOOM_STEP)
  }

  function togglePinnedKnowledgeBase(id: string): void {
    if (!ctx.settings.value) return
    const current = ctx.settings.value.pinnedKnowledgeBaseIds ?? []
    const next = current.includes(id) ? unpinId(current, id) : pinToFront(current, id)
    void updateSettings({ pinnedKnowledgeBaseIds: next })
  }

  function togglePinnedNote(knowledgeBaseId: string, noteUuid: string): void {
    if (!ctx.settings.value) return
    const map = { ...(ctx.settings.value.pinnedNoteUuids ?? {}) }
    const current = map[knowledgeBaseId] ?? []
    const next = current.includes(noteUuid) ? unpinId(current, noteUuid) : pinToFront(current, noteUuid)
    if (next.length === 0) delete map[knowledgeBaseId]
    else map[knowledgeBaseId] = next
    void updateSettings({ pinnedNoteUuids: map })
  }

  /** 拖进置顶组：已经置顶的挪到最前，不会取消置顶。 */
  function pinNote(knowledgeBaseId: string, noteUuid: string): void {
    if (!ctx.settings.value) return
    const map = { ...(ctx.settings.value.pinnedNoteUuids ?? {}) }
    const current = map[knowledgeBaseId] ?? []
    const next = pinToFront(current, noteUuid)
    if (listsEqual(current, next)) return
    map[knowledgeBaseId] = next
    ctx.settings.value = { ...ctx.settings.value, pinnedNoteUuids: map }
    void updateSettings({ pinnedNoteUuids: map })
  }

  return {
    updateSettings,
    applySettings,
    setAppZoom,
    adjustAppZoom,
    zoomFeedbackSequence,
    togglePinnedKnowledgeBase,
    togglePinnedNote,
    pinNote
  }
}

export type SettingsApi = ReturnType<typeof createSettings>
