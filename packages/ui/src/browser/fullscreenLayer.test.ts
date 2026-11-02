// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'

import { setFullscreenLayer } from './fullscreenLayer'

afterEach(() => {
  document.body.replaceChildren()
  delete document.body.dataset.tnFullscreen
})

function layer(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  return el
}

describe('setFullscreenLayer', () => {
  it('flags the body while any layer is fullscreen', () => {
    const a = layer()
    const b = layer()
    setFullscreenLayer(a, true)
    setFullscreenLayer(b, true)
    expect(document.body.dataset.tnFullscreen).toBe('')
    setFullscreenLayer(a, false)
    expect(document.body.dataset.tnFullscreen).toBe('')
    expect(a.dataset.tnFullscreenLayer).toBeUndefined()
    setFullscreenLayer(b, false)
    expect(document.body.dataset.tnFullscreen).toBeUndefined()
  })

  it('drops a stale flag once the layer has left the document', () => {
    const a = layer()
    setFullscreenLayer(a, true)
    a.remove()
    setFullscreenLayer(null, false)
    expect(document.body.dataset.tnFullscreen).toBeUndefined()
  })
})
