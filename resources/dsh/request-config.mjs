import { readSessionSnapshot } from './session-snapshot.mjs'
import { isProjectionEnvelope } from './conversation-context.mjs'

const COMPACTION_GUARD = '你当前只执行内部历史压缩。只返回非空的纯文本摘要正文；不要调用工具，不要输出推理过程，也不要使用主对话的输出协议标签。'

/**
 * Installs a request configuration on one Agent scope. A complete immutable
 * value is captured at prompt assembly, then applied through DSH's official
 * agent/request waterfall for that exact model step.
 */
export function installRequestConfig(agentCtx, snapshotRoot, sourceSessionId, child = false) {
  let assembled
  const reroutedCompactions = new WeakSet()
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
  const disposeCompaction = agentCtx.on('llm/stream', (options, next) => {
    if (reroutedCompactions.has(options)) return next()
    const snapshot = readSessionSnapshot(snapshotRoot, sourceSessionId)
    const projected = projectCompactionRequest(options, snapshot.historyCompactionInstructions)
    if (!projected) return next()
    // DSH deep-freezes requests before the waterfall. Route a fresh one-shot request through the
    // public LLM service, and let its nested waterfall pass through to the adapter exactly once.
    reroutedCompactions.add(projected)
    return agentCtx.llm.stream(projected)
  })
  return () => {
    disposeCompaction()
    disposeRequest()
    disposeAssembly()
  }
}

export function projectCompactionRequest(options, customInstructions) {
  const instructions = typeof customInstructions === 'string' ? customInstructions.trim() : ''
  if (options?.purpose !== 'compaction' || !Array.isArray(options.messages) || !options.messages.length) {
    return undefined
  }
  const messages = options.messages.filter((message) => !isProjectionEnvelope(message))
  const removedProjection = messages.length !== options.messages.length
  const last = messages.at(-1)
  if (!instructions || !last || last.role !== 'user') {
    if (!removedProjection) return undefined
    return { ...options, messages }
  }
  const { tools: _tools, reasoningEffort: _reasoningEffort, ...rest } = options
  return {
    ...rest,
    messages: [
      ...messages.slice(0, -1),
      {
        ...last,
        content: [{ type: 'text', text: `${COMPACTION_GUARD}\n\n${instructions}` }]
      }
    ]
  }
}
