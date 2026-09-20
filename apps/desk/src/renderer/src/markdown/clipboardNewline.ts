/**
 * 纯文本粘贴：保留行边界与**实际空行数**，同时不破坏 Markdown 粘贴能力。
 *
 * 现象（真实界面复现）：从代码块复制多行内容粘到可视化正文，会变成
 * `const a = 1\n\nconst b = 2 indented const c = 3` —— **单个换行被折叠成空格**，
 * 缩进也丢了。
 *
 * 根因：Milkdown 的 clipboard 插件对"只有 text/plain、没有 text/html"的粘贴走
 * `markdown 解析 → DOM 序列化 → 再解析`，而 markdown 里**单换行是软换行**（渲染成
 * 空格），只有空行才算分段。行边界在这一步被吃掉。
 *
 * 修法（只替换 clipboard 插件的 `handlePaste`，该插件没有配置钩子；其余分支原样放行）：
 *  - 代码块内粘贴 → 放行；
 *  - `vscode-editor-data` 或带 text/html → 放行（富文本 / 编辑器粘贴语义不变）；
 *  - **空文本** → 放行；
 *  - 只有纯文本且**看起来是 Markdown**（标题 / 列表 / 围栏 / 引用 / 表格 / 分隔线等
 *    行首标记）→ **放行走原有 Markdown 解析**（保持既有能力，用户粘贴 markdown 文本
 *    仍然得到标题、列表、代码块）；
 *  - 其余纯文本（代码、普通多行文本）→ 走本插件：逐行转 DOM，
 *    **单换行 = 硬换行、空行 = 空段落（有几个空行就有几个空段落）、行首空格保留**。
 */

import { DOMParser as ProseDOMParser } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

import type { EditorView } from '@milkdown/kit/prose/view'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Desk 内代码复制时写入的自定义剪贴板类型。
 *
 * 只靠"文本长什么样"无法区分代码与 Markdown：Python/Shell 的 `# 注释`、C 风格注释里的
 * ` * 内容` 与 Markdown 的标题 / 列表项在字符层面完全一样（反过来只有行内语法的
 * Markdown 又不会被行首规则命中）。所以**应用内复制的代码带明确来源**，粘贴时优先信它。
 */
export const DESK_CODE_CLIPBOARD_TYPE = 'web application/x-desk-code'

/**
 * 代码来源的**文本哨兵**（Unicode Tag 区字符，不可见、不参与排版）。
 *
 * 为什么不用自定义 MIME：实测 Electron 里
 * `ClipboardItem.supports('application/x-desk-code') === false`
 * （只有 `web application/...` 这种带 `web ` 前缀的形式被认），而且
 * `navigator.clipboard.write` 在没有剪贴板权限的环境里会直接抛 `NotAllowedError`，
 * 于是自定义格式写不进去、只能退回"无标记纯文本"，又得靠 Markdown 猜测。
 *
 * 改成把哨兵**放进纯文本本身**：不依赖任何权限，`writeText` 就能带上；
 * 粘贴回 Desk 时先剥掉它并跳过 Markdown 解析，粘到外部应用时它也不可见。
 */
export const DESK_CODE_SENTINEL = '\u{E0000}\u{E0001}desk-code\u{E0001}'

/** 文本是否带"这是 Desk 里复制的代码"标记；返回剥掉哨兵后的正文。 */
export function stripDeskCodeSentinel(text: string): { isCode: boolean; text: string } {
  if (!text.startsWith(DESK_CODE_SENTINEL)) return { isCode: false, text }
  return { isCode: true, text: text.slice(DESK_CODE_SENTINEL.length) }
}

/** 给要写进剪贴板的代码加哨兵（外部应用看到的仍是正常文本）。 */
export function withDeskCodeSentinel(text: string): string {
  return DESK_CODE_SENTINEL + text
}

/** `looksLikeMarkdown` 的判定结果，便于单测与排查。 */
export interface MarkdownSignals {
  /** 强信号：行首块级语法（标题 / 列表 / 引用 / 围栏 / 分隔线 / 表格 / 容器） */
  blockMarkers: string[]
  /** 行内语法（`**粗体**`、`[链接](url)`、`` `代码` ``） */
  inlineMarkers: string[]
}

/**
 * 收集 Markdown 信号。
 *
 * 注意：**行首的 `#` / `-` / `*` 单独出现不算**。Python/Shell 的注释、C 风格注释块里的
 * ` * 内容` 都长这样，只按行首正则判会把代码误判成 Markdown，从而走回会折叠换行的旧路径。
 */
