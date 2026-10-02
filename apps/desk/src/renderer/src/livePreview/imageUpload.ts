import { EditorSelection, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'

import type { Extension } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'

/** 上传多半很快；超过这个时间还没回来，才在插入位置露出占位。 */
export const IMAGE_UPLOAD_HINT_DELAY_MS = 150

interface PendingImageUpload {
  id: number
  pos: number
  label: string
  shown: boolean
}

const addImageUpload = StateEffect.define<PendingImageUpload>()
const showImageUpload = StateEffect.define<number>()
const removeImageUpload = StateEffect.define<number>()

class ImageUploadWidget extends WidgetType {
  constructor(private readonly label: string) {
    super()
  }

  eq(other: ImageUploadWidget): boolean {
    return other.label === this.label
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-lp-image-upload'
    el.textContent = this.label
    return el
  }

  ignoreEvent(): boolean {
    return true
  }
}

const pendingImageUploads = StateField.define<readonly PendingImageUpload[]>({
  create: () => [],
  update(value, tr) {
    let next = value.map((item) => ({ ...item, pos: tr.changes.mapPos(item.pos, 1) }))
    for (const effect of tr.effects) {
      if (effect.is(addImageUpload)) next = [...next, effect.value]
      else if (effect.is(showImageUpload)) {
        next = next.map((item) => (item.id === effect.value ? { ...item, shown: true } : item))
      } else if (effect.is(removeImageUpload)) {
        next = next.filter((item) => item.id !== effect.value)
      }
    }
    return next
  },
  provide(field) {
    return EditorView.decorations.from(field, (items): DecorationSet => {
      const ranges = items
        .filter((item) => item.shown)
        .map((item) =>
          Decoration.widget({ widget: new ImageUploadWidget(item.label), side: 1 }).range(item.pos)
        )
      return ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none
    })
  }
})

let nextUploadId = 1
const uploadTimers = new WeakMap<EditorView, Map<number, number>>()

function clearUploadTimer(view: EditorView, id: number): void {
  const bucket = uploadTimers.get(view)
  const timer = bucket?.get(id)
  if (timer == null) return
  window.clearTimeout(timer)
  bucket?.delete(id)
}

function editorAlive(view: EditorView): boolean {
  return view.dom.isConnected
}

/**
 * 在插入位置记一笔进行中的上传。占位只存在于视图，不写进 Markdown，
 * 所以上传过程中保存笔记不会留下假图片。
 */
export function beginImageUpload(view: EditorView, pos: number, label: string): number {
  const id = nextUploadId
  nextUploadId += 1
  const at = Math.max(0, Math.min(pos, view.state.doc.length))
  view.dispatch({ effects: addImageUpload.of({ id, pos: at, label, shown: false }) })
  const timer = window.setTimeout(() => {
    clearUploadTimer(view, id)
    if (!editorAlive(view)) return
    const pending = view.state.field(pendingImageUploads, false)
    if (!pending?.some((item) => item.id === id)) return
    view.dispatch({ effects: showImageUpload.of(id) })
  }, IMAGE_UPLOAD_HINT_DELAY_MS)
  let bucket = uploadTimers.get(view)
  if (!bucket) {
    bucket = new Map()
    uploadTimers.set(view, bucket)
  }
  bucket.set(id, timer)
  return id
}

/** 上传结束：在占位的位置写入图片 Markdown，并撤掉占位。占位已经不在时返回 false。 */
export function finishImageUpload(view: EditorView, id: number, markdown: string): boolean {
  clearUploadTimer(view, id)
  if (!editorAlive(view)) return false
  const item = view.state.field(pendingImageUploads, false)?.find((entry) => entry.id === id)
  if (!item) return false
  const pos = Math.max(0, Math.min(item.pos, view.state.doc.length))
  view.dispatch({
    changes: { from: pos, insert: markdown },
    effects: removeImageUpload.of(id),
    selection: EditorSelection.cursor(pos + markdown.length),
    userEvent: 'input.paste'
  })
  return true
}

export function cancelImageUpload(view: EditorView, id: number): void {
  clearUploadTimer(view, id)
  if (!editorAlive(view)) return
  if (!view.state.field(pendingImageUploads, false)?.some((entry) => entry.id === id)) return
  view.dispatch({ effects: removeImageUpload.of(id) })
}

const clearUploadTimers = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {}

    destroy(): void {
      const bucket = uploadTimers.get(this.view)
      if (!bucket) return
      for (const timer of bucket.values()) window.clearTimeout(timer)
      uploadTimers.delete(this.view)
    }
  }
)

export const imageUploadExtension: Extension = [pendingImageUploads, clearUploadTimers]
