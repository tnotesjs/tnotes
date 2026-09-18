import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

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
/** 单次写入的字符上限（渲染端按 32K 分片，这里留余量） */
export const WRITE_CHUNK_LIMIT = 64 * 1024
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
    // 目录归属在创建时定死：cwd 缺省用当前知识库根目录。
    // 注意这只限制**初始工作目录**——shell 起来后用户可以自己 `cd` 到任何地方，
    // 这里不是"把终端关在知识库里"。
    const location = workspaceManager.getLocation(input.knowledgeBaseId)
    const cwd = input.cwd ? resolveInitialCwd(location.rootPath, input.cwd) : location.rootPath
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
    // 渲染端按 32K 字符分片（见 TerminalPane 的写队列），所以这里留出余量；
    // 超限会返回错误而不是被静默截断，渲染端负责提示。
    z.object({
      sessionId: z.string().min(1),
      data: z.string().max(WRITE_CHUNK_LIMIT),
      generation: z.number().int().min(1)
    }),
    (input) => {
      terminalManager.write(input.sessionId, input.data, input.generation)
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
      generation: z.number().int().min(1),
      bytes: z
        .number()
        .int()
        .min(0)
        .max(64 * 1024 * 1024)
    }),
    (input) => {
      terminalManager.ack(input.sessionId, input.bytes, input.generation)
    }
  )

  return () => {
    offChanged()
    offData()
  }
}

/**
 * 校验并规范化「初始工作目录」。
 *
 * 三件事缺一不可，纯字符串前缀比较是不够的：
 *  1. **规范化**：`<根>/../别处` 这种靠 `path` 语义逃逸的路径必须先解析掉再比；
 *  2. **真实路径**：符号链接要按 `realpath` 解析，否则库内一个指向库外的软链就能绕开；
 *  3. **确认是目录**：不存在的路径或普通文件不该被当成工作目录。
 *
 * 越界时直接报错，而不是悄悄换成根目录——静默兜底会让「在这个目录打开」变成
 * 「在别处打开」，用户更难发现问题。
 */
export function resolveInitialCwd(rootPath: string, candidate: string): string {
  let realRoot: string
  let realTarget: string
  try {
    realRoot = realpathSync(rootPath)
    realTarget = realpathSync(candidate)
  } catch {
    throw new Error('终端工作目录不存在或无法访问')
  }

  let stats
  try {
    stats = statSync(realTarget)
  } catch {
    throw new Error('终端工作目录不存在或无法访问')
  }
  if (!stats.isDirectory()) throw new Error('终端工作目录必须是一个目录')

  // 用 path.relative 判定包含关系：跨平台正确，且不会被 `<根>-backup` 这类
  // 同前缀路径骗过（`startsWith` 的经典漏洞）。
  const rel = relative(realRoot, realTarget)
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  if (rel !== '' && outside) throw new Error('终端工作目录必须在知识库根目录内')

  return realTarget
}
