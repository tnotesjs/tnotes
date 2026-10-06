const RESOURCE_SCHEME = /^[a-z][a-z\d+.-]*:/i

/**
 * Maps a note-local Markdown image to Desk's guarded asset protocol.
 *
 * Allowed: https://, http://, relative paths. Everything else is ignored.
 * The ProseMirror node keeps `source` unchanged; this URL is only used by its DOM view.
 */
export function resolveMarkdownImageUrl(
  source: string,
  knowledgeBaseId: string,
  noteUuid: string
): string {
  if (!source) return ''
  if (source.startsWith('https://') || source.startsWith('http://')) return source
  // Internal, executable and renderer-relative schemes must never be trusted from note text.
  if (RESOURCE_SCHEME.test(source) || source.startsWith('//') || source.startsWith('#')) return ''
  const params = new URLSearchParams({
    knowledgeBaseId,
    noteUuid,
    path: source.split(/[?#]/, 1)[0]
  })
  return `tnotes-asset://asset?${params.toString()}`
}
