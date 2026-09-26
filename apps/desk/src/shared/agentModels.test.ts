import { describe, expect, it } from 'vitest'

import { DEFAULT_AGENT_SETTINGS, normalizeAgentSettings, providerFromBaseUrl, resolveModelRef } from './agentModels'

describe('normalizeAgentSettings', () => {
  it('migrates the old single baseUrl + model into one provider', () => {
    expect(normalizeAgentSettings({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' })).toEqual({
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com',
          models: [{ id: 'deepseek-flash', vision: true, reasoning: false }]
        }
      ],
      defaultModel: 'deepseek/deepseek-flash'
    })
  })

  it('keeps the new structure and drops empty rows', () => {
    const settings = {
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com',
          models: [
            { id: 'deepseek-flash', vision: true, reasoning: true },
            { id: '', vision: true, reasoning: false }
          ]
        },
        { id: 'p-empty', name: '空', baseUrl: '', models: [] }
      ],
      defaultModel: 'deepseek/deepseek-flash'
    }
    const normalized = normalizeAgentSettings(settings)
    expect(normalized.providers).toHaveLength(1)
    expect(normalized.providers[0].models).toEqual([{ id: 'deepseek-flash', vision: true, reasoning: true }])
    expect(normalizeAgentSettings(normalized)).toEqual(normalized)
  })

  it('falls back to defaults and repairs a default model that no longer exists', () => {
    expect(normalizeAgentSettings(undefined)).toEqual(DEFAULT_AGENT_SETTINGS)
    const repaired = normalizeAgentSettings({
      providers: [{ id: 'a', name: 'A', baseUrl: 'https://a.example.com', models: [{ id: 'm1' }] }],
      defaultModel: 'a/gone'
    })
    expect(repaired.defaultModel).toBe('a/m1')
    expect(resolveModelRef(repaired, 'a/m1')?.model.id).toBe('m1')
  })

  it('keeps a Cursor provider without a base URL, and leaves other providers without a kind', () => {
    const normalized = normalizeAgentSettings({
      providers: [
        { id: 'cursor', kind: 'cursor', name: '', baseUrl: 'ignored', models: [{ id: 'composer-2.5' }] },
        { id: 'ds', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: [{ id: 'deepseek-chat' }] }
      ],
      defaultModel: 'cursor/composer-2.5'
    })
    expect(normalized.providers[0]).toEqual({
      id: 'cursor',
      name: 'Cursor',
      kind: 'cursor',
      baseUrl: '',
      models: [{ id: 'composer-2.5', vision: true, reasoning: false }]
    })
    expect(normalized.providers[1]).not.toHaveProperty('kind')
    expect(normalized.defaultModel).toBe('cursor/composer-2.5')
    expect(normalizeAgentSettings(normalized)).toEqual(normalized)
  })

  it('guesses the provider from the host name', () => {
    expect(providerFromBaseUrl('https://api.openai.com/v1')).toEqual({ id: 'openai', name: 'OpenAI' })
    expect(providerFromBaseUrl('https://llm.example.org/v1').id).toBe('example')
  })
})
