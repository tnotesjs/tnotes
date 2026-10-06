import { inject, provide } from 'vue'

import type { InlineParseOptions } from '@tnotesjs/mindmap-core'
import type { InjectionKey } from 'vue'

/**
 * 当前导图的行内解析选项（链接引用定义等）。由 Mindmap.vue 按会话提供，
 * 大纲行、行内编辑器据此把 `[文字][id]` 渲染成链接、编辑后写回引用写法。
 */
const MINDMAP_INLINE_OPTIONS: InjectionKey<() => InlineParseOptions> =
  Symbol('mindmapInlineOptions')

const NO_OPTIONS = (): InlineParseOptions => ({})

export function provideMindmapInlineOptions(get: () => InlineParseOptions): void {
  provide(MINDMAP_INLINE_OPTIONS, get)
}

export function useMindmapInlineOptions(): () => InlineParseOptions {
  return inject(MINDMAP_INLINE_OPTIONS, NO_OPTIONS)
}
