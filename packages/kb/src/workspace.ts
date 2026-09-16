/**
 * src/workspace.ts
 *
 * createWorkspace — mutations over the single-file knowledge base.
 * Every mutation re-reads the files it touches, applies atomic writes and
 * returns the affected document/snapshot plus the changed-file list.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { addAsset, clearKbIcon, gcAssets, listAssets, replaceKbIcon } from './assets'
import {
  applyAssetPlan,
  fillPlanHashes,
  listAssetJournals,
  planMerge,
  planOptimize,
  planRecycle,
  planRename,
  recoverIncompleteJournals,
  restoreAssetPlan,
  runSerializedAssetWork,
  scanAssets
} from './asset-scan'
import { applyAtomicWrites, writeFileAtomic } from './atomic'
import { ASSETS_DIR, CONFIG_FILE, NOTES_DIR, TOC_FILE } from './constants'
import { KbError } from './errors'
import { parseNoteContent, serializeNoteContent, updateNoteFrontmatter } from './frontmatter'
import { isValidKbName } from './name'
import {
  contentRevision,
  readKbConfig,
  readTocLines,
  scanKnowledgeBase,
  scanNoteFiles
} from './scanner'
import { updateCompletedNotesStats } from './stats'
import {
  buildGroupLine,
  buildNoteLine,
  collectSubtreeNoteIndexes,
  findGroupLineIndex,
  findNoteLineIndex,
  flattenTocLines,
  getSubtreeRange,
  insertLinesRelative,
  moveSubtree,
  normalizeTocBlankLines,
  parseTocLine,
  removeSubtree,
  setNoteDoneLine,
  setNoteTitleLine
} from './toc'

import type {
  ApplyAssetPlanOptions,
  AssetJournalRecord,
  AssetOperationPlan,
  AssetOperationResult,
  AssetScanReport,
  AssetStorePaths,
  ScanAssetsOptions
} from './asset-scan'
import type {
  AssetEntry,
  ChangedFile,
  KbConfig,
  KbIcon,
  KbSnapshot,
  KbStats,
  MutationResult,
  NoteDoc,
  NoteFrontmatter,
  NoteMeta,
  Placement,
  TocEntryRef
} from './types'

export interface CreateWorkspaceOptions {
  rootPath: string
  /**
   * Independent journal/recycle dirs (Desk userData). Required for apply/restore
   * unless those methods receive an explicit store argument.
   */
  assetStore?: AssetStorePaths
}

export interface SaveNoteInput {
  index: string
  content: string
  expectedRevision?: string
}

export interface CreateNoteInput {
  title: string
  placement?: Placement
  frontmatter?: NoteFrontmatter
  /** Markdown body; a `# 标题` heading is prepended when omitted. */
  body?: string
}

export interface RenameNoteInput {
  index: string
  title: string
}

export interface SetFrontmatterInput {
  index: string
  updates: Partial<NoteFrontmatter>
  expectedRevision?: string
}

