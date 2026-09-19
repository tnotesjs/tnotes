import type { MenuItemConstructorOptions } from 'electron'

import type { TabShortcutCommand } from '../shared/contracts'

export function applicationMenuTemplate(options: {
  appName: string
  platform: NodeJS.Platform
  send: (command: TabShortcutCommand) => void
}): MenuItemConstructorOptions[] {
  const { appName, platform, send } = options
  const template: MenuItemConstructorOptions[] = []
  if (platform === 'darwin') {
    template.push({
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }
  template.push(
    {
      label: 'File',
      submenu: [
        {
          label: '搜索笔记',
          accelerator: 'CmdOrCtrl+P',
          click: () => send('open-quick-open')
        },
        {
          label: '命令面板',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => send('open-command-palette')
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => send('close-active-tab-or-window')
        },
        {
          label: 'Next Tab',
          accelerator: 'Ctrl+Tab',
          click: () => send('next-tab')
        },
        {
          label: 'Previous Tab',
          accelerator: 'Ctrl+Shift+Tab',
          click: () => send('previous-tab')
        },
        ...(platform === 'darwin'
          ? []
          : ([{ type: 'separator' }, { role: 'quit' }] satisfies MenuItemConstructorOptions[]))
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(platform === 'darwin'
          ? ([{ role: 'pasteAndMatchStyle' }] satisfies MenuItemConstructorOptions[])
          : []),
        { role: 'delete' },
        // Do not use role:selectAll — it calls webContents.selectAll() on the
        // whole Desk window, so Cmd+A cannot delete inside the note editor.
        {
          label: '全选',
          accelerator: 'CmdOrCtrl+A',
          click: () => send({ type: 'select-all' })
        },
        ...(platform === 'darwin'
          ? ([
              { type: 'separator' },
              {
                label: 'Speech',
                submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]
              }
            ] satisfies MenuItemConstructorOptions[])
          : [])
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: '实际大小（应用）',
          accelerator: 'CmdOrCtrl+0',
          click: () => send('reset-app-zoom')
        },
        {
          label: '放大应用',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => send('increase-app-zoom')
        },
        {
          label: '缩小应用',
          accelerator: 'CmdOrCtrl+-',
          click: () => send('decrease-app-zoom')
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  )
  return template
}
