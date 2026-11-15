/** 笔记在部署站点上的页面：`{站点}/notes/{不补零的编号}`，不是站点首页。 */
export function notePageUrl(pageUrl: string | undefined, noteIndex: string): string | null {
  const base = pageUrl?.trim().replace(/\/+$/, '')
  if (!base || !/^https?:\/\//i.test(base)) return null
  const index = Number(noteIndex)
  if (!Number.isInteger(index) || index < 1 || index > 9999) return null
  return `${base}/notes/${index}`
}

/** 笔记在 GitHub 上的文件页：`{仓库}/blob/main/notes/…md`，不是仓库首页。 */
export function noteGithubFileUrl(
  repositoryUrl: string | undefined,
  dirName: string | undefined
): string | null {
  const base = repositoryUrl
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  if (!base || !/^https?:\/\//i.test(base)) return null
  const stem = dirName?.trim()
  if (!stem) return null
  const path = ['notes', `${stem}.md`].map((part) => encodeURIComponent(part)).join('/')
  return `${base}/blob/main/${path}`
}