export interface MoveTocEntryInput {
  source: TocEntryRef
  target: TocEntryRef
  placement: 'before' | 'after' | 'inside'
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function validateTitle(title: string): string {
  const value = title.trim()
  if (!value || /[\\/\0\r\n]/.test(value) || /[. ]$/.test(value) || WINDOWS_RESERVED.test(value)) {
    throw new KbError('INVALID_TITLE', '笔记或分组标题不合法', { title })
  }
  return value
}

function noteFileName(index: string, title: string): string {
  return `${index}. ${title}.md`
}

/** Default first-line H1 for a newly created note. Rename does not keep this in sync. */
function noteHeading(index: string, title: string): string {
  return `${index}. ${title}`
}

function toDoc(rootPath: string, meta: NoteMeta, content: string): NoteDoc {
  const { frontmatter, body } = parseNoteContent(content)
  return {
    ...meta,
    frontmatter,
    body,
    content,
    revision: contentRevision(content)
  }
}

function placementLineIndex(
  lines: string[],
  placement: Placement | undefined
): { lineIndex: number; indentLevel: number; where: 'before' | 'after' | 'inside' } {
  if (!placement || placement.type === 'root') {
    if (placement?.placement === 'start') {
      const first = flattenTocLines(lines)[0]
      if (first) return { lineIndex: first.lineIndex, indentLevel: 0, where: 'before' }
      return { lineIndex: lines.length - 1, indentLevel: 0, where: 'after' }
    }
    return { lineIndex: lines.length - 1, indentLevel: 0, where: 'after' }
  }
  if (placement.type === 'note') {
    const lineIndex = findNoteLineIndex(lines, placement.targetIndex)
    const indent = parseTocLine(lines[lineIndex]).indentLevel
    return {
      lineIndex,
      indentLevel: placement.placement === 'inside' ? indent + 1 : indent,
      where: placement.placement
    }
  }
  const lineIndex = findGroupLineIndex(lines, placement.groupPath)
  const indent = parseTocLine(lines[lineIndex]).indentLevel
  return {
    lineIndex,
    indentLevel: placement.placement === 'inside' ? indent + 1 : indent,
    where: placement.placement
  }
}

function entryRefLineIndex(lines: string[], ref: TocEntryRef): number {
  return ref.type === 'note'
    ? findNoteLineIndex(lines, ref.index)
    : findGroupLineIndex(lines, ref.groupPath)
}

export interface TNotesKbWorkspace {
  scan(): Promise<KbSnapshot>

  notes: {
    read(index: string): Promise<NoteDoc>
    save(input: SaveNoteInput): Promise<MutationResult<NoteDoc>>
    create(input: CreateNoteInput): Promise<MutationResult<NoteDoc>>
    rename(input: RenameNoteInput): Promise<MutationResult<NoteDoc>>
    /** Delete a single note (file + its TOC line). Fails while it has children. */
    remove(index: string): Promise<MutationResult<{ index: string }>>
    setFrontmatter(input: SetFrontmatterInput): Promise<MutationResult<NoteDoc>>
  }

  toc: {
    move(input: MoveTocEntryInput): Promise<MutationResult<KbSnapshot>>
    createGroup(input: {
      title: string
      placement?: Placement
    }): Promise<MutationResult<KbSnapshot>>
    renameGroup(input: { groupPath: string[]; title: string }): Promise<MutationResult<KbSnapshot>>
    /** Remove a TOC subtree; note files inside it are deleted as well. */
    removeEntry(ref: TocEntryRef): Promise<MutationResult<KbSnapshot>>
    setDone(input: { index: string; done: boolean }): Promise<MutationResult<KbSnapshot>>
  }

  assets: {
    list(): Promise<AssetEntry[]>
    /** Read-only reference analysis. Does not write the knowledge base. */
    analyze(options?: ScanAssetsOptions): Promise<AssetScanReport>
    planRename(input: {
      fromRelPath: string
      toRelPath: string
      generation?: number
    }): Promise<AssetOperationPlan>
    planRecycle(input: {
      relPaths: string[]
      generation?: number
      /** 定向删除（笔记资源面板逐个确认）：放开批量闸门与画布源文件保护 */
      targeted?: boolean
    }): Promise<AssetOperationPlan>
    planMerge(input: {
      keepRelPath: string
      dropRelPaths: string[]
      generation?: number
    }): Promise<AssetOperationPlan>
    planOptimize(
      items: Array<{
        fromRelPath: string
        toRelPath: string
        outputSha256: string
        bytesAfter: number
      }>,
      generation?: number
    ): Promise<AssetOperationPlan>
    /**
     * Apply a previously planned rename or recycle. Journal and recycle dirs are
     * passed by the caller and must not live under `assets/`.
     */
    applyPlan(
      plan: AssetOperationPlan,
      store?: AssetStorePaths,
      options?: ApplyAssetPlanOptions
    ): Promise<AssetOperationResult>
    restorePlan(planId: string, store?: AssetStorePaths): Promise<AssetOperationResult>
    recoverIncomplete(store?: AssetStorePaths): Promise<AssetOperationResult[]>
    listJournals(store?: AssetStorePaths): Promise<AssetJournalRecord[]>
    add(input: {
      fileName: string
      data: Uint8Array
    }): Promise<{ relPath: string; markdownPath: string; reused: boolean }>
    /** Replace KB icon with fixed `assets/kb-icon.<ext>` (deletes prior icons). */
    replaceIcon(input: {
      ext: string
      data: Uint8Array
    }): Promise<{ relPath: string; markdownPath: string; icon: KbIcon; deleted: string[] }>
    /** Delete every KB icon file, current name and legacy `.tn-kb-icon.*`. */
    clearIcon(): Promise<{ deleted: string[] }>
    gc(options?: { delete?: boolean }): Promise<{ unreferenced: string[]; deleted: string[] }>
  }

