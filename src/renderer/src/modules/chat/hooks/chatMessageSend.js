import {
  cancelChatStream,
  createChat as createChatSession,
  getChat,
  listenAgentProcess,
  listenChatStreamDelta,
  sendChatMessage,
} from "../api/chatApi.js";
import { encodeImageDraft } from "./useChatInputImages.js";

export async function runChatMessageSend(options) {
  const {
    event, input, inputImagesRef, isSending, modelConfig, modelSupportsImages, setStatus,
    requestRef, setIsSending, sessionId, chatCharacter, setSessionId, replaceChatMessages,
    setChatCharacter, normalizeLatestChatCharacter, refreshSessionsOnly, setInput, clearInputImages,
    setMessages, updatePendingReply, requestScrollToEnd,
    reconcileChatMessages, commitPendingError, notify,
  } = options;
  event.preventDefault();
  const text = input.trim();
  const draftImages = [...inputImagesRef.current];
  if ((!text && !draftImages.length) || isSending) return;
  if (!modelConfig?.id || !modelConfig.model?.trim()) {
    setStatus("请先在发送按钮左侧选择模型");
    return;
  }
  if (draftImages.length && !modelSupportsImages) {
    setStatus("当前模型未声明图片输入能力，请切换模型或在模型设置中开启。");
    return;
  }

  const controller = new AbortController();
  const activeRequest = { controller };
  requestRef.current = activeRequest;
  setIsSending(true);
  setStatus(draftImages.length ? "正在处理图片..." : "正在回复...");
  let assistantId = "";
  let targetSessionId = sessionId;

  try {
    const encodedImages = await Promise.all(draftImages.map(encodeImageDraft));
    throwIfAborted(controller.signal);
    if (!targetSessionId) {
      if (!chatCharacter.character_id) throw new Error("请先从角色设定中双击角色进入聊天");
      const characterName = chatCharacter.assistant_name || chatCharacter.character_name || "新对话";
      const created = await createChatSession(characterName, chatCharacter);
      throwIfAborted(controller.signal);
      targetSessionId = created.chat.id;
      setSessionId(targetSessionId);
      replaceChatMessages(created.chat, "auto");
      setChatCharacter(normalizeLatestChatCharacter(created.chat));
      await refreshSessionsOnly({ keepSection: true });
      throwIfAborted(controller.signal);
    }

    setInput("");
    const createdAt = new Date().toISOString();
    const userMessage = {
      id: `local-${Date.now()}`, conversationId: targetSessionId, role: "user", content: text,
      variableStateJson: '{}', created_at: createdAt,
      inputImageAttachments: draftImages.map((image, index) => ({
        attachmentId: image.localId, mediaType: image.mediaType, bytes: image.bytes, name: image.name,
        dataUrl: `data:${image.mediaType};base64,${encodedImages[index].data}`,
      })),
    };
    clearInputImages();
    const payload = {
      message: text,
      images: encodedImages,
      session_id: targetSessionId,
    };

    assistantId = `pending-${Date.now()}`;
    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequest.requestId = requestId;
    const unlistenProcess = await listenAgentProcess((event) => {
      if (event?.request_id !== requestId || event?.session_id !== targetSessionId || !event?.item) return;
      updatePendingReply((current) => current?.id === assistantId
        ? { ...current, process: upsertProcess(current.process, event.item) }
        : current);
    });
    activeRequest.unlisten = unlistenProcess;
    throwIfAborted(controller.signal);
    const unlistenDelta = await listenChatStreamDelta((event) => {
      if (event?.request_id !== requestId || event?.session_id !== targetSessionId || !event?.delta) return;
      updatePendingReply((current) => current?.id === assistantId
        ? { ...current, pending: true, content: `${current.content || ""}${event.delta}` }
        : current);
    });
    activeRequest.unlisten = () => { unlistenDelta(); unlistenProcess(); };
    throwIfAborted(controller.signal);
    setMessages((items) => [...items, userMessage]);
    updatePendingReply({ id: assistantId, conversationId: targetSessionId, role: "assistant", content: "", variableStateJson: '{}', pending: true, created_at: createdAt });
    requestScrollToEnd("smooth");
    const result = await sendChatMessage(payload, requestId);
    if (result.cancelled) {
      if (requestRef.current === null || requestRef.current === activeRequest) {
        reconcileChatMessages(result.chat);
      }
      if (requestRef.current === activeRequest) setStatus("已停止");
      return;
    }
    if (requestRef.current !== activeRequest) return;
    setSessionId(result.session_id);
    reconcileChatMessages(result.chat);
    setChatCharacter(normalizeLatestChatCharacter(result.chat || {}));
    await refreshSessionsOnly();
    if (requestRef.current !== activeRequest) return;
    setStatus("回复完成");
  } catch (error) {
    if (requestRef.current === activeRequest && !isAbortError(error)) {
      let reconciled = false;
      if (targetSessionId) {
        try {
          const durable = await getChat(targetSessionId);
          if (requestRef.current === activeRequest) {
            reconcileChatMessages(durable.chat);
            setChatCharacter(normalizeLatestChatCharacter(durable.chat || {}));
            reconciled = true;
          }
        } catch {
          // Keep the original send failure visible if refreshing durable state also fails.
        }
      }
      if (requestRef.current !== activeRequest) return;
      if (!reconciled) commitPendingError(assistantId);
      const message = getErrorMessage(error, "发送失败");
      setStatus(message);
      notify?.("error", message);
    }
  } finally {
    activeRequest.unlisten?.();
    if (requestRef.current === activeRequest) {
      requestRef.current = null;
      setIsSending(false);
    }
  }
}

export function stopChatMessageSend({
  requestRef,
  setIsSending,
  setStatus,
  settlePendingReply,
  notify,
  cancelRequest = cancelChatStream,
}) {
  const activeRequest = requestRef.current;
  if (!activeRequest || activeRequest.stopping) return false;

  activeRequest.stopping = true;
  requestRef.current = null;
  activeRequest.controller?.abort?.();
  activeRequest.unlisten?.();
  settlePendingReply?.();
  setIsSending?.(false);
  setStatus("已停止");
  if (!activeRequest.requestId) {
    return true;
  }

  void cancelRequest(activeRequest.requestId).catch((error) => {
    const message = getErrorMessage(error, "停止生成失败");
    if (requestRef.current === null) setStatus(message);
    notify?.("error", message);
  });
  return true;
}

export function getErrorMessage(error, fallback) {
  const raw = typeof error === "string" ? error : error?.message;
  if (raw?.trim() && !/json-rpc|plugin tree|node_modules|file:\/\/\/|at\s+\S+\s*\(/i.test(raw)) {
    return raw.split(/\r?\n/, 1)[0].slice(0, 200);
  }
  return fallback;
}

export function isAbortError(error) {
  return error?.name === "AbortError" || error?.message === "生成已停止";
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("生成已停止");
  error.name = "AbortError";
  throw error;
}

export function upsertProcess(items = [], item) {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((candidate, candidateIndex) => candidateIndex === index ? item : candidate);
}
