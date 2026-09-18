import { describe, expect, it } from 'vitest'
import { sessionRuntimeIdentityChanged } from '../src/sessionSnapshot'

describe('sessionRuntimeIdentityChanged', () => {
  const identity = {
    mountedPresetId: 'preset-a',
    model: { configId: 'main', provider: 'deepseek', model: 'deepseek-chat' },
    subagentModel: { configId: 'main', provider: 'deepseek', model: 'deepseek-chat' }
  }

  it('does not reload a session before its first snapshot exists', () => {
    expect(sessionRuntimeIdentityChanged(undefined, identity)).toBe(false)
  })

  it('ignores request-only snapshot fields', () => {
    expect(sessionRuntimeIdentityChanged(
      { ...identity, conversationContext: { history: ['old'] } } as typeof identity,
      { ...identity, conversationContext: { history: ['new'] } } as typeof identity
    )).toBe(false)
  })

  it('reloads when the mounted preset changes', () => {
    expect(sessionRuntimeIdentityChanged(identity, { ...identity, mountedPresetId: 'preset-b' })).toBe(true)
  })

  it('reloads when the main model request changes', () => {
    expect(sessionRuntimeIdentityChanged(identity, {
      ...identity,
      model: { ...identity.model, reasoningEffort: 'high' }
    })).toBe(true)
  })
})
