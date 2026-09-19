/**
 * 粘贴纯文本时保留行边界。
 *
 * 现象（真实界面复现）：从代码块复制多行内容粘到可视化正文，会变成
 * `const a = 1\n\nconst b = 2 indented const c = 3` —— **单个换行被折叠成空格**，
 * 缩进也丢了。
 *
 * 根因：Milkdown 的 clipboard 插件对"只有 text/plain、没有 text/html"的粘贴走
 * `markdown 解析 → DOM 序列化 → 再解析`，而 markdown 里**单换行是软换行**（渲染成
 * 空格），只有空行才算分段。行边界在这一步被吃掉。
 *
 * 修法：替换 clipboard 插件的 `handlePaste`（该插件没有配置钩子），其余分支保持原样：
 *  - 代码块内粘贴 → 放行；
 *  - `vscode-editor-data` 或带 text/html → 放行（富文本 / 编辑器粘贴语义不变）；
 *  - **只有纯文本时** → 不经过 markdown 解析，直接把文本按行结构转成 DOM 后交给
 *    ProseMirror 自己的解析器（单换行 = 硬换行、空行 = 段落、行首空格保留）。
 */

import { DOMParser as ProseDOMParser } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

import type { EditorView } from '@milkdown/kit/prose/view'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 把纯文本转成等价的 DOM：单换行 → `<br>`，空行 → 空段落。
 *
 * 用 DOM 表达行结构再交给编辑器的 parser，段落内与跨段落的信息都不会丢。
 */
export function textToDom(text: string): DocumentFragment {
  const template = document.createElement('template')
  const normalized = text.replace(/\r\n?/g, '\n')
  // 连续两个换行 = 段落分隔；单个换行 = 硬换行
  const paragraphs = normalized.split(/\n{2,}/)
  template.innerHTML = paragraphs
    .map((paragraph) => `<p>${paragraph.split('\n').map(escapeHtml).join('<br>')}</p>`)
    .join('')
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
