export function noteFileName(note: {
  noteIndex: string
  title: string
  fileName?: string | null
  dirName?: string | null
}): string {
  const real = note.fileName?.trim() || note.dirName?.trim()
  if (real) return real.replace(/\.md$/i, '')
  return `${note.noteIndex}. ${note.title}`
}

/** 把「0012. 标题」拆成可淡化的编号和标题。编号对不上时整段当标题。 */
export function noteLabelParts(
  label: string,
  noteIndex: string
): { index: string; title: string } {
  const stem = label.replace(/\.md$/i, '').trim()
  const index = noteIndex.trim()
  if (!index || !stem.startsWith(index)) return { index: '', title: stem }
  const title = stem.slice(index.length).replace(/^[.\s]+/, '')
  if (!title) return { index: '', title: stem }
  return { index: `${index}.`, title }
}

/** 知识库内相对路径 → 相对当前工作区根目录的路径。 */
export function workspaceRelativePath(
  workspacePath: string | null | undefined,
  knowledgeBaseRoot: string | null | undefined,
  relPath: string | null | undefined
): string {
  const notePath = relPath?.replace(/\\/g, '/').replace(/^\/+/, '') ?? ''
  if (!notePath) return ''
  const root = knowledgeBaseRoot?.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = workspacePath?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root || !base) return notePath
  const absolute = `${root}/${notePath}`
  if (absolute.startsWith(`${base}/`)) return absolute.slice(base.length + 1)
  return notePath
}
