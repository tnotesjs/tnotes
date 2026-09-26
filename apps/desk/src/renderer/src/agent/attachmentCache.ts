const cache = new Map<string, string>()
const loading = new Map<string, Promise<string>>()

export function cacheAttachment(id: string, url: string): void {
  cache.set(id, url)
}

/** 对话里的图片：先用内存里的，没有再从主进程读成 data URL。读不到返回空字符串。 */
export function attachmentUrl(id: string): Promise<string> {
  const cached = cache.get(id)
  if (cached) return Promise.resolve(cached)
  const inflight = loading.get(id)
  if (inflight) return inflight
  const request = window.desk.agent.readAttachment({ id }).then((result) => {
    loading.delete(id)
    if (!result.ok) return ''
    cache.set(id, result.value)
    return result.value
  })
  loading.set(id, request)
  return request
}

const MAX_EDGE = 1600

/** 缩到长边 1600 像素以内，转成 JPEG（透明处铺白）。 */
export async function prepareImage(file: Blob): Promise<{ url: string; data: Uint8Array; width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法处理这张图片')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const url = canvas.toDataURL('image/jpeg', 0.85)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  if (!blob) throw new Error('无法处理这张图片')
  return { url, data: new Uint8Array(await blob.arrayBuffer()), width, height }
}
