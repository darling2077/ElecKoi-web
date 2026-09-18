export const reasoningEffortIds = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const labels = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

export function reasoningEffortLabel(effort) {
  return labels[effort] || effort;
}

export function reasoningOptions(efforts, defaultLabel = "跟随提供方默认") {
  if (!efforts?.length) return [{ id: "", label: "未声明推理能力" }];
  return [
    { id: "", label: defaultLabel },
    ...efforts.map((id) => ({ id, label: reasoningEffortLabel(id) })),
  ];
}

export function customReasoningOptions(hasProfile = false) {
  return [
    { id: "", label: hasProfile ? "跟随提供方默认" : "未声明推理能力" },
    ...reasoningEffortIds.map((id) => ({ id, label: reasoningEffortLabel(id) })),
  ];
}

export function withCustomReasoningEffort(profile, effort) {
  if (!effort) return profile ?? null;
  return {
    ...(profile ?? {}),
    [effort]: effort === "off" ? null : effort,
  };
}
