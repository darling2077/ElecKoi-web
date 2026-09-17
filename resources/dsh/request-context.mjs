import { projectModelMessages } from './conversation-context.mjs'
import { readSessionSnapshot } from './session-snapshot.mjs'

/**
 * Keep product history at the provider boundary. DSH's durable session remains
 * the record of work that actually happened, while every model request sees
 * the authoritative product branch and current prompt-position injections.
 */
export const name = 'eleckoi-request-context'
export const inject = ['llm']

export function apply(ctx) {
  const snapshotRoot = process.env.ELECKOI_SESSION_SNAPSHOT_ROOT
  if (!snapshotRoot) throw new Error('ELECKOI_SESSION_SNAPSHOT_ROOT is required')
  const wrappers = new WeakMap()
  const wrapRegisteredAdapters = () => {
    const registrations = ctx.llm.adapters
    if (!(registrations instanceof Map)) {
      throw new Error('ElecKoi request projection requires the pinned DSH adapter registry')
    }
    for (const registration of registrations.values()) {
      const adapter = registration.adapter
      if (adapter?.eleckoiRequestContextWrapper === true) continue
      let wrapper = wrappers.get(adapter)
      if (!wrapper) {
        wrapper = requestContextAdapter(adapter, snapshotRoot)
        wrappers.set(adapter, wrapper)
      }
      registration.adapter = wrapper
    }
  }
  wrapRegisteredAdapters()
  const dispose = ctx.on('llm/adapters-updated', wrapRegisteredAdapters)
  return () => dispose()
}

export function projectGenerateOptions(options, snapshotRoot) {
  if (!options?.sessionId || options.purpose !== undefined) return options
  let snapshot
  try {
    snapshot = readSessionSnapshot(snapshotRoot, options.sessionId)
  } catch (error) {
    if (error?.code === 'ENOENT') return options
    throw error
  }
  const messages = projectModelMessages(options.messages, snapshot.conversationContext)
  return messages === options.messages ? options : { ...options, messages }
}

function requestContextAdapter(adapter, snapshotRoot) {
  if (!adapter) throw new Error('ElecKoi request projection received an empty DSH adapter')
  return {
    eleckoiRequestContextWrapper: true,
    providerInfo: (provider) => adapter.providerInfo(provider),
    providerRetryPolicy: (provider) => adapter.providerRetryPolicy(provider),
    listModels: (provider) => adapter.listModels(provider),
    resolveModel: (provider, model, signal) => adapter.resolveModel(provider, model, signal),
    async prepareCall(provider, model, signal) {
      const prepared = await adapter.prepareCall(provider, model, signal)
      return {
        model: prepared.model,
        stream: (options) => prepared.stream(projectGenerateOptions(options, snapshotRoot))
      }
    },
    stream: (options) => adapter.stream(projectGenerateOptions(options, snapshotRoot))
  }
}
