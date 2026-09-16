import { readSessionSnapshot } from './session-snapshot.mjs'

/**
 * Installs a request configuration on one Agent scope. A complete immutable
 * value is captured at prompt assembly, then applied through DSH's official
 * agent/request waterfall for that exact model step.
 */
export function installRequestConfig(agentCtx, snapshotRoot, sourceSessionId, child = false) {
  let assembled
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const snapshot = readSessionSnapshot(snapshotRoot, sourceSessionId)
    assembled = structuredClone(child ? snapshot.subagentModel : snapshot.model)
    const result = await next()
    return assembled === undefined ? result : {
      ...result,
      variables: {
        ...result.variables,
        provider: assembled.provider,
        model: assembled.model
      }
    }
  })
  const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const inherited = await next()
    if (!assembled) return inherited
    const {
      provider: _provider,
      model: _model,
      reasoningEffort: _reasoningEffort,
      temperature: _temperature,
      topP: _topP,
      maxTokens: _maxTokens,
      ...rest
    } = inherited
    return {
      ...rest,
      provider: assembled.provider,
      model: assembled.model,
      ...(assembled.reasoningEffort === undefined ? {} : { reasoningEffort: assembled.reasoningEffort }),
      ...(assembled.temperature === undefined ? {} : { temperature: assembled.temperature }),
      ...(assembled.topP === undefined ? {} : { topP: assembled.topP }),
      ...(assembled.maxTokens === undefined ? {} : { maxTokens: assembled.maxTokens })
    }
  })
  return () => {
    disposeRequest()
    disposeAssembly()
  }
}
