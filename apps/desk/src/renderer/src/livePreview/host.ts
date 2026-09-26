import { Facet } from '@codemirror/state'

/** 编辑器宿主（Vue 组件）提供给显示层的能力：解析资源地址、打开链接、打开画板/导图。 */
export interface LivePreviewHost {
  resolveImage(src: string): string
  openLink(href: string): void
  knowledgeBaseId: string
  noteUuid: string
  /** 笔记在知识库内的相对路径；画布探测需要它把图片 src 还原成 assets/… */
  noteRelPath: string
  isReadOnly(): boolean
  openCanvas(sourceRelPath: string): void
  openMindmap(fenceSource: string): void
}

export const livePreviewHost = Facet.define<LivePreviewHost, LivePreviewHost>({
  combine: (values) =>
    values[values.length - 1] ?? {
      resolveImage: (src) => (src.startsWith('https://') || src.startsWith('data:') ? src : ''),
      openLink: () => undefined,
      knowledgeBaseId: '',
      noteUuid: '',
      noteRelPath: '',
      isReadOnly: () => false,
      openCanvas: () => undefined,
      openMindmap: () => undefined
    }
})

/** 是否处于可视化（实时预览）模式。源码模式不画预览装饰；行号和标题折叠在源码槽里。 */
export const livePreviewEnabled = Facet.define<boolean, boolean>({
  combine: (values) => (values.length === 0 ? true : values[values.length - 1])
})
