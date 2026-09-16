import { desktopClient } from '../../../bridge/desktopClient.ts';
import { AUTHOR_CONVERSATION_EVENT_NAMES } from '@eleckoi/author-sdk';
import { chatAttachmentMediaReference } from '@shared/foundation/mediaReference';

export const authorConversationEventNames = AUTHOR_CONVERSATION_EVENT_NAMES;

const listenersByConversation = new Map();
let gatewayDisposers = [];

function jsonObject(source) {
  try {
    const value = JSON.parse(source || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function publicAuthorMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    displayContent: message.displayContent ?? message.content,
    variableState: jsonObject(message.variableStateJson),
    status: message.status,
    createdAt: message.createdAt,
    turnId: message.turnId ?? '',
    speakerId: message.speakerId ?? '',
    speakerName: message.speakerName ?? '',
    speakerAvatar: message.speakerAvatar ?? '',
    sequence: message.sequence ?? null,
    responseIndex: message.responseIndex ?? null,
    process: message.process ?? [],
    attachments: (message.inputImageAttachments ?? []).map((attachment) => ({
      id: attachment.attachmentId,
      type: 'image',
      url: chatAttachmentMediaReference(message.conversationId, attachment.attachmentId),
      mimeType: attachment.mediaType,
      name: attachment.name || '图片',
      size: attachment.bytes,
      width: attachment.width,
      height: attachment.height,
      duration: null,
      metadata: attachment.originalDimensions ? { originalDimensions: attachment.originalDimensions } : {},
    })),
    openingOptions: (message.openingOptions ?? []).map((option) => ({
      id: option.id,
      title: option.title,
      content: option.content,
      ...(option.displayContent == null ? {} : { displayContent: option.displayContent }),
      initialVariableState: jsonObject(option.initialVariableStateJson),
    })),
    selectedOpeningId: message.selectedOpeningId ?? '',
  };
}

export function publicAuthorEvent(name, payload) {
  return name === 'agent.run.finished'
    ? { ...payload, message: publicAuthorMessage(payload.message) }
    : payload;
}

function startGatewayEvents() {
  if (gatewayDisposers.length) return;
  gatewayDisposers = authorConversationEventNames.map((name) => desktopClient.on(name, (payload) => {
    const listeners = listenersByConversation.get(payload.conversationId);
    if (!listeners) return;
    const event = { name, payload: publicAuthorEvent(name, payload) };
    for (const listener of listeners) listener(event);
  }));
}

function stopGatewayEvents() {
  if (listenersByConversation.size) return;
  for (const dispose of gatewayDisposers) dispose();
  gatewayDisposers = [];
}

export function subscribeAuthorConversationEvents(conversationId, listener) {
  const listeners = listenersByConversation.get(conversationId) ?? new Set();
  listeners.add(listener);
  listenersByConversation.set(conversationId, listeners);
  startGatewayEvents();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) listenersByConversation.delete(conversationId);
    stopGatewayEvents();
  };
}
