/**
 * 选区上下文 + 本机 MCP 的 IPC 入口。
 *
 * 渲染端是**唯一**的快照来源（快照必须反映"当前活动编辑器"）；主进程只做校验、
 * 原子替换与失效。MCP 服务端不经过 IPC，直接读 `selectionContext`。
 */
import { z } from 'zod'

import { IPC_CHANNELS } from '../../shared/contracts'
import { mcpManager } from '../mcp/manager'
import { selectionContext } from '../selection/selectionService'
import { handle } from './shared'

import type { GetWindow } from './shared'

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

const blockSchema = z.object({
  kind: z.string().min(1).max(80),
  markdown: z.string().max(60_000),
  source: z.enum(['raw', 'reserialized']),
  sourceRange: z
    .object({ startLine: z.number().int().min(1), endLine: z.number().int().min(1) })
    .optional()
})

const captureSchema = z.object({
  collector: z.enum(['source', 'visual', 'readonly']),
  empty: z.boolean(),
  // 上限在 selectionService 里统一判定（超限要给结构化原因，不在这里截断）
  selectedText: z.string().max(500_000).optional(),
  sourceRange: rangeSchema.optional(),
  blocks: z.array(blockSchema).max(200).optional(),
  unsupportedReason: z.string().max(500).optional(),
  selectedChars: z.number().int().min(0).optional()
})

const reportSchema = z.object({
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
    viewMode: z.enum(['visual', 'readonly', 'source']),
    contentSource: z.enum(['draft', 'disk']),
    hasUnsavedChanges: z.boolean(),
    revision: z.string()
  }),
  capture: captureSchema
})

const clearSchema = z.object({
  reason: z.string().min(1).max(200),
  noteId: z.string().min(1).optional()
})

export function registerSelection(getWindow: GetWindow): void {
  handle(IPC_CHANNELS.selectionReport, getWindow, reportSchema, (input) => {
    const outcome = selectionContext.update(input)
    return { accepted: outcome.accepted }
  })
  handle(IPC_CHANNELS.selectionClear, getWindow, clearSchema, (input) => {
    // 关闭笔记 / 切换笔记这类"整篇都走了"的情况，用失效比清除更准确：
    // 之后读到的是 selection_invalidated，而不是"用户没选东西"。
    if (input.reason === 'selection-cancelled') {
      return { cleared: selectionContext.clear(input.noteId) }
    }
    selectionContext.invalidate(input.reason)
    return { cleared: true }
  })
  handle(IPC_CHANNELS.mcpStatus, getWindow, z.undefined(), () => mcpManager.status())
  handle(IPC_CHANNELS.mcpSetEnabled, getWindow, z.object({ enabled: z.boolean() }), (input) =>
    mcpManager.setEnabled(input.enabled)
  )
  handle(IPC_CHANNELS.mcpRotateToken, getWindow, z.undefined(), () => mcpManager.rotateToken())
}
