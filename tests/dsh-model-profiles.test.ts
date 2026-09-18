import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { Config as DshPiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  createDshProviderCatalog,
  createDshProviderPlan,
  describeDshModelCapabilities,
  resolveDshProviderBinding
} from '@eleckoi/dsh-runtime'
import type { DshModelSettings } from '@eleckoi/dsh-runtime'
import { describe, expect, it } from 'vitest'

const kimiK3 = {
  configId: 'kimi-k3-config',
  provider: 'moonshot',
  apiKey: 'test-key',
  baseUrl: 'https://api.moonshot.cn/v1',
  model: 'kimi-k3',
  systemPrompt: '',
  apiFormat: 'openai-completions' as const,
  customHeaders: {},
  contextWindow: 272_000,
  supportsImageInput: false
}

function providerPlan(settings: DshModelSettings) {
  const catalog = createDshProviderCatalog([settings])
  return { providers: catalog.providers, main: resolveDshProviderBinding(catalog, settings) }
}

describe('DSH native model profiles', () => {
  it('uses the native Moonshot route and the pi-ai Kimi K3 capability catalog', () => {
    expect(describeDshModelCapabilities(kimiK3)).toEqual({
      provider: 'moonshotai-cn',
      source: 'dsh_catalog',
      reasoningEfforts: ['low', 'high', 'max']
    })

    const native = getBuiltinModels('moonshotai-cn').find((model) => model.id === 'kimi-k3')
    expect(native?.compat).toMatchObject({ supportsDeveloperRole: false })
    const plan = createDshProviderPlan({ ...kimiK3, reasoningEffort: 'high', topP: 0.85 })
    expect(plan.main).toEqual({ provider: 'moonshotai-cn', model: 'kimi-k3', reasoningEffort: 'high' })
    expect(plan.providers['moonshotai-cn']?.apiKeyEnv).toMatch(/^ELECKOI_MODEL_KEY_/)
    expect(plan.providers['moonshotai-cn']?.models).toEqual([
      expect.objectContaining({ id: 'kimi-k3', input: ['text'] })
    ])
    expect(plan.providers['moonshotai-cn']?.models?.[0]).not.toHaveProperty('topP')
    expect(plan.providers['moonshotai-cn']).not.toHaveProperty('api')
    expect(plan.providers['moonshotai-cn']).not.toHaveProperty('compat')
    expect(() => DshPiAiConfig({ providers: plan.providers })).not.toThrow()
  })

  it('does not send an unsupported Kimi K3 off effort', () => {
    const plan = createDshProviderPlan({ ...kimiK3, reasoningEffort: 'off' })
    expect(plan.main).toEqual({ provider: 'moonshotai-cn', model: 'kimi-k3' })
  })

  it('omits Top P when the model leaves it on the upstream default', () => {
    const plan = createDshProviderPlan(kimiK3)
    expect(plan.providers['moonshotai-cn']).not.toHaveProperty('models.0.topP')
  })

  it('treats an unknown endpoint as a non-reasoning custom route instead of inventing capabilities', () => {
    const custom = {
      ...kimiK3,
      configId: 'custom-config',
      provider: 'custom',
      baseUrl: 'https://gateway.example/v1',
      model: 'private-model',
      topP: 0.7,
      reasoningEffort: 'max' as const
    }
    expect(describeDshModelCapabilities(custom)).toEqual({
      provider: null,
      source: 'provider_default',
      reasoningEfforts: []
    })
    const plan = createDshProviderPlan(custom)
    expect(plan.main.provider).toMatch(/^openai-completions-/)
    expect(plan.main).toEqual({ provider: plan.main.provider, model: 'private-model' })
    expect(plan.providers[plan.main.provider]).toMatchObject({
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      models: [expect.objectContaining({ id: 'private-model' })]
    })
    expect(plan.providers[plan.main.provider]?.models?.[0]).not.toHaveProperty('reasoningEfforts')
    expect(plan.providers[plan.main.provider]?.models?.[0]).not.toHaveProperty('topP')
  })

  it('uses an explicit pi-ai reasoning profile for a custom relay model', () => {
    const custom: DshModelSettings = {
      ...kimiK3,
      configId: 'custom-reasoning-config',
      provider: 'custom',
      baseUrl: 'https://gateway.example/v1',
      model: 'vendor/reasoning-model',
      reasoningEfforts: {
        off: null,
        low: 'low',
        high: 'high',
        max: 'ultra'
      },
      reasoningEffort: 'max'
    }
    expect(describeDshModelCapabilities(custom)).toEqual({
      provider: null,
      source: 'explicit_profile',
      reasoningEfforts: ['off', 'low', 'high', 'max']
    })
    const plan = providerPlan(custom)
    expect(plan.main).toEqual({
      provider: plan.main.provider,
      model: 'vendor/reasoning-model',
      reasoningEffort: 'max'
    })
    expect(plan.providers[plan.main.provider]?.models?.[0]).toMatchObject({
      id: 'vendor/reasoning-model',
      reasoningEfforts: {
        off: null,
        low: 'low',
        high: 'high',
        max: 'ultra'
      }
    })
    expect(() => DshPiAiConfig({ providers: plan.providers })).not.toThrow()
  })

  it('normalizes Google model-list identities and the native API root for DSH', () => {
    const google: DshModelSettings = {
      ...kimiK3,
      configId: 'google-config',
      provider: 'custom',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'models/gemini-3.6-flash',
      apiFormat: 'google-generative-ai'
    }
    expect(describeDshModelCapabilities(google)).toMatchObject({
      provider: 'google',
      source: 'dsh_catalog'
    })
    const plan = providerPlan(google)
    expect(plan.main).toMatchObject({ provider: 'google', model: 'gemini-3.6-flash' })
    expect(plan.providers.google).not.toHaveProperty('baseURL')
    expect(plan.providers.google?.models).toEqual([
      expect.objectContaining({ id: 'gemini-3.6-flash' })
    ])
    expect(() => DshPiAiConfig({ providers: plan.providers })).not.toThrow()
  })

  it('rejects a hand-declared Google route that latest DSH cannot serialize', () => {
    const google: DshModelSettings = {
      ...kimiK3,
      configId: 'google-proxy-config',
      provider: 'custom',
      baseUrl: 'https://gateway.example/google',
      model: 'models/private-gemini',
      apiFormat: 'google-generative-ai'
    }
    expect(() => providerPlan(google)).toThrow('最新版 DSH 仅允许 Google Generative AI 接口')
  })

  it('accepts DeepSeek and native Google providers in one DSH process catalog', () => {
    const google: DshModelSettings = {
      ...kimiK3,
      configId: 'google-config',
      provider: 'custom',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'models/gemini-3.6-flash',
      apiFormat: 'google-generative-ai'
    }
    const deepseek: DshModelSettings = {
      ...kimiK3,
      configId: 'deepseek-config',
      provider: 'deepseek',
      apiKey: 'deepseek-test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat'
    }
    const catalog = createDshProviderCatalog([deepseek, google])

    expect(() => DshPiAiConfig({ providers: catalog.providers })).not.toThrow()
    expect(resolveDshProviderBinding(catalog, deepseek)).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-chat'
    })
    expect(resolveDshProviderBinding(catalog, google)).toMatchObject({ provider: 'google', model: 'gemini-3.6-flash' })
  })

  it('uses the DSH DeepSeek adapter capability for every dedicated chat-completions model id', () => {
    const deepseek: DshModelSettings = {
      ...kimiK3,
      configId: 'deepseek-config',
      provider: 'deepseek',
      apiKey: 'deepseek-test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'future-deepseek-model',
      reasoningEffort: 'max'
    }
    expect(describeDshModelCapabilities(deepseek)).toEqual({
      provider: 'deepseek-official',
      source: 'dsh_catalog',
      reasoningEfforts: ['off', 'low', 'high', 'max']
    })
    const catalog = createDshProviderCatalog([deepseek])
    expect(catalog.providers).toEqual({})
    expect(catalog.deepseek).toMatchObject({
      apiKeyEnv: 'ELECKOI_DEEPSEEK_API_KEY',
      baseURL: 'https://api.deepseek.com',
      models: [expect.objectContaining({ id: 'future-deepseek-model' })]
    })
    expect(resolveDshProviderBinding(catalog, deepseek)).toEqual({
      provider: 'deepseek-official',
      model: 'future-deepseek-model',
      reasoningEffort: 'max'
    })
  })

  it('carries the DSH DeepSeek effort contract through the pi-ai Responses route', () => {
    const deepseek: DshModelSettings = {
      ...kimiK3,
      configId: 'deepseek-responses',
      provider: 'deepseek',
      apiKey: 'deepseek-test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'future-deepseek-model',
      apiFormat: 'openai-responses',
      reasoningEffort: 'max'
    }
    expect(describeDshModelCapabilities(deepseek)).toEqual({
      provider: null,
      source: 'dsh_catalog',
      reasoningEfforts: ['off', 'low', 'high', 'max']
    })
    const catalog = createDshProviderCatalog([deepseek])
    expect(() => DshPiAiConfig({ providers: catalog.providers })).not.toThrow()
    expect(Object.values(catalog.providers)[0]?.models?.[0]).toMatchObject({
      id: 'future-deepseek-model',
      reasoningEfforts: {
        off: 'none',
        low: 'low',
        high: 'high',
        max: 'max'
      }
    })
    expect(resolveDshProviderBinding(catalog, deepseek)).toMatchObject({
      model: 'future-deepseek-model',
      reasoningEffort: 'max'
    })
  })
})
