// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ImageOptimizePlayground from './ImageOptimizePlayground.vue'

import type { AppSettings } from '../../../../shared/contracts'

const optimize = {
  encoder: 'sharp' as const,
  strength: 'medium' as const,
  maxDimension: null,
  outputFormat: 'keep' as const
}
const draft = { imageUpload: { optimize } } as unknown as AppSettings

function installBridge(
  preview: () => Promise<
    { ok: true; value: Record<string, unknown> } | { ok: false; error: object }
  >
): void {
  Object.defineProperty(window, 'desk', {
    configurable: true,
    value: { settings: { previewOptimizeImage: vi.fn(preview) } }
  })
}

async function dropFile(wrapper: ReturnType<typeof mount>): Promise<void> {
  const file = new File([new Uint8Array([1, 2, 3, 4])], 'shot.png', { type: 'image/png' })
  await wrapper.get('.drop-zone').trigger('drop', { dataTransfer: { files: [file] } })
  await flushPromises()
}

function dispatchPaste(clipboardData: DataTransfer, target: EventTarget = window): void {
  target.dispatchEvent(
    Object.assign(new Event('paste', { bubbles: true, cancelable: true }), { clipboardData })
  )
}

function clipboardWithImage(file: File): DataTransfer {
  return {
    items: [
      {
        kind: 'file',
        type: file.type,
        getAsFile: () => file
      }
    ],
    files: [file]
  } as unknown as DataTransfer
}

afterEach(() => {
  Reflect.deleteProperty(window, 'desk')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ImageOptimizePlayground', () => {
  it('shows lossy savings and previews via data: URLs the CSP allows', async () => {
    installBridge(async () => ({
      ok: true,
      value: {
        bytesBefore: 1000,
        bytesAfter: 250,
        width: 12,
        height: 8,
        ms: 7,
        lossy: true,
        encoder: 'sharp',
        // 编码器用扩展名口径回传（jpg），不是 MIME 子类型（jpeg）。
        format: 'jpg',
        output: new Uint8Array([1, 2, 3])
      }
    }))
    const wrapper = mount(ImageOptimizePlayground, { props: { draft } })

    expect(wrapper.text()).toContain('压缩效果测试')
    expect(wrapper.text()).toContain('不写入任何知识库')
    expect(wrapper.text()).toContain('粘贴')

    await dropFile(wrapper)

    expect(wrapper.get('[data-testid="saved-percent"]').text()).toContain('-75%')
    expect(wrapper.text()).toContain('有损')

    // 回归护栏：应用 CSP 是 `img-src 'self' data: https: http://localhost:* http://127.0.0.1:* tnotes-asset:`，不含 blob:，
    // 预览必须走 data: URL —— 用 createObjectURL 会被 CSP 拦成破图。
    // 同时 MIME 要按扩展名口径映射（format: 'jpg' → image/jpeg，不能落成 octet-stream）。
    const originalSrc = wrapper.get('figure:nth-child(1) img').attributes('src') ?? ''
    const outputSrc = wrapper.get('figure:nth-child(2) img').attributes('src') ?? ''
    expect(originalSrc.startsWith('data:image/png;base64,')).toBe(true)
    expect(outputSrc.startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('accepts a pasted clipboard image without opening the file picker', async () => {
    installBridge(async () => ({
      ok: true,
      value: {
        bytesBefore: 1000,
        bytesAfter: 400,
        ms: 5,
        lossy: true,
        encoder: 'sharp',
        format: 'png',
        output: new Uint8Array([9, 8, 7])
      }
    }))
    const wrapper = mount(ImageOptimizePlayground, { props: { draft }, attachTo: document.body })
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'image.png', { type: 'image/png' })

    dispatchPaste(clipboardWithImage(file))
    await flushPromises()

    expect(window.desk.settings.previewOptimizeImage).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'image.png' })
    )
    expect(wrapper.get('[data-testid="saved-percent"]').text()).toContain('-60%')
    wrapper.unmount()
  })

  it('does not steal paste while typing in a settings text field', async () => {
    installBridge(async () => ({
      ok: true,
      value: { bytesBefore: 4, ms: 1, lossy: true, encoder: 'sharp' }
    }))
    const wrapper = mount(ImageOptimizePlayground, { props: { draft }, attachTo: document.body })
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    const file = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })

    dispatchPaste(clipboardWithImage(file), input)
    await flushPromises()

    expect(window.desk.settings.previewOptimizeImage).not.toHaveBeenCalled()
    input.remove()
    wrapper.unmount()
  })

  it('surfaces the skip reason instead of a fake saving', async () => {
    installBridge(async () => ({
      ok: true,
      value: {
        bytesBefore: 1000,
        ms: 3,
        lossy: true,
        encoder: 'sharp',
        skipped: '优化后没有变小'
      }
    }))
    const wrapper = mount(ImageOptimizePlayground, { props: { draft } })

    await dropFile(wrapper)

    expect(wrapper.text()).toContain('优化后没有变小')
    expect(wrapper.find('[data-testid="saved-percent"]').exists()).toBe(false)
  })
})

it('uses PNG-only options without overwriting the sharp draft', async () => {
  installBridge(async () => ({
    ok: true,
    value: { bytesBefore: 4, ms: 1, lossy: false, encoder: 'oxipng', skipped: '优化后没有变小' }
  }))
  const localDraft = {
    imageUpload: {
      optimize: {
        ...optimize,
        encoder: 'oxipng',
        strength: 'high',
        outputFormat: 'webp',
        maxDimension: 64
      }
    }
  } as AppSettings
  const wrapper = mount(ImageOptimizePlayground, { props: { draft: localDraft } })
  await dropFile(wrapper)
  expect(window.desk.settings.previewOptimizeImage).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        encoder: 'oxipng',
        strength: 'high',
        outputFormat: 'keep',
        maxDimension: null
      })
    })
  )
  expect(localDraft.imageUpload.optimize.outputFormat).toBe('webp')
  expect(wrapper.get('.lossless-badge').text()).toBe('无损')
  wrapper.unmount()
})

it('invalidates an in-flight result immediately while waiting for the oxipng debounce', async () => {
  vi.useFakeTimers()
  let finish!: (value: { ok: true; value: Record<string, unknown> }) => void
  installBridge(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const localDraft = reactive({
    imageUpload: { optimize: { ...optimize, strength: 'medium' } }
  }) as AppSettings
  const wrapper = mount(ImageOptimizePlayground, { props: { draft: localDraft } })
  await dropFile(wrapper)
  localDraft.imageUpload.optimize.encoder = 'oxipng'
  await wrapper.vm.$nextTick()
  finish({
    ok: true,
    value: {
      bytesBefore: 1000,
      bytesAfter: 250,
      ms: 1,
      lossy: true,
      output: new Uint8Array([1]),
      format: 'png'
    }
  })
  await flushPromises()
  expect(wrapper.find('figure:nth-child(2) img').exists()).toBe(false)
  expect(wrapper.text()).toContain('无损优化中')
  await vi.advanceTimersByTimeAsync(999)
  expect(window.desk.settings.previewOptimizeImage).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(window.desk.settings.previewOptimizeImage).toHaveBeenCalledTimes(2)
  wrapper.unmount()
})
