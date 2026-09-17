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
  const injections = settingInjections(context)
  const before = injections.filter((entry) => entry.anchor === 'insert_point_3')
  const after = injections.filter((entry) => entry.anchor === 'insert_point_4' || entry.anchor === 'insert_point_5')
  if (before.length === 0 && after.length === 0) return messages
  return [...before.map(contextMessage), ...messages, ...after.map(contextMessage)]
}

/**
 * DSH runtime context is a logged user-context snapshot. Entries after the
 * latest input and around tool flow therefore stay visible on later steps
 * without manufacturing assistant history.
 */
export function renderRuntimeContext(context) {
  return settingInjections(context)
    .filter((entry) => entry.anchor === 'insert_point_1' || entry.anchor === 'insert_point_2')
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
      && (entry.triggerMode === 'cache' || (entry.triggerMode === 'always' && entry.position)))
    .map((entry) => {
      const custom = promptPositions.get(entry.promptPositionId)
      const anchor = entry.triggerMode === 'cache' ? 'insert_point_1' : custom?.anchor || entry.position || 'insert_point_1'
      const title = String(entry.title || '').trim() || '未命名设定'
      return {
        id: String(entry.id || '').slice(0, 128),
        anchor,
        role: anchor === 'instructions' ? 'system' : entry.insertRole === 'assistant' ? 'assistant' : 'user',
        content: entry.content.slice(0, 40_000),
        placementRank: entry.triggerMode === 'cache'
          ? 3
          : custom?.side === 'before_setting_position' ? 0 : custom?.side === 'after_setting_position' ? 2 : 1,
        positionOrder: custom?.order ?? 0,
        order: Number.isInteger(entry.order) ? entry.order : 1,
        traceTitle: entry.triggerMode === 'cache'
          ? `缓存设定 · ${title}`
          : entry.kind === 'hidden_tool_timeline'
            ? `预设固定条目 · ${title}`
            : String(entry.id || '').startsWith('agent-preset:')
              ? `预设条目 · ${title}`
              : `设定 · ${title}`,
        traceSource: String(custom?.name || '').trim() || positionLabel(anchor)
      }
    })
    .sort((left, right) => anchorOrder(left.anchor) - anchorOrder(right.anchor)
      || left.placementRank - right.placementRank
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
      label: entry.traceSource,
      sections: [{ name: entry.traceTitle || entry.id || name, text: entry.content }]
    }
  })
}

function anchorOrder(anchor) {
  const index = [
    'instructions',
    'insert_point_1',
    'insert_point_2',
    'insert_point_3',
    'insert_point_4',
    'insert_point_5'
  ].indexOf(anchor)
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}

function positionLabel(anchor) {
  return ({
    instructions: '系统指令',
    insert_point_1: '设定插入点 1',
    insert_point_2: '设定插入点 2',
    insert_point_3: '设定插入点 3',
    insert_point_4: '设定插入点 4',
    insert_point_5: '设定插入点 5'
  })[anchor] || '设定位置'
}
