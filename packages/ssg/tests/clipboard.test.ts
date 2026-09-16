// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { copyText } from '../src/client/clipboard'
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
it('copies the exact original text', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const source = '---\nid: test\n---\n# 标题\n\n```js\n</script>\n```\n'
  await copyText(source)
  expect(writeText).toHaveBeenCalledWith(source)
})
it('reports fallback failure and removes the temporary field', async () => {
  vi.stubGlobal('navigator', {})
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
  await expect(copyText('original')).rejects.toThrow('Copy failed')
  expect(document.querySelector('textarea')).toBeNull()
})
