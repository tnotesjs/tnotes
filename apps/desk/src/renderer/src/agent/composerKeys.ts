/** 中文输入法选词时的回车不能发送。 */
export function shouldSendOnEnter(event: {
  key: string
  shiftKey: boolean
  isComposing: boolean
  keyCode?: number
}): boolean {
  if (event.isComposing || event.keyCode === 229) return false
  return event.key === 'Enter' && !event.shiftKey
}
