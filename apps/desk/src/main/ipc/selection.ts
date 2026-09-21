/**
 * 选区上下文 + 本机 MCP 的 IPC 入口。
 *
 * 渲染端是**唯一**的快照来源（快照必须反映"当前活动编辑器"）；主进程只做校验、
 * 原子替换与失效。MCP 服务端不经过 IPC，直接读 `selectionContext`。
 *
 * **两条边界纪律**（都是踩过的坑）：
 * 1. schema 的传输上限必须**明显高于**语义上限（`SELECTION_TRANSPORT_LIMITS` vs
 *    `SELECTION_LIMITS`）：否则「刚刚超语义上限」的负载会被 schema 挡在门外，
 *    `update()` 没机会执行，旧快照会继续以 `ok` 返回；
 * 2. 校验失败也要让旧快照失效（`onInvalid`）：任何"上报没进来"的情况都不许留下过期内容。
 */
import { z } from 'zod'

import { IPC_CHANNELS, SELECTION_TRANSPORT_LIMITS } from '../../shared/contracts'
import { mcpManager } from '../mcp/manager'
import { selectionContext, type SelectionContextService } from '../selection/selectionService'
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
  // 传输上限，不是语义上限：语义上限在 selectionService（超限要能进来才判得了）
  markdown: z.string().max(SELECTION_TRANSPORT_LIMITS.maxBlockChars),
  source: z.enum(['raw', 'reserialized']),
  sourceRange: z
    .object({ startLine: z.number().int().min(1), endLine: z.number().int().min(1) })
    .optional()
})

const captureSchema = z
  .object({
    collector: z.enum(['source', 'visual', 'readonly']),
    empty: z.boolean(),
    // 传输上限：真正的语义上限（20k / 60k / 20）在 selectionService 里统一判定
    selectedText: z.string().max(SELECTION_TRANSPORT_LIMITS.maxSelectedTextChars).optional(),
    sourceRange: rangeSchema.optional(),
    blocks: z.array(blockSchema).max(SELECTION_TRANSPORT_LIMITS.maxBlocks).optional(),
    unsupportedReason: z.string().max(500).optional(),
    selectedChars: z.number().int().min(0).optional(),
    /** 大到不适合塞进 IPC 时，渲染端只报这个不带正文的超限状态 */
    overLimit: z.string().max(500).optional()
  })
  .refine(
    (capture) =>
      (capture.selectedText?.length ?? 0) +
        (capture.blocks ?? []).reduce((total, block) => total + block.markdown.length, 0) <=
      SELECTION_TRANSPORT_LIMITS.maxTotalChars,
    { message: '选区负载过大' }
  )

const reportSchema = z.object({
  // 切换代次：主进程据此拒收旧编辑器的迟到上报（见 selectionService）
  generation: z.number().int().min(0),
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
  noteId: z.string().min(1).optional(),
  generation: z.number().int().min(0)
})

export function registerSelection(
  getWindow: GetWindow,
  service: SelectionContextService = selectionContext
): void {
  handle(
    IPC_CHANNELS.selectionReport,
    getWindow,
    reportSchema,
    (input) => {
      const outcome = service.update(input)
      return { accepted: outcome.accepted, status: outcome.status, reason: outcome.reason }
    },
    {
      // 上报被 schema 挡下（负载异常大等）：旧快照不能继续以 ok 返回
      onInvalid: (error) => {
        if (!(error instanceof z.ZodError)) return
        service.invalidateNow('选区上报负载不合法（已放弃这一次上报）')
      }
    }
  )
  handle(IPC_CHANNELS.selectionClear, getWindow, clearSchema, (input) => {
    // 关闭笔记 / 切换笔记这类"整篇都走了"的情况，用失效比清除更准确：
    // 之后读到的是 selection_invalidated，而不是"用户没选东西"。
    if (input.reason === 'selection-cancelled') {
      return { cleared: service.clear(input.noteId, input.generation) }
    }
    service.invalidate(input.reason, input.generation)
    return { cleared: true }
  })
  handle(IPC_CHANNELS.mcpStatus, getWindow, z.undefined(), () => mcpManager.status())
  handle(IPC_CHANNELS.mcpSetEnabled, getWindow, z.object({ enabled: z.boolean() }), (input) =>
    mcpManager.setEnabled(input.enabled)
  )
  handle(IPC_CHANNELS.mcpRotateToken, getWindow, z.undefined(), () => mcpManager.rotateToken())
}
