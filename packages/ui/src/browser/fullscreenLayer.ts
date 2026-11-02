/**
 * CSS 全屏层的文档级标记。
 *
 * 全屏层（mindmap / mermaid / Desk 代码块）往往嵌在编辑器的层叠上下文里，z-index
 * 盖不过应用壳。宿主据 `body[data-tn-fullscreen]` 隐藏壳层，再用
 * `[data-tn-fullscreen-layer]` 把全屏层本身显示回来；DOM 不搬家，编辑器 widget 不会重建。
 */
export function setFullscreenLayer(el: HTMLElement | null | undefined, on: boolean): void {
  if (typeof document === 'undefined') return
  if (el) {
    if (on) el.dataset.tnFullscreenLayer = ''
    else delete el.dataset.tnFullscreenLayer
  }
  if (document.querySelector('[data-tn-fullscreen-layer]')) document.body.dataset.tnFullscreen = ''
  else delete document.body.dataset.tnFullscreen
}
