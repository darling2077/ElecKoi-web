import { describe, expect, it } from 'vitest'
import { mergeProcessItems, preserveMessageRenderKeys } from '../src/renderer/src/modules/chat/hooks/useConversationMessages.js'

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

  it('keeps live process events when the durable reply arrives one update behind', () => {
    const pending = {
      id: 'pending-1',
      role: 'assistant',
      content: '完成',
      pending: true,
      process: [
        { id: 'reasoning-1', kind: 'reasoning', status: 'complete', detail: '完整思考' },
        { id: 'tool-1', kind: 'tool', status: 'complete', summary: '已读取' },
        { id: 'tool-2', kind: 'tool', status: 'complete', summary: '已搜索' },
      ],
    }
    const incoming = [{
      id: 'assistant-1',
      role: 'assistant',
      content: '完成',
      status: 'complete',
      process: [
        { id: 'reasoning-1', kind: 'reasoning', status: 'running', detail: '完整' },
        { id: 'tool-1', kind: 'tool', status: 'complete', summary: '已读取' },
      ],
    }]

    const [message] = preserveMessageRenderKeys([], incoming, pending)
    expect(message.renderKey).toBe('pending-1')
    expect(message.process.map((item) => item.id)).toEqual(['reasoning-1', 'tool-1', 'tool-2'])
    expect(message.process[0]).toMatchObject({ status: 'complete', detail: '完整思考' })
  })

  it('adds newly persisted process events without dropping live-only events', () => {
    const merged = mergeProcessItems(
      [{ id: 'live', kind: 'tool', status: 'complete' }],
      [{ id: 'saved', kind: 'tool', status: 'complete' }],
    )
    expect(merged.map((item) => item.id)).toEqual(['live', 'saved'])
  })
})
