import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ModelIdentityIcon } from "./ModelIdentityIcon.jsx";
import { UnsavedChangesDialog } from "../../../ui/ui/UnsavedChangesDialog.jsx";
import { catalogItem, isImageProviderId, modelOptionsKey, normalizeProviderId } from "../model/modelProviderCatalog.js";
import {
  DshChevronDownIcon,
  DshCloseIcon,
  DshRefreshIcon,
  DshSearchIcon,
} from "../../../ui/icons/dshComposerIcons.jsx";
import { useModelCapabilities } from "../hooks/useModelCapabilities.js";
import {
  customReasoningOptions,
  reasoningOptions,
  withCustomReasoningEffort,
} from "../model/modelReasoningOptions.js";

function configName(config) {
  return String(config?.name || "").trim() || "未命名";
}

function modelItems(config, modelOptionsByKey) {
  if (!config) return [];
  const cached = modelOptionsByKey?.[modelOptionsKey(config)] || [];
  const byId = new Map();
  for (const item of [...(config.model_options || []), ...cached]) {
    const id = String(item?.id || item?.name || "").trim();
    if (id) byId.set(id, { ...byId.get(id), ...item, id, name: item?.name || id });
  }
  const defaultModel = String(config.model || "").trim();
  if (defaultModel && !byId.has(defaultModel)) {
    byId.set(defaultModel, { id: defaultModel, name: defaultModel, isUserAdded: true });
  }
  return [...byId.values()];
}

export function configDefaultModel(config, modelOptionsByKey) {
  const configured = String(config?.model || "").trim();
  if (configured) return configured;
  return modelItems(config, modelOptionsByKey)[0]?.id || "";
}

function emptyModelsText(config) {
  if (!config) return "没有模型配置";
  if (!String(config.api_key || "").trim()) return "请先在模型库补全连接";
  return "刷新模型列表";
}

function parameterDraft(option) {
  return {
    supportsImageInput: option?.supportsImageInput === true,
    contextWindowTokens: option?.contextWindowTokens ?? "",
    autoCompactTokenLimit: option?.autoCompactTokenLimit ?? "",
    maxOutputTokens: option?.maxOutputTokens ?? "",
    reasoningEfforts: option?.reasoningEfforts ?? null,
    reasoningEffort: option?.reasoningEffort || "",
    temperature: option?.temperature ?? "",
    topP: option?.topP ?? "",
  };
}

