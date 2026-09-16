import { describe, expect, it, vi } from 'vitest'
import { AUTHOR_API_VERSION } from '@eleckoi/author-sdk'
import { AuthorSdkService } from '../src/main/modules/authorSdk/AuthorSdkService'

function request(method: string, params: Record<string, unknown> = {}) {
  return JSON.stringify({ id: 'request-1', apiVersion: AUTHOR_API_VERSION, method, params })
}

function service() {
  const message = {
    id: 'assistant-1', conversationId: 'chat-1', role: 'assistant' as const, content: 'content',
    displayContent: '<div>content</div>',
    variableStateJson: '{"messageValue":7,"name":"{{user}}"}', status: 'complete' as const, createdAt: 'now',
    turnId: 'turn-1', speakerId: 'speaker-1', speakerName: 'Card', speakerAvatar: 'avatar', sequence: 2,
    responseIndex: 0,
    process: [{
      id: 'process-1', kind: 'tool' as const, status: 'complete' as const, toolName: 'read_file',
      arguments: '{"path":"story.md"}', summary: '读取文件', detail: '完成', startedAtMillis: 1, completedAtMillis: 2
    }],
    inputImageAttachments: [{ attachmentId: 'image-1', mediaType: 'image/png' as const, bytes: 12, width: 2, height: 3 }]
  }
  const selectOpening = vi.fn()
  const start = vi.fn(() => ({ accepted: true as const, conversationId: 'chat-1', runId: 'run-1', messageId: 'assistant-2' }))
  const regenerate = vi.fn((_conversationId: string, messageId: string, replacement?: string) => ({
    accepted: true as const, conversationId: 'chat-1', runId: replacement ? 'run-edit' : 'run-regenerate', messageId
  }))
  const cancel = vi.fn(async () => ({ cancelled: true }))
  const deleteMessagesFrom = vi.fn(async () => ({
    ok: true as const, deletedMessageCount: 1, remainingMessageCount: 0
  }))
  let currentStateJson = '{"current":1}'
  const replaceCurrent = vi.fn((_conversationId: string, stateJson: string) => {
    currentStateJson = stateJson
    return stateJson
  })
  const conversationRows = [
    { conversation: { id: 'chat-1', title: 'Chat', preview: '', createdAt: 'now', updatedAt: 'now' }, metadata: { characterId: 'card-1', characterName: 'Card', characterAvatar: '', characterPersona: { user_name: '测试用户甲' } } },
    { conversation: { id: 'chat-2', title: 'Other', preview: '', createdAt: 'now', updatedAt: 'now' }, metadata: { characterId: 'card-2', characterName: 'Other', characterAvatar: '', characterPersona: {} } }
  ]
  const createConversation = vi.fn((input: { title?: string; metadata?: { characterId?: string; characterName?: string; characterAvatar?: string; characterPersona?: Record<string, unknown> } }) => {
    const row = {
      conversation: { id: `chat-${conversationRows.length + 1}`, title: input.title ?? '新对话', preview: '', createdAt: 'now', updatedAt: 'now' },
      metadata: {
        characterId: input.metadata?.characterId ?? '', characterName: input.metadata?.characterName ?? '',
        characterAvatar: input.metadata?.characterAvatar ?? '', characterPersona: input.metadata?.characterPersona ?? {}
      }
    }
    conversationRows.unshift(row)
    return row
  })
  const deleteConversation = vi.fn(async (id: string) => {
    const index = conversationRows.findIndex((item) => item.conversation.id === id)
    if (index >= 0) conversationRows.splice(index, 1)
  })
  let modelSelection = { capability: 'chat' as const, config_id: 'model-config-1', model: 'model-a' }
  const writeModelSelection = vi.fn((_key: string, value: typeof modelSelection) => {
    modelSelection = value
    return value
  })
  const notifyModelSelection = vi.fn()
  const value = new AuthorSdkService({
    conversations: {
      get: (id: string) => conversationRows.find((item) => item.conversation.id === id)!.conversation,
      getMetadata: (id: string) => conversationRows.find((item) => item.conversation.id === id)!.metadata,
      list: () => conversationRows,
      create: createConversation,
      delete: deleteConversation,
      selectOpening
    } as never,
    messages: {
      get: (_conversationId: string, messageId: string) => messageId === 'opening'
        ? { ...message, id: 'opening', openingOptions: [{ id: 'opening-b', title: 'B', content: 'B', initialVariableStateJson: '{}' }], selectedOpeningId: 'opening-b' }
        : message,
      list: () => [message]
    } as never,
    variables: { get: () => ({ characterId: 'card-1' }) } as never,
    variableStates: {
      viewerStates: () => ({ initialStateJson: '{"initial":1}', currentStateJson }),
      replaceCurrent
    } as never,
    characters: { get: () => ({ active_character_id: 'card-1', groups: [], items: [{ id: 'card-1', name: 'Card', persona: { opening: 'hello' } }] }) } as never,
    settingLibraries: {
      get: () => ({ characterId: 'card-1', name: 'World', activeVersionId: 'version-1', entries: [{ id: 'entry-1' }], groups: [], versions: [], promptPositions: [], listAllExpanded: true, expandedGroupIds: [] }),
      runtimeContext: () => ({ characterId: 'card-1', name: 'World', entries: [{ id: 'entry-1', title: 'Background', content: 'Story facts' }], groups: [], promptPositions: [] })
    } as never,
    models: { list: () => [{
      id: 'model-config-1', name: 'Chat model', provider: 'deepseek', api_key: 'secret', base_url: 'https://example.com',
      proxy_url: '', model: 'model-a', model_options: [{ id: 'model-a', name: 'Model A', supportsImageInput: true }],
      custom_headers: { Authorization: 'secret' }, supports_tools: true, enabled: true, image_settings: {}, api_format: 'responses'
    }] } as never,
    userSettings: { read: () => modelSelection, write: writeModelSelection } as never,
    notifyModelSelection,
    agentSessions: {
      start,
      regenerate,
      deleteMessagesFrom,
      cancel,
      inspect: () => ({ active: true as const, conversationId: 'chat-1', runId: 'run-1', messageId: 'assistant-2', accumulated: 'partial', sequence: 3 }),
      generationStats: () => ({ conversationId: 'chat-1', stats: null }),
      trajectory: () => ({ conversationId: 'chat-1', runtimeThreadId: 'thread-1', records: [{ id: 'trace-1', kind: 'tool', input: 'read' }], totalRecords: 1, hasMore: false, beforeIndex: null, startedAtMillis: 1, completedAtMillis: 2 })
    } as never
  })
  return {
    value, selectOpening, start, regenerate, deleteMessagesFrom, cancel, replaceCurrent, createConversation, deleteConversation,
    writeModelSelection, notifyModelSelection
  }
}

