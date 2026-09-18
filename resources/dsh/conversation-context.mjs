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
      stream: [],
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

/** Install product-owned prompt contributions for every root turn. */
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
  const disposeStepProjection = agentCtx.on('agent/pre-step', async ({ step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision
    return {
      ...decision,
      messages: projectModelMessages(decision.messages, read().conversationContext)
    }
  })
  return () => {
    disposeStepProjection()
    disposeContext()
    disposeInstructions()
  }
}

/** Place current-turn prompt entries into DSH's durable admitted message batch. */
export function projectModelMessages(messages, context) {
  const injections = settingInjections(context)
  const before = injections.filter((entry) => entry.anchor === 'insert_point_3')
  const after = injections.filter((entry) => entry.anchor === 'insert_point_4' || entry.anchor === 'insert_point_5')
  if (before.length === 0 && after.length === 0) return messages
  const currentUserIndex = findCurrentUserIndex(messages)
  if (currentUserIndex < 0) return messages
  return [
    ...messages.slice(0, currentUserIndex),
    ...before.map(contextMessage),
    messages[currentUserIndex],
    ...after.map(contextMessage),
    ...messages.slice(currentUserIndex + 1)
  ]
}

/**
 * Replace previous native provider turns with the active product branch.
 * Current-turn tool messages remain untouched because this runs only at step 1.
 */
export function projectProductHistory(messages, context) {
  const currentUserIndex = findCurrentUserIndex(messages)
  if (currentUserIndex < 0) return messages
  const firstDialogue = messages.findIndex((message, index) => (
    index <= currentUserIndex && isDialogueMessage(message)
  ))
  const replaceFrom = firstDialogue < 0 ? currentUserIndex : firstDialogue
  const nativeHistory = messages.slice(replaceFrom, currentUserIndex)
  const productHistory = (Array.isArray(context?.history) ? context.history : [])
    .map(productHistoryMessage)
    .filter(Boolean)
  const authoritative = compactedProjection(productHistory, nativeHistory) ?? productHistory
  return [
    ...messages.slice(0, replaceFrom),
    ...authoritative,
    ...messages.slice(currentUserIndex)
  ]
}

function productHistoryMessage(item, index) {
  if (!item || (item.role !== 'user' && item.role !== 'assistant')) return null
  const value = String(item.content ?? '')
  if (!value.trim()) return null
  return {
    id: `eleckoi-product-history-${index}`,
    role: item.role,
    content: [{ type: 'text', text: value }],
    source: { kind: 'plugin', plugin: 'eleckoi-product-history' }
  }
}

function compactedProjection(productHistory, nativeHistory) {
  const checkpointIndex = nativeHistory.findLastIndex(isCompactionCheckpoint)
  if (checkpointIndex < 0) return null
  const checkpoint = nativeHistory[checkpointIndex]
  const nativeTail = nativeHistory.slice(checkpointIndex + 1).filter(isDialogueMessage)
  if (nativeTail.length > productHistory.length) return null
  const productTail = nativeTail.length === 0 ? [] : productHistory.slice(-nativeTail.length)
  if (!productTail.every((product, index) => messagesMatch(product, nativeTail[index]))) return null
  return [checkpoint, ...productTail]
}

function findCurrentUserIndex(messages) {
  return messages.findLastIndex((message) => message?.role === 'user' && message?.source?.kind === 'user')
}

function isDialogueMessage(message) {
  return (message?.role === 'user' || message?.role === 'assistant') && message?.source?.kind !== 'tool'
}

function isCompactionCheckpoint(message) {
  return message?.role === 'user' && messageText(message).includes('<compacted-summary>')
}

function messagesMatch(left, right) {
  if (left?.role !== right?.role) return false
  return normalizedDialogueText(messageText(left), left.role) === normalizedDialogueText(messageText(right), right.role)
}

function messageText(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join('\n')
    : ''
}

function normalizedDialogueText(value, role) {
  const trimmed = value.trim()
  if (role !== 'assistant') return trimmed
  const start = trimmed.indexOf('<FINAL>')
  if (start < 0) return trimmed
  const bodyStart = start + '<FINAL>'.length
  const end = trimmed.lastIndexOf('</FINAL>')
  return trimmed.slice(bodyStart, end >= bodyStart ? end : undefined).trim()
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
