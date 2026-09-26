import type { ChangeSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { locateUniqueReplace } from '../../../shared/agentReplace'
import {
  acceptAgentEdits,
  applyAgentChanges,
  applyAgentEditToContent,
  archivedEntries,
  archivedEntry,
  dropArchive,
  liveReviewEntries,
  markArchiveStale,
  rejectAgentEdits,
  revealFirstReview,
  reviewLineCounts,
  reviewMeta,
  reviewsOf,
  reviewViewFor,
  revertArchived,
  setReviewMeta,
  staleReviewNotes,
  syncArchiveContent
} from '../livePreview/agentReview'
import { liveEditorFor } from '../livePreview/editorRegistry'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import { documentKey, ipcPlain, notePlacement, resultValue } from '../stores/workspace/helpers'

import {
  appendRange,
  findNote,
  lineChangeCounts,
  listNoteRefs,
  locateSelection,
  locateWritten,
  notePageHeader,
  type SelectionTarget,
  overlapsProtectedFrontmatter,
  pageNoteRefs,
  readLineSlice,
  resolveKnowledgeBase
} from './agentNoteQuery'

import type { DeskTocNode, KnowledgeBaseDescriptor, KnowledgeBaseDetail } from '../../../shared/contracts'

type NoteNode = Extract<DeskTocNode, { type: 'note' }>

export interface AgentToolContext {
  /** 本轮的默认知识库（发送时固定） */
  knowledgeBaseId: string
  defaultNote: { knowledgeBaseId: string; noteUuid: string } | null
  /** 点名笔记和选区所在的知识库：note 省略 kb 时也会去这些库里找 */
  contextKbIds: string[]
  readCounts: Map<string, number>
  isCurrent: () => boolean
  details: Map<string, KnowledgeBaseDetail>
}

export interface AgentToolOutcome {
  ok: boolean
  summary: string
  detail: string
  noteUuid?: string
  knowledgeBaseId?: string
  added?: number
  removed?: number
}

export function createToolContext(knowledgeBaseId = ''): AgentToolContext {
  return {
    knowledgeBaseId,
    defaultNote: null,
    contextKbIds: [],
    readCounts: new Map(),
    isCurrent: () => false,
    details: new Map()
  }
}

async function waitForEditor(knowledgeBaseId: string, noteUuid: string): Promise<EditorView | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const view = liveEditorFor(knowledgeBaseId, noteUuid)
    if (view) return view
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

function clip(text: string, limit = 4000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text
}

function knowledgeBases(): KnowledgeBaseDescriptor[] {
  return useWorkspaceStore().overview.knowledgeBases
}

function kbName(knowledgeBaseId: string): string {
  return knowledgeBases().find((item) => item.id === knowledgeBaseId)?.displayName ?? knowledgeBaseId
}

async function kbDetail(context: AgentToolContext, knowledgeBaseId: string, fresh = false): Promise<KnowledgeBaseDetail> {
  const current = useWorkspaceStore().knowledgeBase
  if (current?.id === knowledgeBaseId && !fresh) return current
  const cached = context.details.get(knowledgeBaseId)
  if (cached && !fresh) return cached
  const detail = resultValue(await window.desk.knowledgeBases.read(knowledgeBaseId))
  context.details.set(knowledgeBaseId, detail)
  return detail
}

function prefix(context: AgentToolContext, knowledgeBaseId: string): string {
  return knowledgeBaseId === context.knowledgeBaseId ? '' : `${kbName(knowledgeBaseId)} · `
}

function noteLabel(node: NoteNode): string {
  return node.noteIndex ? `${node.noteIndex} ${node.title}` : node.title
}

type Target = { knowledgeBaseId: string; node: NoteNode } | { error: string }

/** kb 写了就只在那个库找；没写先找默认库，再找点名笔记和选区所在的库。 */
async function findTarget(args: Record<string, unknown>, context: AgentToolContext): Promise<Target> {
  const requested = String(args.note ?? '').trim()
  if (args.kb !== undefined && String(args.kb).trim()) {
    const resolved = resolveKnowledgeBase(knowledgeBases(), args.kb, context.knowledgeBaseId)
    if ('error' in resolved) return { error: resolved.error }
    const needle = requested || (context.defaultNote?.knowledgeBaseId === resolved.kb.id ? context.defaultNote.noteUuid : '')
    const node = needle ? findNote((await kbDetail(context, resolved.kb.id)).toc, needle) : null
    return node ? { knowledgeBaseId: resolved.kb.id, node } : { error: `在「${resolved.kb.displayName}」里找不到这篇笔记` }
  }
  if (!requested) {
    const fallback = context.defaultNote
    if (!fallback) return { error: '请指明是哪一篇笔记（note 参数）' }
    const node = findNote((await kbDetail(context, fallback.knowledgeBaseId)).toc, fallback.noteUuid)
    return node ? { knowledgeBaseId: fallback.knowledgeBaseId, node } : { error: '找不到这篇笔记' }
  }
  const order = [...new Set([context.knowledgeBaseId, ...context.contextKbIds])].filter(Boolean)
  for (const knowledgeBaseId of order) {
    const node = findNote((await kbDetail(context, knowledgeBaseId)).toc, requested)
    if (node) return { knowledgeBaseId, node }
  }
  return { error: '找不到这篇笔记' }
}

async function liveContent(knowledgeBaseId: string, noteUuid: string): Promise<string> {
  const view = reviewViewFor(knowledgeBaseId, noteUuid) ?? liveEditorFor(knowledgeBaseId, noteUuid)
  if (view) return view.state.doc.toString()
  return (await useWorkspaceStore().ensureDocument(knowledgeBaseId, noteUuid)).content
}

/** 保存并返回失败原因；成功返回空字符串。 */
async function saveQuietly(key: string): Promise<string> {
  const workspace = useWorkspaceStore()
  const session = workspace.documents[key]
  if (!session) return '找不到这篇笔记的内容'
  if (session.document.readOnly) return '这篇笔记是只读的'
  try {
    if (session.dirty) await workspace.saveDocument(key, { silent: true })
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
  return workspace.documents[key]?.dirty ? workspace.error || '保存没有完成' : ''
}

type ChangePlan = { change: ChangeSpec; oldText: string; newText: string } | { error: string }

/**
 * 编辑器开着就在编辑器里标出来；没开（包括其他知识库）就在后台改，标记进存档。
 * 两种情况都会立即保存。
 */
async function writeAgentChange(
  knowledgeBaseId: string,
  node: NoteNode,
  label: string,
  plan: (content: string) => ChangePlan,
  context: AgentToolContext
): Promise<{ ok: false; message: string } | { ok: true; oldText: string; newText: string; saveError: string }> {
  const workspace = useWorkspaceStore()
  const key = documentKey(knowledgeBaseId, node.uuid)
  const view = liveEditorFor(knowledgeBaseId, node.uuid)
  const content = view ? view.state.doc.toString() : (await workspace.ensureDocument(knowledgeBaseId, node.uuid)).content
  const planned = plan(content)
  if ('error' in planned) return { ok: false, message: planned.error }
  if (!context.isCurrent()) return { ok: false, message: '已停止' }
  setReviewMeta(knowledgeBaseId, node.uuid, { title: node.title, index: node.noteIndex, knowledgeBaseName: kbName(knowledgeBaseId) })
  const live = liveEditorFor(knowledgeBaseId, node.uuid)
  if (live && live.state.doc.toString() === content) {
    applyAgentChanges(live, planned.change, label)
    workspace.updateDocumentContent(key, live.state.doc.toString(), true)
  } else {
    const next = applyAgentEditToContent({ knowledgeBaseId, noteUuid: node.uuid }, content, planned.change, label)
    workspace.updateDocumentContent(key, next, true)
  }
  const saveError = await saveQuietly(key)
  if (!live) syncArchiveContent(knowledgeBaseId, node.uuid, workspace.documents[key]?.content ?? '')
  return { ok: true, oldText: planned.oldText, newText: planned.newText, saveError }
}

function editDetail(title: string, saveError: string): string {
  return saveError
    ? `已改好，但保存失败：${saveError}。改动标在「${title}」里，笔记仍是未保存状态。`
    : `已保存，并标在「${title}」里，等用户保留或撤销。`
}

export async function runAgentTool(
  name: string,
  args: Record<string, unknown>,
  created: Set<string>,
  context: AgentToolContext
): Promise<AgentToolOutcome> {
  const workspace = useWorkspaceStore()
  if (!context.isCurrent()) return { ok: false, summary: '已停止', detail: '' }
  try {
    if (name === 'list_notes' || name === 'search_notes') {
      const resolved = resolveKnowledgeBase(knowledgeBases(), args.kb, context.knowledgeBaseId)
      if ('error' in resolved) return { ok: false, summary: resolved.error, detail: '' }
      const kb = resolved.kb
      const label = prefix(context, kb.id)
      if (name === 'list_notes') {
        const page = pageNoteRefs(listNoteRefs((await kbDetail(context, kb.id)).toc), {
          offset: Number(args.offset) || 0,
          limit: Number(args.limit) || 200,
          query: String(args.query ?? '')
        })
        const from = page.lines.length ? page.offset + 1 : page.offset
        const to = page.offset + page.lines.length
        return {
          ok: true,
          summary: `列出目录 · ${label}${from}–${to} / ${page.total} 篇`,
          detail: `${notePageHeader(page)}\n${page.lines.join('\n')}`.trimEnd()
        }
      }
      const query = String(args.query ?? '').trim()
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 8))
      if (!query) return { ok: false, summary: '缺少搜索词', detail: '' }
      const result = await window.desk.search({ query, knowledgeBaseId: kb.id, limit })
      if (!result.ok) return { ok: false, summary: result.error.message, detail: '' }
      const lines = result.value.map((item) => `${item.noteIndex} ${item.title} ${item.noteUuid}\n${item.snippet}`)
      return { ok: true, summary: `搜索 ${label}「${query}」· ${lines.length} 条`, detail: clip(lines.join('\n\n')) }
    }
    if (name === 'read_note') {
      const target = await findTarget(args, context)
      if ('error' in target) return { ok: false, summary: target.error, detail: '' }
      const { knowledgeBaseId, node } = target
      const readKey = `${knowledgeBaseId}:${node.uuid}`
      const reads = (context.readCounts.get(readKey) ?? 0) + 1
      context.readCounts.set(readKey, reads)
      const slice = readLineSlice(await liveContent(knowledgeBaseId, node.uuid), Number(args.offset) || 1, Number(args.limit) || 400)
      const more =
        slice.toLine < slice.total ? `\n\n还有第 ${slice.toLine + 1}–${slice.total} 行，需要时用 offset=${slice.toLine + 1} 继续读。` : ''
      const hint =
        more + (reads >= 3 ? '\n\n你已经读过这篇笔记多次，请直接根据已有内容作答或调用 edit_note，不要再读。' : '')
      return {
        ok: true,
        summary: `读取 ${prefix(context, knowledgeBaseId)}${noteLabel(node)}（第 ${slice.fromLine}–${slice.toLine} 行）`,
        detail: `第 ${slice.fromLine}–${slice.toLine} 行 / 共 ${slice.total} 行\n${slice.text}${hint}`,
        noteUuid: node.uuid,
        knowledgeBaseId
      }
    }
    if (name === 'edit_note') {
      const target = await findTarget(args, context)
      if ('error' in target) return { ok: false, summary: target.error, detail: '' }
      const { knowledgeBaseId, node } = target
      const inserted = String(args.new_string ?? '')
      const oldString = String(args.old_string ?? '')
      const written = await writeAgentChange(
        knowledgeBaseId,
        node,
        `修改 ${node.title}`,
        (content) => {
          if (args.position === 'end') {
            if (!inserted) return { error: '缺少要追加的内容' }
            const range = appendRange(content, inserted)
            return { change: { from: range.from, to: range.from, insert: range.insert }, oldText: '', newText: range.insert }
          }
          if (!oldString) return { error: '缺少要替换的原文' }
          const located = locateUniqueReplace(content, oldString)
          if ('error' in located) return { error: located.error }
          if (overlapsProtectedFrontmatter(content, located.from, located.to)) return { error: '不能修改 frontmatter 的 id 行' }
          return { change: { from: located.from, to: located.to, insert: inserted }, oldText: oldString, newText: inserted }
        },
        context
      )
      if (!written.ok) return { ok: false, summary: written.message, detail: '' }
      const counts = lineChangeCounts(written.oldText, written.newText)
      return {
        ok: true,
        summary: `修改 ${prefix(context, knowledgeBaseId)}${noteLabel(node)}${written.saveError ? ' · 保存失败' : ''}`,
        detail: editDetail(node.title, written.saveError),
        noteUuid: node.uuid,
        knowledgeBaseId,
        added: counts.added,
        removed: counts.removed
      }
    }
    if (name === 'create_note') {
      const title = String(args.title ?? '').trim()
      const content = String(args.content ?? '')
      if (!title) return { ok: false, summary: '缺少标题', detail: '' }
      const resolved = resolveKnowledgeBase(knowledgeBases(), args.kb, context.knowledgeBaseId)
      if ('error' in resolved) return { ok: false, summary: resolved.error, detail: '' }
      const knowledgeBaseId = resolved.kb.id
      const detail = await kbDetail(context, knowledgeBaseId, true)
      if (detail.health !== 'ready') return { ok: false, summary: '这个知识库现在不能新建笔记', detail: '' }
      if (!context.isCurrent()) return { ok: false, summary: '已停止', detail: '' }
      const mutation = resultValue(
        await window.desk.notes.create(
          ipcPlain({
            knowledgeBaseId,
            title,
            placement: notePlacement({ type: 'root', placement: 'end' }),
            expectedSnapshotRevision: detail.snapshotRevision
          })
        )
      )
      context.details.set(knowledgeBaseId, mutation.knowledgeBase)
      if (workspace.knowledgeBase?.id === knowledgeBaseId) await workspace.reloadKnowledgeBase()
      const node = findNote(mutation.knowledgeBase.toc, mutation.note.uuid)
      if (!node) return { ok: false, summary: '笔记已创建，但在目录里找不到', detail: '' }
      created.add(`${knowledgeBaseId}:${node.uuid}`)
      const label = `新建 ${prefix(context, knowledgeBaseId)}${title}`
      if (!content) return { ok: true, summary: label, detail: `已新建「${title}」。`, noteUuid: node.uuid, knowledgeBaseId }
      const written = await writeAgentChange(
        knowledgeBaseId,
        node,
        `新建 ${title}`,
        (current) => {
          const range = appendRange(current, content)
          return { change: { from: range.from, insert: range.insert }, oldText: '', newText: range.insert }
        },
        context
      )
      if (!written.ok) return { ok: false, summary: written.message, detail: '', noteUuid: node.uuid, knowledgeBaseId }
      const counts = lineChangeCounts('', content)
      return {
        ok: true,
        summary: `${label}${written.saveError ? ' · 保存失败' : ''}`,
        detail: editDetail(title, written.saveError),
        noteUuid: node.uuid,
        knowledgeBaseId,
        added: counts.added,
        removed: 0
      }
    }
  } catch (cause) {
    return { ok: false, summary: cause instanceof Error ? cause.message : String(cause), detail: '' }
  }
  return { ok: false, summary: `不认识的工具：${name}`, detail: '' }
}

