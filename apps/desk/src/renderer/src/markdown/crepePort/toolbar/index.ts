/**
 * 移植自 `@milkdown/crepe@7.22.1` 的 `src/feature/toolbar/**`（MIT）。
 *
 * 改动：去掉 Crepe 的 `FeaturesCtx`/`CrepeCtx` 与 `DefineFeature` 类型；把「latex / ai
 * 是否开启」从 Crepe 的 feature 登记表改成显式参数（见 `./features`，Desk 默认 ai:false
 * —— 「Ask AI」按钮连同它依赖的 palette/tooltip 一并移除）；额外导出 `toolbarTooltip`
 * 以便验收断言「工具条视图已注册」，并加一个 `ToolbarRuntimeOptions.isEnabled` 开关
 * （Desk 设置项「选区浮动工具条」，默认关闭）。其余（`.milkdown-toolbar` 容器、TooltipProvider 的
 * `shouldShow` 判定、图标/文案/快捷键解析）原样保留。
 */
import type { Ctx } from '@milkdown/kit/ctx'
import type {
  EditorState,
  PluginView,
  Selection,
} from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

import { TooltipProvider, tooltipFactory } from '@milkdown/kit/plugin/tooltip'
import { TextSelection } from '@milkdown/kit/prose/state'
import { $ctx } from '@milkdown/kit/utils'
import { createApp, ref, shallowRef, type App, type ShallowRef } from 'vue'

import { EditorStatus, type Editor } from '@milkdown/kit/core'
import type { GroupBuilder } from '../utils'

import {
  DEFAULT_DESK_TOOLBAR_FEATURES,
  type DeskToolbarFeatures
} from './features'
import type { ToolbarItem } from './config'

import { Toolbar } from './component'

export { keymapRef } from '../utils/keyboard-shortcut'
export type { KeymapRef } from '../utils/keyboard-shortcut'
export type { ToolbarItem } from './config'

interface ToolbarConfig {
  boldIcon: string
  codeIcon: string
  italicIcon: string
  linkIcon: string
  strikethroughIcon: string
  latexIcon: string
  /// Accessible names for the built-in items, for localization. Each defaults to
  /// its English label.
  boldLabel: string
  codeLabel: string
  italicLabel: string
  linkLabel: string
  strikethroughLabel: string
  latexLabel: string
  buildToolbar: (builder: GroupBuilder<ToolbarItem>) => void
}

export type ToolbarFeatureConfig = Partial<ToolbarConfig>

/**
 * 工具条的运行时开关（与内容配置 `ToolbarFeatureConfig` 分开，避免混进
 * `getGroups()` 读的那份图标/文案配置）。
 */
export interface ToolbarRuntimeOptions {
  /**
   * 选区浮动工具条是否启用。返回 false 时 `shouldShow` 直接为 false：工具条既不显示
   * （`data-show` 保持 `false`，CSS `display:none`），也就不会留下拦截指针事件的浮层。
   *
   * 做成 getter 而不是布尔值：设置面板改开关后立即生效，不必重建编辑器。
   * 缺省视为启用（调用方自己决定默认值；Desk 生产装配默认关闭）。
   */
  isEnabled?: () => boolean
}

export const toolbarTooltip = tooltipFactory('CREPE_TOOLBAR')

/**
 * 由 `ToolbarView` 在装配时登记的控制柄：让外部能立即收起浮条。
 * （与 `toolbarTooltip` 分开，免得往 ProseMirror 的 plugin spec 里塞非 plugin 字段。）
 */
const selectionToolbarControl = $ctx(
  null as { hide: () => void } | null,
  'CREPE_TOOLBAR_CONTROL'
)

/**
 * 立即收起选区浮条，不等下一次编辑器更新。
 *
 * 设置面板把开关关掉时需要它：`shouldShow` 只在编辑器更新时被调用，如果只靠它，
 * 上一次选区留下的浮条会一直挂到下一次编辑器交互，这期间它仍然会拦截指针事件。
 */
export function hideSelectionToolbar(editor: Editor): void {
  if (editor.status !== EditorStatus.Created) return
  editor.action((ctx) => ctx.get(selectionToolbarControl.key)?.hide())
}

class ToolbarView implements PluginView {
  #tooltipProvider: TooltipProvider
  #content: HTMLElement
  #app: App
  #selection: ShallowRef<Selection>
  #show = ref(false)

  constructor(
    ctx: Ctx,
    view: EditorView,
    config?: ToolbarFeatureConfig,
    features: DeskToolbarFeatures = DEFAULT_DESK_TOOLBAR_FEATURES,
    runtime?: ToolbarRuntimeOptions
  ) {
    const isEnabled = runtime?.isEnabled ?? (() => true)
    const content = document.createElement('div')
    content.className = 'milkdown-toolbar'
    this.#selection = shallowRef(view.state.selection)
    const app = createApp(Toolbar, {
      ctx,
      hide: this.hide,
      config,
      features,
      selection: this.#selection,
      show: this.#show,
    })
    app.mount(content)
    this.#content = content
    this.#app = app

    this.#tooltipProvider = new TooltipProvider({
      content: this.#content,
      debounce: 20,
      offset: 10,
      shouldShow(view: EditorView) {
        // 开关关闭时直接否决：TooltipProvider 会走 hide()，浮层停在 display:none。
        if (!isEnabled()) return false

        const { doc, selection } = view.state
        const { empty, from, to } = selection

        const isEmptyTextBlock =
          !doc.textBetween(from, to).length &&
          selection instanceof TextSelection

        const isNotTextBlock = !(selection instanceof TextSelection)

        const activeElement = (view.dom.getRootNode() as ShadowRoot | Document)
          .activeElement
        const isTooltipChildren = content.contains(activeElement)

        const notHasFocus = !view.hasFocus() && !isTooltipChildren

        const isReadonly = !view.editable

        if (
          notHasFocus ||
          isNotTextBlock ||
          empty ||
          isEmptyTextBlock ||
          isReadonly
        )
          return false

        return true
      },
    })
    this.#tooltipProvider.onShow = () => {
      this.#show.value = true
    }
    this.#tooltipProvider.onHide = () => {
      this.#show.value = false
    }
    this.update(view)
  }

  update = (view: EditorView, prevState?: EditorState) => {
    this.#tooltipProvider.update(view, prevState)
    this.#selection.value = view.state.selection
  }

  destroy = () => {
    this.#tooltipProvider.destroy()
    this.#app.unmount()
    this.#content.remove()
  }

  hide = () => {
    this.#tooltipProvider.hide()
  }
}

export function toolbar(
  editor: Editor,
  config?: ToolbarFeatureConfig,
  features: DeskToolbarFeatures = DEFAULT_DESK_TOOLBAR_FEATURES,
  runtime?: ToolbarRuntimeOptions
): void {
  editor
    .config((ctx) => {
      ctx.set(toolbarTooltip.key, {
        view: (view) => {
          const instance = new ToolbarView(ctx, view, config, features, runtime)
          // 注册「立即收起」控制柄，供 hideSelectionToolbar 使用。
          ctx.set(selectionToolbarControl.key, { hide: instance.hide })
          return instance
        }
      })
    })
    .use(selectionToolbarControl)
    .use(toolbarTooltip)
}
