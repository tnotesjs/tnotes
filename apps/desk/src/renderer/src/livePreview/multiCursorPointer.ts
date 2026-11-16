/** 追加光标：⌥-click（左键 + Alt），与 VS Code 一致。⌘-click 不再追加。 */
export function addsCursorOnPointerDown(event: {
  altKey: boolean
  shiftKey: boolean
  button: number
}): boolean {
  return event.altKey && !event.shiftKey && event.button === 0
}

/**
 * 列选区：鼠标中键，或 ⇧⌥ 拖左键。
 * 单独的 ⌥-click 留给追加光标，不能再占用矩形选区。
 */
export function isColumnSelectionGesture(event: {
  altKey: boolean
  shiftKey: boolean
  button: number
}): boolean {
  return event.button === 1 || (event.altKey && event.shiftKey && event.button === 0)
}
