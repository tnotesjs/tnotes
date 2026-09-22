/**
 * Agent 上下文（当前活动笔记）的 IPC 入口。
 *
 * 只做校验与转发：真相在渲染端（活动标签），主进程按代次水位收消息。
 */
import { z } from 'zod'

import { IPC_CHANNELS } from '../../shared/contracts'
import { activeNoteService, type ActiveNoteService } from '../context/activeNoteService'
import { handle } from './shared'

import type { GetWindow } from './shared'

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
  service: ActiveNoteService = activeNoteService
): void {
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
