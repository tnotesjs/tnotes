// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ConfigSettings from './ConfigSettings.vue'

beforeEach(() => {
  Object.defineProperty(window, 'desk', {
    configurable: true,
    value: {
      settings: {
        readRaw: vi.fn(async () => ({ ok: true, value: '{}\n' }))
      }
    }
  })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'desk')
})

function pointerDown(target: EventTarget): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
}

describe('ConfigSettings actions menu', () => {
  it('closes the menu when pressing outside it', () => {
    const wrapper = mount(ConfigSettings)
    const menu = wrapper.get('details.config-actions').element as HTMLDetailsElement
    menu.open = true

    pointerDown(document.body)

    expect(menu.open).toBe(false)
  })

  it('keeps the menu open when pressing the trigger or an item', () => {
    const wrapper = mount(ConfigSettings)
    const menu = wrapper.get('details.config-actions').element as HTMLDetailsElement
    menu.open = true

    pointerDown(wrapper.get('summary').element)
    expect(menu.open).toBe(true)

    pointerDown(wrapper.get('.config-actions-popover button').element)
    expect(menu.open).toBe(true)
  })
})
