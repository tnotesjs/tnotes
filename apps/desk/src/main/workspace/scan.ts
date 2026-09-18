import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createWorkspace, isKnowledgeBaseRoot, type AssetStorePaths } from '@tnotesjs/kb'

import { deskLog } from '../log'

import { knowledgeBaseAssetStore } from './assetStore'

import { knowledgeBaseId } from './dto'
import type { KnowledgeBaseHandle, WorkspaceManagerEvents } from './types'

/** Mutable runtime state shared between WorkspaceManager and scan/watch helpers. */
export interface WorkspaceScanState {
  handles: Map<string, KnowledgeBaseHandle>
  workspacePath: string | null
  watchers: Map<string, FSWatcher>
  refreshTimer: NodeJS.Timeout | null
  scanTail: Promise<void>
  internalWriteUntil: Map<string, number>
  lastWatcherError: string
  lastWatcherErrorAt: number
  events: EventEmitter<WorkspaceManagerEvents>
  emitChanged: () => void
  /** Desk userData; asset journals/recycle live here, never under KB assets/. */
  userDataDir?: string
}

/** fs.watch 漏事件时条目会永久留在 Map 里；每次标记顺带清掉过期的。 */
function pruneInternalWrites(state: WorkspaceScanState, now: number): void {
  for (const [key, until] of state.internalWriteUntil) {
    if (until < now) state.internalWriteUntil.delete(key)
  }
}

export function markInternalWrites(
  state: WorkspaceScanState,
  rootPath: string,
  changedFiles: Array<{ path: string; previousPath?: string }>
): void {
  const now = Date.now()
  pruneInternalWrites(state, now)
  const until = now + 1500
  for (const changed of changedFiles) {
    // changedFiles are kb-root-relative; the watcher compares absolute paths.
    state.internalWriteUntil.set(path.normalize(path.join(rootPath, changed.path)), until)
    if (changed.previousPath) {
      state.internalWriteUntil.set(path.normalize(path.join(rootPath, changed.previousPath)), until)
    }
  }
}

/**
 * Hand-written notes may lack a frontmatter id (the renderer identity and the
 * comment mapping key). Backfill once, logged, idempotent.
 */
