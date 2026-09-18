import { spawn } from 'node:child_process'
import { Menu, type BrowserWindow, type MenuItemConstructorOptions, shell } from 'electron'

import { loadSettings } from './settings'

function ideLabel(): string {
  return loadSettings().ide === 'cursor' ? 'Cursor' : 'VSCode'
}

export async function openInConfiguredIde(targetPath: string): Promise<void> {
  const ide = loadSettings().ide
  let child: ReturnType<typeof spawn>
  if (process.platform === 'darwin') {
    const application = ide === 'cursor' ? 'Cursor' : 'Visual Studio Code'
    child = spawn('/usr/bin/open', ['-a', application, targetPath], {
      detached: true,
      stdio: 'ignore'
    })
  } else {
    const command =
      process.platform === 'win32' ? `${ide}.cmd` : ide === 'cursor' ? 'cursor' : 'code'
    child = spawn(command, [targetPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
  }
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
    child.once('error', reject)
  })
}

export function showIdeContextMenu(
  window: BrowserWindow,
  targetPath: string,
  links?: { repositoryUrl?: string; pageUrl?: string },
  options?: {
    onOpenSettings?: () => void
    onOpenAssets?: () => void
    onOpenTerminal?: () => void
  }
): void {
  const template: MenuItemConstructorOptions[] = []
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
