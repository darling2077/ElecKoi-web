import {
  AUTHOR_API_STAGE,
  AUTHOR_API_VERSION,
  AuthorApiError,
  AuthorBridgeRequestGate,
  AUTHOR_EVENT_NAMES,
  authorApiDefinitions,
  characterConversationPermissions,
  routeAuthorApiRequest,
  type AuthorBridgeRejectionCode
} from '@eleckoi/author-sdk'
import type { AgentSessionCoordinator } from '@main/modules/agent'
import type { ConversationRepository, MessageRepository } from '@main/modules/conversations'
import type { ModelRepository } from '@main/modules/models'
import type { CharacterRepository } from '@main/modules/personas'
import type { UserSettingsStore } from '@main/modules/settings'
import type { SettingLibraryRepository } from '@main/modules/settingLibraries'
import type { VariableConfigRepository, VariableStateRepository } from '@main/modules/variables'
import type { ChatMessage } from '@shared/contracts/entities/chat'
import {
  characterCardMacroValues,
  resolveCharacterCardMacrosInJson
} from '@shared/foundation/characterCardMacros'
import type { CharacterCardMacroValues } from '@shared/foundation/characterCardMacros'
import { chatAttachmentMediaReference } from '@shared/foundation/mediaReference'

const bridgeErrors: Record<AuthorBridgeRejectionCode, string> = {
  BRIDGE_REQUEST_TOO_LARGE: '作者 API 请求过大',
  BRIDGE_BUSY: '作者 API 同时请求过多',
  BRIDGE_RATE_LIMITED: '作者 API 请求过于频繁'
}

function requestId(rawRequest: string): string {
  try {
    const value: unknown = JSON.parse(rawRequest)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const id = (value as Record<string, unknown>).id
      return typeof id === 'string' ? id : ''
    }
  } catch { /* handled by the SDK router */ }
  return ''
}

function parsedJson(source: string): unknown {
  try { return JSON.parse(source || '{}') } catch { return {} }
}

function jsonObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthorApiError('INVALID_PARAMS', message)
  }
  return value as Record<string, unknown>
}

function mergeObjects(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const previous = result[key]
    result[key] = previous && typeof previous === 'object' && !Array.isArray(previous)
      && value && typeof value === 'object' && !Array.isArray(value)
      ? mergeObjects(previous as Record<string, unknown>, value as Record<string, unknown>)
      : value
  }
  return result
}

function pointerParts(path: unknown): string[] {
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/'))) {
    throw new AuthorApiError('INVALID_PARAMS', '变量补丁路径必须是 JSON Pointer')
  }
  return path === '' ? [] : path.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function arrayIndex(part: string, length: number, allowEnd: boolean): number {
  if (allowEnd && part === '-') return length
  if (!/^(0|[1-9]\d*)$/.test(part)) throw new AuthorApiError('INVALID_PARAMS', `无效的数组位置：${part}`)
  const index = Number(part)
  if (index < 0 || index > length || (!allowEnd && index === length)) {
    throw new AuthorApiError('INVALID_PARAMS', `数组位置超出范围：${part}`)
  }
  return index
}

