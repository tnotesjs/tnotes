import { z } from 'zod'

import { askpassServer } from '../askpass'
import { commandTaskManager } from '../commandTaskManager'
import { IPC_CHANNELS } from '../../shared/contracts'
import { handle } from './shared'

import type { BrowserWindow } from 'electron'
import type { AskpassPromptDto } from '../../shared/contracts'

/** 把 git 的凭据询问转给界面，并接收作答。 */
export function registerAskpass(getWindow: () => BrowserWindow | null): () => void {
  const server = askpassServer()
  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  const offRequest = server?.onRequest((prompt) => {
    const window = getWindow()
    if (!window || window.isDestroyed()) {
      server.answer(prompt.id, null)
      return
    }
    const [taskId] = prompt.runId.split(':')
    const task = commandTaskManager.list().find((item) => item.id === taskId)
    const dto: AskpassPromptDto = {
      id: prompt.id,
      prompt: prompt.prompt,
      secret: prompt.secret,
      taskTitle: task?.title ?? null,
      knowledgeBaseName: task?.knowledgeBaseName ?? null
    }
    send(IPC_CHANNELS.askpassRequest, dto)
  })
  const offDismiss = server?.onDismiss((id) => send(IPC_CHANNELS.askpassDismiss, id))

  handle(
    IPC_CHANNELS.askpassAnswer,
    getWindow,
    z.object({ id: z.string().min(1), value: z.string().max(4096).nullable() }),
    (input) => {
      askpassServer()?.answer(input.id, input.value)
    }
  )

  return () => {
    offRequest?.()
    offDismiss?.()
  }
}
