import { useEffect, useRef } from 'react';
import {
  getChat,
  listenAgentFailedEvent,
  listenAgentFinishedEvent,
  listenAgentOutputEvent,
  listenAgentProcessEvent,
} from '../api/chatApi.js';

function upsertProcess(items = [], item) {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function publicError(error, fallback) {
  const message = typeof error === 'string' ? error : error?.message;
  return message?.trim() ? message.split(/\r?\n/, 1)[0].slice(0, 200) : fallback;
}

export function useAuthorFrontendActions({
  sessionId,
  setIsSending,
  setStatus,
  setMessages,
  reconcileChatMessages,
  setChatCharacter,
  normalizeLatestChatCharacter,
  refreshSessionsOnly,
  requestScrollToEnd,
  loadChat,
  input,
  inputImages,
  setInput,
  sendMessage,
}) {
  const runsRef = useRef(new Map());
  const inputRef = useRef(input);
  const hasInputImagesRef = useRef(Boolean(inputImages?.length));
  const sendMessageRef = useRef(sendMessage);
  inputRef.current = input;
  hasInputImagesRef.current = Boolean(inputImages?.length);
  sendMessageRef.current = sendMessage;

  useEffect(() => {
    const refreshActiveChat = async (targetSessionId) => {
      if (!targetSessionId || targetSessionId !== sessionId) return;
      const data = await getChat(targetSessionId);
      reconcileChatMessages(data.chat);
      setChatCharacter(normalizeLatestChatCharacter(data.chat));
      await refreshSessionsOnly({ keepSection: true });
    };
    const onAuthorAction = (event) => {
      const detail = event.detail || {};
      if (detail.conversationId !== sessionId) return;
      if ([
        'chat.send',
        'messages.deleteFrom',
        'messages.regenerate',
        'messages.editAndRegenerate',
      ].includes(detail.method) && detail.result?.runId) {
        runsRef.current.set(detail.result.runId, detail.result.messageId || '');
        setIsSending(true);
        requestScrollToEnd('smooth');
      }
      if (['chat.create', 'chat.open', 'chat.delete'].includes(detail.method) && detail.result?.chat?.id) {
        loadChat(detail.result.chat.id).then(() => refreshSessionsOnly({ keepSection: true }))
          .catch((error) => setStatus(publicError(error, '切换聊天失败')));
        return;
      }
      refreshActiveChat(detail.conversationId).catch((error) => setStatus(publicError(error, '刷新聊天失败')));
    };
    const updateExternalMessage = (event, update) => {
      if (event.conversationId !== sessionId || !runsRef.current.has(event.runId)) return;
      setMessages((items) => items.map((message) => message.id === event.messageId ? update(message) : message));
    };
    const onAuthorInputRequest = (event) => {
      const detail = event.detail || {};
      if (detail.conversationId !== sessionId || typeof detail.claim !== 'function') return;
      const operation = detail.claim();
      const text = typeof detail.params?.text === 'string' ? detail.params.text : '';
      if (detail.method === 'input.get') {
        operation.resolve({ text: inputRef.current });
      } else if (detail.method === 'input.set') {
        inputRef.current = text;
        setInput(text);
        operation.resolve({ text });
      } else if (detail.method === 'input.append') {
        const next = `${inputRef.current}${text}`;
        inputRef.current = next;
        setInput(next);
        operation.resolve({ text: next });
      } else if (detail.method === 'input.clear') {
        inputRef.current = '';
        setInput('');
        operation.resolve({ text: '' });
      } else if (detail.method === 'input.send') {
        const submitted = Boolean(inputRef.current.trim()) || hasInputImagesRef.current;
        if (submitted) void sendMessageRef.current({ preventDefault() {} }, inputRef.current);
        operation.resolve({ submitted });
      } else {
        operation.reject(Object.assign(new Error('未知的输入框操作'), { code: 'METHOD_NOT_FOUND' }));
      }
    };
    window.addEventListener('eleckoi:author-action', onAuthorAction);
    window.addEventListener('eleckoi:author-input-request', onAuthorInputRequest);
    const disposeDelta = listenAgentOutputEvent((event) => updateExternalMessage(event, (message) => ({
      ...message,
      pending: true,
      content: `${message.content || ''}${event.delta}`,
    })));
    const disposeProcess = listenAgentProcessEvent((event) => updateExternalMessage(event, (message) => ({
      ...message,
      process: upsertProcess(message.process, event.item),
    })));
    const disposeFinished = listenAgentFinishedEvent((event) => {
      if (!runsRef.current.delete(event.runId)) return;
      if (event.conversationId === sessionId) setIsSending(false);
      refreshActiveChat(event.conversationId).catch((error) => setStatus(publicError(error, '刷新聊天失败')));
    });
    const disposeFailed = listenAgentFailedEvent((event) => {
      if (!runsRef.current.delete(event.runId)) return;
      if (event.conversationId === sessionId) {
        setIsSending(false);
        setStatus(event.message || '生成失败');
      }
      refreshActiveChat(event.conversationId).catch(() => {});
    });
    return () => {
      window.removeEventListener('eleckoi:author-action', onAuthorAction);
      window.removeEventListener('eleckoi:author-input-request', onAuthorInputRequest);
      disposeDelta();
      disposeProcess();
      disposeFinished();
      disposeFailed();
    };
  }, [sessionId]);
}