  config: {
    get(): Promise<KbConfig>
    set(updates: Partial<KbConfig>): Promise<MutationResult<KbConfig>>
  }

  stats: {
    /** Rewrite `stats.completedNotesCount` when enabled; requires a git repo. */
    update(): Promise<MutationResult<KbStats>>
  }
}

export function createWorkspace(options: CreateWorkspaceOptions): TNotesKbWorkspace {
  const rootPath = path.resolve(options.rootPath)
  const tocPath = path.join(rootPath, TOC_FILE)
  const defaultAssetStore = options.assetStore

  function requireAssetStore(store?: AssetStorePaths): AssetStorePaths {
    const resolved = store ?? defaultAssetStore
    if (!resolved) {
      throw new KbError(
        'INVALID_OPERATION',
        '资源写操作需要独立的 journalDir/recycleDir，不能放在知识库 assets/ 下'
      )
    }
    const assetsAbs = path.join(rootPath, ASSETS_DIR)
    for (const dir of [resolved.journalDir, resolved.recycleDir]) {
      const abs = path.resolve(dir)
      if (abs === assetsAbs || abs.startsWith(assetsAbs + path.sep)) {
        throw new KbError('INVALID_OPERATION', '回收区与 journal 不能放在 assets/ 内', { dir })
      }
    }
    return resolved
  }

  async function readNoteFile(index: string): Promise<{ meta: NoteMeta; content: string }> {
    const snapshot = await scanKnowledgeBase(rootPath)
    const meta = snapshot.notes.find((n) => n.index === index)
    if (!meta) {
      throw new KbError('NOTE_NOT_FOUND', `笔记不存在: ${index}`, { index })
    }
    const content = await fs.readFile(path.join(rootPath, meta.relPath), 'utf8')
    return { meta, content }
  }

  async function writeTocLines(lines: string[]): Promise<void> {
    const normalized = normalizeTocBlankLines(lines)
    const content = normalized.join('\n').replace(/\n*$/, '\n')
    await writeFileAtomic(tocPath, content)
  }

  async function nextIndex(): Promise<string> {
    const files = await scanNoteFiles(rootPath)
    let max = 0
    for (const file of files) max = Math.max(max, Number.parseInt(file.index, 10))
    const next = max + 1
    if (next > 9999) {
      throw new KbError('INVALID_OPERATION', '笔记编号已用尽（> 9999）')
    }
    return String(next).padStart(4, '0')
  }

  const workspace: TNotesKbWorkspace = {
    scan: () => scanKnowledgeBase(rootPath),

    notes: {
      async read(index) {
        const { meta, content } = await readNoteFile(index)
        return toDoc(rootPath, meta, content)
      },

      async save(input) {
        const { meta, content } = await readNoteFile(input.index)
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== contentRevision(content)
        ) {
          throw new KbError('REVISION_CONFLICT', `笔记 ${input.index} 已被外部修改`, {
            index: input.index
          })
        }
        await writeFileAtomic(path.join(rootPath, meta.relPath), input.content)
        return {
          value: toDoc(rootPath, meta, input.content),
          changedFiles: [{ path: meta.relPath, kind: 'updated' }]
        }
      },

      async create(input) {
        const title = validateTitle(input.title)
        const index = await nextIndex()
        const fileName = noteFileName(index, title)
        const relPath = `${NOTES_DIR}/${fileName}`

        const frontmatter: NoteFrontmatter = {
          id: randomUUID(),
          ...input.frontmatter
        }
        const body = input.body ?? `# ${noteHeading(index, title)}\n`
        const content = serializeNoteContent(frontmatter, body)

        const lines = await readTocLines(rootPath)
        const { lineIndex, indentLevel, where } = placementLineIndex(lines, input.placement)
        const noteLine = buildNoteLine(index, title, false, indentLevel)
        const nextLines =
          lines.length === 0 ? [noteLine] : insertLinesRelative(lines, lineIndex, [noteLine], where)

        await applyAtomicWrites([
          { path: path.join(rootPath, relPath), data: content },
          {
            path: tocPath,
            data: normalizeTocBlankLines(nextLines).join('\n').replace(/\n*$/, '\n')
          }
        ])

        const doc = toDoc(
          rootPath,
          {
            index,
            title,
            fileName,
            relPath,
            frontmatter,
            done: false,
            inToc: true,
            groupPath: []
          },
          content
        )
        return {
          value: doc,
          changedFiles: [
            { path: relPath, kind: 'created' },
            { path: TOC_FILE, kind: 'updated' }
          ]
        }
      },

      async rename(input) {
        const title = validateTitle(input.title)
        const { meta, content } = await readNoteFile(input.index)
        if (meta.title === title) {
          return { value: toDoc(rootPath, meta, content), changedFiles: [] }
        }
        const nextFileName = noteFileName(input.index, title)
        const nextRelPath = `${NOTES_DIR}/${nextFileName}`
        const lines = await readTocLines(rootPath)

        await applyAtomicWrites([
          {
            path: tocPath,
            data: setNoteTitleLine(lines, input.index, title).join('\n')
          }
        ])
        await fs.rename(path.join(rootPath, meta.relPath), path.join(rootPath, nextRelPath))

        const nextMeta: NoteMeta = { ...meta, title, fileName: nextFileName, relPath: nextRelPath }
        return {
          value: toDoc(rootPath, nextMeta, content),
          changedFiles: [
            { path: nextRelPath, kind: 'renamed', previousPath: meta.relPath },
            { path: TOC_FILE, kind: 'updated' }
          ]
        }
      },

      async remove(index) {
        const { meta } = await readNoteFile(index)
        const lines = await readTocLines(rootPath)
        let nextLines = lines
        try {
          const lineIndex = findNoteLineIndex(lines, index)
          const children = collectSubtreeNoteIndexes(lines, lineIndex).filter((i) => i !== index)
          if (children.length > 0) {
            throw new KbError(
              'INVALID_OPERATION',
              `笔记 ${index} 在 TOC 中还有子笔记（${children.join('、')}），请使用 toc.removeEntry 删除整个子树`,
              { index, children }
            )
          }
          nextLines = removeSubtree(lines, lineIndex).lines
        } catch (error) {
          if (error instanceof KbError && error.code === 'NOTE_NOT_FOUND') {
            nextLines = lines // not in TOC — just delete the file
          } else {
            throw error
          }
        }
        await applyAtomicWrites([
          {
            path: tocPath,
            data: normalizeTocBlankLines(nextLines).join('\n').replace(/\n*$/, '\n')
          }
        ])
        await fs.rm(path.join(rootPath, meta.relPath), { force: true })
        return {
          value: { index },
          changedFiles: [
            { path: meta.relPath, kind: 'deleted' },
            { path: TOC_FILE, kind: 'updated' }
          ]
        }
      },

      async setFrontmatter(input) {
        const { meta, content } = await readNoteFile(input.index)
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== contentRevision(content)
        ) {
          throw new KbError('REVISION_CONFLICT', `笔记 ${input.index} 已被外部修改`, {
            index: input.index
          })
        }
        const next = updateNoteFrontmatter(content, input.updates)
        await writeFileAtomic(path.join(rootPath, meta.relPath), next)
        return {
          value: toDoc(rootPath, meta, next),
          changedFiles: [{ path: meta.relPath, kind: 'updated' }]
        }
      }
    },