export async function backfillMissingNoteIds(
  state: WorkspaceScanState,
  handle: KnowledgeBaseHandle
): Promise<void> {
  const missing = handle.snapshot.notes.filter((note) => !note.frontmatter.id)
  for (const note of missing) {
    try {
      const result = await handle.workspace.notes.setFrontmatter({
        index: note.index,
        updates: { id: randomUUID() }
      })
      // 回填是我们自己写的盘：不标记的话 fs.watch 会当成外部修改，给正在编辑的
      // 文档弹假冲突，并让已加载文档的 revision 失效
      markInternalWrites(state, handle.rootPath, result.changedFiles)
      deskLog('workspace', 'backfilled note id', { relPath: note.relPath })
    } catch (error) {
      deskLog(
        'workspace',
        'note id backfill failed',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  if (missing.length > 0) {
    handle.snapshot = await handle.workspace.scan()
  }
}

async function openHandle(
  state: WorkspaceScanState,
  rootPath: string,
  name: string,
  previousByPath: Map<string, KnowledgeBaseHandle>
): Promise<KnowledgeBaseHandle> {
  const existing = previousByPath.get(rootPath)
  const assetStore: AssetStorePaths | undefined = state.userDataDir
    ? knowledgeBaseAssetStore(state.userDataDir, rootPath)
    : undefined
  const workspace = existing?.workspace ?? createWorkspace({ rootPath, assetStore })
  if (assetStore) {
    try {
      const recovered = await workspace.assets.recoverIncomplete(assetStore)
      if (recovered.length > 0) {
        markInternalWrites(
          state,
          rootPath,
          recovered.flatMap((result) => result.changedPaths.map((changed) => ({ path: changed })))
        )
        deskLog('workspace', 'recovered incomplete asset journals', {
          rootPath,
          count: recovered.length
        })
      }
    } catch (error) {
      deskLog(
        'workspace',
        'asset journal recover failed',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  const handle: KnowledgeBaseHandle = {
    id: existing?.id ?? knowledgeBaseId(rootPath),
    name,
    rootPath,
    workspace,
    snapshot: await workspace.scan()
  }
  await backfillMissingNoteIds(state, handle)
  return handle
}

/**
 * Discover knowledge bases under the workspace:
 * - If the workspace root itself has tnotes.json → single-kb workspace.
 * - Else each direct child directory that has a tnotes.json file.
 */
export async function scan(state: WorkspaceScanState): Promise<void> {
  if (!state.workspacePath) return
  const previousByPath = new Map(
    [...state.handles.values()].map((handle) => [handle.rootPath, handle])
  )
  const next = new Map<string, KnowledgeBaseHandle>()

  if (await isKnowledgeBaseRoot(state.workspacePath)) {
    const name = path.basename(state.workspacePath)
    const handle = await openHandle(state, state.workspacePath, name, previousByPath)
    next.set(handle.id, handle)
  } else {
    const entries = await fs.readdir(state.workspacePath, { withFileTypes: true })
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of directories) {
      const rootPath = path.join(state.workspacePath, entry.name)
      if (!(await isKnowledgeBaseRoot(rootPath))) continue
      const handle = await openHandle(state, rootPath, entry.name, previousByPath)
      next.set(handle.id, handle)
    }
  }

  state.handles = next
  syncKnowledgeBaseWatchers(state)
  deskLog('workspace', 'scan complete', {
    path: state.workspacePath,
    knowledgeBases: next.size
  })
}

export async function enqueueScan(state: WorkspaceScanState): Promise<void> {
  state.scanTail = state.scanTail
    .then(() => scan(state))
    .catch((error) => {
      deskLog('workspace', 'scan failed', error instanceof Error ? error.message : String(error))
    })
  await state.scanTail
}

export function startWatchers(state: WorkspaceScanState, workspacePath: string): void {
  createWatcher(state, 'workspace', workspacePath, false, (_event, fileName) => {
    if (!fileName) return
    // Any top-level rename/change may add/remove a kb (tnotes.json marker).
    scheduleRefresh(state)
  })
  syncKnowledgeBaseWatchers(state)
}

function createWatcher(
  state: WorkspaceScanState,
  key: string,
  targetPath: string,
  recursive: boolean,
  listener: (eventType: 'rename' | 'change', fileName: string | null) => void
): void {
  if (state.watchers.has(key)) return
  let watcher: FSWatcher
  try {
    watcher = watch(targetPath, { recursive }, listener)
  } catch (error) {
    logWatcherError(state, error)
    return
  }
  watcher.on('error', (error) => logWatcherError(state, error))
  state.watchers.set(key, watcher)
}

function logWatcherError(state: WorkspaceScanState, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const now = Date.now()
  if (message !== state.lastWatcherError || now - state.lastWatcherErrorAt > 5000) {
    state.lastWatcherError = message
    state.lastWatcherErrorAt = now
    deskLog('workspace:watcher', 'error', message)
  }
}

export function syncKnowledgeBaseWatchers(state: WorkspaceScanState): void {
  if (!state.workspacePath || !state.watchers.has('workspace')) return
  const expectedKeys = new Set(['workspace'])
  for (const handle of state.handles.values()) {
    const key = `knowledge-base:${handle.rootPath}`
    expectedKeys.add(key)
    createWatcher(state, key, handle.rootPath, true, (_event, fileName) => {
      if (!fileName) return
      const relativePath = fileName.toString()
      if (shouldIgnoreKnowledgeBasePath(relativePath)) return
      handleWatchedPath(state, handle, path.join(handle.rootPath, relativePath))
    })
  }

  for (const [key, watcher] of state.watchers) {
    if (!expectedKeys.has(key)) {
      watcher.close()
      state.watchers.delete(key)
    }
  }
}

function shouldIgnoreKnowledgeBasePath(relativePath: string): boolean {
  const segments = relativePath.split(path.sep).filter(Boolean)
  return segments.some((segment) => {
    // `.name.<uuid>.tmp` — atomic-write staging files; the rename onto the
    // real path emits its own event.
    if (segment.startsWith('.') && segment.endsWith('.tmp')) return true
    return (
      segment === '.git' ||
      segment === 'node_modules' ||
      segment === 'dist' ||
      segment === '.tnotes'
    )
  })
}

/**
 * 磁盘上某个被监听的路径发生变化时的处理。
 *
 * 关键不变量：**只有 Desk 自己刚写过的路径才被忽略**。终端里跑脚本 `git checkout`
 * 或直接改笔记，对这里来说就是普通的外部变更——必须发事件，让渲染端去刷新或提示
 * 冲突（终端不受 Desk 的写入门禁约束，不能拿门禁当保护）。
 */
export function handleWatchedPath(
  state: WorkspaceScanState,
  handle: KnowledgeBaseHandle,
  changedPath: string
): void {
  const normalizedPath = path.normalize(changedPath)
  const internalUntil = state.internalWriteUntil.get(normalizedPath) ?? 0
  if (internalUntil >= Date.now()) {
    return
  }
  state.internalWriteUntil.delete(normalizedPath)

  for (const note of handle.snapshot.notes) {
    if (path.normalize(path.join(handle.rootPath, note.relPath)) === normalizedPath) {
      state.events.emit('noteExternalChanged', {
        knowledgeBaseId: handle.id,
        noteUuid: note.frontmatter.id ?? note.index
      })
      break
    }
  }
  scheduleRefresh(state)
}

export function scheduleRefresh(state: WorkspaceScanState): void {
  if (state.refreshTimer) clearTimeout(state.refreshTimer)
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null
    void enqueueScan(state).then(() => {
      state.emitChanged()
    })
  }, 250)
}

export async function stopWatcher(state: WorkspaceScanState): Promise<void> {
  for (const watcher of state.watchers.values()) watcher.close()
  state.watchers.clear()
}

export async function disposeHandles(state: WorkspaceScanState): Promise<void> {
  state.handles.clear()
}
