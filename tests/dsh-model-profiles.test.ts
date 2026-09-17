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
      models: [expect.objectContaining({ id: 'private-model', reasoningEfforts: false })]
    })
    expect(plan.providers[plan.main.provider]?.models?.[0]).not.toHaveProperty('topP')
  })

  it('normalizes Google model-list identities and the native API root for DSH', () => {
    const google: DshModelSettings = {
      ...kimiK3,
      configId: 'google-config',
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

  it('adds the native Google API version for a custom Gemini endpoint', () => {
    const google: DshModelSettings = {
      ...kimiK3,
      configId: 'google-proxy-config',
      baseUrl: 'https://gateway.example/google',
      model: 'models/private-gemini',
      apiFormat: 'google-generative-ai'
    }
    const plan = providerPlan(google)
    expect(plan.main).toEqual({ provider: plan.main.provider, model: 'private-gemini' })
    expect(plan.providers[plan.main.provider]).toMatchObject({
      api: 'google-generative-ai',
      baseURL: 'https://gateway.example/google/v1beta',
      models: [expect.objectContaining({ id: 'private-gemini' })]
    })
    expect(() => DshPiAiConfig({ providers: plan.providers })).not.toThrow()
  })

  it('accepts DeepSeek and native Google providers in one DSH process catalog', () => {
    const google: DshModelSettings = {
      ...kimiK3,
      configId: 'google-config',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'models/gemini-3.6-flash',
      apiFormat: 'google-generative-ai'
    }
    const deepseek: DshModelSettings = {
      ...kimiK3,
      configId: 'deepseek-config',
      apiKey: 'deepseek-test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat'
    }
    const catalog = createDshProviderCatalog([deepseek, google])

    expect(() => DshPiAiConfig({ providers: catalog.providers })).not.toThrow()
    expect(resolveDshProviderBinding(catalog, deepseek)).toMatchObject({ model: 'deepseek-chat' })
    expect(resolveDshProviderBinding(catalog, google)).toMatchObject({ provider: 'google', model: 'gemini-3.6-flash' })
  })
})
