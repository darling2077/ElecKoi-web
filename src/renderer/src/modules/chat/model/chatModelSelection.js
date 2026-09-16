export function resolveModelConfig(modelConfigs, modelSelection) {
  const requested = (modelConfigs || []).find((item) => item.id === modelSelection.configId) || null;
  const selected = requested || (modelConfigs || [])[0] || null;
  return selected ? { ...selected, model: requested ? modelSelection.model || selected.model || "" : selected.model || "" } : null;
}

export function selectionFromActiveSetting(stored = {}) {
  return normalizeModelSelection({
    capability: stored.capability || "chat",
    configId: stored.config_id || "",
    model: stored.model || "",
  });
}

export function reconcileModelSelection(selection, modelConfigs = []) {
  const current = normalizeModelSelection(selection);
  const fallback = (modelConfigs || []).find((item) => item.id === current.configId) || (modelConfigs || [])[0] || null;
  if (!fallback) return current;
  const availableModels = Array.isArray(fallback.model_options) ? fallback.model_options : [];
  const selectedModelExists = availableModels.some((item) => item.id === current.model);
  return {
    capability: "chat",
    configId: fallback.id,
    model: current.configId === fallback.id && (selectedModelExists || availableModels.length === 0) && current.model
      ? current.model
      : fallback.model || availableModels[0]?.id || "",
  };
}

export function normalizeModelSelection(nextSelection) {
  return {
    capability: nextSelection.capability || "chat",
    configId: nextSelection.configId || "",
    model: nextSelection.model || "",
  };
}

export function toActiveModelSelection(selection) {
  return {
    capability: "chat",
    config_id: selection.configId || "",
    model: selection.model || "",
  };
}
