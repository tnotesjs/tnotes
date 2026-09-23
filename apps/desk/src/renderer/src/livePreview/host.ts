import { Facet } from '@codemirror/state'

/** 编辑器宿主（Vue 组件）提供给显示层的能力：解析资源地址、打开链接。 */
export interface LivePreviewHost {
  resolveImage(src: string): string
  openLink(href: string): void
}

export const livePreviewHost = Facet.define<LivePreviewHost, LivePreviewHost>({
  combine: (values) =>
    values[values.length - 1] ?? {
      resolveImage: (src) => (src.startsWith('https://') || src.startsWith('data:') ? src : ''),
      openLink: () => undefined
    }
})

/** 是否处于可视化（实时预览）模式；源码模式下显示层不产生任何装饰。 */
export const livePreviewEnabled = Facet.define<boolean, boolean>({
  combine: (values) => (values.length === 0 ? true : values[values.length - 1])
})