function applyVariablePatch(current: Record<string, unknown>, rawPatch: unknown): Record<string, unknown> {
  if (!Array.isArray(rawPatch) || rawPatch.length > 1_000) {
    throw new AuthorApiError('INVALID_PARAMS', '变量补丁必须是操作数组')
  }
  let root: unknown = structuredClone(current)
  for (const rawOperation of rawPatch) {
    const operation = jsonObject(rawOperation, '变量补丁操作必须是对象')
    const op = operation.op
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw new AuthorApiError('INVALID_PARAMS', `不支持的变量补丁操作：${String(op)}`)
    }
    if (op !== 'remove' && !Object.prototype.hasOwnProperty.call(operation, 'value')) {
      throw new AuthorApiError('INVALID_PARAMS', `${op} 操作必须提供 value`)
    }
    const parts = pointerParts(operation.path)
    if (parts.length === 0) {
      root = op === 'remove' ? {} : structuredClone(operation.value)
      continue
    }
    let parent = root
    for (const part of parts.slice(0, -1)) {
      if (Array.isArray(parent)) parent = parent[arrayIndex(part, parent.length, false)]
      else if (parent && typeof parent === 'object') parent = (parent as Record<string, unknown>)[part]
      else throw new AuthorApiError('INVALID_PARAMS', `变量补丁找不到路径：${String(operation.path)}`)
    }
    const key = parts.at(-1)!
    if (Array.isArray(parent)) {
      const index = arrayIndex(key, parent.length, op === 'add')
      if (op === 'add') parent.splice(index, 0, structuredClone(operation.value))
      else if (op === 'replace') parent[index] = structuredClone(operation.value)
      else parent.splice(index, 1)
    } else if (parent && typeof parent === 'object') {
      const object = parent as Record<string, unknown>
      if (op !== 'add' && !(key in object)) {
        throw new AuthorApiError('INVALID_PARAMS', `变量补丁找不到路径：${String(operation.path)}`)
      }
      if (op === 'remove') delete object[key]
      else object[key] = structuredClone(operation.value)
    } else {
      throw new AuthorApiError('INVALID_PARAMS', `变量补丁找不到路径：${String(operation.path)}`)
    }
  }
  return jsonObject(root, '变量补丁的最终结果必须是一个对象')
}

function publicMessage(message: ChatMessage, macroValues?: CharacterCardMacroValues) {
  const variableStateJson = macroValues
    ? resolveCharacterCardMacrosInJson(message.variableStateJson, macroValues)
    : message.variableStateJson
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    displayContent: message.displayContent ?? message.content,
    variableState: parsedJson(variableStateJson),
    status: message.status,
    createdAt: message.createdAt,
    turnId: message.turnId ?? '',
    speakerId: message.speakerId ?? '',
    speakerName: message.speakerName ?? '',
    speakerAvatar: message.speakerAvatar ?? '',
    sequence: message.sequence ?? null,
    responseIndex: message.responseIndex ?? null,
    process: message.process ?? [],
    attachments: (message.inputImageAttachments ?? []).map((attachment) => publicImageAttachment(message.conversationId, attachment)),
    openingOptions: (message.openingOptions ?? []).map((option) => ({
      id: option.id,
      title: option.title,
      content: option.content,
      ...(option.displayContent === undefined ? {} : { displayContent: option.displayContent }),
      initialVariableState: parsedJson(option.initialVariableStateJson)
    })),
    selectedOpeningId: message.selectedOpeningId ?? ''
  }
}

function publicImageAttachment(conversationId: string, attachment: NonNullable<ChatMessage['inputImageAttachments']>[number]) {
  return {
    id: attachment.attachmentId,
    type: 'image' as const,
    url: chatAttachmentMediaReference(conversationId, attachment.attachmentId),
    mimeType: attachment.mediaType,
    name: attachment.name ?? '图片',
    size: attachment.bytes,
    width: attachment.width,
    height: attachment.height,
    duration: null,
    metadata: attachment.originalDimensions ? { originalDimensions: attachment.originalDimensions } : {}
  }
}

function sendImages(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 4) throw new AuthorApiError('INVALID_PARAMS', '每条消息最多发送 4 张图片')
  const supported = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  return value.map((item) => {
    const input = jsonObject(item, '消息附件格式不正确')
    const mediaType = typeof input.mediaType === 'string' ? input.mediaType : ''
    const data = typeof input.data === 'string' ? input.data.replace(/\s+/g, '') : ''
    if (input.type !== 'image' || !supported.has(mediaType)) {
      throw new AuthorApiError('INVALID_PARAMS', 'Agent 消息附件仅支持 PNG、JPEG、WebP 和 GIF 图片')
    }
    if (!data) throw new AuthorApiError('INVALID_PARAMS', '图片附件内容不能为空')
    return {
      mediaType: mediaType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
      data,
      ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim().slice(0, 255) } : {})
    }
  })
}

