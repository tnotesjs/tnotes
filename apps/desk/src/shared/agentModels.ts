import type { AgentModelConfig, AgentProviderConfig, AgentSettings } from './contracts'

const KNOWN_PROVIDERS: Record<string, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  moonshot: 'Moonshot',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  siliconflow: 'SiliconFlow',
  dashscope: '通义千问',
  bigmodel: '智谱',
  volces: '火山方舟'
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-4o-mini', vision: true, reasoning: false }]
    }
  ],
  defaultModel: 'openai/gpt-4o-mini'
}

/** 从接口地址推断服务商：api.deepseek.com → deepseek / DeepSeek */
export function providerFromBaseUrl(baseUrl: string): { id: string; name: string } {
  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch {
    host = ''
  }
  const parts = host.split('.').filter(Boolean)
  const core = (parts.length >= 2 ? parts[parts.length - 2] : parts[0]) || 'custom'
  const id = core.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'custom'
  return { id, name: KNOWN_PROVIDERS[id] ?? (host || '自定义') }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanModel(value: unknown): AgentModelConfig | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id)
  if (!id) return null
  return { id, vision: raw.vision !== false, reasoning: raw.reasoning === true }
}

function cleanProvider(value: unknown, index: number): AgentProviderConfig | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const models = Array.isArray(raw.models) ? raw.models.map(cleanModel).filter((item): item is AgentModelConfig => Boolean(item)) : []
  if (raw.kind === 'cursor') {
    const id = text(raw.id).replace(/[^a-zA-Z0-9_-]/g, '') || `cursor-${index + 1}`
    return { id, name: text(raw.name) || 'Cursor', kind: 'cursor', baseUrl: '', models }
  }
  const baseUrl = text(raw.baseUrl)
  if (!baseUrl) return null
  const guessed = providerFromBaseUrl(baseUrl)
  const id = text(raw.id).replace(/[^a-zA-Z0-9_-]/g, '') || `${guessed.id}-${index + 1}`
  return { id, name: text(raw.name) || guessed.name, baseUrl, models }
}

export function isCursorProvider(provider: Pick<AgentProviderConfig, 'kind'>): boolean {
  return provider.kind === 'cursor'
}

/**
 * 读设置时统一成「服务商 + 模型列表」：
 * 旧版的 `{ baseUrl, model }` 迁成一个服务商，下面挂一个模型。
 */
export function normalizeAgentSettings(value: unknown): AgentSettings {
  if (!value || typeof value !== 'object') return structuredClone(DEFAULT_AGENT_SETTINGS)
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.providers)) {
    const baseUrl = text(raw.baseUrl)
    const model = text(raw.model)
    if (!baseUrl || !model) return structuredClone(DEFAULT_AGENT_SETTINGS)
    const provider = providerFromBaseUrl(baseUrl)
    return {
      providers: [{ id: provider.id, name: provider.name, baseUrl, models: [{ id: model, vision: true, reasoning: false }] }],
      defaultModel: `${provider.id}/${model}`
    }
  }
  const seen = new Set<string>()
  const providers = raw.providers
    .map(cleanProvider)
    .filter((item): item is AgentProviderConfig => Boolean(item))
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
  if (providers.length === 0) return structuredClone(DEFAULT_AGENT_SETTINGS)
  const settings = { providers, defaultModel: text(raw.defaultModel) }
  if (!resolveModelRef(settings, settings.defaultModel)) settings.defaultModel = firstModelRef(settings)
  return settings
}

export function firstModelRef(settings: AgentSettings): string {
  for (const provider of settings.providers) {
    const model = provider.models[0]
    if (model) return `${provider.id}/${model.id}`
  }
  return ''
}

export function resolveModelRef(
  settings: AgentSettings,
  ref: string
): { provider: AgentProviderConfig; model: AgentModelConfig } | null {
  const split = ref.indexOf('/')
  if (split <= 0) return null
  const providerId = ref.slice(0, split)
  const modelId = ref.slice(split + 1)
  const provider = settings.providers.find((item) => item.id === providerId)
  const model = provider?.models.find((item) => item.id === modelId)
  return provider && model ? { provider, model } : null
}

export function allModelRefs(settings: AgentSettings): Array<{ ref: string; provider: AgentProviderConfig; model: AgentModelConfig }> {
  return settings.providers.flatMap((provider) =>
    provider.models.map((model) => ({ ref: `${provider.id}/${model.id}`, provider, model }))
  )
}
