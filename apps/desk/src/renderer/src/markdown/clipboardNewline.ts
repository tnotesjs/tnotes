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
 * 这段纯文本是否**看起来像 Markdown**（命中任一"行首 Markdown 标记"就认为像）。
 *
 * 命中时交回原有的 Markdown 解析路径，从而保住"粘贴 markdown 文本 → 得到标题/列表/
 * 围栏代码块"的既有能力。代码（`const a = 1`、缩进、`}` 之类）通常不命中，
 * 于是走保留行边界的路径。
 */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return lines.some((line) => {
    if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) return true // ATX 标题
    if (/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/.test(line)) return true // 列表项
    if (/^\s{0,3}>/.test(line)) return true // 引用
    if (/^\s{0,3}(?:```|~~~)/.test(line)) return true // 围栏代码块
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true // 分隔线
    if (/^\s{0,3}\|.*\|\s*$/.test(line)) return true // 表格行
    if (/^\s{0,3}:{2,}\s*\S/.test(line)) return true // 容器语法 `::: note`
    return false
  })
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
          // 看起来是 Markdown 的文本交回原有 Markdown 解析（保住既有能力）
          if (looksLikeMarkdown(text)) return false

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