    toc: {
      async move(input) {
        const lines = await readTocLines(rootPath)
        const sourceIndex = entryRefLineIndex(lines, input.source)
        const targetIndex = entryRefLineIndex(lines, input.target)
        const next = moveSubtree(lines, sourceIndex, targetIndex, input.placement)
        await writeTocLines(next)
        return {
          value: await scanKnowledgeBase(rootPath),
          changedFiles: [{ path: TOC_FILE, kind: 'updated' }]
        }
      },

      async createGroup(input) {
        const title = validateTitle(input.title)
        const lines = await readTocLines(rootPath)
        const { lineIndex, indentLevel, where } = placementLineIndex(lines, input.placement)
        const groupLine = buildGroupLine(title, indentLevel)
        const next =
          flattenTocLines(lines).length === 0 && lines.every((l) => l.trim() === '')
            ? [groupLine]
            : insertLinesRelative(lines, lineIndex, [groupLine], where)
        await writeTocLines(next)
        return {
          value: await scanKnowledgeBase(rootPath),
          changedFiles: [{ path: TOC_FILE, kind: 'updated' }]
        }
      },

      async renameGroup(input) {
        const title = validateTitle(input.title)
        const lines = await readTocLines(rootPath)
        const lineIndex = findGroupLineIndex(lines, input.groupPath)
        const parsed = parseTocLine(lines[lineIndex])
        const next = [...lines]
        next[lineIndex] = buildGroupLine(title, parsed.indentLevel)
        await writeTocLines(next)
        return {
          value: await scanKnowledgeBase(rootPath),
          changedFiles: [{ path: TOC_FILE, kind: 'updated' }]
        }
      },

      async removeEntry(ref) {
        const lines = await readTocLines(rootPath)
        const lineIndex = entryRefLineIndex(lines, ref)
        const noteIndexes = collectSubtreeNoteIndexes(lines, lineIndex)
        const { lines: next } = removeSubtree(lines, lineIndex)

        const files = await scanNoteFiles(rootPath)
        const toDelete = files.filter((f) => noteIndexes.includes(f.index))

        await writeTocLines(next)
        for (const file of toDelete) {
          await fs.rm(path.join(rootPath, file.relPath), { force: true })
        }
        return {
          value: await scanKnowledgeBase(rootPath),
          changedFiles: [
            ...toDelete.map((f): ChangedFile => ({ path: f.relPath, kind: 'deleted' })),
            { path: TOC_FILE, kind: 'updated' }
          ]
        }
      },

      async setDone(input) {
        const lines = await readTocLines(rootPath)
        await writeTocLines(setNoteDoneLine(lines, input.index, input.done))
        return {
          value: await scanKnowledgeBase(rootPath),
          changedFiles: [{ path: TOC_FILE, kind: 'updated' }]
        }
      }
    },

