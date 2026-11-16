/** 去掉每一行行尾的空格和制表符，保留换行。 */
export function stripTrailingWhitespace(content: string): string {
  return content.replace(/[ \t]+$/gm, '')
}

/** 未显式关闭时，保存前去掉行尾空白。 */
export function contentForSave(
  content: string,
  trimTrailingWhitespace: boolean | undefined
): string {
  if (trimTrailingWhitespace === false) return content
  return stripTrailingWhitespace(content)
}
