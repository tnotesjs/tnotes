/**
 * 复制内容里的图片要贡献纯文本（回归修复，走向 0.10.1）。
 *
 * ## 回归（二分定位到 6dc6d04：图片描述框移出 contenteditable）
 *
 * 在那之前，选区里的描述 `<input>` 会被 Chromium 当作纯文本来源（它的 value 就是 alt），
 * 所以"复制一张图 → 粘到外部应用"能得到 alt 文字。移出之后选区里只剩 `<img>`，
 * 而**图片节点不贡献纯文本**，Chromium 于是只写 `text/html`：
 * 复制图片后粘到只认 `text/plain` 的地方（外部 IDE / 聊天框 / 普通文本框）得到**空**；
 * Desk 内部粘贴仍正常（走 `text/html` 里的引用）。
 *
 * ## 修法：不动原生复制，复制完成后只把 `text/plain` 补上
 *
 * 为什么不是"在 copy 事件里自己写剪贴板"（三条路都试过、都失败，记录以免回退）：
 *  - `clipboardData.setData('text/plain', …)`：事件对象上读得到，**系统剪贴板拿不到**；
 *  - `execCommand('copy')` + 离屏元素重发：纯 DOM 选区下不产生任何 flavor，
 *    还会把原生 `text/html`（Desk 内部粘贴画布图要用的引用）一起弄丢；
 *  - `EditorProps.clipboardTextSerializer`：实测这条复制根本不经过 ProseMirror
 *    的复制流程（序列化器从未被调用）。
 *
 * 现在这条：让原生复制照常发生（`text/html` 完全不变），复制结束后把**纯文本形态**
 * 交给主进程覆盖 `text/plain`（主进程会连同 html 一起重写，避免清掉 html flavor）。
 */

import type { EditorView } from '@milkdown/kit/prose/view'

/** 图片节点在纯文本里的表示：alt（没有就是空串）。 */
function imageText(node: { attrs: Record<string, unknown> }): string {
  return String(node.attrs.alt ?? '').trim()
}

/**
 * 当前选区内容的**纯文本形态**：文字原样、图片取 alt、硬换行与块之间转成换行。
 *
 * 与"选区里有没有图片"无关 —— 正文复制得到正文，图片复制得到 alt，
 * 图文混选按文档顺序拼接（不丢不重）。
 */
export function selectionPlainText(view: EditorView): string {
  const { doc, selection } = view.state
  const pieces: string[] = []
  let previousBlockEnd = -1
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.type.name === 'image') {
      pieces.push(imageText(node))
      return false
    }
    if (node.type.name === 'hardbreak') {
      pieces.push('\n')
      return false
    }
    if (node.isText) {
      pieces.push(node.text ?? '')
      return false
    }
    if (node.isBlock) {
      // 块之间补换行：`nodesBetween` 会给出每个块的起点，块起点超出上一个块就算换块
      if (previousBlockEnd !== -1 && pos >= previousBlockEnd) pieces.push('\n')
      previousBlockEnd = pos + node.nodeSize
    }
    return true
  })
  return pieces.join('')
}

/** 选区里是否含图片节点（只有含图时才需要补纯文本）。 */
export function selectionHasImage(view: EditorView): boolean {
  let found = false
  view.state.doc.nodesBetween(view.state.selection.from, view.state.selection.to, (node) => {
    if (node.type.name === 'image') {
      found = true
      return false
    }
    return true
  })
  return found
}

/** 选区是否落在代码块内（那条复制有自己的独立格式标记，不能覆盖它的纯文本）。 */
function selectionInCodeBlock(view: EditorView): boolean {
  try {
    return view.state.selection.$from.parent.type.spec.code === true
  } catch {
    return false
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 按选区构造 `text/html`：图片输出 `<img src alt>`（**`.svg` 引用必须保留** ——
 * 画布插件的粘贴侧靠它识别引用；`alt` 也必须带 —— 否则粘回 Desk 后描述会丢）。
 *
 * 为什么不用原生 html：这条复制在 Electron 里给不出可用的 `text/html`
 * （要么为空、要么是整篇快照），而 Desk 内部粘贴又会重写产物，所以自己序列化更可控。
 */
export function selectionHtml(view: EditorView): string {
  const { doc, selection } = view.state
  const blocks: string[] = []
  const inline: string[] = []
  const flush = (): void => {
    blocks.push(`<p>${inline.join('')}</p>`)
    inline.length = 0
  }
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.name === 'image') {
      const attrs = node.attrs as Record<string, unknown>
      inline.push(
        `<img src="${escapeAttribute(String(attrs.src ?? ''))}" alt="${escapeAttribute(
          String(attrs.alt ?? '')
        )}">`
      )
      return false
    }
    if (node.type.name === 'hardbreak') {
      inline.push('<br>')
      return false
    }
    if (node.isText) {
      inline.push(
        node.text?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') ?? ''
      )
      return false
    }
    if (node.isTextblock) {
      flush()
      return true
    }
    return true
  })
  flush()
  // 不再自带 `<meta charset>`：Electron 的 `clipboard.readHTML()` 会自行前缀一个，
  // 带上会出现两个（功能无影响，但没必要）
  return blocks.join('')
}

/**
 * 在编辑器根上挂 `copy` 监听：复制含图片的内容后，把 `text/plain` 补成纯文本形态。
 *
 * 返回摘除监听器的函数。
 */
export function ensureImageCopyPlainText(view: EditorView): () => void {
  const root = view.dom
  let pending: ReturnType<typeof setTimeout> | null = null

  const onCopy = (): void => {
    if (!selectionHasImage(view)) return
    if (selectionInCodeBlock(view)) return
    const text = selectionPlainText(view)
    const html = selectionHtml(view)
    if (pending) clearTimeout(pending)
    // 等原生复制把 flavor 写进剪贴板之后再补，避免被它覆盖
    pending = setTimeout(() => {
      pending = null
      void window.desk.clipboard.setPlainText(text, html).catch(() => undefined)
    }, 30)
  }
  root.addEventListener('copy', onCopy, true)
  return () => {
    if (pending) clearTimeout(pending)
    root.removeEventListener('copy', onCopy, true)
  }
}
