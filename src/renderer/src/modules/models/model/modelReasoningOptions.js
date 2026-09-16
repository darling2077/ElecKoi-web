const labels = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

export function reasoningOptions(efforts, defaultLabel = "跟随模型默认") {
  return [
    { id: "", label: defaultLabel },
    ...(efforts || []).map((id) => ({ id, label: labels[id] || id })),
  ];
}
