/**
 * 本机 MCP 服务的生命周期管理（主进程单例）。
 *
 * 把「设置里的开关 / 端口」与「`McpSelectionServer`」接起来，并向渲染端广播状态变化：
 * - 应用启动时按设置决定是否启动；
 * - 设置里开关或端口变化时**幂等**地重新应用（端口没变且已在运行就不动它）；
 * - 退出时停止服务、释放端口、关闭现有会话；
 * - 状态变化（启动成功 / 端口占用 / 令牌重置）推给设置界面。
 */
import { BrowserWindow } from 'electron'

import { DEFAULT_MCP_PORT, IPC_CHANNELS } from '../../shared/contracts'
import { deskLog } from '../log'
import { loadSettings } from '../settings'
import { McpSelectionServer } from './server'

import type { McpServerStatusDto } from '../../shared/contracts'

interface AppliedConfig {
  enabled: boolean
  port: number
}

class McpManager {
  private server: McpSelectionServer | null = null
  private applied: AppliedConfig | null = null
  private readonly listeners = new Set<(status: McpServerStatusDto) => void>()

  /** 按当前设置启动 / 停止（应用启动与设置变更都走这里，幂等） */
  async applySettings(): Promise<McpServerStatusDto> {
    const settings = loadSettings()
    const next: AppliedConfig = {
      enabled: settings.mcp?.enabled ?? false,
      port: settings.mcp?.port ?? DEFAULT_MCP_PORT
    }
    const sameConfig = this.applied?.enabled === next.enabled && this.applied?.port === next.port
    if (sameConfig && (!next.enabled || this.server?.isRunning)) return this.status()

    if (!next.enabled) {
      const stopped = this.server ? await this.server.stop() : null
      this.server = null
      this.applied = next
      const status = stopped ?? this.status()
      this.broadcast({ ...status, enabled: false })
      return { ...status, enabled: false }
    }

    if (this.server) {
      await this.server.stop()
      this.server = null
    }
    const server = new McpSelectionServer({ port: next.port })
    this.server = server
    this.applied = next
    const status = await server.start(true)
    this.broadcast(status)
    return status
  }

  status(): McpServerStatusDto {
    if (this.server) return this.server.status()
    const settings = loadSettings()
    const probe = new McpSelectionServer({ port: settings.mcp?.port ?? DEFAULT_MCP_PORT })
    return { ...probe.status(), enabled: this.applied?.enabled ?? Boolean(settings.mcp?.enabled) }
  }

  async setEnabled(enabled: boolean): Promise<McpServerStatusDto> {
    if (!enabled) {
      if (!this.server) {
        this.applied = { ...this.configured(), enabled: false }
        return this.status()
      }
      const status = await this.server.stop()
      this.server = null
      this.applied = { ...this.configured(), enabled: false }
      const next = { ...status, enabled: false }
      this.broadcast(next)
      return next
    }
    // 打开：清掉 applied 让它按最新设置重建
    this.applied = null
    return this.applySettings()
  }

  /** 令牌轮换：未运行时也允许（生成后写盘，等下次启动使用） */
  async rotateToken(): Promise<McpServerStatusDto> {
    const server = this.server ?? new McpSelectionServer({ port: this.configured().port })
    this.server = server
    const status = await server.rotate()
    this.broadcast({ ...status, enabled: this.server.status().enabled })
    return status
  }

  async dispose(): Promise<void> {
    if (!this.server) return
    const status = await this.server.stop()
    this.server = null
    this.broadcast({ ...status, enabled: false })
  }

  onChanged(listener: (status: McpServerStatusDto) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private configured(): AppliedConfig {
    const settings = loadSettings()
    return {
      enabled: settings.mcp?.enabled ?? false,
      port: settings.mcp?.port ?? DEFAULT_MCP_PORT
    }
  }

  private broadcast(status: McpServerStatusDto): void {
    for (const listener of this.listeners) listener(status)
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send(IPC_CHANNELS.mcpChanged, status)
    }
    deskLog('mcp', '状态变化', {
      enabled: status.enabled,
      running: status.running,
      error: status.error
    })
  }
}

export const mcpManager = new McpManager()
