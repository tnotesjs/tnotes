import {
  editorViewOptionsCtx,
  remarkPluginsCtx,
  remarkStringifyOptionsCtx,
  type Editor
} from '@milkdown/kit/core'
import { blockConfig } from '@milkdown/kit/plugin/block'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import { strikethroughKeymap } from '@milkdown/kit/preset/gfm'

import { serializeDeskCalloutMdast } from '../editor/markdown/deskCallout'
import { breakMarkdown, remarkHtmlBreakToBreak } from '../editor/markdown/htmlBreak'
import { resolvePastedImageWidth } from '../editor/markdown/pasteImageWidth'
import { canShowBlockHandle } from './blockActionMenu'
import { stripContainerPasteContext } from './pasteContext'

export interface DeskEditorConfigOptions {
  /** 有效只读状态（props.readOnly || mode === 'readonly'）。 */
  isReadOnly: () => boolean
  /** 图片落盘（粘贴 / 拖拽上传）。 */
  uploadImage: (file: File) => Promise<{ src: string }>
}

/**
 * 编辑器的共享配置：序列化选项、删除线快捷键、块手柄过滤、图片上传。
 *
 * 抽成独立模块是为了让**生产装配与 canonical 快照测试用同一份配置** —— 否则快照
 * 测的是另一套序列化行为，「新旧装配字节一致」这个等价性论证就没有意义。
 *
 * 这些配置原先内联在 `MilkdownMarkdownEditor.vue` 里，迁移到 self-assembled 编辑器
 * 时原样搬过来（行为不变）。
 */
export function applyDeskEditorConfigs(editor: Editor, options: DeskEditorConfigOptions): void {
  editor.config((ctx) => {
    // Match the source editor and the shortcut shown in Desk's toolbar/settings.
    // Keep Milkdown's original binding available for existing users as well.
    ctx.update(strikethroughKeymap.key, (current) => ({
      ...current,
      ToggleStrikethrough: {
        ...current.ToggleStrikethrough,
        shortcuts: ['Mod-Shift-x', 'Mod-Alt-x']
      }
    }))
    ctx.update(blockConfig.key, (current) => ({
      ...current,
      filterNodes: (position, node) =>
        canShowBlockHandle(node) && current.filterNodes(position, node)
    }))
    // 行内 <br>（含表格单元格）解析成硬换行，并记住原始拼写（见 htmlBreak.ts）。
    ctx.update(remarkPluginsCtx, (plugins) => [
      ...plugins,
      { plugin: remarkHtmlBreakToBreak, options: {} }
    ])
    // Prefer GitHub / TNotes style list markers (`-`) over remark's default `*`.
    ctx.update(remarkStringifyOptionsCtx, (current) => ({
      ...current,
      bullet: '-' as const,
      bulletOther: '*' as const,
      /**
       * 分割线统一写 `---`（`mdast-util-to-markdown` 的 `rule` 选项，默认 `*`）。
       *
       * 不指定时斜杠菜单插入的分割线会序列化成 `***`，与仓库里既有的写法（以及
       * Prettier `parser: markdown` 的输出）不一致；`---`/`***`/`___` 三种写法**解析**
       * 都继续兼容（micromark 层面就支持），这里只改**输出**。
       * 前后空行由 mdast-util-to-markdown 的 join/unsafe 机制按**节点树**决定（与原始
       * 输入无关），所以不会因为换成 `-` 就把分割线写成 Setext 标题，也不会贴到
       * frontmatter 上 —— canonical 快照用例覆盖这些边界。
       */
      rule: '-' as const,
      handlers: {
        ...current.handlers,
        deskCallout: serializeDeskCalloutMdast,
        // 来自行内 <br> 的硬换行写回原拼写；普通硬换行沿用 mdast-util-to-markdown 的默认行为。
        // 逻辑在 htmlBreak.ts 的纯函数里（可单测），这里按上下文的 Handle 类型内联。
        break: (node, _parent, state, info) =>
          breakMarkdown(node?.data, state.stack, state.unsafe, info.before ?? '')
      }
    }))
    // 粘贴时别把「复制时所在的提示块」一起还原回来（规则见 pasteContext.ts）。
    ctx.update(editorViewOptionsCtx, (current) => ({
      ...current,
      transformPastedHTML: (html, view) => {
        const previous = current.transformPastedHTML
          ? current.transformPastedHTML(html, view)
          : html
        return stripContainerPasteContext(previous)
      }
    }))
    ctx.update(uploadConfig.key, (current) => ({
      ...current,
      enableHtmlFileUploader: true,
      // Milkdown's upload plugin keeps a mapped placeholder in the document,
      // so edits made while the image uploads cannot stale the insertion point.
      uploader: async (files, schema) => {
        if (options.isReadOnly()) return []
        const imageType = schema.nodes.image
        if (!imageType) return []
        const images = [...files].filter((file) => file.type.startsWith('image/'))
        return Promise.all(
          images.map(async (file) => {
            const uploaded = await options.uploadImage(file)
            return imageType.create({
              src: uploaded.src,
              alt: '',
              width: await resolvePastedImageWidth(file)
            })
          })
        )
      }
    }))
  })
}
