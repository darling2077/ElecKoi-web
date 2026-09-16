import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTHOR_API_VERSION } from '@eleckoi/author-sdk';
import { routeAuthorHostInputRequest } from '../src/renderer/src/modules/authorFrontend/model/authorHostInput.js';

const originalWindow = globalThis.window;

beforeEach(() => {
  globalThis.window = new EventTarget();
});

afterEach(() => {
  globalThis.window = originalWindow;
});

function request(method, params = {}, apiVersion = AUTHOR_API_VERSION) {
  return JSON.stringify({ id: 'input-1', apiVersion, method, params });
}

describe('author host input bridge', () => {
  it('routes input operations to the active conversation UI', async () => {
    window.addEventListener('eleckoi:author-input-request', (event) => {
      expect(event.detail.conversationId).toBe('chat-1');
      expect(event.detail.method).toBe('input.append');
      event.detail.claim().resolve({ text: 'draft more' });
    });

    const response = JSON.parse(await routeAuthorHostInputRequest(
      request('input.append', { text: ' more' }),
      'chat-1',
    ));
    expect(response).toEqual({ id: 'input-1', ok: true, result: { text: 'draft more' } });
  });

  it('leaves non-input methods for the native SDK service', async () => {
    expect(await routeAuthorHostInputRequest(request('chat.send', { text: 'hi' }), 'chat-1')).toBeNull();
  });

  it('rejects an invalid request before touching the host input', async () => {
    const response = JSON.parse(await routeAuthorHostInputRequest(
      JSON.stringify({ id: '', apiVersion: AUTHOR_API_VERSION, method: 'input.get', params: {} }),
      'chat-1',
    ));
    expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });
});