export function collectMarkdownSignals(text: string): MarkdownSignals {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blockMarkers: string[] = []
  const inlineMarkers: string[] = []
  const fenceLines = lines.filter((line) => /^\s{0,3}(?:```|~~~)/.test(line)).length
  for (const line of lines) {
    // 标题：要求 `#` 后有空格且不是"注释风格"的单词（`# 注释` 无法区分，交给行内/围栏信号）
    if (/^\s{0,3}#{1,6}\s+\S/.test(line)) blockMarkers.push('heading')
    // 列表：要求整段文本里**至少两行**是列表项，单行 `- xxx` 在代码里太常见。
    // `*` / `+` 还要求**顶格**：C 风格注释块里的 ` * 内容` 与它们字符层面一样（实测会误判）。
    if (/^\s{0,3}(?:-|\d{1,9}[.)])\s+\S/.test(line) || /^(?:[*+])\s+\S/.test(line)) {
      blockMarkers.push('list')
    }
    if (/^\s{0,3}>\s+\S/.test(line)) blockMarkers.push('quote')
    // 围栏：成对（≥2 行）才算，单个 ``` 在代码里可能是字符串
    if (fenceLines >= 2 && /^\s{0,3}(?:```|~~~)/.test(line)) blockMarkers.push('fence')
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) blockMarkers.push('rule')
    if (/^\s{0,3}\|.*\|\s*$/.test(line)) blockMarkers.push('table')
    if (/^\s{0,3}:{2,}\s*\S/.test(line)) blockMarkers.push('container')
    if (/\*\*[^*\n]+\*\*/.test(line)) inlineMarkers.push('bold')
    if (/\[[^\]\n]+\]\([^)\n]+\)/.test(line)) inlineMarkers.push('link')
    if (/(^|[^*\w])\*[^*\s][^*\n]*\*([^*\w]|$)/.test(line)) inlineMarkers.push('italic')
  }
  return { blockMarkers, inlineMarkers }
}

/**
 * 这段纯文本是否**应当走 Markdown 解析**。
 *
 * 判定顺序（P2 修正后）：
 *  1. **行内语法**（`**粗体**` / `[链接](url)`）—— 代码里几乎不会出现，出现即认为是 Markdown；
 *  2. 行首块级语法，但要求**结构性**证据：列表至少两行、围栏成对、引用/表格/分隔线/容器
 *     各自有明确形态；单独的 `# 注释` 或 `* 内容` **不算**（那是注释，不是 Markdown）。
 */
export function looksLikeMarkdown(text: string): boolean {
  const { blockMarkers, inlineMarkers } = collectMarkdownSignals(text)
  if (inlineMarkers.length > 0) return true
  // 列表：至少两行才当 Markdown（代码里的 `- xxx` 单行太常见）
  if (blockMarkers.filter((marker) => marker === 'list').length >= 2) return true
  // `### 标题` 这种多级标题：`##` 及以上几乎不会出现在注释里，直接认
  if (collectMarkdownSignals(text).blockMarkers.length === 0) return false
  if (/^\s{0,3}#{2,6}\s+\S/m.test(text.replace(/\r\n?/g, '\n'))) return true
  // 单个 `# 标题`：与 Python/Shell 的 `# 注释` 字符层面无法区分，
  // 只有**另有块级证据**（围栏/引用/表格/分隔线/容器）时才当 Markdown
  return blockMarkers.some((marker) => marker !== 'list' && marker !== 'heading')
}

/**
 * 把纯文本逐行转成等价的 DOM。
 *
 * 逐行处理，**不合并连续空行**：每个空行都产出一个空段落，因此"粘贴里有两个空行"
 * 在文档里就是两个空段落（旧的 `split(/\n{2,}/)` 会把 2 个、3 个空行压成同一种结果，
 * 属于信息丢失）。单换行产出一个硬换行；行首空格原样保留。
 */
export function textToDom(text: string): DocumentFragment {
  const template = document.createElement('template')
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let current: string[] = []
  const flush = (): void => {
    if (current.length === 0) return
    blocks.push(`<p>${current.map(escapeHtml).join('<br>')}</p>`)
    current = []
  }
  for (const line of lines) {
    if (line === '') {
      flush()
      blocks.push('<p></p>')
    } else {
      current.push(line)
    }
  }
  flush()
  template.innerHTML = blocks.join('')
  return template.content
}

/**
 * 在**捕获阶段**监听 `copy`：把"从代码块复制的文本"打上哨兵。
 *
 * 代码块内部是 CodeMirror，它会在自己的处理器里写剪贴板，ProseMirror 的
 * `handleDOMEvents.copy` 拿不到（冒泡阶段已经被处理完）。实测在编辑器根上挂
 * capture 监听可以抢在它前面：`event.defaultPrevented === false`、能读到
 * `clipboardData`、`preventDefault()` + `setData()` 后剪贴板里就是改写后的内容。
 *
 * 只处理"选区在代码块内"的情况，其它复制（正文、图片等）原样放行。
 */
function markCodeCopy(dom: HTMLElement): () => void {
  const onCopy = (event: ClipboardEvent): void => {
    const target = event.target as HTMLElement | null
    if (!target?.closest?.('.cm-content, .cm-editor')) return
    const data = event.clipboardData
    if (!data) return
    // 注意：**捕获阶段 `clipboardData` 是空的**（Chromium 只在 copy 事件里填充），
    // 所以不能想着"读出来再改写"；必须自己拿到文本后 `preventDefault` + `setData`。
    const text = readCodeText(target)
    if (!text) return
    // 去尾部换行：Electron 剪贴板会把行尾统一成 CRLF，留着尾部换行会让
    // "复制 → 粘贴"多一个空行，逐字比对就不相等了
    const normalized = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
    if (normalized.length === 0) return
    event.preventDefault()
    data.setData('text/plain', withDeskCodeSentinel(normalized))
  }
  dom.addEventListener('copy', onCopy, true)
  return () => dom.removeEventListener('copy', onCopy, true)
}

/**
 * 取代码区内**被选中的**文本。
 *
 * 优先走 CodeMirror 的内部状态（`.cm-content` 上有 `cmView`）：它能给出精确的
 * 行结构与选区，并且处理"没选任何东西"（此时按整段复制）。拿不到就退回 DOM 选区。
 */
function readCodeText(target: HTMLElement): string {
  const content = target.closest('.cm-content') as
    (HTMLElement & { cmView?: { view?: { state?: CodeMirrorStateLike } } }) | null
  const state = content?.cmView?.view?.state
  if (state?.doc && state.selection?.main) {
    const { from, to } = state.selection.main
    return state.doc.sliceString(from, to)
  }
  const selection = window.getSelection()
  return selection ? selection.toString() : ''
}

/** CodeMirror 状态的**最小**结构（只用到读文本所需的部分，避免直接依赖内部类型）。 */
interface CodeMirrorStateLike {
  doc: { sliceString(from: number, to: number): string; length: number }
  selection: { main: { from: number; to: number } }
}

export const clipboardNewline = $prose(
  () =>
    new Plugin({
      key: new PluginKey('DESK_CLIPBOARD_NEWLINES'),
      view: (view: EditorView) => {
        const detach = markCodeCopy(view.dom)
        return { destroy: detach }
      },
      props: {
        handlePaste: (view: EditorView, event: ClipboardEvent): boolean => {
          const clipboardData = event.clipboardData
          if (!clipboardData) return false
          if (!view.props.editable?.(view.state)) return false
          // 代码块内粘贴放行（交给 CodeMirror / 默认行为）
          if (view.state.selection.$from.parent.type.spec.code) return false

          const rawText = clipboardData.getData('text/plain')
          // 富文本、编辑器来源、空文本：都交回原有流程
          if (
            clipboardData.getData('text/html').length > 0 ||
            clipboardData.getData('vscode-editor-data').length > 0 ||
            rawText.length === 0
          ) {
            return false
          }
          // 应用内复制的**代码**：文本哨兵（不依赖剪贴板权限）或自定义类型任一命中，
          // 都绝不做 Markdown 解析
          const stripped = stripDeskCodeSentinel(rawText)
          const markedAsCode =
            stripped.isCode || clipboardData.getData(DESK_CODE_CLIPBOARD_TYPE).length > 0
          const text = stripped.text
          if (text.length === 0) return false
          // 外部纯文本：只有确实像 Markdown 才交回原有解析（保住既有能力）
          if (!markedAsCode && looksLikeMarkdown(text)) return false

          // 用 schema 自建 DOMParser：不依赖 clipboard 插件暴露 parser，
          // 也就不受插件顺序影响。preserveWhitespace 保住行首缩进。
          const parser = ProseDOMParser.fromSchema(view.state.schema)
          const slice = parser.parseSlice(textToDom(text), {
            preserveWhitespace: 'full'
          })
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
          return true
        }
      }
    })
)
