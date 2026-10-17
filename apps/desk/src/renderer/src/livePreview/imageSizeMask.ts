/** 蒙版大约能放下 `1234 x 1234` 的最小渲染框。 */
export const IMAGE_SIZE_MASK_MIN_WIDTH = 88
export const IMAGE_SIZE_MASK_MIN_HEIGHT = 32

export function syncImageSizeMask(frame: HTMLElement): void {
  const rect = frame.getBoundingClientRect()
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  const existing = frame.querySelector<HTMLElement>(':scope > .cm-lp-image-size')
  if (width < IMAGE_SIZE_MASK_MIN_WIDTH || height < IMAGE_SIZE_MASK_MIN_HEIGHT) {
    existing?.remove()
    return
  }
  const mask = existing ?? document.createElement('span')
  mask.className = 'cm-lp-image-size'
  mask.textContent = `${width} x ${height}`
  if (!existing) frame.append(mask)
}

export function clearImageSizeMask(frame: HTMLElement): void {
  frame.querySelector(':scope > .cm-lp-image-size')?.remove()
}
