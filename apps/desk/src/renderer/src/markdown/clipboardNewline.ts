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
export const DESK_CODE_CLIPBOARD_TYPE = 'application/x-desk-code'

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

export const clipboardNewline = $prose(
  () =>
    new Plugin({
      key: new PluginKey('DESK_CLIPBOARD_NEWLINES'),
      props: {
        handlePaste: (view: EditorView, event: ClipboardEvent): boolean => {
          const clipboardData = event.clipboardData
          if (!clipboardData) return false
          if (!view.props.editable?.(view.state)) return false
          // 代码块内粘贴放行（交给 CodeMirror / 默认行为）
          if (view.state.selection.$from.parent.type.spec.code) return false

          const text = clipboardData.getData('text/plain')
          // 富文本、编辑器来源、空文本：都交回原有流程
          if (
            clipboardData.getData('text/html').length > 0 ||
            clipboardData.getData('vscode-editor-data').length > 0 ||
            text.length === 0
          ) {
            return false
          }
          // 应用内复制的**代码**：带明确来源标记，绝不做 Markdown 解析
          const markedAsCode = clipboardData.getData(DESK_CODE_CLIPBOARD_TYPE).length > 0
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
