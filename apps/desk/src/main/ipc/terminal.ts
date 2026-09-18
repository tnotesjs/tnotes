import { z } from 'zod'

import { terminalManager } from '../terminalManager'
import { workspaceManager } from '../workspaceManager'
import { IPC_CHANNELS } from '../../shared/contracts'
import { handle, type GetWindow } from './shared'

const createSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  cwd: z.string().min(1).max(4096).optional(),
  cols: z.number().int().min(2).max(1000).optional(),
  rows: z.number().int().min(1).max(500).optional()
})

const idSchema = z.object({ sessionId: z.string().min(1) })
const resizeSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(500)
})

export function registerTerminal(getWindow: GetWindow): () => void {
  const offChanged = terminalManager.onChanged((state) => {
    getWindow()?.webContents.send(IPC_CHANNELS.terminalChanged, state)
  })
  const offData = terminalManager.onData((event) => {
    getWindow()?.webContents.send(IPC_CHANNELS.terminalData, event)
  })

  handle(IPC_CHANNELS.terminalCreate, getWindow, createSchema, (input) => {
    // 目录归属在这里定死：cwd 缺省用当前知识库根目录，显式传入时必须是它内部路径
    // （不变量：终端只能在知识库范围内工作，避免把命令跑进无关目录）。
    const location = workspaceManager.getLocation(input.knowledgeBaseId)
    const cwd = input.cwd ? resolveWithin(location.rootPath, input.cwd) : location.rootPath
    return terminalManager.create({
      knowledgeBaseId: input.knowledgeBaseId,
      knowledgeBaseName: location.name,
      cwd,
      cols: input.cols,
      rows: input.rows
    })
  })

  handle(IPC_CHANNELS.terminalList, getWindow, z.undefined(), () => terminalManager.list())

  handle(IPC_CHANNELS.terminalRestart, getWindow, idSchema, (input) =>
    terminalManager.restart(input.sessionId)
  )

  handle(
    IPC_CHANNELS.terminalRename,
    getWindow,
    z.object({ sessionId: z.string().min(1), title: z.string().max(120) }),
    (input) => terminalManager.rename(input.sessionId, input.title)
  )

  handle(IPC_CHANNELS.terminalClose, getWindow, idSchema, (input) => {
    terminalManager.close(input.sessionId)
  })

  handle(
    IPC_CHANNELS.terminalWrite,
    getWindow,
    z.object({ sessionId: z.string().min(1), data: z.string().max(64 * 1024) }),
    (input) => {
      terminalManager.write(input.sessionId, input.data)
    }
  )

  handle(IPC_CHANNELS.terminalResize, getWindow, resizeSchema, (input) => {
    terminalManager.resize(input.sessionId, input.cols, input.rows)
  })

  handle(
    IPC_CHANNELS.terminalAck,
    getWindow,
    z.object({
      sessionId: z.string().min(1),
      bytes: z
        .number()
        .int()
        .min(0)
        .max(64 * 1024 * 1024)
    }),
    (input) => {
      terminalManager.ack(input.sessionId, input.bytes)
    }
  )

  return () => {
    offChanged()
    offData()
  }
}

/** 只接受知识库根目录内部的路径，越界直接报错而不是悄悄改用根目录。 */
function resolveWithin(rootPath: string, candidate: string): string {
  const normalizedRoot = rootPath.endsWith('/') ? rootPath : `${rootPath}/`
  if (candidate === rootPath || candidate.startsWith(normalizedRoot)) return candidate
  throw new Error('终端工作目录必须在知识库根目录内')
}
