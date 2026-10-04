import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createSearchIndex,
  querySearchIndex,
  searchDocumentFingerprint,
  searchFingerprintSignature,
  searchSnippet,
  tokenizeSearchText
} from './searchModel'

import type { SearchIndexDocument } from './searchModel'

const documents: SearchIndexDocument[] = [
  {
    id: 'kb-a:note-a',
    knowledgeBaseId: 'kb-a',
    knowledgeBaseName: 'docs',
    noteUuid: 'note-a',
    noteIndex: '0038',
    fileName: '0038. 后台搜索索引',
    relPath: 'notes/0038. 后台搜索索引.md',
    title: '后台搜索索引',
    content: '# 后台搜索索引\n\nDesk 使用独立线程维护全文搜索，不阻塞编辑器。',
    revision: 'a'
  },
  {
    id: 'kb-b:note-b',
    knowledgeBaseId: 'kb-b',
    knowledgeBaseName: 'other',
    noteUuid: 'note-b',
    noteIndex: '0001',
    fileName: '0001. 编辑器说明',
    relPath: 'notes/0001. 编辑器说明.md',
    title: '编辑器说明',
    content: '这里也提到了搜索，但属于另一个知识库。',
    revision: 'b'
  }
]

describe('search model', () => {
  it('tokenizes Chinese and Latin words', () => {
    expect(tokenizeSearchText('Desk 后台搜索')).toEqual(
      expect.arrayContaining(['desk', '后台', '搜索'])
    )
  })

  it('searches title and content within one knowledge base', () => {
    const index = createSearchIndex(documents)
    expect(querySearchIndex(index, '后台搜索', 'kb-a')).toMatchObject([
      { knowledgeBaseId: 'kb-a', noteUuid: 'note-a', noteIndex: '0038' }
    ])
    expect(querySearchIndex(index, '搜索', 'kb-b')).toMatchObject([
      { knowledgeBaseId: 'kb-b', noteUuid: 'note-b' }
    ])
    expect(querySearchIndex(index, '0038. 后台', 'kb-a')).toMatchObject([
      { knowledgeBaseId: 'kb-a', noteUuid: 'note-a', fileName: '0038. 后台搜索索引' }
    ])
  })

  it('creates a compact plain-text excerpt', () => {
    expect(
      searchSnippet('## 标题\n\n这是 **正文** 和 [链接](https://example.com)。', '正文')
    ).toContain('这是 **正文**')
  })
})

describe('搜索缓存指纹', () => {
  const base = {
    id: 'kb:note-1',
    knowledgeBaseId: 'kb',
    knowledgeBaseName: 'kb',
    noteUuid: 'note-1',
    noteIndex: '0001',
    fileName: '0001. 旧标题.md',
    relPath: 'notes/0001. 旧标题.md',
    title: '旧标题',
    content: '# 旧标题\n',
    revision: 'rev-1'
  }

  it('正文不变但标题/文件名/编号变化时指纹必须变化', () => {
    const original = searchDocumentFingerprint(base)
    expect(searchDocumentFingerprint({ ...base, title: '新标题' })).not.toBe(original)
    expect(searchDocumentFingerprint({ ...base, fileName: '0001. 新标题.md' })).not.toBe(original)
    expect(searchDocumentFingerprint({ ...base, noteIndex: '0002' })).not.toBe(original)
    expect(searchDocumentFingerprint({ ...base, relPath: 'notes/0002. 旧标题.md' })).not.toBe(
      original
    )
    expect(searchDocumentFingerprint({ ...base })).toBe(original)
  })

  it('签名随指纹变化，并忽略文档顺序', () => {
    const first = { 'kb:a': searchDocumentFingerprint({ ...base, id: 'kb:a' }) }
    const second = { 'kb:b': searchDocumentFingerprint({ ...base, id: 'kb:b' }) }
    const renamed = {
      'kb:a': searchDocumentFingerprint({ ...base, id: 'kb:a', title: '改名后' })
    }
    expect(searchFingerprintSignature({ ...first, ...second })).toBe(
      searchFingerprintSignature({ ...second, ...first })
    )
    expect(searchFingerprintSignature(renamed)).not.toBe(searchFingerprintSignature(first))
  })
})

describe('搜索分词器复用', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('不再为每次分词新建 Intl.Segmenter', () => {
    const spy = vi.spyOn(Intl, 'Segmenter')
    tokenizeSearchText('中文 English 混排')
    tokenizeSearchText('第二次调用')
    expect(spy).not.toHaveBeenCalled()
  })

  it('按固定 locale 归一化大小写', () => {
    // zh-CN 下 'I' → 'i'；土耳其语环境会映射成 'ı'，固定 locale 才能保证跨机器一致
    expect(tokenizeSearchText('I')).toEqual(['i'])
    expect(tokenizeSearchText('FOO BAR')).toEqual(['foo', 'bar'])
  })
})