    assets: {
      list: () => listAssets(rootPath),
      analyze: (options) => scanAssets(rootPath, options),
      async planRename(input) {
        const report = await scanAssets(rootPath, { generation: input.generation })
        const plan = planRename(report, {
          fromRelPath: input.fromRelPath,
          toRelPath: input.toRelPath
        })
        if (plan.blockedReasons.length > 0) return plan
        return fillPlanHashes(rootPath, plan)
      },
      async planRecycle(input) {
        const report = await scanAssets(rootPath, { generation: input.generation })
        const plan = planRecycle(report, input.relPaths, { targeted: input.targeted })
        if (plan.blockedReasons.length > 0) return plan
        return fillPlanHashes(rootPath, plan)
      },
      async planMerge(input) {
        const report = await scanAssets(rootPath, {
          generation: input.generation,
          includeHashes: true
        })
        const plan = planMerge(report, {
          keepRelPath: input.keepRelPath,
          dropRelPaths: input.dropRelPaths
        })
        if (plan.blockedReasons.length > 0) return plan
        return fillPlanHashes(rootPath, plan)
      },
      async planOptimize(items, generation) {
        const report = await scanAssets(rootPath, { generation })
        const plan = planOptimize(report, items)
        if (plan.blockedReasons.length > 0) return plan
        return fillPlanHashes(rootPath, plan)
      },
      applyPlan: (plan, store, options) =>
        applyAssetPlan(rootPath, plan, requireAssetStore(store), options),
      restorePlan: (planId, store) => restoreAssetPlan(rootPath, planId, requireAssetStore(store)),
      recoverIncomplete: (store) => recoverIncompleteJournals(rootPath, requireAssetStore(store)),
      listJournals: (store) => listAssetJournals(requireAssetStore(store)),
      add: (input) =>
        runSerializedAssetWork(rootPath, () => addAsset(rootPath, input.fileName, input.data)),
      replaceIcon: (input) => replaceKbIcon(rootPath, input.ext, input.data),
      clearIcon: () => clearKbIcon(rootPath),
      gc: (options) => gcAssets(rootPath, options)
    },

