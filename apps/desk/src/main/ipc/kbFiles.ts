import { workspaceManager } from '../workspaceManager'
import { IPC_CHANNELS } from '../../shared/contracts'
import {
  kbFilesListSchema,
  kbFilesReadSchema,
  kbReadmeReadSchema,
  kbReadmeWriteSchema
} from './schemas'
import { handle, type GetWindow } from './shared'

/**
 * 知识库文件浏览（Monaco 文本入口）。
 *
 * 只读、只列一层：拒绝名单（`.git` / `node_modules` / 生成目录）与"是不是文本"
 * 全部在主进程按字节判定，渲染端拿不到任意文件系统访问，也无法靠改扩展名绕过。
 */
export function registerKbFiles(getWindow: GetWindow): () => void {
  handle(IPC_CHANNELS.kbFilesList, getWindow, kbFilesListSchema, (input) =>
    workspaceManager.listKbFiles(input.knowledgeBaseId, input.relPath)
  )
  handle(IPC_CHANNELS.kbFilesRead, getWindow, kbFilesReadSchema, (input) =>
    workspaceManager.readKbTextFile(input.knowledgeBaseId, input.relPath)
  )
  // README 是唯一开放写入的普通文件：路径固定在库根，渲染端传不进别的路径。
  handle(IPC_CHANNELS.kbReadmeRead, getWindow, kbReadmeReadSchema, (input) =>
    workspaceManager.readKbReadme(input.knowledgeBaseId, Boolean(input.create))
  )
  handle(IPC_CHANNELS.kbReadmeWrite, getWindow, kbReadmeWriteSchema, (input) =>
    workspaceManager.writeKbReadme(input.knowledgeBaseId, input.content, input.baseRevision)
  )
  return () => undefined
}
