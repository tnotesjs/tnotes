import { openFind } from './findPanel'

import type { EditorView } from '@codemirror/view'

/**
 * 全局 ⌘F 的目标：焦点不在编辑器里（侧栏、标签条）时，打开「最近聚焦过且仍可见」的
 * 那个笔记编辑器的查找条。分栏时就是用户刚才在用的那一栏。
 */
const views = new Set<EditorView>()
let lastFocused: EditorView | null = null

function visible(view: EditorView): boolean {
  return view.dom.isConnected && view.dom.getClientRects().length > 0
}

export function trackFindTarget(view: EditorView): () => void {
  views.add(view)
  const onFocus = (): void => {
    lastFocused = view
  }
  view.dom.addEventListener('focusin', onFocus)
  return () => {
    view.dom.removeEventListener('focusin', onFocus)
    views.delete(view)
    if (lastFocused === view) lastFocused = null
  }
}

export function activeFindTarget(): EditorView | null {
  if (lastFocused && visible(lastFocused)) return lastFocused
  for (const view of views) if (visible(view)) return view
  return null
}

/**
 * 窗口级 ⌘F / ⌥⌘F：编辑器自己处理过的（焦点在正文或查找条里）直接放过；
 * 焦点在终端面板时留给终端自己的查找；有弹框时不往背后的编辑器开查找条。
 */
export function handleGlobalFindKey(
  event: KeyboardEvent,
  open: (view: EditorView, replace: boolean) => boolean = openFind,
  target: () => EditorView | null = activeFindTarget
): boolean {
  if (event.defaultPrevented || event.shiftKey) return false
  if (!(event.metaKey || event.ctrlKey) || event.code !== 'KeyF') return false
  const active = document.activeElement
  if (active?.closest('.terminal-panel')) return false
  if (document.querySelector('.dialog-backdrop, .credential-backdrop')) return false
  const view = target()
  if (!view) return false
  event.preventDefault()
  return open(view, event.altKey)
}
