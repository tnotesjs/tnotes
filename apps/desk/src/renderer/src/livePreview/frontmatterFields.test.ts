import { describe, expect, it } from 'vitest'

import {
  frontmatterDescriptionChange,
  readFrontmatterFields,
  replaceFrontmatterDescription
} from './frontmatterFields'

const sample = ['---', 'id: abc-123', 'description: 简介', '---', '', '正文'].join('\n')

const folded = [
  '---',
  'id: abc-123',
  'description: >-',
  '  TNotes 是一套工具。知识库是独立 git 仓库，笔记是 notes/',
  '  下的平铺单文件。',
  '---',
  '',
  '正文'
].join('\n')

describe('frontmatterFields', () => {
  it('reads id and description', () => {
    expect(readFrontmatterFields(sample)).toEqual({ id: 'abc-123', description: '简介' })
  })

  it('reads folded description into one line of text', () => {
    expect(readFrontmatterFields(folded)).toEqual({
      id: 'abc-123',
      description: 'TNotes 是一套工具。知识库是独立 git 仓库，笔记是 notes/ 下的平铺单文件。'
    })
  })

  it('replaces only the description line', () => {
    const next = replaceFrontmatterDescription(sample, '新摘要')
    expect(next).toBe(['---', 'id: abc-123', 'description: 新摘要', '---', '', '正文'].join('\n'))
  })

  it('collapses a folded description block into one line', () => {
    const next = replaceFrontmatterDescription(folded, '新摘要')
    expect(next).toBe(['---', 'id: abc-123', 'description: 新摘要', '---', '', '正文'].join('\n'))
    const change = frontmatterDescriptionChange(folded, '新摘要')
    expect(change).toEqual({
      from: folded.indexOf('description:'),
      to: folded.indexOf('---', 4),
      insert: 'description: 新摘要\n'
    })
  })

  it('inserts description after id when missing', () => {
    const source = ['---', 'id: abc-123', '---', '', '正文'].join('\n')
    expect(replaceFrontmatterDescription(source, '补上')).toBe(
      ['---', 'id: abc-123', 'description: 补上', '---', '', '正文'].join('\n')
    )
  })

  it('leaves documents without frontmatter unchanged', () => {
    expect(replaceFrontmatterDescription('# 标题\n', 'x')).toBe('# 标题\n')
  })
})