function optionalNumber(value) {
  if (String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizedParameters(draft, automaticContextWindow) {
  const contextWindowTokens = optionalNumber(draft.contextWindowTokens);
  const autoCompactTokenLimit = optionalNumber(draft.autoCompactTokenLimit);
  const maxOutputTokens = optionalNumber(draft.maxOutputTokens);
  const temperature = optionalNumber(draft.temperature);
  const topP = optionalNumber(draft.topP);
  const context = contextWindowTokens ?? automaticContextWindow;
  const invalid = [contextWindowTokens, autoCompactTokenLimit, maxOutputTokens, temperature, topP].some(Number.isNaN)
    || (contextWindowTokens !== null && (contextWindowTokens < 4096 || contextWindowTokens > 4_000_000))
    || (autoCompactTokenLimit !== null && (autoCompactTokenLimit < 1024 || autoCompactTokenLimit > context))
    || (maxOutputTokens !== null && (maxOutputTokens < 1 || maxOutputTokens > 4_000_000))
    || (temperature !== null && (temperature < 0 || temperature > 2))
    || (topP !== null && (topP < 0 || topP > 1));
  if (invalid) return null;
  return {
    supportsImageInput: draft.supportsImageInput,
    contextWindowTokens,
    autoCompactTokenLimit,
    maxOutputTokens,
    reasoningEfforts: draft.reasoningEfforts,
    reasoningEffort: draft.reasoningEffort || null,
    temperature,
    topP,
  };
}

function cloneConfig(config) {
  return {
    ...config,
    model_options: (config.model_options || []).map((option) => ({
      ...option,
      ...(Array.isArray(option.reasoningEfforts) ? { reasoningEfforts: [...option.reasoningEfforts] } : {}),
    })),
  };
}

function parameterKey(configId, modelId) {
  return `${configId}\u0000${modelId}`;
}

function automaticContextWindowFor(config) {
  return normalizeProviderId(config?.provider) === "deepseek"
    && (!config?.base_url || config.base_url.includes("api.deepseek.com"))
    ? 1_000_000
    : 272_000;
}

export function ModelPicker({
  configs = [],
  selectedConfigId,
  selectedModel,
  modelOptionsByKey,
  title = "选择模型",
  allowFollowMain = false,
  elevated = false,
  renderTrigger,
  onLoadModels,
  onSelect,
  onSaveModelConfig,
  onNotify,
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("models");
  const [focusedConfigId, setFocusedConfigId] = useState("");
  const [query, setQuery] = useState("");
  const [loadingConfigId, setLoadingConfigId] = useState("");
  const [saving, setSaving] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [leaveError, setLeaveError] = useState("");
  const [draftConfigs, setDraftConfigs] = useState([]);
  const [draftSelection, setDraftSelection] = useState({ capability: "chat", configId: "", model: "" });
  const [parameterDrafts, setParameterDrafts] = useState({});
  const [dirtyParameterKeys, setDirtyParameterKeys] = useState({});
  const chatConfigs = useMemo(
    () => configs.filter((config) => !isImageProviderId(config.provider)),
    [configs],
  );
  const selectedChatConfig = useMemo(
    () => chatConfigs.find((config) => config.id === selectedConfigId) || null,
    [chatConfigs, selectedConfigId],
  );
  const committedConfig = selectedChatConfig || chatConfigs[0] || null;
  const committedSelection = useMemo(() => {
    if (allowFollowMain && !selectedChatConfig) {
      return { capability: "chat", configId: "", model: "" };
    }
    return {
      capability: "chat",
      configId: committedConfig?.id || "",
      model: String((selectedChatConfig ? selectedModel : "") || configDefaultModel(committedConfig, modelOptionsByKey)).trim(),
    };
  }, [allowFollowMain, committedConfig, modelOptionsByKey, selectedChatConfig, selectedModel]);
  const activeDraftConfigs = open ? draftConfigs : chatConfigs;
  const draftSelectedConfig = activeDraftConfigs.find((config) => config.id === draftSelection.configId) || null;
  const followingMain = allowFollowMain && !draftSelectedConfig;
  const focusedConfig = activeDraftConfigs.find((config) => config.id === focusedConfigId)
    || draftSelectedConfig
    || activeDraftConfigs[0]
    || null;
  const focusedModels = useMemo(
    () => modelItems(focusedConfig, modelOptionsByKey),
    [focusedConfig, modelOptionsByKey],
  );
  const visibleModels = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? focusedModels.filter((item) => `${item.name} ${item.id}`.toLocaleLowerCase().includes(needle))
      : focusedModels;
  }, [focusedModels, query]);
  const groupedConfigs = useMemo(() => {
    const groups = new Map();
    for (const config of activeDraftConfigs) {
      const providerId = normalizeProviderId(config.provider);
      if (!groups.has(providerId)) groups.set(providerId, []);
      groups.get(providerId).push(config);
    }
    return [...groups].map(([providerId, items]) => ({ provider: catalogItem(providerId), items }));
  }, [activeDraftConfigs]);

  const parameterModelId = followingMain
    ? ""
    : String(draftSelection.model || configDefaultModel(draftSelectedConfig, modelOptionsByKey)).trim();
  const selectedOptions = useMemo(
    () => modelItems(draftSelectedConfig, modelOptionsByKey),
    [draftSelectedConfig, modelOptionsByKey],
  );
  const selectedOption = selectedOptions.find((item) => item.id === parameterModelId) || null;
  const activeParameterKey = parameterModelId && draftSelectedConfig
    ? parameterKey(draftSelectedConfig.id, parameterModelId)
    : "";
  const draft = parameterDrafts[activeParameterKey] || parameterDraft(selectedOption);
  const modelCapabilities = useModelCapabilities(draftSelectedConfig, parameterModelId);
  const usesCustomReasoningList = modelCapabilities.source === "provider_default" || modelCapabilities.source === "explicit_profile";
  const reasoningEffortOptions = usesCustomReasoningList
    ? customReasoningOptions(draft.reasoningEfforts != null)
    : reasoningOptions(modelCapabilities.reasoningEfforts);
  const selectedReasoningEffort = reasoningEffortOptions.some((item) => item.id === draft.reasoningEffort)
    ? draft.reasoningEffort
    : "";
  const automaticContextWindow = automaticContextWindowFor(draftSelectedConfig);
  const selectionChanged = draftSelection.configId !== committedSelection.configId
    || draftSelection.model !== committedSelection.model;
  const hasChanges = selectionChanged || Object.keys(dirtyParameterKeys).length > 0;

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => {
      if (event.key !== "Escape") return;
      if (leaveDialogOpen) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestClosePicker();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [hasChanges, leaveDialogOpen, open, saving]);

  function openPicker() {
    const nextConfigs = chatConfigs.map(cloneConfig);
    setDraftConfigs(nextConfigs);
    setDraftSelection(committedSelection);
    setFocusedConfigId(committedSelection.configId || nextConfigs[0]?.id || "");
    setParameterDrafts({});
    setDirtyParameterKeys({});
    setQuery("");
    setTab("models");
    setLeaveDialogOpen(false);
    setLeaveError("");
    setOpen(true);
  }

  function requestClosePicker() {
    if (saving) return;
    if (hasChanges) {
      setLeaveError("");
      setLeaveDialogOpen(true);
      return;
    }
    setOpen(false);
  }

  function discardAndClosePicker() {
    if (saving) return;
    setLeaveDialogOpen(false);
    setLeaveError("");
    setOpen(false);
  }

  function chooseModel(config, modelId) {
    setDraftSelection({
      capability: "chat",
      configId: config.id,
      model: modelId,
    });
    setFocusedConfigId(config.id);
  }

  function chooseConfig(config) {
    const modelId = configDefaultModel(config, modelOptionsByKey);
    setFocusedConfigId(config.id);
    setQuery("");
    if (!modelId) {
      onNotify?.("error", "这个配置还没有可用模型");
      return;
    }
    chooseModel(config, modelId);
  }

  function followMainModel() {
    setDraftSelection({ capability: "chat", configId: "", model: "" });
    setTab("models");
  }

  async function refreshModels() {
    if (!focusedConfig || loadingConfigId) return;
    setLoadingConfigId(focusedConfig.id);
    try {
      const models = await onLoadModels?.(focusedConfig);
      if (Array.isArray(models)) {
        setDraftConfigs((current) => current.map((config) => (
          config.id === focusedConfig.id
            ? { ...config, model_options: models.map((item) => ({ ...item })) }
            : config
        )));
      }
    } catch (error) {
      onNotify?.("error", error.message || "刷新模型列表失败");
    } finally {
      setLoadingConfigId("");
    }
  }

  function updateDraft(patch) {
    if (!activeParameterKey) return;
    setParameterDrafts((current) => ({
      ...current,
      [activeParameterKey]: { ...(current[activeParameterKey] || parameterDraft(selectedOption)), ...patch },
    }));
    setDirtyParameterKeys((current) => ({ ...current, [activeParameterKey]: true }));
  }

  function updateReasoningEffort(value) {
    updateDraft({
      ...(usesCustomReasoningList
        ? { reasoningEfforts: withCustomReasoningEffort(draft.reasoningEfforts, value) }
        : {}),
      reasoningEffort: value,
    });
  }

  async function saveChanges() {
    if (!hasChanges || saving) return false;
    const changedConfigs = new Map();
    for (const key of Object.keys(dirtyParameterKeys)) {
      const separator = key.indexOf("\u0000");
      const configId = key.slice(0, separator);
      const modelId = key.slice(separator + 1);
      const baseConfig = changedConfigs.get(configId)
        || draftConfigs.find((config) => config.id === configId);
      if (!baseConfig || !modelId) continue;
      const nextDraft = parameterDrafts[key];
      const normalized = normalizedParameters(nextDraft, automaticContextWindowFor(baseConfig));
      if (!normalized) {
        const message = "参数超出有效范围";
        setLeaveError(message);
        onNotify?.("error", message);
        return false;
      }
      const availableOptions = modelItems(baseConfig, modelOptionsByKey);
      const baseOption = availableOptions.find((item) => item.id === modelId)
        || { id: modelId, name: modelId, isUserAdded: true };
      const nextOption = { ...baseOption, ...normalized, id: modelId, name: baseOption.name || modelId };
      const options = [...(baseConfig.model_options || [])];
      const index = options.findIndex((item) => (item.id || item.name) === modelId);
      if (index >= 0) options[index] = nextOption;
      else options.push(nextOption);
      changedConfigs.set(configId, { ...baseConfig, model_options: options });
    }
    if (changedConfigs.size > 0 && !onSaveModelConfig) {
      const message = "模型参数保存功能不可用";
      setLeaveError(message);
      onNotify?.("error", message);
      return false;
    }
    setSaving(true);
    setLeaveError("");
    try {
      for (const config of changedConfigs.values()) {
        await onSaveModelConfig(config);
      }
      await onSelect?.(draftSelection);
      setLeaveDialogOpen(false);
      setOpen(false);
      onNotify?.("success", "模型设置已保存，将从下一次请求生效。");
      return true;
    } catch (error) {
      const message = error.message || "保存模型设置失败";
      setLeaveError(message);
      onNotify?.("error", message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const triggerLabel = (selectedChatConfig ? selectedModel : "") || committedConfig?.model || "选择模型";
  const trigger = renderTrigger ? renderTrigger({
    open,
    openPicker,
    selectedConfig: selectedChatConfig,
    selectedModel: selectedChatConfig ? selectedModel : "",
  }) : (
    <button
      className={`chat-model-trigger ${open ? "active" : ""}`}
      type="button"
      title="选择模型"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={openPicker}
    >
      <ModelIdentityIcon
        modelName={triggerLabel === "选择模型" ? "" : triggerLabel}
        providerId={committedConfig?.provider}
        className="chat-model-trigger-icon"
      />
      <span className="chat-model-trigger-label">{triggerLabel}</span>
      <DshChevronDownIcon />
    </button>
  );
  return (
    <div className="chat-model-picker">
      {trigger}

      {open ? createPortal(
        <div className={`chat-model-backdrop${elevated ? " is-elevated" : ""}`} role="presentation" onMouseDown={requestClosePicker}>
          <section className="chat-model-panel" role="dialog" aria-modal="true" aria-label={title} aria-busy={saving} onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div className="chat-model-title">
                <strong>{title}</strong>
                {parameterModelId ? (
                  <span>
                    <ModelIdentityIcon
                      modelName={parameterModelId}
                      providerId={draftSelectedConfig?.provider}
                      className="chat-model-title-icon"
                    />
                    {parameterModelId}
                  </span>
                ) : null}
              </div>
              <button type="button" className="chat-model-close" aria-label="关闭" disabled={saving} onClick={requestClosePicker}>
                <DshCloseIcon size={20} />
              </button>
            </header>

            <nav className="chat-model-tabs" aria-label="模型选择页面">
              <button type="button" className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}>模型</button>
              <button type="button" className={tab === "parameters" ? "active" : ""} disabled={!parameterModelId} onClick={() => setTab("parameters")}>参数</button>
            </nav>

            {tab === "models" ? (
              <div className="chat-model-browser">
                <div className="chat-model-configs">
                  {allowFollowMain ? <section className="chat-model-provider-group chat-model-follow-group">
                    <button type="button" className={followingMain ? "active" : ""} aria-pressed={followingMain} onClick={followMainModel}>
                      <ModelSelectionIndicator selected={followingMain} />
                      <span className="chat-model-config-copy"><strong>跟随主模型</strong><small>使用当前对话选择的模型与参数</small></span>
                    </button>
                  </section> : null}
                  {groupedConfigs.length ? groupedConfigs.map((group) => (
                    <section className="chat-model-provider-group" key={group.provider.id}>
                      <h3>
                        <ModelIdentityIcon modelName="" providerId={group.provider.id} className="chat-model-provider-icon" />
                        {group.provider.label}
                      </h3>
                      {group.items.map((config) => (
                        <div
                          key={config.id}
                          className={`chat-model-config-row${focusedConfig?.id === config.id ? " active" : ""}`}
                        >
                          <button
                            type="button"
                            className="chat-model-config-select"
                            aria-label={`使用配置 ${configName(config)}`}
                            aria-pressed={draftSelectedConfig?.id === config.id}
                            onClick={() => chooseConfig(config)}
                          >
                            <ModelSelectionIndicator selected={draftSelectedConfig?.id === config.id} />
                          </button>
                          <button
                            type="button"
                            className="chat-model-config-open"
                            aria-label={`查看配置 ${configName(config)} 的模型`}
                            onClick={() => { setFocusedConfigId(config.id); setQuery(""); }}
                          >
                            <span className="chat-model-config-copy"><strong>{configName(config)}</strong><small>{config.model || "未选择模型"}</small></span>
                          </button>
                        </div>
                      ))}
                    </section>
                  )) : <p className="chat-model-empty">没有聊天模型配置</p>}
                </div>

                <div className="chat-model-list-pane">
                  <div className="chat-model-list-tools">
                    <label>
                      <DshSearchIcon size={16} />
                      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" />
                    </label>
                    <button type="button" aria-label="刷新模型" title="刷新模型" disabled={!focusedConfig || Boolean(loadingConfigId)} onClick={refreshModels}>
                      <DshRefreshIcon size={17} />
                    </button>
                  </div>
                  <div className="chat-model-list">
                    {visibleModels.length ? visibleModels.map((model) => {
                      const selected = draftSelectedConfig?.id === focusedConfig?.id && parameterModelId === model.id;
                      return <button type="button" className={selected ? "active" : ""} aria-pressed={selected} key={model.id} onClick={() => chooseModel(focusedConfig, model.id)}>
                        <ModelSelectionIndicator selected={selected} />
                        <span className="chat-model-name">{model.name}</span>
                      </button>;
                    }) : <p className="chat-model-empty">{query ? "没有匹配模型" : emptyModelsText(focusedConfig)}</p>}
                  </div>
                </div>
              </div>
            ) : (
              <div className="chat-model-parameters">
                <ParameterGroup title="连接与能力">
                  <ParameterSwitch label="此模型支持图片" checked={draft.supportsImageInput} onChange={(checked) => updateDraft({ supportsImageInput: checked })} />
                </ParameterGroup>
                <ParameterGroup title="推理">
                  <ParameterSelect label="推理强度" disabled={!usesCustomReasoningList && modelCapabilities.reasoningEfforts.length === 0} value={selectedReasoningEffort} options={reasoningEffortOptions} onChange={updateReasoningEffort} />
                </ParameterGroup>
                <ParameterGroup title="上限">
                  <ParameterNumber label="上下文窗口" value={draft.contextWindowTokens} placeholder={automaticContextWindow} min={4096} max={4_000_000} onChange={(value) => updateDraft({ contextWindowTokens: value })} />
                  <ParameterNumber label="自动压缩阈值" value={draft.autoCompactTokenLimit} placeholder={Math.floor((optionalNumber(draft.contextWindowTokens) || automaticContextWindow) * 0.8)} min={1024} onChange={(value) => updateDraft({ autoCompactTokenLimit: value })} />
                  <ParameterNumber label="最大输出" value={draft.maxOutputTokens} placeholder="自动" min={1} onChange={(value) => updateDraft({ maxOutputTokens: value })} />
                </ParameterGroup>
                <ParameterGroup title="采样">
                  <ParameterNumber label="温度" value={draft.temperature} placeholder="上游默认" min={0} max={2} step={0.01} onChange={(value) => updateDraft({ temperature: value })} />
                  <ParameterNumber label="Top P" value={draft.topP} placeholder="上游默认" min={0} max={1} step={0.01} onChange={(value) => updateDraft({ topP: value })} />
                </ParameterGroup>
              </div>
            )}
            <footer className="chat-model-actions">
              <button type="button" className="chat-model-cancel" disabled={saving} onClick={requestClosePicker}>取消</button>
              <button type="button" className="chat-model-save" disabled={!hasChanges || saving} onClick={saveChanges}>
                {saving ? "保存中…" : "保存"}
              </button>
            </footer>
          </section>
        </div>,
        document.body,
      ) : null}
      <UnsavedChangesDialog
        open={leaveDialogOpen}
        title="保存修改？"
        description="离开前是否保存模型选择和参数修改？"
        error={leaveError}
        saving={saving}
        onCancel={() => {
          setLeaveDialogOpen(false);
          setLeaveError("");
        }}
        onDiscard={discardAndClosePicker}
        onSave={saveChanges}
      />
    </div>
  );
}

function ModelSelectionIndicator({ selected }) {
  return <span className={`chat-model-selection${selected ? " selected" : ""}`} aria-hidden="true">
    {selected ? <svg viewBox="0 0 14 14" fill="none">
      <path d="M2.5 7.2 5.65 10.25 11.55 3.85" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg> : null}
  </span>;
}

function ParameterGroup({ title, children }) {
  return <section className="chat-model-parameter-group"><h3>{title}</h3><div>{children}</div></section>;
}

function ParameterSelect({ label, value, options, disabled, onChange }) {
  return <label className="chat-model-parameter-row"><span>{label}</span><select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>;
}

function ParameterSwitch({ label, checked, onChange }) {
  return <label className="chat-model-parameter-row"><span>{label}</span><input className="chat-model-switch" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

function ParameterNumber({ label, value, placeholder, min, max, step = 1, disabled, onChange }) {
  return <label className="chat-model-parameter-row"><span>{label}</span><span className="chat-model-number-control"><input type="number" value={value} placeholder={String(placeholder ?? "")} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></span></label>;
}