const supportedMethods = new Set([
  'app.getInfo',
  'app.getCapabilities',
  'context.current',
  'variables.getState',
  'variables.getConfig',
  'variables.setState',
  'variables.merge',
  'variables.applyPatch',
  'variables.reset',
  'openings.list',
  'openings.current',
  'openings.select',
  'messages.list',
  'messages.get',
  'messages.current',
  'messages.deleteFrom',
  'messages.regenerate',
  'messages.editAndRegenerate',
  'chat.current',
  'chat.list',
  'chat.getGenerationState',
  'chat.getAgentTrajectory',
  'chat.getModels',
  'chat.send',
  'chat.stopGeneration',
  'chat.create',
  'chat.open',
  'chat.delete',
  'chat.selectModel',
  'character.current',
  'settingLibrary.current',
  'settingLibrary.getSummary',
  'media.getMessageAttachments',
  'media.getMessageAttachment',
  'audio.play',
  'audio.pause',
  'audio.resume',
  'audio.stop',
  'audio.seek',
  'audio.getState',
  'audio.getPlaylist',
  'audio.setPlaylist',
  'audio.appendPlaylist',
  'audio.getSettings',
  'audio.setSettings',
  'input.get',
  'input.set',
  'input.append',
  'input.clear',
  'input.send',
  'events.list'
])

export class AuthorSdkService {
  private readonly gates = new Map<string, AuthorBridgeRequestGate>()

  constructor(private readonly dependencies: {
    conversations: ConversationRepository
    messages: MessageRepository
    variables: VariableConfigRepository
    variableStates: VariableStateRepository
    characters: CharacterRepository
    settingLibraries: SettingLibraryRepository
    models: ModelRepository
    userSettings: UserSettingsStore
    notifyModelSelection(selection: { capability: 'chat'; config_id: string; model: string }): void
    agentSessions: AgentSessionCoordinator
  }) {}

  async invoke(input: { conversationId: string; messageId: string; request: string }, senderId: number): Promise<{ response: string }> {
    const message = this.dependencies.messages.get(input.conversationId, input.messageId)
    const gateKey = `${senderId}:${input.conversationId}:${input.messageId}`
    let gate = this.gates.get(gateKey)
    if (gate) {
      this.gates.delete(gateKey)
    } else {
      gate = new AuthorBridgeRequestGate()
      if (this.gates.size >= 1_024) {
        const oldest = this.gates.keys().next().value
        if (oldest !== undefined) this.gates.delete(oldest)
      }
    }
    this.gates.set(gateKey, gate)
    const rejection = gate.tryAcquire(input.request)
    if (rejection) {
      return { response: JSON.stringify({
        id: requestId(input.request),
        ok: false,
        error: { code: rejection, message: bridgeErrors[rejection] }
      }) }
    }
    try {
      const response = await routeAuthorApiRequest(
        input.request,
        characterConversationPermissions,
        (method, params) => this.invokeMethod(input.conversationId, message, method, params)
      )
      return { response }
    } finally {
      gate.release()
    }
  }

