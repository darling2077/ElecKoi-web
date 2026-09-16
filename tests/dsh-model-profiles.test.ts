import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { Config as DshPiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { createDshProviderPlan, describeDshModelCapabilities } from '@eleckoi/dsh-runtime'
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
})
