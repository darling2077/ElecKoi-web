import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { readSessionSnapshot } from './session-snapshot.mjs'

export const name = 'eleckoi-conversation-context'

/**
 * Seed a newly-created DSH Session from ElecKoi's authoritative active branch.
 * The current user input is deliberately absent: the SDK records it through
 * session/prompt, so it must never be copied into the seed.
 */
export function createConversationSeed(snapshot, modelSelection) {
  const history = Array.isArray(snapshot?.conversationContext?.history)
    ? snapshot.conversationContext.history
    : []
  const events = []
  let sequence = 0
  let turn = 0
  let openTurn = false

  const append = (type, data, surface = false) => {
    events.push({
      type,
      seq: sequence,
      time: Date.now() + sequence,
      data,
      ...(surface ? { surfaceOp: 'append' } : {})
    })
    sequence += 1
  }
  const beginTurn = () => {
    turn += 1
    append('turn/start', { turn })
    openTurn = true
  }
  const endTurn = () => {
    if (!openTurn) return
    append('turn/end', { turn, reason: { kind: 'completed' } })
    openTurn = false
  }

  for (const item of history) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) continue
    const text = String(item.content ?? '')
    if (!text.trim()) continue
    if (item.role === 'user') {
      endTurn()
      beginTurn()
      append('user/message', createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' }
      }), true)
      continue
    }
    if (!openTurn) beginTurn()
    append('step/start', { turn, step: 1 })
    append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: {
          provider: modelSelection.provider,
          model: modelSelection.model
        }
      })
    }, true)
    append('step/end', { turn, step: 1 })
    endTurn()
  }
  endTurn()
  return events
}

/**
 * Install only agent-scoped, logged DSH prompt contributions. Model-visible
 * history is never rewritten at llm/stream: DSH owns it after the initial seed.
 */
export function installConversationContext(agentCtx, snapshotRoot, sourceSessionId) {
  const read = () => readSessionSnapshot(snapshotRoot, sourceSessionId)
  const disposeInstructions = agentCtx.systemPrompt.section({
    name: 'eleckoi:session-instructions',
    order: 1,
    text: () => {
      const snapshot = read()
      const additions = settingInjections(snapshot.conversationContext)
        .filter((entry) => entry.anchor === 'instructions')
        .map((entry) => entry.content)
      return [snapshot.model?.systemPrompt, ...additions]
        .filter((value) => typeof value === 'string' && value.trim())
        .join('\n\n')
    }
  })
  const disposeContext = agentCtx.systemPrompt.context({
    name: 'eleckoi:conversation-context',
    order: 10,
    text: () => renderRuntimeContext(read().conversationContext)
  })
  const disposePreStep = agentCtx.on('agent/pre-step', async ({ step }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1) return decision
    return {
      kind: 'enter',
      messages: projectPreStepMessages(decision.messages, read().conversationContext)
    }
  }, { prepend: true })
  return () => {
    disposePreStep()
    disposeContext()
    disposeInstructions()
  }
}

/** Prefix entries that belong before the latest user input on the first step. */
export function projectPreStepMessages(messages, context) {
  const before = settingInjections(context).filter((entry) => (
    entry.anchor === 'after_instructions'
    || entry.anchor === 'before_history'
    || entry.anchor === 'before_latest_user_input'
  ))
  if (before.length === 0) return messages
  return [...before.map(contextMessage), ...messages]
}

/**
 * DSH runtime context is a logged user-context snapshot. Entries after the
 * latest input and around tool flow therefore stay visible on later steps
 * without manufacturing assistant history.
 */
export function renderRuntimeContext(context) {
  return settingInjections(context)
    .filter((entry) => (
      entry.anchor === 'after_history'
      || entry.anchor === 'after_latest_user_input'
      || entry.anchor === 'before_tool_flow'
      || entry.anchor === 'after_tool_flow'
    ))
    .map((entry) => entry.content)
    .join('\n\n')
}

export function settingInjections(context) {
  const library = context?.settingLibrary
  if (!library) return []
  const promptPositions = new Map((library.promptPositions || []).map((position) => [position.id, position]))
  return (library.entries || [])
    .filter((entry) => entry?.enabled
      && typeof entry.content === 'string'
      && entry.content.trim()
      && entry.kind !== 'opening'
      && entry.kind !== 'history_compaction'
      && entry.triggerMode === 'always')
    .map((entry) => {
      const custom = promptPositions.get(entry.promptPositionId)
      return {
        id: String(entry.id || '').slice(0, 128),
        anchor: custom?.anchor || entry.position || 'after_instructions',
        content: entry.content.slice(0, 40_000),
        positionOrder: custom?.order ?? Number.MIN_SAFE_INTEGER,
        order: Number.isInteger(entry.order) ? entry.order : 1
      }
    })
    .sort((left, right) => anchorOrder(left.anchor) - anchorOrder(right.anchor)
      || left.positionOrder - right.positionOrder
      || left.order - right.order
      || left.id.localeCompare(right.id))
    .slice(0, 128)
}

function contextMessage(entry) {
  return createUserMessage({
    content: [{ type: 'text', text: entry.content }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'snapshot',
      sections: [{ name: entry.id || name, text: entry.content }]
    }
  })
}

function anchorOrder(anchor) {
  const index = [
    'instructions',
    'after_instructions',
    'before_history',
    'before_latest_user_input',
    'after_history',
    'after_latest_user_input',
    'before_tool_flow',
    'after_tool_flow'
  ].indexOf(anchor)
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}
