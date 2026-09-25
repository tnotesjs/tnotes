import { randomUUID } from 'node:crypto'

import type { BrowserWindow } from 'electron'
import { z } from 'zod'

import { runAgentChat } from '../agent/chat'
import { deskLog } from '../log'
import { clearAgentKey, encryptionAvailable, readAgentKey, writeAgentKey } from '../agent/key'
import { loadSettings } from '../settings'
import { IPC_CHANNELS } from '../../shared/contracts'
import { handle, noInputSchema, type GetWindow } from './shared'

import type { AgentApplyEditResult, AgentKeyStatus, AgentTurnRequest } from '../../shared/contracts'

const pendingApplies = new Map<string, (result: { ok: boolean; message: string }) => void>()
let currentAbort: AbortController | null = null

function keyStatus(): AgentKeyStatus {
  const key = readAgentKey()
  return { configured: Boolean(key && key.trim()), encryptionAvailable: encryptionAvailable() }
}

function requestApply(
  window: BrowserWindow,
  edit: { oldString: string; newString: string }
): Promise<{ ok: boolean; message: string }> {
  const id = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApplies.delete(id)
      resolve({ ok: false, message: '编辑器没有在 8 秒内应用这次修改' })
    }, 8000)
    pendingApplies.set(id, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    if (window.isDestroyed()) {
      clearTimeout(timer)
      pendingApplies.delete(id)
      resolve({ ok: false, message: '主窗口已经关闭' })
      return
    }
    window.webContents.send(IPC_CHANNELS.agentApplyEdit, {
      id,
      oldString: edit.oldString,
      newString: edit.newString
    })
  })
}

export function registerAgent(getWindow: GetWindow): void {
  handle(IPC_CHANNELS.agentKeyStatus, getWindow, noInputSchema, () => keyStatus())
  handle(
    IPC_CHANNELS.agentKeyUpdate,
    getWindow,
    z.object({
      apiKey: z.string().max(4096).optional(),
      clear: z.boolean()
    }),
    ({ apiKey, clear }) => {
      if (clear) {
        clearAgentKey()
        return keyStatus()
      }
      const next = apiKey?.trim()
      if (next) writeAgentKey(next)
      return keyStatus()
    }
  )
  handle(IPC_CHANNELS.agentCancel, getWindow, noInputSchema, () => {
    currentAbort?.abort()
    currentAbort = null
  })
  handle(
    IPC_CHANNELS.agentApplyResult,
    getWindow,
    z.object({
      id: z.string().min(1),
      ok: z.boolean(),
      message: z.string()
    }),
    (result: AgentApplyEditResult) => {
      const resolve = pendingApplies.get(result.id)
      pendingApplies.delete(result.id)
      resolve?.({ ok: result.ok, message: result.message })
    }
  )
  handle(
    IPC_CHANNELS.agentTurn,
    getWindow,
    z.object({
      messages: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(100_000)
          })
        )
        .min(1)
        .max(40),
      note: z
        .object({
          title: z.string(),
          path: z.string(),
          content: z.string().max(400_000),
          selection: z.string().max(20_000)
        })
        .nullable()
    }),
    async (request: AgentTurnRequest) => {
      const window = getWindow()
      if (!window) throw new Error('Desk 主窗口不可用')
      const apiKey = readAgentKey()?.trim()
      if (!apiKey) throw new Error('还没有填写 API Key。打开设置 → 内置 Agent。')
      const settings = loadSettings().agent
      currentAbort?.abort()
      const controller = new AbortController()
      currentAbort = controller
      try {
        return await runAgentChat({
          baseUrl: settings.baseUrl,
          apiKey,
          model: settings.model,
          messages: request.messages,
          note: request.note,
          signal: controller.signal,
          applyEdit: (edit) => requestApply(window, edit),
          onRequest: ({ url, model }) => {
            deskLog('agent', 'request', { url, model })
            if (window.isDestroyed()) return
            const line = JSON.stringify(`[agent] POST ${url}  model=${model}`)
            void window.webContents.executeJavaScript(`console.log(${line})`)
          }
        })
      } catch (error) {
        if (controller.signal.aborted) throw new Error('已停止')
        throw error
      } finally {
        if (currentAbort === controller) currentAbort = null
      }
    }
  )
}
