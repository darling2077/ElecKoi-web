/** Composes every SDK-created Agent from its immutable ElecKoi Session snapshot. */

import { createConversationSeed, installConversationContext } from './conversation-context.mjs'
import { installRequestConfig } from './request-config.mjs'
import { readSessionSnapshot } from './session-snapshot.mjs'
import { applyDisabledPolicy } from './tool-policy.mjs'

export const name = 'eleckoi-agent-preset-bridge'
export const inject = ['agents', 'agentPresets']

export function apply(ctx) {
  const snapshotRoot = process.env.ELECKOI_SESSION_SNAPSHOT_ROOT
  if (!snapshotRoot) throw new Error('ELECKOI_SESSION_SNAPSHOT_ROOT is required')
  const originalCreate = ctx.agents.create
  const originalResume = ctx.agents.resume
  const wrappedCreate = function (options) {
    const child = options.meta?.origin === 'subagent'
    const sourceSessionId = child ? options.meta?.parentSession : options.sessionId
    if (!sourceSessionId) throw new Error('ElecKoi subagent is missing its parent Session id')
    const snapshot = readSessionSnapshot(snapshotRoot, sourceSessionId)
    const nextOptions = composeSessionOptions(ctx, options, snapshotRoot, sourceSessionId, snapshot, child, false)
    return originalCreate.call(ctx.agents, nextOptions)
  }
  const wrappedResume = function (options) {
    const sourceSessionId = options.resumeSessionId
    if (!sourceSessionId) return originalResume.call(ctx.agents, options)
    let snapshot
    try {
      snapshot = readSessionSnapshot(snapshotRoot, sourceSessionId)
    } catch (error) {
      if (error?.code === 'ENOENT') return originalResume.call(ctx.agents, options)
      throw error
    }
    return originalResume.call(
      ctx.agents,
      composeSessionOptions(ctx, options, snapshotRoot, sourceSessionId, snapshot, false, true)
    )
  }

  ctx.agents.create = wrappedCreate
  ctx.agents.resume = wrappedResume
  return () => {
    if (ctx.agents.create === wrappedCreate) ctx.agents.create = originalCreate
    if (ctx.agents.resume === wrappedResume) ctx.agents.resume = originalResume
  }
}

function composeSessionOptions(ctx, options, snapshotRoot, sourceSessionId, snapshot, child, resuming) {
  const model = child ? snapshot.subagentModel : snapshot.model
  if (!model?.provider || !model?.model) throw new Error(`Session ${sourceSessionId} has no model snapshot`)
  const originalSetup = options.setup
  return {
    ...options,
    agentOptions: requestAgentOptions(options.agentOptions, model),
    ...resuming || child || options.seed !== undefined
      ? {}
      : { seed: createConversationSeed(snapshot, model) },
    ...resuming || child ? {} : {
      meta: { ...(options.meta ?? {}), agentPreset: snapshot.mountedPresetId }
    },
    setup: async (agentCtx) => {
      if (!child) await ctx.agentPresets.mount(agentCtx, snapshot.mountedPresetId)
      const transaction = await originalSetup?.(agentCtx)
      installRequestConfig(agentCtx, snapshotRoot, sourceSessionId, child)
      if (!child) installConversationContext(agentCtx, snapshotRoot, sourceSessionId)
      applyDisabledPolicy(agentCtx, snapshot.disabledToolGroupIds)
      return transaction
    }
  }
}

function requestAgentOptions(inherited, model) {
  const { maxTokens: _maxTokens, reasoningEffort: _reasoningEffort, ...rest } = inherited ?? {}
  return {
    ...rest,
    provider: model.provider,
    model: model.model,
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort })
  }
}
