import { useEffect, useState } from "react";
import {
  getUiPreferences,
  listenUiPreferencesChanged,
  updateUiPreferences,
} from "../../settings/index.js";
import {
  hideConversationEntry,
  normalizeConversationEntryIds,
  restoreConversationEntry,
} from "../model/chatSessionView.js";

function updateIds(key, update) {
  updateUiPreferences((preferences) => ({
    ...preferences,
    [key]: update(normalizeConversationEntryIds(preferences?.[key])),
  })).catch(() => {});
}

export function useConversationListPreferences() {
  const [pinnedIds, setPinnedIds] = useState([]);
  const [hiddenIds, setHiddenIds] = useState([]);

  useEffect(() => {
    let active = true;
    let dispose = () => {};
    const applyPreferences = (preferences) => {
      if (!active) return;
      setPinnedIds(normalizeConversationEntryIds(preferences?.pinned_chat_ids));
      setHiddenIds(normalizeConversationEntryIds(preferences?.hidden_chat_ids));
    };
    getUiPreferences().then(applyPreferences).catch(() => {});
    listenUiPreferencesChanged(applyPreferences).then((cleanup) => {
      if (active) dispose = cleanup;
      else cleanup();
    }).catch(() => {});
    return () => {
      active = false;
      dispose();
    };
  }, []);

  function togglePinChat(chatId) {
    const id = String(chatId || "").trim();
    if (!id) return;
    setPinnedIds((items) => {
      return items.includes(id) ? items.filter((item) => item !== id) : [id, ...items];
    });
    updateIds("pinned_chat_ids", (items) => (
      items.includes(id) ? items.filter((item) => item !== id) : [id, ...items]
    ));
  }

  function unpinChat(chatId) {
    const id = String(chatId || "").trim();
    if (!id) return;
    setPinnedIds((items) => items.filter((item) => item !== id));
    updateIds("pinned_chat_ids", (items) => items.filter((item) => item !== id));
  }

  function hideChatEntry(chatId) {
    const id = String(chatId || "").trim();
    if (!id) return;
    setHiddenIds((items) => hideConversationEntry(items, id));
    updateIds("hidden_chat_ids", (items) => hideConversationEntry(items, id));
  }

  function restoreChatEntry(chatId) {
    const id = String(chatId || "").trim();
    if (!id) return;
    setHiddenIds((items) => restoreConversationEntry(items, id));
    updateIds("hidden_chat_ids", (items) => restoreConversationEntry(items, id));
  }

  return {
    pinnedIds,
    hiddenIds,
    togglePinChat,
    unpinChat,
    hideChatEntry,
    restoreChatEntry,
  };
}
