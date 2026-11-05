import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createKnowledgeBase,
  DOCS_SITE_URL,
  isKnowledgeBaseRoot,
  STARTER_NOTE_TITLE
} from '../src/create'
import { CANONICAL_GITATTRIBUTES, CANONICAL_GITIGNORE } from '../src/scaffold'
import { createWorkspace } from '../src/workspace'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function makeParent(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-create-'))
  cleanups.push(async () => fs.rm(root, { recursive: true, force: true }))
  return root
}

describe('isKnowledgeBaseRoot', () => {
  it('requires a tnotes.json file', async () => {
    const parent = await makeParent()
    const kb = path.join(parent, 'demo')
    await fs.mkdir(kb)
    expect(await isKnowledgeBaseRoot(kb)).toBe(false)

    await fs.writeFile(path.join(kb, 'tnotes.json'), '{ "title": "demo" }\n')
    expect(await isKnowledgeBaseRoot(kb)).toBe(true)
  })

  it('ignores a tnotes.json directory', async () => {
    const parent = await makeParent()
    const kb = path.join(parent, 'weird')
    await fs.mkdir(path.join(kb, 'tnotes.json'), { recursive: true })
    expect(await isKnowledgeBaseRoot(kb)).toBe(false)
  })
})

describe('createKnowledgeBase', () => {
  it('writes the minimal layout with a starter note', async () => {
    const parent = await makeParent()
    const result = await createKnowledgeBase({
      parentDir: parent,
      folderName: 'demo-kb',
      title: '演示库'
    })

    expect(result.rootPath).toBe(path.join(parent, 'demo-kb'))
    expect(result.config).toEqual({ name: 'demo-kb', title: '演示库' })
    expect(result.starterNoteRelPath).toBe(`notes/0001. ${STARTER_NOTE_TITLE}.md`)

    const config = JSON.parse(await fs.readFile(path.join(result.rootPath, 'tnotes.json'), 'utf8'))
    expect(config).toEqual({ name: 'demo-kb', title: '演示库' })

    const toc = await fs.readFile(path.join(result.rootPath, 'TOC.md'), 'utf8')
    expect(toc).toBe(`- [ ] 0001. ${STARTER_NOTE_TITLE}\n`)

    const note = await fs.readFile(path.join(result.rootPath, result.starterNoteRelPath), 'utf8')
    expect(note).toMatch(/^---\nid: .+\n---\n/)
    expect(note).toContain(DOCS_SITE_URL)
    expect(note).not.toContain('region:toc')
    expect(note).not.toContain('](https://github.com/')

    expect(await fs.readFile(path.join(result.rootPath, '.gitignore'), 'utf8')).toBe(
      CANONICAL_GITIGNORE
    )
    expect(await fs.readFile(path.join(result.rootPath, '.gitattributes'), 'utf8')).toBe(
      CANONICAL_GITATTRIBUTES
    )

    expect(result.extras).toEqual([])

    for (const missing of ['public', 'assets', 'package.json', '.github', '.vscode', 'README.md']) {
      await expect(fs.stat(path.join(result.rootPath, missing))).rejects.toThrow()
    }

    expect(await isKnowledgeBaseRoot(result.rootPath)).toBe(true)
    const snapshot = await createWorkspace({ rootPath: result.rootPath }).scan()
    expect(snapshot.notes).toHaveLength(1)
    expect(snapshot.notes[0].title).toBe(STARTER_NOTE_TITLE)
    expect(snapshot.notes[0].frontmatter.id).toBeTruthy()
  })

  it('writes markdown.lineBreaks only when visual is requested', async () => {
    const parent = await makeParent()
    const result = await createKnowledgeBase({
      parentDir: parent,
      folderName: 'visual-kb',
      options: { lineBreaks: 'visual' }
    })
    const config = JSON.parse(await fs.readFile(path.join(result.rootPath, 'tnotes.json'), 'utf8'))
    expect(config.markdown).toEqual({ lineBreaks: 'visual' })
  })

  it('scaffolds package.json, pages workflow, readme, and git init when requested', async () => {
    const parent = await makeParent()
    const result = await createKnowledgeBase({
      parentDir: parent,
      folderName: 'full-kb',
      title: '完整库',
      options: {
        packageJson: true,
        githubPages: true,
        readme: true,
        gitInit: true
      }
    })

    expect(result.extras).toEqual(
      expect.arrayContaining([
        'package.json',
        'pnpm-workspace.yaml',
        '.npmrc',
        '.github/workflows/deploy.yml',
        'README.md',
        '.git'
      ])
    )

    const pkg = JSON.parse(
      await fs.readFile(path.join(result.rootPath, 'package.json'), 'utf8')
    ) as { name?: string; scripts: Record<string, string> }
    expect(pkg.name).toBe('full-kb')
    expect(pkg.scripts['tn:build']).toBe('tnotes-ssg build')

    const deploy = await fs.readFile(
      path.join(result.rootPath, '.github', 'workflows', 'deploy.yml'),
      'utf8'
    )
    expect(deploy).toContain('path: .tnotes/dist')

    expect(await fs.readFile(path.join(result.rootPath, 'README.md'), 'utf8')).toContain('# 完整库')
    await expect(fs.stat(path.join(result.rootPath, '.git'))).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    })
  })

  it('implies package.json when only githubPages is requested', async () => {
    const parent = await makeParent()
    const result = await createKnowledgeBase({
      parentDir: parent,
      folderName: 'pages-only',
      options: { githubPages: true }
    })
    expect(result.extras).toEqual(
      expect.arrayContaining(['package.json', '.github/workflows/deploy.yml'])
    )
    expect(result.extras).not.toContain('README.md')
  })

  it('defaults title to folderName and rejects collisions', async () => {
    const parent = await makeParent()
    const first = await createKnowledgeBase({ parentDir: parent, folderName: 'alone' })
    expect(first.config.title).toBe('alone')

    await expect(createKnowledgeBase({ parentDir: parent, folderName: 'alone' })).rejects.toThrow(
      /已存在/
    )

    await expect(
      createKnowledgeBase({ parentDir: parent, folderName: 'bad name' })
    ).rejects.toThrow(/文件夹名不合法/)
  })
})