describe('desktop author SDK service', () => {
  it('returns complete message and Agent process data and writes current-chat variables', async () => {
    const { value, replaceCurrent } = service()
    const state = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('variables.getState') }, 1)).response)
    const saved = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('variables.setState', { state: { hp: 9 } }) }, 1)).response)
    const patched = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('variables.applyPatch', { patch: [
      { op: 'replace', path: '/hp', value: 8 },
      { op: 'add', path: '/inventory', value: ['key'] }
    ] }) }, 1)).response)
    const messages = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('messages.list') }, 1)).response)
    expect(state).toMatchObject({ ok: true, result: { current: 1 } })
    expect(saved).toMatchObject({ ok: true, result: { hp: 9 } })
    expect(patched).toMatchObject({ ok: true, result: { hp: 8, inventory: ['key'] } })
    expect(replaceCurrent).toHaveBeenCalledWith('chat-1', '{"hp":8,"inventory":["key"]}')
    expect(messages).toMatchObject({ ok: true, result: [{
      displayContent: '<div>content</div>',
      variableState: { messageValue: 7, name: '测试用户甲' },
      process: [{ kind: 'tool', toolName: 'read_file', summary: '读取文件' }],
      attachments: [{ id: 'image-1', type: 'image', url: 'eleckoi-media://chat/v1/chat-1/image-1', mimeType: 'image/png' }]
    }] })
  })

  it('maps the permitted opening switch and chat send actions to native services', async () => {
    const { value, selectOpening, start } = service()
    const selected = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('openings.select', { id: 'opening-b' }) }, 2)).response)
    const sent = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('chat.send', { text: 'hello' }) }, 2)).response)
    expect(selected).toMatchObject({ ok: true, result: { selectedId: 'opening-b' } })
    expect(sent).toMatchObject({ ok: true, result: { runId: 'run-1' } })
    expect(selectOpening).toHaveBeenCalledWith('chat-1', 'opening-b')
    expect(start).toHaveBeenCalledWith('chat-1', 'hello', [])
  })

  it('exposes message media as browser URLs and sends image attachments to the Agent', async () => {
    const { value, start } = service()
    const listed = JSON.parse((await value.invoke({
      conversationId: 'chat-1', messageId: 'assistant-1', request: request('media.getMessageAttachments')
    }, 4)).response)
    const sent = JSON.parse((await value.invoke({
      conversationId: 'chat-1', messageId: 'assistant-1', request: request('chat.send', {
        text: 'look', attachments: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'hello.png' }]
      })
    }, 4)).response)
    expect(listed).toMatchObject({ ok: true, result: { items: [{
      id: 'image-1', type: 'image', url: 'eleckoi-media://chat/v1/chat-1/image-1', width: 2, height: 3
    }] } })
    expect(sent).toMatchObject({ ok: true, result: { runId: 'run-1' } })
    expect(start).toHaveBeenCalledWith('chat-1', 'look', [{ mediaType: 'image/png', data: 'aGVsbG8=', name: 'hello.png' }])
  })

  it('keeps chat management inside the current character and exposes native Agent controls and events', async () => {
    const {
      value, regenerate, deleteMessagesFrom, cancel, createConversation, deleteConversation, writeModelSelection, notifyModelSelection
    } = service()
    const chats = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('chat.list') }, 3)).response)
    const state = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('chat.getGenerationState') }, 3)).response)
    const regenerated = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('messages.editAndRegenerate', { id: 'assistant-1', text: 'changed' }) }, 3)).response)
    const deletedMessages = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('messages.deleteFrom', { id: 'assistant-1' }) }, 3)).response)
    const stopped = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('chat.stopGeneration') }, 3)).response)
    const events = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('events.list') }, 3)).response)
    const trajectory = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('chat.getAgentTrajectory') }, 3)).response)
    const models = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('chat.getModels') }, 3)).response)
    const selectedModel = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('chat.selectModel', { configId: 'model-config-1', model: 'model-a' }) }, 3)).response)
    const settingLibrary = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('settingLibrary.current') }, 3)).response)
    const capabilities = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('app.getCapabilities') }, 3)).response)
    const outOfScope = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('chat.open', { sessionId: 'chat-2' }) }, 3)).response)
    const created = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('chat.create', { title: 'New story' }) }, 3)).response)
    const deleted = JSON.parse((await value.invoke({ conversationId: 'chat-1', messageId: 'assistant-1', request: request('chat.delete', { sessionId: 'chat-1' }) }, 3)).response)

    expect(chats.result.items.map((item: { id: string }) => item.id)).toEqual(['chat-1'])
    expect(state).toMatchObject({ ok: true, result: { active: true, accumulated: 'partial', sequence: 3, stats: null } })
    expect(regenerated).toMatchObject({ ok: true, result: { runId: 'run-edit' } })
    expect(deletedMessages).toMatchObject({ ok: true, result: { deletedMessageCount: 1, remainingMessageCount: 0 } })
    expect(stopped).toMatchObject({ ok: true, result: { cancelled: true } })
    expect(regenerate).toHaveBeenCalledWith('chat-1', 'assistant-1', 'changed')
    expect(deleteMessagesFrom).toHaveBeenCalledWith('chat-1', 'assistant-1')
    expect(cancel).toHaveBeenCalledWith('chat-1')
    expect(events.result.items).toContain('agent.process.updated')
    expect(events.result.items).toContain('agent.generation.stats')
    expect(events.result.items).toContain('messages.changed')
    expect(events.result.items).toContain('audio.state.changed')
    expect(trajectory).toMatchObject({ ok: true, result: { records: [{ id: 'trace-1', kind: 'tool', input: 'read' }] } })
    expect(models).toMatchObject({ ok: true, result: {
      current: { configId: 'model-config-1', model: 'model-a' },
      items: [{ configId: 'model-config-1', models: [{ id: 'model-a', supportsImageInput: true }] }]
    } })
    expect(JSON.stringify(models)).not.toContain('secret')
    expect(selectedModel).toMatchObject({ ok: true, result: { configId: 'model-config-1', model: 'model-a' } })
    expect(writeModelSelection).toHaveBeenCalledWith('models.active', {
      capability: 'chat', config_id: 'model-config-1', model: 'model-a'
    })
    expect(notifyModelSelection).toHaveBeenCalledWith({
      capability: 'chat', config_id: 'model-config-1', model: 'model-a'
    })
    expect(settingLibrary).toMatchObject({ ok: true, result: { characterId: 'card-1', entries: [{ content: 'Story facts' }] } })
    expect(outOfScope).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE' } })
    expect(created).toMatchObject({ ok: true, result: { chat: { title: 'New story', characterId: 'card-1' } } })
    expect(deleted).toMatchObject({ ok: true, result: { deletedId: 'chat-1', chat: { characterId: 'card-1' } } })
    expect(createConversation).toHaveBeenCalled()
    expect(deleteConversation).toHaveBeenCalledWith('chat-1')
    expect(capabilities.result.map((item: { method: string }) => item.method)).toContain('chat.delete')
    expect(capabilities.result).toHaveLength(51)
    expect(capabilities.result.map((item: { method: string }) => item.method)).toContain('messages.deleteFrom')
    expect(capabilities.result.map((item: { method: string }) => item.method)).toContain('chat.selectModel')
    expect(capabilities.result.map((item: { method: string }) => item.method)).toContain('audio.setPlaylist')
  })
})
