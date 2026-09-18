import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  createChat: vi.fn(),
  getChat: vi.fn(),
  listenAgentProcess: vi.fn(),
  listenChatStreamDelta: vi.fn(),
  sendChatMessage: vi.fn()
}))
const images = vi.hoisted(() => ({ encodeImageDraft: vi.fn() }))

vi.mock('../src/renderer/src/modules/chat/api/chatApi.js', () => api)
vi.mock('../src/renderer/src/modules/chat/hooks/useChatInputImages.js', () => images)

import { runChatMessageSend } from '../src/renderer/src/modules/chat/hooks/chatMessageSend.js'

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset()
  images.encodeImageDraft.mockReset()
})

describe('chat message send cancellation', () => {
  it('never dispatches a request that was stopped while local preparation was pending', async () => {
    let finishEncoding
    images.encodeImageDraft.mockImplementation(() => new Promise((resolve) => { finishEncoding = resolve }))
    const requestRef = { current: null }
    const setMessages = vi.fn()

    const sending = runChatMessageSend({
      event: { preventDefault: vi.fn() },
      input: '测试停止',
      inputImagesRef: { current: [{ localId: 'image-1', mediaType: 'image/png', bytes: 12, name: 'test.png' }] },
      isSending: false,
      modelConfig: { id: 'model-1', model: 'test-model' },
      modelSupportsImages: true,
      setStatus: vi.fn(),
      requestRef,
      setIsSending: vi.fn(),
      sessionId: 'conversation-1',
      chatCharacter: { character_id: 'character-1' },
      setSessionId: vi.fn(),
      replaceChatMessages: vi.fn(),
      setChatCharacter: vi.fn(),
      normalizeLatestChatCharacter: vi.fn(),
      refreshSessionsOnly: vi.fn(),
      setInput: vi.fn(),
      clearInputImages: vi.fn(),
      setMessages,
      updatePendingReply: vi.fn(),
      requestScrollToEnd: vi.fn(),
      reconcileChatMessages: vi.fn(),
      commitPendingError: vi.fn()
    })

    await vi.waitFor(() => expect(images.encodeImageDraft).toHaveBeenCalledOnce())
    const stoppedRequest = requestRef.current
    requestRef.current = null
    stoppedRequest.controller.abort()
    finishEncoding({ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'test.png' })
    await sending

    expect(api.listenAgentProcess).not.toHaveBeenCalled()
    expect(api.sendChatMessage).not.toHaveBeenCalled()
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('rehydrates the durable cancelled reply after the local request is released', async () => {
    let finishReply
    api.listenAgentProcess.mockResolvedValue(vi.fn())
    api.listenChatStreamDelta.mockResolvedValue(vi.fn())
    api.sendChatMessage.mockImplementation(() => new Promise((resolve) => { finishReply = resolve }))
    const requestRef = { current: null }
    const reconcileChatMessages = vi.fn()

    const sending = runChatMessageSend({
      event: { preventDefault: vi.fn() },
      input: '测试取消回填',
      inputImagesRef: { current: [] },
      isSending: false,
      modelConfig: { id: 'model-1', model: 'test-model' },
      modelSupportsImages: false,
      setStatus: vi.fn(),
      requestRef,
      setIsSending: vi.fn(),
      sessionId: 'conversation-1',
      chatCharacter: { character_id: 'character-1' },
      setSessionId: vi.fn(),
      replaceChatMessages: vi.fn(),
      setChatCharacter: vi.fn(),
      normalizeLatestChatCharacter: vi.fn(),
      refreshSessionsOnly: vi.fn(),
      setInput: vi.fn(),
      clearInputImages: vi.fn(),
      setMessages: vi.fn(),
      updatePendingReply: vi.fn(),
      requestScrollToEnd: vi.fn(),
      reconcileChatMessages,
      commitPendingError: vi.fn()
    })

    await vi.waitFor(() => expect(api.sendChatMessage).toHaveBeenCalledOnce())
    requestRef.current = null
    const chat = { id: 'conversation-1', messages: [{ id: 'assistant-cancelled', content: '部分正文' }] }
    finishReply({ cancelled: true, chat })
    await sending

    expect(reconcileChatMessages).toHaveBeenCalledWith(chat)
  })

  it('does not let an old cancelled reply replace a newer active request', async () => {
    let finishReply
    api.listenAgentProcess.mockResolvedValue(vi.fn())
    api.listenChatStreamDelta.mockResolvedValue(vi.fn())
    api.sendChatMessage.mockImplementation(() => new Promise((resolve) => { finishReply = resolve }))
    const requestRef = { current: null }
    const reconcileChatMessages = vi.fn()

    const sending = runChatMessageSend({
      event: { preventDefault: vi.fn() }, input: '旧请求', inputImagesRef: { current: [] }, isSending: false,
      modelConfig: { id: 'model-1', model: 'test-model' }, modelSupportsImages: false, setStatus: vi.fn(),
      requestRef, setIsSending: vi.fn(), sessionId: 'conversation-1', chatCharacter: { character_id: 'character-1' },
      setSessionId: vi.fn(), replaceChatMessages: vi.fn(), setChatCharacter: vi.fn(), normalizeLatestChatCharacter: vi.fn(),
      refreshSessionsOnly: vi.fn(), setInput: vi.fn(), clearInputImages: vi.fn(), setMessages: vi.fn(),
      updatePendingReply: vi.fn(), requestScrollToEnd: vi.fn(), reconcileChatMessages, commitPendingError: vi.fn()
    })

    await vi.waitFor(() => expect(api.sendChatMessage).toHaveBeenCalledOnce())
    requestRef.current = { requestId: 'new-request' }
    finishReply({ cancelled: true, chat: { id: 'conversation-1', messages: [] } })
    await sending

    expect(reconcileChatMessages).not.toHaveBeenCalled()
  })

  it('reconciles durable history when image preparation rejects before persistence', async () => {
    api.listenAgentProcess.mockResolvedValue(vi.fn())
    api.listenChatStreamDelta.mockResolvedValue(vi.fn())
    images.encodeImageDraft.mockResolvedValue({ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'test.png' })
    const durableChat = { id: 'conversation-1', messages: [] }
    api.getChat.mockResolvedValue({ chat: durableChat })
    api.sendChatMessage.mockRejectedValue(new Error('图片处理失败，请重新添加。'))
    const requestRef = { current: null }
    const reconcileChatMessages = vi.fn()
    const commitPendingError = vi.fn()
    const notify = vi.fn()

    await runChatMessageSend({
      event: { preventDefault: vi.fn() },
      input: '看看图片',
      inputImagesRef: { current: [{ localId: 'image-1', mediaType: 'image/png', bytes: 12, name: 'test.png', file: {} }] },
      isSending: false,
      modelConfig: { id: 'model-1', model: 'test-model' },
      modelSupportsImages: true,
      setStatus: vi.fn(),
      requestRef,
      setIsSending: vi.fn(),
      sessionId: 'conversation-1',
      chatCharacter: { character_id: 'character-1' },
      setSessionId: vi.fn(),
      replaceChatMessages: vi.fn(),
      setChatCharacter: vi.fn(),
      normalizeLatestChatCharacter: vi.fn((chat) => chat),
      refreshSessionsOnly: vi.fn(),
      setInput: vi.fn(),
      clearInputImages: vi.fn(),
      setMessages: vi.fn(),
      updatePendingReply: vi.fn(),
      requestScrollToEnd: vi.fn(),
      reconcileChatMessages,
      commitPendingError,
      notify,
    })

    expect(api.getChat).toHaveBeenCalledWith('conversation-1')
    expect(reconcileChatMessages).toHaveBeenCalledWith(durableChat)
    expect(commitPendingError).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('error', '图片处理失败，请重新添加。')
  })
})
