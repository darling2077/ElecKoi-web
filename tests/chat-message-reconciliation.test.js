import { describe, expect, it } from 'vitest'
import { preserveMessageRenderKeys } from '../src/renderer/src/modules/chat/hooks/useConversationMessages.js'

describe('chat message reconciliation', () => {
  it('keeps optimistic image and streaming reply nodes mounted when durable ids arrive', () => {
    const current = [{
      id: 'local-1',
      role: 'user',
      content: '这是谁',
      inputImageAttachments: [{ localId: 'draft-image-1', dataUrl: 'data:image/png;base64,draft' }]
    }]
    const pending = { id: 'pending-1', role: 'assistant', content: '识别结果', pending: true }
    const incoming = [{
      id: 'user-1',
      sequence: 1,
      role: 'user',
      content: '这是谁',
      inputImageAttachments: [{ attachmentId: 'sha256:image-1', mediaType: 'image/png' }]
    }, {
      id: 'assistant-1',
      sequence: 2,
      role: 'assistant',
      content: '识别结果',
      pending: false
    }]

    expect(preserveMessageRenderKeys(current, incoming, pending)).toEqual([
      expect.objectContaining({
        id: 'user-1',
        renderKey: 'local-1',
        inputImageAttachments: [expect.objectContaining({
          attachmentId: 'sha256:image-1',
          renderKey: 'draft-image-1'
        })]
      }),
      expect.objectContaining({ id: 'assistant-1', renderKey: 'pending-1', pending: false })
    ])
  })

  it('does not reuse an optimistic user key for a different durable message', () => {
    const current = [{ id: 'local-1', role: 'user', content: '第一条', inputImageAttachments: [] }]
    const incoming = [{ id: 'user-2', role: 'user', content: '第二条', inputImageAttachments: [] }]

    expect(preserveMessageRenderKeys(current, incoming)).toEqual(incoming)
  })
})
