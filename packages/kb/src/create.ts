/**
 * Create a minimal knowledge base and detect roots by tnotes.json.
 */

import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { CONFIG_FILE, NOTES_DIR, TOC_FILE } from './constants'
import { KbError } from './errors'
import { serializeNoteContent } from './frontmatter'
import { initGitRepository } from './git'
import {
  CANONICAL_GITATTRIBUTES,
  CANONICAL_GITIGNORE,
  buildRootReadme,
  writeDeployWorkflowScaffold,
  writePackageJsonScaffold
} from './scaffold'
import { isValidKbName } from './name'
import type { KbConfig, KbLineBreakMode } from './types'

/** Starter note title written into notes/ and TOC.md on init. */
export const STARTER_NOTE_TITLE = '开始使用'

/** Docs site linked from the starter note. */
export const DOCS_SITE_URL = 'https://tnotesjs.github.io/TNotes.docs/'

export interface CreateKnowledgeBaseOptions {
  /** Write package.json (+ pnpm-workspace.yaml / .npmrc). Implied by githubPages. */
  packageJson?: boolean
  /** Write GitHub Pages deploy.yml; also enables packageJson. */
  githubPages?: boolean
  /** Write a root README.md for the GitHub repo landing page. */
  readme?: boolean
  /** Run `git init` in the new knowledge-base directory. */
  gitInit?: boolean
  /** Written to `markdown.lineBreaks`; omitted means the CommonMark default. */
  lineBreaks?: KbLineBreakMode
}

export interface CreateKnowledgeBaseInput {
  /** Parent directory (usually the Desk workspace root). */
  parentDir: string
  /** On-disk folder name; must match KB_NAME_REGEX. */
  folderName: string
  /** Display title in Desk; defaults to folderName. */
  title?: string
  /** Optional scaffolds; all default to false. */
  options?: CreateKnowledgeBaseOptions
}

export interface CreateKnowledgeBaseResult {
  rootPath: string
  folderName: string
  config: KbConfig
  starterNoteRelPath: string
  /** Extra files/dirs written beyond the minimal layout. */
  extras: string[]
}

/** True when `dir` contains a file named tnotes.json (not a directory). */
export async function isKnowledgeBaseRoot(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dir, CONFIG_FILE))
    return stat.isFile()
  } catch {
    return false
  }
}

function starterNoteBody(): string {
  return [
    `# ${STARTER_NOTE_TITLE}`,
    '',
    '这是一个 TNotes 知识库。你可以改这篇笔记的标题和正文，把它当成第一篇内容。',
    '',
    '在 Desk 侧栏新建笔记或分组，即可开始整理目录。',
    '',
    `完整说明请查看 [TNotes.docs](${DOCS_SITE_URL})。`,
    ''
  ].join('\n')
}

/**
 * Create a minimal kb under parentDir/folderName.
 * Always writes: tnotes.json, TOC.md, notes/0001. 开始使用.md, .gitignore, .gitattributes.
 * Optional: package.json (+ Pages workflow), README.md, git init.
 */
export async function createKnowledgeBase(
  input: CreateKnowledgeBaseInput
): Promise<CreateKnowledgeBaseResult> {
  const folderName = input.folderName.trim()
  if (!isValidKbName(folderName)) {
    throw new KbError(
      'INVALID_CONFIG',
      `文件夹名不合法（须匹配 ^[A-Za-z0-9._-]{1,100}$）: ${folderName}`,
      { folderName }
    )
  }

  const title = (input.title?.trim() || folderName).trim()
  if (!title) {
    throw new KbError('INVALID_CONFIG', '显示名称不能为空')
  }

  const parentDir = path.resolve(input.parentDir)
  const rootPath = path.join(parentDir, folderName)

  try {
    await fs.access(rootPath, fsConstants.F_OK)
    throw new KbError('INVALID_OPERATION', `目录已存在: ${folderName}`, {
      rootPath
    })
  } catch (error) {
    if (error instanceof KbError) throw error
  }

  const config: KbConfig = {
    name: folderName,
    title
  }
  if (input.options?.lineBreaks === 'visual') config.markdown = { lineBreaks: 'visual' }

  const noteFileName = `0001. ${STARTER_NOTE_TITLE}.md`
  const starterNoteRelPath = `${NOTES_DIR}/${noteFileName}`
  const noteContent = serializeNoteContent({ id: randomUUID() }, starterNoteBody())
  const tocContent = `- [ ] 0001. ${STARTER_NOTE_TITLE}\n`

  await fs.mkdir(path.join(rootPath, NOTES_DIR), { recursive: true })
  await fs.writeFile(path.join(rootPath, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`)
  await fs.writeFile(path.join(rootPath, TOC_FILE), tocContent)
  await fs.writeFile(path.join(rootPath, starterNoteRelPath), noteContent)
  await fs.writeFile(path.join(rootPath, '.gitignore'), CANONICAL_GITIGNORE)
  await fs.writeFile(path.join(rootPath, '.gitattributes'), CANONICAL_GITATTRIBUTES)

  const options = input.options ?? {}
  const wantPages = options.githubPages === true
  const wantPackageJson = options.packageJson === true || wantPages
  const extras: string[] = []

  if (wantPackageJson) {
    extras.push(...(await writePackageJsonScaffold(rootPath, folderName)))
  }
  if (wantPages) {
    extras.push(...(await writeDeployWorkflowScaffold(rootPath)))
  }
  if (options.readme === true) {
    await fs.writeFile(path.join(rootPath, 'README.md'), buildRootReadme(title, folderName))
    extras.push('README.md')
  }
  if (options.gitInit === true) {
    try {
      await initGitRepository(rootPath)
    } catch (error) {
      throw new KbError(
        'INVALID_OPERATION',
        error instanceof Error ? error.message : String(error),
        { rootPath }
      )
    }
    extras.push('.git')
  }

  return {
    rootPath,
    folderName,
    config,
    starterNoteRelPath,
    extras
  }
}
