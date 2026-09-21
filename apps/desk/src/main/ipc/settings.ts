import { readFileSync, writeFileSync } from 'node:fs'
import { dialog } from 'electron'
import { z } from 'zod'

import { encodeManager } from '../encodeManager'
import { gitManager } from '../gitManager'
import { mcpManager } from '../mcp/manager'
import { validateGitHubImageSettings } from '../imageBed'
import { clearGitHubToken, imageTokenStatus, saveGitHubToken } from '../imageSecret'
import { toEncodeImageOptions } from '../optimizeStrength'
import {
  importSettings,
  readSettingsFile,
  resetSettings,
  saveSettings,
  writeSettingsRaw
} from '../settings'
import { updateManager } from '../updateManager'
import { webContentsManager } from '../webContentsManager'
import { IPC_CHANNELS } from '../../shared/contracts'
import { githubImageSettingsSchema, imageOptimizePreviewSchema } from './schemas'
import { handle, noInputSchema, type GetWindow } from './shared'

import type { AppSettings } from '../../shared/contracts'

export function registerSettings(getWindow: GetWindow): void {
  function applyRuntimeSettings(settings: AppSettings): AppSettings {
    // 本机 MCP：开关 / 端口变化时幂等地重新应用（端口没变且已在跑就不动）
    void mcpManager.applySettings()
    gitManager.applyAutoPushSchedules(true)
    // 后台自动抓取开关：关掉立刻停定时器与等待队列，打开则立刻安排一轮
    gitManager.applyBackgroundFetchPreference()
    updateManager.configure(settings.updates.autoCheck)
    webContentsManager.setZoomFactor(settings.appZoomPercent / 100)
    return settings
  }

  handle(IPC_CHANNELS.settingsUpdate, getWindow, z.record(z.string(), z.unknown()), (input) => {
    const settings = saveSettings(input as Partial<AppSettings>)
    return applyRuntimeSettings(settings)
  })
  handle(IPC_CHANNELS.settingsExport, getWindow, noInputSchema, async () => {
    const window = getWindow()
    if (!window) throw new Error('Desk 主窗口不可用')
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: '导出配置',
      defaultPath: '.tn-desk-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return
    writeFileSync(filePath, readSettingsFile(), 'utf8')
  })
  handle(IPC_CHANNELS.settingsImport, getWindow, noInputSchema, async () => {
    const window = getWindow()
    if (!window) throw new Error('Desk 主窗口不可用')
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: '导入配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePaths[0]) throw new Error('未选择配置文件')
    const settings = importSettings(readFileSync(filePaths[0], 'utf8'))
    return applyRuntimeSettings(settings)
  })
  handle(IPC_CHANNELS.settingsReset, getWindow, noInputSchema, () => {
    const settings = resetSettings()
    return applyRuntimeSettings(settings)
  })
  handle(IPC_CHANNELS.settingsReadRaw, getWindow, noInputSchema, () => readSettingsFile())
  handle(IPC_CHANNELS.settingsWriteRaw, getWindow, z.string(), (json) => {
    const settings = writeSettingsRaw(json)
    return applyRuntimeSettings(settings)
  })
  handle(IPC_CHANNELS.imageTokenStatus, getWindow, noInputSchema, () => imageTokenStatus())
  handle(
    IPC_CHANNELS.imageTokenUpdate,
    getWindow,
    z.object({
      token: z.string().max(2048).optional(),
      clear: z.boolean()
    }),
    ({ token, clear }) => {
      if (clear) return clearGitHubToken()
      if (token?.trim()) return saveGitHubToken(token)
      return imageTokenStatus()
    }
  )
  handle(
    IPC_CHANNELS.imageSettingsValidate,
    getWindow,
    z.object({
      github: githubImageSettingsSchema,
      token: z.string().max(2048).optional()
    }),
    ({ github, token }) => validateGitHubImageSettings(github, token)
  )
  handle(
    IPC_CHANNELS.imageOptimizePreview,
    getWindow,
    imageOptimizePreviewSchema,
    async ({ fileName, data, options }) => {
      // 只编码到内存：不落盘、不写知识库，渲染进程关闭面板即丢弃。
      // 设置页试压与粘贴上传一致：不按最大边缩放。
      const result = await encodeManager.encode(
        data,
        fileName,
        toEncodeImageOptions({ ...options, maxDimension: null })
      )
      return {
        bytesBefore: result.bytesBefore,
        bytesAfter: result.bytesAfter,
        width: result.width,
        height: result.height,
        ms: result.ms,
        lossy: result.lossy,
        encoder: result.encoder,
        format: result.format,
        outputExt: result.outputExt,
        skipped: result.skipped,
        output: result.output
      }
    }
  )
}
