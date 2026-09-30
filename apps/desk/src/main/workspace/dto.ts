import { createHash } from 'node:crypto'
import path from 'node:path'

import {
  DEFAULT_PREVIEW_PORT,
  isGitRepository,
  readOriginRemoteUrl,
  resolveKbName,
  type KbSnapshot,
  type NoteDoc,
  type TocNode
} from '@tnotesjs/kb'
import type {
  DeskTocNode,
  KnowledgeBaseDescriptor,
  KnowledgeBaseDetail,
  KnowledgeBaseSettingsDto,
  NoteDocumentDto
} from '../../shared/contracts'

import type { KnowledgeBaseHandle } from './types'

export function stablePathSuffix(rootPath: string): string {
  return createHash('sha256').update(rootPath).digest('hex').slice(0, 10)
}

/** desk-stable kb id: derived from the root path (survives config edits). */
export function knowledgeBaseId(rootPath: string): string {
  return stablePathSuffix(rootPath)
}

export function resolveIconDisplaySrc(
  knowledgeBaseId: string,
  src: string | undefined
): string | undefined {
  if (!src?.trim()) return undefined
  const value = src.trim()
  if (
    /^https?:\/\//i.test(value) ||
    value.startsWith('data:') ||
    value.startsWith('tnotes-asset:')
  ) {
    return value
  }
  const params = new URLSearchParams({ knowledgeBaseId, path: value.split(/[?#]/, 1)[0] })
  return `tnotes-asset://asset?${params.toString()}`
}

function iconFromConfig(
  snapshot: KbSnapshot,
  knowledgeBaseId: string
): KnowledgeBaseDescriptor['icon'] {
  const icon = snapshot.config.icon
  if (!icon || typeof icon !== 'object') return null
  const value = icon as Record<string, unknown>
  const letter =
    typeof value.letter === 'string' && value.letter.trim()
      ? value.letter.trim().slice(0, 1)
      : undefined
  const src = resolveIconDisplaySrc(
    knowledgeBaseId,
    typeof value.src === 'string' ? value.src : undefined
  )
  const svg = typeof value.svg === 'string' ? value.svg : undefined
  if (!src && !svg && !letter) return null
  return { src, svg, letter }
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function resolvePort(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535) {
    return value
  }
  return DEFAULT_PREVIEW_PORT
}

export function descriptor(handle: KnowledgeBaseHandle): KnowledgeBaseDescriptor {
  const snapshot = handle.snapshot
  const hasError = snapshot.diagnostics.some((d) => d.severity === 'error')
  const configName = optionalString(snapshot.config.name)
  const title = optionalString(snapshot.config.title)
  return {
    id: handle.id,
    configId: handle.id,
    name: handle.name,
    rootPath: handle.rootPath,
    displayName: title || configName || handle.name.replace(/^TNotes\./, ''),
    icon: iconFromConfig(snapshot, handle.id),
    repositoryUrl: httpUrl(snapshot.config.repositoryUrl),
    pageUrl: httpUrl(snapshot.config.pageUrl),
    configName,
    port: resolvePort(snapshot.config.port),
    rootUrl: optionalString(snapshot.config.rootUrl),
    statsEnabled: snapshot.config.stats?.enabled === true,
    autoPush: snapshot.config.autoPush ?? undefined,
    headingNumberMaxDepth: snapshot.config.headingNumberMaxDepth,
    health: hasError ? 'invalid' : 'ready',
    diagnostics: snapshot.diagnostics,
    noteCount: snapshot.notes.length,
    snapshotRevision: snapshot.revision
  }
}

export async function toSettingsDto(
  handle: KnowledgeBaseHandle
): Promise<KnowledgeBaseSettingsDto> {
  const config = handle.snapshot.config
  const isGitRepo = await isGitRepository(handle.rootPath)
  const originUrl = isGitRepo ? await readOriginRemoteUrl(handle.rootPath) : null
  const directoryName = path.basename(handle.rootPath)
  const configuredName = optionalString(config.name) ?? ''
  const suggestedName = resolveKbName({
    configured: configuredName || null,
    originUrl,
    directoryName
  })
  const icon = iconFromConfig(handle.snapshot, handle.id)
  return {
    knowledgeBaseId: handle.id,
    name: configuredName || suggestedName || '',
    title: optionalString(config.title) || configuredName || suggestedName || directoryName,
    icon,
    repositoryUrl: optionalString(config.repositoryUrl) || originUrl || '',
    rootUrl: optionalString(config.rootUrl) || '',
    port: resolvePort(config.port),
    pageUrl: optionalString(config.pageUrl) || '',
    statsEnabled: config.stats?.enabled === true,
    isGitRepo,
    originUrl,
    suggestedName,
    autoPush: config.autoPush ?? null,
    headingNumberMaxDepth: config.headingNumberMaxDepth ?? null
  }
}

export function mapToc(nodes: TocNode[], snapshot: KbSnapshot): DeskTocNode[] {
  const noteByIndex = new Map(snapshot.notes.map((note) => [note.index, note]))
  const walk = (items: TocNode[], folderPath: string[]): DeskTocNode[] =>
    items.flatMap((node): DeskTocNode[] => {
      const tocLineIndex = node.lineIndex
      if (node.kind === 'group') {
        const currentPath = [...folderPath, node.title]
        return [
          {
            type: 'group',
            title: node.title,
            tocLineIndex,
            nodeId: `folder:${tocLineIndex}:${currentPath.join('/')}`,
            folderPath: currentPath,
            children: walk(node.children, currentPath)
          }
        ]
      }
      const note = noteByIndex.get(node.index)
      if (!note) return []
      const uuid = note.frontmatter.id ?? note.index
      return [
        {
          type: 'note',
          uuid,
          title: note.title,
          dirName: note.fileName.replace(/\.md$/i, ''),
          noteIndex: note.index,
          tocLineIndex,
          nodeId: `note:${uuid}`,
          completed: node.done,
          children: walk(node.children, folderPath)
        }
      ]
    })
  return walk(nodes, [])
}

export function toDetail(handle: KnowledgeBaseHandle): KnowledgeBaseDetail {
  return {
    ...descriptor(handle),
    toc: mapToc(handle.snapshot.toc, handle.snapshot)
  }
}

export function toNoteDocument(handle: KnowledgeBaseHandle, doc: NoteDoc): NoteDocumentDto {
  const readOnly = handle.snapshot.diagnostics.some((d) => d.severity === 'error')
  return {
    knowledgeBaseId: handle.id,
    uuid: doc.frontmatter.id ?? doc.index,
    index: doc.index,
    title: doc.title,
    dirName: doc.fileName.replace(/\.md$/i, ''),
    fileName: doc.fileName,
    relPath: doc.relPath,
    filePath: `${handle.rootPath}/${doc.relPath}`,
    content: doc.content,
    revision: doc.revision,
    config: {
      done: doc.done,
      description: doc.frontmatter.description
    },
    readOnly
  }
}
