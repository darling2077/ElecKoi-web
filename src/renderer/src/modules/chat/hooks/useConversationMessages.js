import { useMemo, useRef, useState } from "react";

function transientMessage(message) {
  return message?.pending
    || String(message?.id || "").startsWith("local-")
    || String(message?.id || "").startsWith("pending-")
    || String(message?.id || "").startsWith("regen-");
}

function sameOptimisticUserMessage(current, incoming) {
  if (current?.role !== "user" || incoming?.role !== "user") return false;
  if (String(current.content || "") !== String(incoming.content || "")) return false;
  return (current.inputImageAttachments || []).length === (incoming.inputImageAttachments || []).length;
}

function preserveAttachmentRenderKeys(current = [], incoming = []) {
  return incoming.map((image, index) => {
    const previous = current.find((candidate) => (
      candidate?.attachmentId && candidate.attachmentId === image?.attachmentId
    )) || current[index];
    const renderKey = previous?.renderKey || previous?.localId || previous?.attachmentId;
    return renderKey ? { ...image, renderKey } : image;
  });
}

export function preserveMessageRenderKeys(currentMessages = [], incomingMessages = [], pendingMessage = null) {
  const current = pendingMessage ? [...currentMessages, pendingMessage] : currentMessages;
  const matches = new Map();
  const claimedIncoming = new Set();

  incomingMessages.forEach((message, index) => {
    const existing = current.find((candidate) => candidate?.id === message?.id);
    if (!existing) return;
    matches.set(index, existing);
    claimedIncoming.add(index);
  });

  for (const candidate of current.filter(transientMessage)) {
    if ([...matches.values()].includes(candidate)) continue;
    for (let index = incomingMessages.length - 1; index >= 0; index -= 1) {
      if (claimedIncoming.has(index)) continue;
      const incoming = incomingMessages[index];
      const compatible = candidate.role === "user"
        ? sameOptimisticUserMessage(candidate, incoming)
        : candidate.role === "assistant" && incoming?.role === "assistant";
      if (!compatible) continue;
      matches.set(index, candidate);
      claimedIncoming.add(index);
      break;
    }
  }

  return incomingMessages.map((message, index) => {
    const previous = matches.get(index);
    if (!previous) return message;
    const renderKey = previous.renderKey || previous.id;
    return {
      ...message,
      ...(renderKey ? { renderKey } : {}),
      inputImageAttachments: preserveAttachmentRenderKeys(
        previous.inputImageAttachments || [],
        message.inputImageAttachments || [],
      ),
    };
  });
}

export function useConversationMessages() {
  const [messages, setMessages] = useState([]);
  const [pendingReply, setPendingReply] = useState(null);
  const pendingReplyRef = useRef(null);
  const scrollRef = useRef(null);
  const [historyPage, setHistoryPage] = useState({ hasMore: false, beforeSequence: null });
  const [scrollRequest, setScrollRequest] = useState({ revision: 0, behavior: "auto" });
  const displayedMessages = useMemo(
    () => pendingReply ? [...messages, pendingReply] : messages,
    [messages, pendingReply],
  );

  function updatePendingReply(updater) {
    const current = pendingReplyRef.current;
    const next = typeof updater === "function" ? updater(current) : updater;
    pendingReplyRef.current = next;
    setPendingReply(next);
  }

  function clearPendingReply() {
    pendingReplyRef.current = null;
    setPendingReply(null);
  }

  function requestScrollToEnd(behavior = "smooth") {
    setScrollRequest((current) => ({ revision: current.revision + 1, behavior }));
  }

  function setMessagesWithScroll(nextMessages, behavior = null, page = {}) {
    clearPendingReply();
    setMessages(nextMessages);
    setHistoryPage({
      hasMore: Boolean(page.hasMore),
      beforeSequence: page.beforeSequence ?? null,
    });
    if (behavior) requestScrollToEnd(behavior);
  }

  function reconcileMessages(nextMessages, page = {}) {
    const pending = pendingReplyRef.current;
    clearPendingReply();
    setMessages((current) => {
      const reconciled = preserveMessageRenderKeys(current, nextMessages, pending);
      const firstIncomingSequence = nextMessages.reduce((first, message) => (
        Number.isInteger(message.sequence) ? Math.min(first, message.sequence) : first
      ), Number.POSITIVE_INFINITY);
      if (!Number.isFinite(firstIncomingSequence)) return reconciled;
      const retained = current.filter((message) => (
        Number.isInteger(message.sequence) && message.sequence < firstIncomingSequence
      ));
      return retained.length ? [...retained, ...reconciled] : reconciled;
    });
    setHistoryPage((current) => current.beforeSequence === null
      ? {
          hasMore: Boolean(page.hasMore),
          beforeSequence: page.beforeSequence ?? null,
        }
      : current);
  }

  function prependMessages(olderMessages, page = {}) {
    setMessages((current) => {
      const existing = new Set(current.map((message) => message.id));
      const uniqueOlder = olderMessages.filter((message) => !existing.has(message.id));
      return uniqueOlder.length ? [...uniqueOlder, ...current] : current;
    });
    setHistoryPage({
      hasMore: Boolean(page.hasMore),
      beforeSequence: page.beforeSequence ?? null,
    });
  }

  function settlePendingReply() {
    const pending = pendingReplyRef.current;
    if (pending && String(pending.content || "").trim()) {
      setMessages((items) => [...items, { ...pending, pending: false }]);
    }
    clearPendingReply();
  }

  function commitPendingError(assistantId) {
    const pending = pendingReplyRef.current;
    if (pending?.id === assistantId && (String(pending.content || "").trim() || (pending.process || []).length)) {
      setMessages((items) => [...items, { ...pending, pending: false }]);
    }
    clearPendingReply();
  }

  return {
    messages,
    displayedMessages,
    setMessages,
    setMessagesWithScroll,
    reconcileMessages,
    updatePendingReply,
    settlePendingReply,
    commitPendingError,
    prependMessages,
    historyPage,
    requestScrollToEnd,
    scrollRequest,
    scrollRef,
  };
}