export async function acceptNoteEdits(knowledgeBaseId: string, noteUuid: string): Promise<{ ok: boolean; message: string }> {
  const view = reviewViewFor(knowledgeBaseId, noteUuid)
  if (view) acceptAgentEdits(view)
  dropArchive(knowledgeBaseId, noteUuid)
  const key = documentKey(knowledgeBaseId, noteUuid)
  if (!useWorkspaceStore().documents[key]?.dirty) return { ok: true, message: '' }
  const saveError = await saveQuietly(key)
  return saveError ? { ok: false, message: saveError } : { ok: true, message: '' }
}

export async function rejectNoteEdits(
  knowledgeBaseId: string,
  noteUuid: string,
  created: Set<string>
): Promise<{ ok: boolean; message: string }> {
  const workspace = useWorkspaceStore()
  const key = documentKey(knowledgeBaseId, noteUuid)
  const view = reviewViewFor(knowledgeBaseId, noteUuid)
  if (view) {
    rejectAgentEdits(view)
    workspace.updateDocumentContent(key, view.state.doc.toString(), true)
  } else {
    const entry = archivedEntry(knowledgeBaseId, noteUuid)
    if (entry) {
      const session = await workspace.ensureDocument(knowledgeBaseId, noteUuid)
      if (session.content !== entry.content) {
        markArchiveStale(knowledgeBaseId, noteUuid)
        const title = reviewMeta(knowledgeBaseId, noteUuid)?.title ?? session.document.title
        return { ok: false, message: `「${title}」在外部被改过，无法自动撤销` }
      }
      dropArchive(knowledgeBaseId, noteUuid)
      workspace.updateDocumentContent(key, revertArchived(entry.content, entry.reviews), true)
    }
  }
  const saveError = await saveQuietly(key)
  if (saveError) return { ok: false, message: saveError }
  const createdKey = `${knowledgeBaseId}:${noteUuid}`
  if (!created.has(createdKey)) return { ok: true, message: '' }
  const preview = await window.desk.toc.previewDelete(knowledgeBaseId, { type: 'note', noteUuid })
  if (!preview.ok) return { ok: false, message: preview.error.message }
  await workspace.deleteNode(preview.value)
  created.delete(createdKey)
  return { ok: true, message: '' }
}

