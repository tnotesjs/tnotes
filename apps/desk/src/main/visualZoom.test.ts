import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import {
  applyVisualZoomLimits,
  attachVisualZoomGuard,
  VISUAL_ZOOM_MAX,
  VISUAL_ZOOM_MIN
} from './visualZoom'

function createFakeWindow() {
  const winEmitter = new EventEmitter()
  const webEmitter = new EventEmitter()
  let destroyed = false
  const setVisualZoomLevelLimits = vi.fn(async () => undefined)
  const window = {
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
      winEmitter.emit('closed')
    },
    on: (event: string, listener: (...args: unknown[]) => void) => winEmitter.on(event, listener),
    emit: (event: string, ...args: unknown[]) => winEmitter.emit(event, ...args),
    webContents: {
      isDestroyed: () => destroyed,
      setVisualZoomLevelLimits,
      on: (event: string, listener: (...args: unknown[]) => void) => webEmitter.on(event, listener),
      emit: (event: string, ...args: unknown[]) => webEmitter.emit(event, ...args)
    }
  }
  return { window, setVisualZoomLevelLimits }
}

describe('visualZoom guard', () => {
  it('applies visual zoom limits immediately and reapplies on window, power, and display events', () => {
    const { window, setVisualZoomLevelLimits } = createFakeWindow()
    const powerMonitor = new EventEmitter()
    const screen = new EventEmitter()

    attachVisualZoomGuard(window, { powerMonitor, screen })
    expect(setVisualZoomLevelLimits).toHaveBeenCalledTimes(1)
    expect(setVisualZoomLevelLimits).toHaveBeenLastCalledWith(VISUAL_ZOOM_MIN, VISUAL_ZOOM_MAX)

    window.webContents.emit('did-finish-load')
    window.emit('focus')
    window.emit('show')
    window.emit('restore')
    window.emit('enter-full-screen')
    window.emit('leave-full-screen')
    powerMonitor.emit('resume')
    powerMonitor.emit('unlock-screen')
    screen.emit('display-added')
    screen.emit('display-removed')
    screen.emit('display-metrics-changed')

    expect(setVisualZoomLevelLimits).toHaveBeenCalledTimes(12)
  })

  it('detaches global powerMonitor and screen listeners when the window closes', () => {
    const { window, setVisualZoomLevelLimits } = createFakeWindow()
    const powerMonitor = new EventEmitter()
    const screen = new EventEmitter()

    attachVisualZoomGuard(window, { powerMonitor, screen })
    setVisualZoomLevelLimits.mockClear()

    window.destroy()
    powerMonitor.emit('resume')
    powerMonitor.emit('unlock-screen')
    screen.emit('display-added')
    screen.emit('display-removed')
    screen.emit('display-metrics-changed')

    expect(setVisualZoomLevelLimits).not.toHaveBeenCalled()
    expect(powerMonitor.listenerCount('resume')).toBe(0)
    expect(powerMonitor.listenerCount('unlock-screen')).toBe(0)
    expect(screen.listenerCount('display-added')).toBe(0)
    expect(screen.listenerCount('display-removed')).toBe(0)
    expect(screen.listenerCount('display-metrics-changed')).toBe(0)
  })

  it('is a no-op when the window is null or destroyed', () => {
    const { window, setVisualZoomLevelLimits } = createFakeWindow()
    window.destroy()
    applyVisualZoomLimits(null)
    applyVisualZoomLimits(window)
    expect(setVisualZoomLevelLimits).not.toHaveBeenCalled()
  })
})