  private invokeMethod(conversationId: string, message: ChatMessage, method: string, params: Record<string, unknown>): unknown {
    const conversation = this.dependencies.conversations.get(conversationId)
    const metadata = this.dependencies.conversations.getMetadata(conversationId)
    const macroValues = characterCardMacroValues(metadata, metadata.characterPersona.user_name)
    const messages = () => this.dependencies.messages.list(conversationId)
    const publicMessages = () => messages().map((item) => publicMessage(item, macroValues))
    const publicChat = (item: ReturnType<ConversationRepository['list']>[number]) => ({
      ...item.conversation,
      characterId: item.metadata.characterId,
      characterName: item.metadata.characterName,
      characterAvatar: item.metadata.characterAvatar
    })
    const opening = () => {
      try { return this.dependencies.messages.get(conversationId, 'opening') } catch { return undefined }
    }
    switch (method) {
      case 'app.getInfo':
        return { name: 'ElecKoi', apiVersion: AUTHOR_API_VERSION, stage: AUTHOR_API_STAGE }
      case 'app.getCapabilities':
        return authorApiDefinitions.filter((item) => (
          supportedMethods.has(item.method) && characterConversationPermissions.has(item.permission)
        ))
      case 'context.current':
        return {
          surface: 'message-renderer',
          scope: 'current-character',
          conversationId,
          conversationTitle: conversation.title,
          messageId: message.id,
          characterId: metadata.characterId
        }
      case 'variables.getState': {
        const messageId = typeof params.messageId === 'string' ? params.messageId.trim() : ''
        const stateJson = messageId
          ? this.dependencies.messages.get(conversationId, messageId).variableStateJson
          : this.dependencies.variableStates.viewerStates(conversationId).currentStateJson
        return parsedJson(macroValues ? resolveCharacterCardMacrosInJson(stateJson, macroValues) : stateJson)
      }
      case 'variables.getConfig':
        return metadata.characterId ? this.dependencies.variables.get(metadata.characterId) : null
      case 'variables.setState': {
        const state = jsonObject(params.state, '变量状态必须是一个对象')
        return parsedJson(this.dependencies.variableStates.replaceCurrent(conversationId, JSON.stringify(state)))
      }
      case 'variables.merge': {
        const patch = jsonObject(params.state, '合并内容必须是一个对象')
        const current = jsonObject(parsedJson(this.dependencies.variableStates.viewerStates(conversationId).currentStateJson), '当前变量状态不正确')
        return parsedJson(this.dependencies.variableStates.replaceCurrent(conversationId, JSON.stringify(mergeObjects(current, patch))))
      }
      case 'variables.applyPatch': {
        const current = jsonObject(parsedJson(this.dependencies.variableStates.viewerStates(conversationId).currentStateJson), '当前变量状态不正确')
        const next = applyVariablePatch(current, params.patch)
        return parsedJson(this.dependencies.variableStates.replaceCurrent(conversationId, JSON.stringify(next)))
      }
      case 'variables.reset': {
        const initial = this.dependencies.variableStates.viewerStates(conversationId).initialStateJson
        return parsedJson(this.dependencies.variableStates.replaceCurrent(conversationId, initial))
      }
      case 'openings.list':
        return { items: publicMessage(opening() ?? message, macroValues).openingOptions }
      case 'openings.current': {
        const current = publicMessage(opening() ?? message, macroValues)
        return current.openingOptions.find((item) => item.id === current.selectedOpeningId) ?? null
      }
      case 'openings.select': {
        const id = typeof params.id === 'string' ? params.id.trim() : ''
        if (!id) throw new AuthorApiError('INVALID_PARAMS', '开场白 id 不能为空')
        this.dependencies.conversations.selectOpening(conversationId, id)
        return { selectedId: id }
      }
      case 'messages.list':
        return publicMessages()
      case 'messages.get': {
        const id = typeof params.id === 'string' ? params.id.trim() : ''
        if (!id) throw new AuthorApiError('INVALID_PARAMS', '消息 id 不能为空')
        return publicMessage(this.dependencies.messages.get(conversationId, id), macroValues)
      }
      case 'messages.current':
        return publicMessage(messages().at(-1) ?? message, macroValues)
      case 'messages.deleteFrom': {
        const id = typeof params.id === 'string' ? params.id.trim() : ''
        if (!id) throw new AuthorApiError('INVALID_PARAMS', '消息 id 不能为空')
        return this.dependencies.agentSessions.deleteMessagesFrom(conversationId, id)
      }
      case 'messages.regenerate': {
        const id = typeof params.id === 'string' ? params.id.trim() : ''
        if (!id) throw new AuthorApiError('INVALID_PARAMS', '消息 id 不能为空')
        return this.dependencies.agentSessions.regenerate(conversationId, id)
      }
      case 'messages.editAndRegenerate': {
        const id = typeof params.id === 'string' ? params.id.trim() : ''
        const text = typeof params.text === 'string' ? params.text.trim() : ''
        if (!id) throw new AuthorApiError('INVALID_PARAMS', '消息 id 不能为空')
        if (!text) throw new AuthorApiError('INVALID_PARAMS', '修改后的消息不能为空')
        if (text.length > 100_000) throw new AuthorApiError('INVALID_PARAMS', '修改后的消息过长')
        return this.dependencies.agentSessions.regenerate(conversationId, id, text)
      }
      case 'chat.current':
        return publicChat({ conversation, metadata })
      case 'chat.list': {
        const items = metadata.characterId
          ? this.dependencies.conversations.list().filter((item) => item.metadata.characterId === metadata.characterId)
          : [{ conversation, metadata }]
        return { items: items.map(publicChat) }
      }
      case 'chat.getGenerationState': {
        const state = this.dependencies.agentSessions.inspect(conversationId)
        return { ...state, stats: this.dependencies.agentSessions.generationStats(conversationId).stats }
      }
      case 'chat.getAgentTrajectory': {
        const beforeIndex = Number.isInteger(params.beforeIndex) && Number(params.beforeIndex) > 0
          ? Number(params.beforeIndex)
          : undefined
        const limit = Number.isInteger(params.limit) && Number(params.limit) > 0
          ? Math.min(Number(params.limit), 200)
          : undefined
        return this.dependencies.agentSessions.trajectory(conversationId, { beforeIndex, limit })
      }
      case 'chat.getModels': {
        const current = this.dependencies.userSettings.read('models.active')
        return {
          current: { configId: current.config_id, model: current.model },
          items: this.dependencies.models.list()
            .filter((item) => item.enabled && item.provider !== 'openai_image' && item.provider !== 'novelai_image')
            .map((item) => ({
              configId: item.id,
              name: item.name,
              provider: item.provider,
              defaultModel: item.model,
              models: item.model_options
            }))
        }
      }
      case 'chat.selectModel': {
        const configId = typeof params.configId === 'string' ? params.configId.trim() : ''
        const model = typeof params.model === 'string' ? params.model.trim() : ''
        if (!configId) throw new AuthorApiError('INVALID_PARAMS', '模型配置 id 不能为空')
        const config = this.dependencies.models.list().find((item) => (
          item.id === configId
          && item.enabled
          && item.provider !== 'openai_image'
          && item.provider !== 'novelai_image'
        ))
        if (!config) throw new AuthorApiError('INVALID_PARAMS', '找不到可用的聊天模型配置')
        const selection = this.dependencies.userSettings.write('models.active', {
          capability: 'chat',
          config_id: config.id,
          model: model || config.model
        })
        this.dependencies.notifyModelSelection(selection)
        return { configId: selection.config_id, model: selection.model }
      }
      case 'chat.send': {
        const text = typeof params.text === 'string' ? params.text.trim() : ''
        const images = sendImages(params.attachments)
        if (!text && images.length === 0) throw new AuthorApiError('INVALID_PARAMS', '发送内容和图片不能同时为空')
        if (text.length > 100_000) throw new AuthorApiError('INVALID_PARAMS', '发送内容过长')
        return this.dependencies.agentSessions.start(conversationId, text, images)
      }
      case 'chat.stopGeneration':
        return this.dependencies.agentSessions.cancel(conversationId)
      case 'chat.create': {
        if (!metadata.characterId) throw new AuthorApiError('INVALID_CONTEXT', '当前聊天没有绑定角色')
        const title = typeof params.title === 'string' ? params.title.trim() : ''
        const created = this.dependencies.conversations.create({
          title: title || metadata.characterName || '新对话',
          metadata
        })
        return { chat: publicChat(created) }
      }
      case 'chat.open': {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
        if (!sessionId) throw new AuthorApiError('INVALID_PARAMS', '聊天 id 不能为空')
        const target = {
          conversation: this.dependencies.conversations.get(sessionId),
          metadata: this.dependencies.conversations.getMetadata(sessionId)
        }
        if (!metadata.characterId || target.metadata.characterId !== metadata.characterId) {
          throw new AuthorApiError('OUT_OF_SCOPE', '角色对话界面只能打开当前角色的聊天')
        }
        return { chat: publicChat(target) }
      }
      case 'chat.delete': {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
        if (!sessionId) throw new AuthorApiError('INVALID_PARAMS', '聊天 id 不能为空')
        const targetMetadata = this.dependencies.conversations.getMetadata(sessionId)
        if (!metadata.characterId || targetMetadata.characterId !== metadata.characterId) {
          throw new AuthorApiError('OUT_OF_SCOPE', '角色对话界面只能删除当前角色的聊天')
        }
        return this.dependencies.conversations.delete(sessionId).then(() => {
          const remaining = this.dependencies.conversations.list()
            .filter((item) => item.metadata.characterId === metadata.characterId)
          const next = sessionId !== conversationId
            ? remaining.find((item) => item.conversation.id === conversationId) ?? remaining[0]
            : remaining[0]
          const active = next ?? this.dependencies.conversations.create({
            title: metadata.characterName || '新对话',
            metadata
          })
          return { deletedId: sessionId, chat: publicChat(active) }
        })
      }
      case 'character.current': {
        const character = this.dependencies.characters.get().items.find((item) => item.id === metadata.characterId)
        return character ?? {
          id: metadata.characterId,
          name: metadata.characterName,
          avatar: metadata.characterAvatar,
          persona: metadata.characterPersona
        }
      }
      case 'settingLibrary.getSummary': {
        if (!metadata.characterId) return null
        const library = this.dependencies.settingLibraries.get(metadata.characterId)
        return {
          characterId: library.characterId,
          name: library.name,
          activeVersionId: library.activeVersionId,
          entryCount: library.entries.length,
          groupCount: library.groups.length
        }
      }
      case 'settingLibrary.current':
        return metadata.characterId
          ? this.dependencies.settingLibraries.runtimeContext(conversationId, { characterId: metadata.characterId }) ?? null
          : null
      case 'media.getMessageAttachments': {
        const messageId = typeof params.messageId === 'string' && params.messageId.trim()
          ? params.messageId.trim()
          : message.id
        const target = this.dependencies.messages.get(conversationId, messageId)
        return { items: (target.inputImageAttachments ?? []).map((item) => publicImageAttachment(conversationId, item)) }
      }
      case 'media.getMessageAttachment': {
        const messageId = typeof params.messageId === 'string' ? params.messageId.trim() : ''
        const attachmentId = typeof params.attachmentId === 'string' ? params.attachmentId.trim() : ''
        if (!messageId || !attachmentId) throw new AuthorApiError('INVALID_PARAMS', '消息 id 和附件 id 不能为空')
        const target = this.dependencies.messages.get(conversationId, messageId)
        const attachment = target.inputImageAttachments?.find((item) => item.attachmentId === attachmentId)
        if (!attachment) throw new AuthorApiError('NOT_FOUND', '找不到这条消息里的媒体附件')
        return publicImageAttachment(conversationId, attachment)
      }
      case 'events.list':
        return { items: AUTHOR_EVENT_NAMES }
      default:
        throw new AuthorApiError('METHOD_NOT_FOUND', `当前页面不支持 ${method}`)
    }
  }
}