export interface PendingNote {
  knowledgeBaseId: string
  knowledgeBaseName: string
  uuid: string
  title: string
  index: string
  added: number
  removed: number
}

function describeNote(knowledgeBaseId: string, noteUuid: string): { title: string; index: string; knowledgeBaseName: string } | null {
  const workspace = useWorkspaceStore()
  const meta = reviewMeta(knowledgeBaseId, noteUuid)
  const name = knowledgeBases().find((item) => item.id === knowledgeBaseId)?.displayName ?? meta?.knowledgeBaseName ?? knowledgeBaseId
  if (workspace.knowledgeBase?.id === knowledgeBaseId) {
    const node = findNote(workspace.knowledgeBase.toc, noteUuid)
    if (!node) return null
    return { title: node.title, index: node.noteIndex, knowledgeBaseName: name }
  }
  return { title: meta?.title ?? noteUuid, index: meta?.index ?? '', knowledgeBaseName: name }
}

/** 所有知识库里待确认的改动：开着的编辑器加上存档。当前知识库里已经删掉的笔记，存档顺手清掉。 */
export function pendingReviewList(): PendingNote[] {
  const items: PendingNote[] = []
  const seen = new Set<string>()
  const orphans: Array<{ knowledgeBaseId: string; noteUuid: string }> = []
  for (const entry of liveReviewEntries()) {
    const info = describeNote(entry.knowledgeBaseId, entry.noteUuid)
    if (!info) continue
    seen.add(`${entry.knowledgeBaseId}:${entry.noteUuid}`)
    const counts = reviewLineCounts(entry.view.state.doc.toString(), reviewsOf(entry.view.state))
    items.push({ knowledgeBaseId: entry.knowledgeBaseId, uuid: entry.noteUuid, ...info, ...counts })
  }
  for (const entry of archivedEntries()) {
    if (seen.has(`${entry.knowledgeBaseId}:${entry.noteUuid}`)) continue
    const info = describeNote(entry.knowledgeBaseId, entry.noteUuid)
    if (!info) {
      orphans.push(entry)
      continue
    }
    items.push({ knowledgeBaseId: entry.knowledgeBaseId, uuid: entry.noteUuid, ...info, ...reviewLineCounts(entry.content, entry.reviews) })
  }
  if (orphans.length) queueMicrotask(() => orphans.forEach((item) => dropArchive(item.knowledgeBaseId, item.noteUuid)))
  return items
}

