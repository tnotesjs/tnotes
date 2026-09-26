import { spawn } from 'node:child_process'
import { Menu, type BrowserWindow, type MenuItemConstructorOptions, shell } from 'electron'

import { deskLog } from './log'
import { loadSettings } from './settings'

function ideLabel(): string {
  return loadSettings().ide === 'cursor' ? 'Cursor' : 'VSCode'
}

export interface IdeLaunchSpec {
  command: string
  args: string[]
  /** macOS 用 `open -a`；其它平台直接调 IDE 的 CLI */
  detached: boolean
}

/**
 * 按平台给出启动器命令，**保留各平台既有方式**（macOS 仍是 `open -a`，
 * 不统一改成 `code` / `cursor`）。
 */
export function ideLaunchSpec(targetPath: string): IdeLaunchSpec {
  const ide = loadSettings().ide
  if (process.platform === 'darwin') {
    const application = ide === 'cursor' ? 'Cursor' : 'Visual Studio Code'
    return { command: '/usr/bin/open', args: ['-a', application, targetPath], detached: true }
  }
  const command = process.platform === 'win32' ? `${ide}.cmd` : ide === 'cursor' ? 'cursor' : 'code'
  return { command, args: [targetPath], detached: true }
}

export function formatIdeCommand(spec: IdeLaunchSpec): string {
  return [spec.command, ...spec.args]
    .map((part) => (/[\s"']/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(' ')
}

export interface IdeLaunchResult {
  ok: boolean
  command: string
  targetPath: string
  exitCode: number | null
  stdout: string
  stderr: string
  error: string | null
}

/**
 * 启动 IDE 并**等待启动器退出**后报告结果。
 *
 * 原来的实现只等 `spawn` 事件：那只能说明进程被创建，`open -a 不存在的应用`
 * 或 CLI 非零退出都会被当成成功。这里改为等 `close` 并检查退出码。
 *
 * 注意：只有**启动器**归我们管；IDE 本身是用户的应用，任务结束或取消都不能去关它。
 */
export function launchIde(
  targetPath: string,
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void,
  specOverride?: IdeLaunchSpec
): Promise<IdeLaunchResult> {
  const spec = specOverride ?? ideLaunchSpec(targetPath)
  const command = formatIdeCommand(spec)
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      detached: spec.detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
      onOutput?.('stdout', chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
      onOutput?.('stderr', chunk.toString('utf8'))
    })
    child.once('error', (error) => {
      resolve({
        ok: false,
        command,
        targetPath,
        exitCode: null,
        stdout: '',
        stderr: '',
        error: error.message
      })
    })
    child.once('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      // 启动器把目标交给了 IDE，之后 IDE 的生命周期与我们无关
      try {
        child.unref()
      } catch {
        /* 已退出 */
      }
      resolve({
        ok: code === 0,
        command,
        targetPath,
        exitCode: code,
        stdout,
        stderr,
        error: code === 0 ? null : stderr.trim() || `启动器退出码 ${code}`
      })
    })
  })
}

/** 兼容旧调用点：只关心成功与否，失败时抛出带启动器输出的错误。 */
export async function openInConfiguredIde(targetPath: string): Promise<void> {
  const result = await launchIde(targetPath)
  if (!result.ok) {
    deskLog('ide:launch-failed', 'launcher exited non-zero', {
      targetPath,
      error: result.error ?? '',
      exitCode: result.exitCode
    })
    throw new Error(result.error ?? '启动 IDE 失败')
  }
}

export function showIdeContextMenu(
  window: BrowserWindow,
  targetPath: string,
  links?: { repositoryUrl?: string; pageUrl?: string },
  options?: {
    onOpenSettings?: () => void
    onOpenAssets?: () => void
    onOpenTerminal?: () => void
    onTogglePin?: () => void
    pinned?: boolean
  }
): void {
  const template: MenuItemConstructorOptions[] = []
  if (options?.onTogglePin) {
    template.push(
      {
        label: options.pinned ? '取消置顶' : '置顶',
        click: () => options.onTogglePin?.()
      },
      { type: 'separator' }
    )
  }
  if (options?.onOpenSettings || options?.onOpenAssets) {
    if (options.onOpenAssets) {
      template.push({
        label: '资源',
        click: () => options.onOpenAssets?.()
      })
    }
    if (options.onOpenSettings) {
      template.push({
        label: '知识库配置',
        click: () => options.onOpenSettings?.()
      })
    }
    template.push({ type: 'separator' })
  }
  template.push(
    {
      label: '在终端中打开',
      enabled: Boolean(options?.onOpenTerminal),
      click: () => options?.onOpenTerminal?.()
    },
    {
      label: `在 ${ideLabel()} 中打开`,
      click: () => void openInConfiguredIde(targetPath)
    },
    { type: 'separator' },
    {
      label: '在文件管理器中显示',
      click: () => shell.showItemInFolder(targetPath)
    }
  )
  if (links?.repositoryUrl || links?.pageUrl) {
    template.push(
      { type: 'separator' },
      {
        label: '打开 GitHub 仓库',
        enabled: Boolean(links.repositoryUrl),
        click: () => links.repositoryUrl && void shell.openExternal(links.repositoryUrl)
      },
      {
        label: '打开 GitHub Page',
        enabled: Boolean(links.pageUrl),
        click: () => links.pageUrl && void shell.openExternal(links.pageUrl)
      }
    )
  }
  const menu = Menu.buildFromTemplate(template)
  menu.popup({ window })
}
