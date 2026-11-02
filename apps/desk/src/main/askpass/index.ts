import { deskLog } from '../log'
import { AskpassServer, type AskpassServerOptions } from './askpassServer'

import type { GitAskpassBridge } from '../gitManager'

let server: AskpassServer | null = null

/** 启动凭据桥；失败只记日志，手动任务退回「不弹凭据框、认证失败即报错」的旧行为。 */
export async function startAskpass(options: AskpassServerOptions): Promise<void> {
  if (server) return
  const next = new AskpassServer(options)
  try {
    await next.start()
    server = next
  } catch (error) {
    deskLog('askpass:start-failed', '', {
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

export function askpassServer(): AskpassServer | null {
  return server
}

export function askpassBridgeFor(runId: string): GitAskpassBridge | undefined {
  return server?.bridgeFor(runId)
}

export async function stopAskpass(): Promise<void> {
  const current = server
  server = null
  await current?.dispose()
}
