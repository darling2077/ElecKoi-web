import { describe, expect, it } from 'vitest';
import {
  authorConversationEventNames,
  publicAuthorEvent,
} from '../src/renderer/src/modules/authorFrontend/model/authorConversationEvents.js';

describe('author conversation events', () => {
  it('publishes the complete native Agent process event set', () => {
    expect(authorConversationEventNames).toEqual([
      'messages.changed',
      'agent.output.delta',
      'agent.run.finished',
      'agent.run.failed',
      'agent.state.changed',
      'agent.process.updated',
      'agent.generation.stats',
    ]);
  });

  it('projects a finished message without dropping process or media data', () => {
    const payload = publicAuthorEvent('agent.run.finished', {
      conversationId: 'chat-1',
      runId: 'run-1',
      message: {
        id: 'assistant-1',
        conversationId: 'chat-1',
        role: 'assistant',
        content: 'done',
        variableStateJson: '{"hp":8}',
        status: 'complete',
        createdAt: 'now',
        process: [{ id: 'tool-1', kind: 'tool', status: 'complete', toolName: 'read_file' }],
        inputImageAttachments: [{ attachmentId: 'image-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }],
      },
    });

    expect(payload.message).toMatchObject({
      variableState: { hp: 8 },
      process: [{ id: 'tool-1', kind: 'tool', toolName: 'read_file' }],
      attachments: [{ id: 'image-1', type: 'image', url: 'eleckoi-media://chat/v1/chat-1/image-1' }],
    });
  });
});
