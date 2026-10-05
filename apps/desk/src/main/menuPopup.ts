import type { BrowserWindow, Menu } from 'electron'

/**
 * macOS delivers the menu item click after the popup close callback.
 * Remember the choice and resolve only after that click has had time to land.
 */
const MENU_CLICK_GRACE_MS = 100

export function popupForChoice<T>(
  menu: Menu,
  window: BrowserWindow,
  readChoice: () => T | null
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    menu.popup({
      window,
      callback: () => {
        setTimeout(() => {
          if (settled) return
          settled = true
          resolve(readChoice())
        }, MENU_CLICK_GRACE_MS)
      }
    })
  })
}
