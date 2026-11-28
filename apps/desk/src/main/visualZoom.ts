export const VISUAL_ZOOM_MIN = 1
export const VISUAL_ZOOM_MAX = 3

export interface VisualZoomWebContents {
  isDestroyed?: () => boolean
  setVisualZoomLevelLimits?: (minimumLevel: number, maximumLevel: number) => Promise<void> | void
}

export interface VisualZoomObservableWebContents extends VisualZoomWebContents {
  on: (event: 'did-finish-load', listener: () => void) => unknown
}

export interface VisualZoomWindowTarget {
  isDestroyed: () => boolean
  webContents: VisualZoomWebContents
}

export interface VisualZoomWindow extends VisualZoomWindowTarget {
  webContents: VisualZoomObservableWebContents
  on(event: 'focus', listener: () => void): unknown
  on(event: 'show', listener: () => void): unknown
  on(event: 'restore', listener: () => void): unknown
  on(event: 'enter-full-screen', listener: () => void): unknown
  on(event: 'leave-full-screen', listener: () => void): unknown
  on(event: 'closed', listener: () => void): unknown
}

export interface VisualZoomPowerMonitor {
  on(event: 'resume', listener: () => void): unknown
  on(event: 'unlock-screen', listener: () => void): unknown
  off?(event: 'resume', listener: () => void): unknown
  off?(event: 'unlock-screen', listener: () => void): unknown
  removeListener?(event: 'resume', listener: () => void): unknown
  removeListener?(event: 'unlock-screen', listener: () => void): unknown
}

export interface VisualZoomScreen {
  on(event: 'display-added', listener: () => void): unknown
  on(event: 'display-removed', listener: () => void): unknown
  on(event: 'display-metrics-changed', listener: () => void): unknown
  off?(event: 'display-added', listener: () => void): unknown
  off?(event: 'display-removed', listener: () => void): unknown
  off?(event: 'display-metrics-changed', listener: () => void): unknown
  removeListener?(event: 'display-added', listener: () => void): unknown
  removeListener?(event: 'display-removed', listener: () => void): unknown
  removeListener?(event: 'display-metrics-changed', listener: () => void): unknown
}

export function applyVisualZoomLimits(window: VisualZoomWindowTarget | null | undefined): void {
  if (!window || window.isDestroyed()) return
  if (window.webContents.isDestroyed?.()) return
  if (typeof window.webContents.setVisualZoomLevelLimits !== 'function') return
  void Promise.resolve(
    window.webContents.setVisualZoomLevelLimits(VISUAL_ZOOM_MIN, VISUAL_ZOOM_MAX)
  ).catch(() => undefined)
}

/**
 * Electron / Chromium 在系统休眠唤醒、锁屏解锁、插拔/切换外接显示器或重设
 * zoomFactor 后，可能把页面的 visualZoomLevelLimits 悄悄重置回 1–1，导致双指捏合
 * 缩放突然失效（参考 electron/electron#31392）。
 *
 * `setVisualZoomLevelLimits(1, 3)` 幂等且轻量，这里在窗口与系统恢复相关事件上
 * 自动补设，避免用户必须重启 Desk 才能恢复。
 */
export function attachVisualZoomGuard(
  window: VisualZoomWindow,
  sources: {
    powerMonitor: VisualZoomPowerMonitor
    screen: VisualZoomScreen
  }
): () => void {
  const reapply = (): void => applyVisualZoomLimits(window)

  reapply()
  window.webContents.on('did-finish-load', reapply)
  window.on('focus', reapply)
  window.on('show', reapply)
  window.on('restore', reapply)
  window.on('enter-full-screen', reapply)
  window.on('leave-full-screen', reapply)

  sources.powerMonitor.on('resume', reapply)
  sources.powerMonitor.on('unlock-screen', reapply)
  sources.screen.on('display-added', reapply)
  sources.screen.on('display-removed', reapply)
  sources.screen.on('display-metrics-changed', reapply)

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (sources.powerMonitor.off) {
      sources.powerMonitor.off('resume', reapply)
      sources.powerMonitor.off('unlock-screen', reapply)
    } else {
      sources.powerMonitor.removeListener?.('resume', reapply)
      sources.powerMonitor.removeListener?.('unlock-screen', reapply)
    }
    if (sources.screen.off) {
      sources.screen.off('display-added', reapply)
      sources.screen.off('display-removed', reapply)
      sources.screen.off('display-metrics-changed', reapply)
    } else {
      sources.screen.removeListener?.('display-added', reapply)
      sources.screen.removeListener?.('display-removed', reapply)
      sources.screen.removeListener?.('display-metrics-changed', reapply)
    }
  }

  window.on('closed', dispose)
  return dispose
}
