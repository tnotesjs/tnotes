/** 在笔记全文里定位唯一一段原文。对不上就拒绝，不猜测。 */
export function locateUniqueReplace(
  content: string,
  oldString: string
): { from: number; to: number } | { error: string } {
  if (!oldString) return { error: '要替换的原文不能是空的' }
  const first = content.indexOf(oldString)
  if (first < 0) return { error: '笔记里没有这段原文' }
  if (content.indexOf(oldString, first + oldString.length) >= 0) {
    return { error: '这段原文出现了多次，需要带上更多上下文，让它只匹配一处' }
  }
  return { from: first, to: first + oldString.length }
}
