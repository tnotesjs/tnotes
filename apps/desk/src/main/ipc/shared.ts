import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'

import { deskLog } from '../log'

import type { KbError } from '@tnotesjs/kb'
import type { DeskError, DeskResult } from '../../shared/contracts'

export function assertSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null
): void {
  const window = getWindow()
  if (!window || event.sender.id !== window.webContents.id) {
    throw new Error('拒绝来自未知页面的 IPC 请求')
  }
}

export function toDeskError(error: unknown): DeskError {
  const diagnosticId = randomUUID()
  if (error instanceof z.ZodError) {
    // zod 的 issue 里带着 schema 实例（`ZodString` 内含 `RegExp`），
    // **structured clone 克隆不了**：IPC 会以
    // 「An object could not be cloned.」失败，连"请求参数无效"都传不回渲染端，
    // 调用方只会看到一个看不懂的克隆错误。只回传纯数据。
    return {
      code: 'INVALID_REQUEST',
      message: '请求参数无效',
      diagnosticId,
      details: {
        issues: error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map((segment) => String(segment)),
          message: issue.message
        }))
      }
    }
  }

  const workspaceError = error as Partial<KbError>
  const code = typeof workspaceError?.code === 'string' ? workspaceError.code : 'INTERNAL_ERROR'
  const message = error instanceof Error ? error.message : '发生了无法识别的内部错误'
  deskLog('ipc:error', diagnosticId, { code, message })
  return {
    code,
    message,
    diagnosticId,
    details:
      workspaceError?.details && typeof workspaceError.details === 'object'
        ? workspaceError.details
        : undefined
  }
}

export interface HandleOptions {
  /**
   * 参数校验失败时的兜底（仍会照常把 `INVALID_REQUEST` 回给渲染端）。
   *
   * 给"不能留下过期状态"的通道用：例如选区上报被 schema 挡下时，
   * 必须让主进程里的旧快照失效，否则工具会一直返回上一次的选区。
   */
  onInvalid?: (error: unknown) => void
}

export function handle<TInput, TOutput>(
  channel: string,
  getWindow: () => BrowserWindow | null,
  schema: z.ZodType<TInput>,
  operation: (input: TInput) => Promise<TOutput> | TOutput,
  options: HandleOptions = {}
): void {
  ipcMain.handle(channel, async (event, rawInput): Promise<DeskResult<TOutput>> => {
    try {
      assertSender(event, getWindow)
      const input = schema.parse(rawInput)
      return { ok: true, value: await operation(input) }
    } catch (error) {
      try {
        options.onInvalid?.(error)
      } catch (fallbackError) {
        deskLog('ipc:onInvalid', channel, {
          message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        })
      }
      return { ok: false, error: toDeskError(error) }
    }
  })
}

export const noInputSchema = z.undefined()

export type GetWindow = () => BrowserWindow | null
