import { createHash } from 'node:crypto'

import MiniSearch from 'minisearch'

import type { SearchResultDto } from '../shared/contracts'

export interface SearchIndexDocument {
  id: string
  knowledgeBaseId: string
  knowledgeBaseName: string
  noteUuid: string
  noteIndex: string
  fileName: string
  /** POSIX path relative to the knowledge-base root. */
  relPath: string
  title: string
  content: string
  revision: string
}

/**
 * 缓存签名必须覆盖索引里所有会被检索或展示的字段。此前只用正文哈希，导致重命名
 * 笔记 / 改标题（正文不变）时命中旧缓存并跳过重建，fileName/title/noteIndex 一直是
 * 旧值，落盘后重启依旧陈旧。
 */
export function searchDocumentFingerprint(document: SearchIndexDocument): string {
  return [
    document.revision,
    document.fileName,
    document.title,
    document.noteIndex,
    document.relPath
  ].join('\u0000')
}

export function searchFingerprintSignature(fingerprints: Record<string, string>): string {
  const hash = createHash('sha256')
  for (const id of Object.keys(fingerprints).sort()) {
    hash.update(id)
    hash.update('\0')
    hash.update(fingerprints[id] ?? '')
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * MiniSearch 会对每个文档的每个字段调用一次 tokenize；每次新建 Intl.Segmenter
 * 是纯浪费（构建期 N×4 次分配）。同时固定 locale：不写参数的 toLocaleLowerCase
 * 会随系统 locale 变化，土耳其语环境下大小写映射会改变字符串长度，令摘要偏移错位、
 * 跨环境缓存也无法复用。
 */
const SEARCH_LOCALE = 'zh-CN'
const searchSegmenter = new Intl.Segmenter([SEARCH_LOCALE, 'en'], { granularity: 'word' })

export function tokenizeSearchText(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase(SEARCH_LOCALE)
  return [...searchSegmenter.segment(normalized)]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment.trim())
    .filter(Boolean)
}

export function searchOptions(): ConstructorParameters<typeof MiniSearch<SearchIndexDocument>>[0] {
  return {
    fields: ['fileName', 'title', 'noteIndex', 'content'],
    storeFields: [
      'knowledgeBaseId',
      'knowledgeBaseName',
      'noteUuid',
      'noteIndex',
      'fileName',
      'title',
      'relPath',
      'content'
    ],
    tokenize: tokenizeSearchText,
    processTerm: (term) => term.normalize('NFKC').toLocaleLowerCase(SEARCH_LOCALE)
  }
}

export function createSearchIndex(
  documents: SearchIndexDocument[]
): MiniSearch<SearchIndexDocument> {
  const index = new MiniSearch<SearchIndexDocument>(searchOptions())
  index.addAll(documents)
  return index
}

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[\s>#+*\-|]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function searchSnippet(content: string, query: string, maximumLength = 180): string {
  const text = plainText(content)
  if (!text) return ''
  const terms = tokenizeSearchText(query)
  const lower = text.toLocaleLowerCase()
  const positions = terms
    .map((term) => lower.indexOf(term.toLocaleLowerCase()))
    .filter((position) => position >= 0)
  const matchPosition = positions.length ? Math.min(...positions) : 0
  const start = Math.max(0, matchPosition - Math.floor(maximumLength * 0.28))
  const excerpt = text.slice(start, start + maximumLength).trim()
  return `${start > 0 ? '…' : ''}${excerpt}${start + maximumLength < text.length ? '…' : ''}`
}

export function querySearchIndex(
  index: MiniSearch<SearchIndexDocument>,
  query: string,
  knowledgeBaseId: string | null,
  limit = 40
): SearchResultDto[] {
  const normalized = query.trim()
  if (!normalized) return []
  return index
    .search(normalized, {
      boost: { fileName: 6, title: 4, noteIndex: 5, content: 1 },
      combineWith: 'AND',
      prefix: true,
      fuzzy: (term) => (term.length >= 5 ? 0.16 : false),
      filter: (result) => !knowledgeBaseId || result.knowledgeBaseId === knowledgeBaseId
    })
    .slice(0, Math.max(1, Math.min(limit, 100)))
    .map((result) => ({
      knowledgeBaseId: result.knowledgeBaseId as string,
      knowledgeBaseName: result.knowledgeBaseName as string,
      noteUuid: result.noteUuid as string,
      noteIndex: result.noteIndex as string,
      fileName: result.fileName as string,
      relPath: (result.relPath as string) ?? '',
      title: result.title as string,
      snippet: searchSnippet(result.content as string, normalized),
      score: result.score
    }))
}
