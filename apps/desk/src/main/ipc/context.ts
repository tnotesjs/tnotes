/**
 * Agent 上下文（当前活动笔记）的 IPC 入口。
 *
 * 只做校验与转发：真相在渲染端（活动标签），主进程按代次水位收消息。
 */
import { z } from 'zod'

import { BrowserWindow } from 'electron'

import { IPC_CHANNELS } from '../../shared/contracts'
import { activeNoteService, type ActiveNoteService } from '../context/activeNoteService'
import { pinnedContext, type PinnedContextService } from '../context/pinnedContextService'
import { workspaceManager } from '../workspaceManager'
import { handle } from './shared'

import type { GetWindow } from './shared'

const blockSchema = z.object({
  kind: z.string().min(1).max(80),
  markdown: z.string().max(1_000_000),
  source: z.enum(['raw', 'reserialized']),
  sourceRange: z
    .object({ startLine: z.number().int().min(1), endLine: z.number().int().min(1) })
    .optional()
})

const rangeSchema = z.object({
  startLine: z.number().int().min(1),
  startColumn: z.number().int().min(1),
  endLine: z.number().int().min(1),
  endColumn: z.number().int().min(1),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  lineBase: z.literal(1),
  columnBase: z.literal(1),
  endExclusive: z.literal(true),
  source: z.enum(['draft', 'disk'])
})

const anchorSchema = z.object({
  view: z.enum(['source', 'visual']),
  kind: z.enum(['source-range', 'block']),
  sourceRange: rangeSchema.optional(),
  // 位置锚：跨视图 / 磁盘复核的唯一判据（漏掉它固定会被拒，所以这里必须有）
  textRange: z
    .object({
      startOffset: z.number().int().min(0),
      endOffset: z.number().int().min(0),
      expected: z.string().max(1_000_000)
    })
    .optional(),
  ranges: z
    .array(
      z.object({
        startOffset: z.number().int().min(0),
        endOffset: z.number().int().min(0),
        expected: z.string().max(1_000_000)
      })
    )
    .max(200)
    .optional(),
  code: z
    .object({
      from: z.number().int().min(0),
      to: z.number().int().min(0),
      expected: z.string().max(1_000_000)
    })
    .optional(),
  blocks: z
    .array(
      z.object({
        pos: z.number().int().min(0),
        kind: z.string().min(1).max(80),
        markdown: z.string().max(1_000_000)
      })
    )
    .max(200)
    .optional(),
  from: z.number().int().min(0).optional(),
  to: z.number().int().min(0).optional(),
  nodeSelection: z.boolean().optional()
})

const pinSelectionSchema = z.object({
  owner: z.object({
    groupId: z.string().min(1),
    tabId: z.string().min(1),
    knowledgeBaseId: z.string().min(1),
    noteUuid: z.string().min(1)
  }),
  knowledgeBase: z.object({
    id: z.string().min(1),
    name: z.string(),
    rootPath: z.string().min(1)
  }),
  note: z.object({
    id: z.string().min(1),
    title: z.string(),
    absolutePath: z.string().min(1)
  }),
  editor: z.object({
    viewMode: z.enum(['visual', 'source']),
    contentSource: z.enum(['draft', 'disk']),
    hasUnsavedChanges: z.boolean(),
    revision: z.string()
  }),
  capture: z.object({
    collector: z.enum(['source', 'visual']),
    empty: z.boolean(),
    selectedText: z.string().max(1_000_000).optional(),
    sourceRange: rangeSchema.optional(),
    blocks: z.array(blockSchema).max(200).optional(),
    unsupportedReason: z.string().max(500).optional(),
    overLimit: z.string().max(500).optional()
  }),
  anchor: anchorSchema
})

const pinValidateSchema = z.object({
  pinId: z.string().min(1),
  valid: z.boolean(),
  reason: z.string().max(300).optional()
})

const pinDiskRevalidateSchema = z.object({
  pinId: z.string().min(1),
  knowledgeBaseId: z.string().min(1),
  noteUuid: z.string().min(1)
})

const pinClearSchema = z.object({
  reason: z.string().min(1).max(200)
})

const noteViewModeSchema = z.enum(['visual', 'source'])

const activeNoteReportSchema = z.object({
  generation: z.number().int().min(0),
  knowledgeBase: z.object({
    id: z.string().min(1),
    name: z.string(),
    rootPath: z.string().min(1)
  }),
  note: z.object({
    id: z.string().min(1),
    title: z.string(),
    absolutePath: z.string().min(1),
    relPath: z.string().min(1)
  }),
  editor: z.object({
    viewMode: noteViewModeSchema,
    hasUnsavedChanges: z.boolean()
  })
})

const activeNoteClearSchema = z.object({
  reason: z.string().min(1).max(200),
  generation: z.number().int().min(0)
})

export function registerContext(
  getWindow: GetWindow,
  service: ActiveNoteService = activeNoteService,
  pinService: PinnedContextService = pinnedContext
): void {
  // 固定上下文变化 → 广播给所有窗口（状态条在任意标签下都要看得见）
  pinService.onChanged((context) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send(IPC_CHANNELS.contextPinChanged, context)
    }
  })
  handle(IPC_CHANNELS.contextPinSelection, getWindow, pinSelectionSchema, (input) =>
    pinService.pin(input)
  )
  handle(IPC_CHANNELS.contextPinValidate, getWindow, pinValidateSchema, (input) => {
    pinService.validate(input)
    return { state: pinService.read().state }
  })
  handle(
    IPC_CHANNELS.contextPinRevalidateFromDisk,
    getWindow,
    pinDiskRevalidateSchema,
    async (input) => {
      // 磁盘才是"外部修改"的真相：读不到就明确失效，绝不拿编辑器里的旧内容蒙混
      const document = await workspaceManager
        .readNote(input.knowledgeBaseId, input.noteUuid)
        .catch(() => null)
      if (!document) {
        pinService.invalidate('来源笔记已无法读取（可能已被删除或移动）', input.pinId)
      } else {
        pinService.revalidateAgainst(document.content, input.pinId)
      }
      return { state: pinService.read().state }
    }
  )
  handle(IPC_CHANNELS.contextPinClear, getWindow, pinClearSchema, (input) => ({
    cleared: pinService.clear(input.reason)
  }))

  // 负载不合法 = 这次上报/清除没进来：宁可没有当前笔记，也不留旧路径
  const onInvalid = (error: unknown): void => {
    if (!(error instanceof z.ZodError)) return
    service.clearNow('活动笔记上报负载不合法（已放弃这一次上报）')
  }
  handle(
    IPC_CHANNELS.contextActiveNoteReport,
    getWindow,
    activeNoteReportSchema,
    (input) => service.update(input),
    { onInvalid }
  )
  handle(
    IPC_CHANNELS.contextActiveNoteClear,
    getWindow,
    activeNoteClearSchema,
    (input) => ({ cleared: service.clear(input.reason, input.generation) }),
    { onInvalid }
  )
}
