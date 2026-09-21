/**
 * 代码块 / 代码组面板里的 CodeMirror 选区变化（可视化视图）。
 *
 * 为什么需要它：可视化视图的选区上报挂在 **ProseMirror 事务**上（不看 DOM 选区），
 * 而代码块内部的选区属于内嵌的 CodeMirror —— 在 CM 里拖动选区不会产生 PM 事务，
 * 于是"在代码块 / 代码组面板里选了一段"就上报不出去。
 *
 * 这里由 CM 自己的 `updateListener` 扩展在选区变化时通知（**只做触发，不读 DOM 文本**，
 * 文本仍然从 CM 的 state 读）。谁的通知谁处理：订阅方会先确认这个 CM 在自己的 host 里。
 */
import type { EditorView } from '@codemirror/view'

type Listener = (view: EditorView) => void

const listeners = new Set<Listener>()

/** CM 选区变化（由源码编辑器扩展调用） */
export function notifyCodeEditorSelection(view: EditorView): void {
  for (const listener of [...listeners]) listener(view)
}

/** 订阅 CM 选区变化；返回取消订阅函数 */
export function onCodeEditorSelection(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
