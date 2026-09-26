import {
  Editor,
  EditorStatus,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx
} from '@milkdown/kit/core'
import { block } from '@milkdown/kit/plugin/block'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { history } from '@milkdown/kit/plugin/history'
import { indent, indentConfig } from '@milkdown/kit/plugin/indent'
import { listener } from '@milkdown/kit/plugin/listener'
import { trailing } from '@milkdown/kit/plugin/trailing'
import { upload } from '@milkdown/kit/plugin/upload'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { getMarkdown } from '@milkdown/kit/utils'

import {
  blockEdit,
  type BlockEditFeatureConfig,
  type DeskBlockEditFeatures
} from './crepePort/blockEdit'
import { codeMirror, type DeskCodeMirrorConfig } from './crepePort/codemirror'
import { cursor } from './crepePort/cursor'
import { latex, type LatexFeatureConfig } from './crepePort/latex'
import { linkTooltip } from './crepePort/linktooltip'
import { listItem } from './crepePort/listitem'
import { placeholder, type DeskPlaceholderConfig } from './crepePort/placeholder'
import { table } from './crepePort/table'
import { toolbar, type ToolbarFeatureConfig } from './crepePort/toolbar'
import { type DeskToolbarFeatures } from './crepePort/toolbar/features'
import { applyDeskEditorConfigs, type DeskEditorConfigOptions } from './deskEditorConfigs'
import { clipboardNewline } from './clipboardNewline'
import { headingKeymap } from './headingKeymap'
import { listBackspaceKeymap } from './listBackspaceKeymap'

/**
 * Desk 的编辑器装配（替代 `@milkdown/crepe` 的 `Crepe` 类；crepe 依赖已移除）。
 *
 * 这里复刻的是 Crepe `lib/esm/builder.js` 里那套基座装配：
 *   `Editor.make().config(root/defaultValue/editable/indent=4).use(commonmark, listener,
 *   history, indent, trailing, clipboard, upload, gfm)`
 * 外加 Crepe 各 feature：kit 直供的部分（code block / list item / table / link tooltip /
 * cursor / placeholder / block handle）与从 Crepe 移植的部分（latex、斜杠菜单、选区工具条），
 * 全部见 `crepePort/`（MIT 移植，附来源）。可视化编辑器已经走这条装配，Crepe 只剩出处注释。
 *
 * 与 Crepe 的语义对齐点：`getMarkdown()` = `editor.action(getMarkdown())`、
 * `setReadonly()` = 闭包可编辑标记 + `view.setProps({ editable })`、`destroy()` =
 * `editor.destroy()`。
 */
export interface DeskEditorOptions extends DeskEditorConfigOptions {
  root: HTMLElement
  defaultValue: string
  /** Desk 的代码块配置（语言、CodeMirror 扩展、主题、复制按钮文案等）。 */
  codeBlock: DeskCodeMirrorConfig
  placeholder?: DeskPlaceholderConfig
  /** 行内/块级公式（`math_inline`、`$$` 代码块预览、KaTeX 选项）。 */
  latex?: LatexFeatureConfig
  /** 斜杠菜单 / 块手柄（与 Crepe 装配共用 `createDeskBlockEditConfig` 的产物）。 */
  blockEdit?: BlockEditFeatureConfig
  /** 斜杠菜单里按 feature 显隐的项（默认 latex 开、image-block 关、table 开，与生产一致）。 */
  blockEditFeatures?: DeskBlockEditFeatures
  /** 选区格式工具条（图标/文案/自定义项）。 */
  toolbar?: ToolbarFeatureConfig
  /** 工具条里按 feature 显隐的项（默认 latex 开、ai 关 —— Desk 没有 AI）。 */
  toolbarFeatures?: DeskToolbarFeatures
  /**
   * 选区浮动工具条开关。实时预览编辑器不用它，设置里也不再提供。
   * 做成 getter：调用方改值后立即生效，不必重建编辑器。默认关闭。
   */
  selectionToolbar?: () => boolean
}

export interface DeskEditorHandle {
  /** Milkdown `Editor`：Desk 自己的插件都挂在它上面。 */
  editor: Editor
  create(): Promise<void>
  getMarkdown(): string
  setReadonly(value: boolean): void
  destroy(): Promise<void>
}

export function createDeskEditor(options: DeskEditorOptions): DeskEditorHandle {
  let editable = !options.isReadOnly()

  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, options.root)
      ctx.set(defaultValueCtx, options.defaultValue)
      ctx.set(editorViewOptionsCtx, { editable: () => editable })
      ctx.update(indentConfig.key, (value) => ({ ...value, size: 4 }))
    })
    .use(commonmark)
    .use(listener)
    .use(history)
    .use(indent)
    .use(trailing)
    // clipboardNewline 必须在 clipboard **之前**：带 text/plain 的粘贴在 ProseMirror
    // 里只认**第一个返回 true** 的 handlePaste，而 clipboard 插件的纯文本分支会先
    // 把文本当 markdown 解析（单换行被折叠成空格）。插件顺序 = 注册顺序。
    .use(clipboardNewline)
    .use(clipboard)
    .use(upload)
    // 标题里按一次 Backspace 直接回正文（语雀对齐），覆盖 Milkdown 的逐级降级
    .use(headingKeymap)
    .use(listBackspaceKeymap)
    // 标题里按一次 Backspace 直接回正文（语雀对齐），覆盖 Milkdown 的逐级降级
    // 标题里按一次 Backspace 直接回正文（语雀对齐），覆盖 Milkdown 的逐级降级
    .use(gfm)
    .use(block)

  // 序列化选项、删除线快捷键、块手柄过滤、图片上传：与生产装配共用同一份配置。
  applyDeskEditorConfigs(editor, options)

  codeMirror(editor, options.codeBlock)
  listItem(editor)
  table(editor)
  linkTooltip(editor)
  cursor(editor)
  placeholder(editor, { config: options.placeholder, isReadOnly: options.isReadOnly })
  latex(editor, options.latex)
  blockEdit(editor, options.blockEdit, options.blockEditFeatures)
  toolbar(editor, options.toolbar, options.toolbarFeatures, {
    isEnabled: options.selectionToolbar ?? (() => false)
  })

  return {
    editor,
    create: async () => {
      await editor.create()
    },
    getMarkdown: () => editor.action(getMarkdown()),
    setReadonly: (value) => {
      editable = !value
      if (editor.status === EditorStatus.Created) {
        editor.action((ctx) => ctx.get(editorViewCtx).setProps({ editable: () => editable }))
      }
    },
    destroy: async () => {
      await editor.destroy()
    }
  }
}
