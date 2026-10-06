/**
 * WordList 勾选态的 localStorage 键。
 *
 * - SSG：一页一个 pathname，不传作用域，沿用 `${pathname}-${word}`（兼容已存的勾选记录）。
 * - Desk：所有笔记共用同一个 index.html，pathname 固定，必须由宿主注入笔记维度的作用域
 *   （见 {@link deskWordListStorageScope}），否则勾选态会在笔记之间串用。
 */
export function wordListStorageKey(
  storageScope: string | null | undefined,
  pathname: string,
  word: string
): string {
  const scope = storageScope ? storageScope : pathname
  return `${scope}-${word}`
}

/** Desk 的作用域：知识库 + 笔记 uuid。缺任一项时返回空串，由组件退回 pathname。 */
export function deskWordListStorageScope(knowledgeBaseId: string, noteUuid: string): string {
  if (!knowledgeBaseId || !noteUuid) return ''
  return `tnotes-desk:word-list:${knowledgeBaseId}:${noteUuid}`
}