export function staleReviewList(): Array<{ knowledgeBaseId: string; uuid: string; title: string }> {
  return staleReviewNotes().map((item) => ({
    knowledgeBaseId: item.knowledgeBaseId,
    uuid: item.noteUuid,
    title: describeNote(item.knowledgeBaseId, item.noteUuid)?.title ?? item.noteUuid
  }))
}

/** 切到笔记所在的知识库并打开它，返回编辑器。 */
export async function openNoteIn(knowledgeBaseId: string, noteUuid: string): Promise<EditorView | null> {
  const workspace = useWorkspaceStore()
  if (workspace.knowledgeBase?.id !== knowledgeBaseId) await workspace.selectKnowledgeBase(knowledgeBaseId)
  const kb = workspace.knowledgeBase
  if (!kb || kb.id !== knowledgeBaseId) return null
  const node = findNote(kb.toc, noteUuid)
  if (!node) return null
  useEditorStore().openNote(kb, node.uuid, node.title, 'visual', undefined, 'permanent')
  return waitForEditor(knowledgeBaseId, noteUuid)
}

export async function revealPendingNote(knowledgeBaseId: string, noteUuid: string): Promise<void> {
  const view = await openNoteIn(knowledgeBaseId, noteUuid)
  if (!view) return
  revealFirstReview(reviewViewFor(knowledgeBaseId, noteUuid) ?? view)
}