    config: {
      async get() {
        return (await readKbConfig(rootPath)).config
      },
      async set(updates) {
        if (updates.name !== undefined && updates.name !== null) {
          const name = String(updates.name).trim()
          if (!isValidKbName(name)) {
            throw new KbError('INVALID_OPERATION', '知识库名称须匹配 ^[A-Za-z0-9._-]{1,100}$', {
              name: updates.name
            })
          }
          updates = { ...updates, name }
        }
        if (updates.port !== undefined && updates.port !== null) {
          const port = Number(updates.port)
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new KbError('INVALID_OPERATION', '站点预览端口须为 1–65535 的整数', {
              port: updates.port
            })
          }
          updates = { ...updates, port }
        }
        if (updates.title !== undefined && updates.title !== null) {
          const title = String(updates.title).trim()
          updates = { ...updates, title: title || undefined }
        }
        if (updates.headingNumberMaxDepth !== undefined && updates.headingNumberMaxDepth !== null) {
          const depth = Number(updates.headingNumberMaxDepth)
          if (!Number.isInteger(depth) || depth < 1 || depth > 6) {
            throw new KbError('INVALID_OPERATION', '标题编号层级上限须为 1–6 的整数', {
              headingNumberMaxDepth: updates.headingNumberMaxDepth
            })
          }
          updates = { ...updates, headingNumberMaxDepth: depth }
        }
        if (updates.autoPush !== undefined && updates.autoPush !== null) {
          const autoPush = updates.autoPush
          const idleMinutes = Number(autoPush.idleMinutes)
          if (
            typeof autoPush.enabled !== 'boolean' ||
            !Number.isInteger(idleMinutes) ||
            idleMinutes < 1
          ) {
            throw new KbError(
              'INVALID_OPERATION',
              'autoPush 须为 { enabled: boolean, idleMinutes: 正整数 }',
              { autoPush: updates.autoPush }
            )
          }
          updates = { ...updates, autoPush: { enabled: autoPush.enabled, idleMinutes } }
        }

        const { config } = await readKbConfig(rootPath)
        const next: KbConfig = { ...config }
        for (const [key, value] of Object.entries(updates)) {
          if (value === undefined) delete next[key]
          else next[key] = value
        }
        // Normalize empty title away; consumers fall back to name / dir.
        if (typeof next.title === 'string' && !next.title.trim()) {
          delete next.title
        }

        await writeFileAtomic(
          path.join(rootPath, CONFIG_FILE),
          `${JSON.stringify(next, null, 2)}\n`
        )
        return {
          value: next,
          changedFiles: [{ path: CONFIG_FILE, kind: 'updated' }]
        }
      }
    },

    stats: {
      update: () => updateCompletedNotesStats(rootPath)
    }
  }

  return workspace
}

export { ASSETS_DIR, CONFIG_FILE, NOTES_DIR, TOC_FILE }
export { getSubtreeRange }
