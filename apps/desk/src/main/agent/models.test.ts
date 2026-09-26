import { describe, expect, it, vi } from 'vitest'

import { listOpenAiModels } from './models'

function reply(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('listOpenAiModels', () => {
  it('读 {baseUrl}/models，去重排序，带上密钥', async () => {
    const fetchImpl = reply(200, { data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }, { id: 'deepseek-chat' }, {}] })
    const models = await listOpenAiModels('https://api.deepseek.com/', 'sk-1', fetchImpl)
    expect(models).toEqual([
      { id: 'deepseek-chat', displayName: 'deepseek-chat' },
      { id: 'deepseek-reasoner', displayName: 'deepseek-reasoner' }
    ])
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/models')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-1')
  })

  it('没有接口、密钥不对、空列表都给出能看懂的原因', async () => {
    await expect(listOpenAiModels('https://a.example.com/v1', 'k', reply(404, {}))).rejects.toThrow('没有模型列表接口')
    await expect(listOpenAiModels('https://a.example.com/v1', 'k', reply(401, {}))).rejects.toThrow('密钥无效')
    await expect(listOpenAiModels('https://a.example.com/v1', 'k', reply(200, { data: [] }))).rejects.toThrow('没有返回模型')
  })
})
