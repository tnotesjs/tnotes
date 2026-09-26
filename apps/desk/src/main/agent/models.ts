/**
 * 向服务商读取可用模型。只拿得到模型 ID（和 Cursor 的显示名），
 * 能不能看图、支持不支持思考强度，接口都不告诉我们，仍由用户勾选。
 */
import type { AgentListedModel } from '../../shared/contracts'

const TIMEOUT_MS = 15_000

/** OpenAI 兼容接口：GET {baseUrl}/models → { data: [{ id }] } */
export async function listOpenAiModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<AgentListedModel[]> {
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/models`
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`连不上 ${url}：${message}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('密钥无效或没有权限，检查 API Key')
  }
  if (response.status === 404) {
    throw new Error('这个服务商没有模型列表接口（/models），请手动填写模型名')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`模型列表接口返回 ${response.status}：${text.slice(0, 200)}`)
  }
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null
  const rows = Array.isArray(body?.data) ? body.data : []
  const ids = rows
    .map((row) => (row && typeof row === 'object' ? (row as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
  if (ids.length === 0) throw new Error('模型列表接口没有返回模型')
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right)).map((id) => ({ id, displayName: id }))
}
