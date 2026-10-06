import { cloneSubtree, parseMarkdown } from '@tnotesjs/mindmap-core'
import type { InlineParseOptions, MindmapNode, MindmapSession } from '@tnotesjs/mindmap-core'

const LIST_LINE_RE = /^\s*[-*+]\s+/

/** In-app fallback when Electron denies async Clipboard API (common in Desk). */
let mindmapClipboardBuffer = ''

function clipboardNodes(text: string, options?: InlineParseOptions): MindmapNode[] {
  const fragment = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      if (LIST_LINE_RE.test(line)) return line
      const match = /^(\s*)(.*)$/.exec(line)!
      return `${match[1]}- ${match[2]}`
    })
    .join('\n')
  if (!fragment) return []
  const parsed = parseMarkdown(`# _\n\n${fragment}\n`, '_', options)
  if (!parsed.valid) return []
  return parsed.doc.root.children.map((node) => cloneSubtree(node))
}

/** Sync write that survives Electron's missing clipboard permission. */
export function writeMindmapClipboard(text: string, event?: ClipboardEvent | null): void {
  mindmapClipboardBuffer = text
  if (event?.clipboardData) {
    event.clipboardData.setData('text/plain', text)
    return
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.top = '0'
    textarea.style.opacity = '0'
    document.body.append(textarea)
    textarea.focus()
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  } catch {
    // fall through to async API
  }
  void navigator.clipboard?.writeText(text).catch(() => {
    // Buffer above still enables in-app Cmd+V.
  })
}

export async function readMindmapClipboard(event?: ClipboardEvent | null): Promise<string> {
  const fromEvent = event?.clipboardData?.getData('text/plain') ?? ''
  if (fromEvent.trim()) {
    mindmapClipboardBuffer = fromEvent
    return fromEvent
  }
  try {
    const fromApi = (await navigator.clipboard?.readText?.()) ?? ''
    if (fromApi.trim()) {
      mindmapClipboardBuffer = fromApi
      return fromApi
    }
  } catch {
    // Electron often denies readText without an explicit permission grant.
  }
  return mindmapClipboardBuffer
}

/** 把剪贴板中的普通文字 / Markdown 列表作为当前主题后的同级子树插入。 */
export function pasteCanvasOutline(
  session: MindmapSession,
  anchorId: string,
  text: string
): string[] {
  const nodes = clipboardNodes(text, session.inlineOptions)
  const anchor = session.document.find(anchorId)
  if (!anchor || nodes.length === 0) return []
  const insertedIds: string[] = []
  session.transact((doc) => {
    const parent =
      anchor === session.focusRootNode ? anchor : (anchor.parent ?? session.focusRootNode)
    let index =
      anchor === session.focusRootNode
        ? parent.children.length
        : parent.children.indexOf(anchor) + 1
    for (const source of nodes) {
      const inserted = doc.addNode(
        parent,
        { ...source.content, image: source.content.image ? { ...source.content.image } : null },
        index++
      )
      inserted.collapsed = source.collapsed
      for (const child of [...source.children]) doc.move(child, inserted, inserted.children.length)
      insertedIds.push(inserted.id)
    }
  })
  session.selectMany(
    insertedIds,
    insertedIds[insertedIds.length - 1] ?? null,
    insertedIds[0] ?? null
  )
  return insertedIds
}
