import { ipcMain, type BrowserWindow } from 'electron'

import { IPC_CHANNELS } from '../shared/contracts'
import { registerGit } from './ipc/git'
import { registerNotes } from './ipc/notes'
import { registerAssets } from './ipc/assets'
import { registerExcalidraw } from './ipc/excalidraw'
import { registerKbFiles } from './ipc/kbFiles'
import { registerHistory } from './ipc/history'
import { registerRecovery } from './ipc/recovery'
import { registerSettings } from './ipc/settings'
import { registerClipboard } from './ipc/clipboard'
import { registerCommandTask } from './ipc/commandTask'
import { registerTerminal } from './ipc/terminal'
import { registerUpdate } from './ipc/update'
import { registerWeb } from './ipc/web'
import { registerWorkspace } from './ipc/workspace'

export function registerIpc(getWindow: () => BrowserWindow | null): () => void {
  const offWorkspace = registerWorkspace(getWindow)
  registerSettings(getWindow)
  const offGit = registerGit(getWindow)
  registerNotes(getWindow)
  const offAssets = registerAssets(getWindow)
  const offExcalidraw = registerExcalidraw(getWindow)
  const offKbFiles = registerKbFiles(getWindow)
  const offHistory = registerHistory(getWindow)
  registerRecovery(getWindow)
  const offWeb = registerWeb(getWindow)
  const offUpdate = registerUpdate(getWindow)
  const offTerminal = registerTerminal(getWindow)
  const offCommandTask = registerCommandTask(getWindow)
  registerClipboard(getWindow)

  return () => {
    offWorkspace()
    offWeb()
    offGit()
    offAssets()
    offExcalidraw()
    offKbFiles()
    offHistory()
    offUpdate()
    offTerminal()
    offCommandTask()
    for (const channel of Object.values(IPC_CHANNELS)) {
      ipcMain.removeHandler(channel)
    }
  }
}