/**
 * 点工具行：打开对应笔记并定位。
 * 读取 → 选中读过的那几行；修改/新建 → 还有待确认的改动就跳到第一处，否则选中写进去的文字。
 */
export async function revealToolTarget(
  tool: { name: string; noteUuid?: string; knowledgeBaseId?: string; summary: string; args: Record<string, unknown> },
  fallbackKbId: string
): Promise<void> {
  const knowledgeBaseId = tool.knowledgeBaseId ?? fallbackKbId
  if (!tool.noteUuid || !knowledgeBaseId) return
  const view = await openNoteIn(knowledgeBaseId, tool.noteUuid)
  if (!view) return
  const marked = reviewViewFor(knowledgeBaseId, tool.noteUuid)
  if (tool.name !== 'read_note' && marked) {
    revealFirstReview(marked)
    return
  }
  const doc = view.state.doc.toString()
  let range: { from: number; to: number } | null = null
  if (tool.name === 'read_note') {
    const lines = tool.summary.match(/第 (\d+)–(\d+) 行/)
    if (lines) range = locateSelection(doc, { startLine: Number(lines[1]), endLine: Number(lines[2]) })
  } else {
    range = locateWritten(doc, String(tool.args.new_string ?? tool.args.content ?? ''))
  }
  if (range) {
    view.dispatch({
      selection: { anchor: range.from, head: range.to },
      effects: EditorView.scrollIntoView(range.from, { y: 'center' })
    })
  }
  view.focus()
}

/** 跳到选区原文并选中；内容挪了位置就按原文重新找，找不到就选中原来那几行。 */
export async function revealSelection(ref: SelectionTarget & { knowledgeBaseId: string; noteUuid: string }): Promise<void> {
  const view = await openNoteIn(ref.knowledgeBaseId, ref.noteUuid)
  if (!view) return
  const range = locateSelection(view.state.doc.toString(), ref)
  if (range) {
    view.dispatch({
      selection: { anchor: range.from, head: range.to },
      effects: EditorView.scrollIntoView(range.from, { y: 'center' })
    })
  }
  view.focus()
}
