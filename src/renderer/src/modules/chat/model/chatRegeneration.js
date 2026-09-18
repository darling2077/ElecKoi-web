function previousUserIndex(items, beforeIndex) {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    if (items[index]?.role === "user") return index;
  }
  return -1;
}

export function findLatestRegenerateTargetMessageId(items) {
  if (!Array.isArray(items)) return "";
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const id = String(item?.id || "").trim();
    if (!id || id === "opening" || item?.pending) continue;
    if (item?.role === "user" || item?.role === "assistant") {
      return String(item?.turnId || id).trim();
    }
  }
  return "";
}

export function findRegenerateBranchUserIndex(items, targetMessageId = "", editingUserInput = false) {
  const targetId = String(targetMessageId || "").trim();
  if (!targetId) return -1;
  const targetIndex = items.findIndex((item) => item?.id === targetId || item?.turnId === targetId);
  if (targetIndex < 0) return -1;
  if (items[targetIndex]?.role === "assistant") return previousUserIndex(items, targetIndex);
  if (items[targetIndex]?.role === "user") return targetIndex;
  return -1;
}
