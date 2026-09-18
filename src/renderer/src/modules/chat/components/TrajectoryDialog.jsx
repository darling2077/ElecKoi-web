import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { DshChevronRightIcon, DshCloseIcon } from "../../../ui/icons/dshComposerIcons.jsx";
import { getTrajectory } from "../api/chatApi.js";

const pageSize = 400;
const toolContextCollapseCharacters = 320;
const toolContextCollapseLines = 8;
const contextCollapseCharacters = 3_000;
const contextCollapseLines = 40;
const contextPreviewCharacters = 620;
const contextPreviewLines = 7;
const lanes = [
  { id: "input", label: "输入", kinds: new Set(["system", "user", "context"]) },
  { id: "model", label: "模型", kinds: new Set(["assistant", "compaction"]) },
  { id: "tools", label: "工具", kinds: new Set(["tool"]) },
];

const kindLabels = {
  system: "系统",
  user: "用户",
  context: "上下文",
  assistant: "助手",
  tool: "工具",
  compaction: "压缩",
};

const statusLabels = {
  running: "运行中",
  complete: "已完成",
  error: "失败",
  cancelled: "已取消",
};

export function TrajectoryDialog({ conversationId, isSending, onClose }) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selectedRequestSeq, setSelectedRequestSeq] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [actualDuration, setActualDuration] = useState(false);
  const [collapsedTurns, setCollapsedTurns] = useState(() => new Set());
  const [callsCollapsed, setCallsCollapsed] = useState(false);
  const [detailTab, setDetailTab] = useState("summary");
  const dialogRef = useRef(null);
  const ledgerRef = useRef(null);
  const initialScrollPendingRef = useRef(true);
  const followLatestRef = useRef(true);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    setSnapshot(null);
    setSelectedId("");
    setSelectedRequestSeq(null);
    setError("");
    setLoading(true);
    initialScrollPendingRef.current = true;
    followLatestRef.current = true;
  }, [conversationId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getTrajectory(conversationId, { limit: pageSize });
      setSnapshot((current) => mergeLatest(current, next));
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "轨迹读取失败");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await getTrajectory(conversationId, { limit: pageSize });
        if (!active) return;
        setSnapshot((current) => mergeLatest(current, next));
        setError("");
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "轨迹读取失败");
      } finally {
        if (active) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const timer = isSending ? window.setInterval(load, 900) : undefined;
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [conversationId, isSending]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => dialogRef.current?.focus(), 0);
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialogRef.current);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  const records = snapshot?.records || [];
  useLayoutEffect(() => {
    const ledger = ledgerRef.current;
    if (!ledger || records.length === 0) return;
    if (!initialScrollPendingRef.current && !followLatestRef.current) return;
    ledger.scrollTop = ledger.scrollHeight;
    initialScrollPendingRef.current = false;
    followLatestRef.current = true;
  }, [conversationId, records.length]);

  useEffect(() => {
    if (selectedId && !records.some((record) => record.id === selectedId)) setSelectedId("");
    if (selectedRequestSeq !== null
      && !records.some((record) => record.requests.some((request) => request.seq === selectedRequestSeq))) {
      setSelectedRequestSeq(null);
    }
  }, [records, selectedId, selectedRequestSeq]);

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const matchedRecords = useMemo(() => records.filter((record) => {
    if (!normalizedQuery) return true;
    return [record.title, record.preview, record.source, record.type]
      .some((value) => String(value || "").toLocaleLowerCase().includes(normalizedQuery));
  }), [normalizedQuery, records]);
  const displayedRecords = callsCollapsed && !normalizedQuery
    ? matchedRecords.filter((record) => record.kind !== "tool")
    : matchedRecords;
  const turnGroups = useMemo(() => groupByTurn(displayedRecords), [displayedRecords]);
  const collapsibleTurns = turnGroups.map((group) => group.key);
  const allTurnsCollapsed = collapsibleTurns.length > 0
    && collapsibleTurns.every((key) => collapsedTurns.has(key));
  const selectedRecord = records.find((record) => record.id === selectedId) || null;
  const selectedRequest = records
    .flatMap((record) => record.requests)
    .find((request) => request.seq === selectedRequestSeq) || null;
  const inspectorOpen = selectedRecord !== null || selectedRequest !== null;

  const toggleAllTurns = () => {
    setCollapsedTurns(() => allTurnsCollapsed ? new Set() : new Set(collapsibleTurns));
  };

  const toggleTurn = (key) => {
    setCollapsedTurns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const loadOlder = async () => {
    if (!snapshot?.hasMore || snapshot.beforeIndex === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await getTrajectory(conversationId, {
        beforeIndex: snapshot.beforeIndex,
        limit: pageSize,
      });
      setSnapshot((current) => mergeOlder(current, older));
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "更早的轨迹读取失败");
    } finally {
      setLoadingOlder(false);
    }
  };

  return createPortal(
    <div className="trajectory-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="trajectory-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trajectory-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="trajectory-titlebar">
          <h2 id="trajectory-title">轨迹</h2>
          <span className="trajectory-count" aria-live="polite">
            {snapshot?.runtimeThreadId ? `${snapshot.totalRecords} 条事件` : ""}
          </span>
          <button type="button" onClick={onClose} aria-label="关闭轨迹">
            <DshCloseIcon />
          </button>
        </header>

        <div className="trajectory-toolbar" role="toolbar" aria-label="轨迹显示选项">
          <div className="trajectory-toolbar-actions">
            <button
              type="button"
              aria-pressed={actualDuration}
              title={actualDuration ? "使用等宽时间块" : "按实际耗时显示"}
              onClick={() => setActualDuration((value) => !value)}
            >
              <span aria-hidden="true">◷</span>耗时
            </button>
            <button
              type="button"
              aria-pressed={allTurnsCollapsed}
              title={allTurnsCollapsed ? "展开所有轮次" : "折叠所有轮次"}
              onClick={toggleAllTurns}
            >
              <span aria-hidden="true">{allTurnsCollapsed ? "⊞" : "⊟"}</span>轮次
            </button>
            <button
              type="button"
              aria-pressed={callsCollapsed}
              title={callsCollapsed ? "展开工具调用" : "折叠工具调用"}
              onClick={() => setCallsCollapsed((value) => !value)}
            >
              <span aria-hidden="true">{callsCollapsed ? "⊞" : "⊟"}</span>调用
            </button>
          </div>
          <label className="trajectory-search">
            <MagnifyingGlass size={14} aria-hidden="true" />
            <input
              type="search"
              value={searchQuery}
              placeholder="搜索"
              aria-label="搜索轨迹"
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
            />
          </label>
        </div>

        <TrajectoryOverview
          records={records}
          selectedId={selectedId}
          actualDuration={actualDuration}
          onSelect={(recordId) => {
            setSelectedRequestSeq(null);
            setSelectedId(recordId);
            setDetailTab("summary");
          }}
        />

        <div className={`trajectory-content${inspectorOpen ? " has-inspector" : ""}${selectedRequest && detailTab === "context" ? " has-context-inspector" : ""}`}>
          <main
            ref={ledgerRef}
            className="trajectory-ledger"
            aria-label="轨迹事件"
            onScroll={(event) => {
              const ledger = event.currentTarget;
              followLatestRef.current = ledger.scrollHeight - ledger.clientHeight - ledger.scrollTop <= 48;
            }}
          >
            {snapshot?.hasMore ? (
              <button className="trajectory-load-older" type="button" disabled={loadingOlder} onClick={loadOlder}>
                {loadingOlder ? "正在加载…" : "加载更早记录"}
              </button>
            ) : null}
            {loading && !snapshot ? <TrajectoryState text="正在读取轨迹…" /> : null}
            {!loading && error && !snapshot ? <TrajectoryState text={error} action="重试" onAction={refresh} /> : null}
            {!loading && snapshot && !snapshot.runtimeThreadId ? <TrajectoryState text="这个对话还没有 DSH 轨迹" /> : null}
            {!loading && snapshot?.runtimeThreadId && !records.length ? <TrajectoryState text="当前会话还没有可显示的事件" /> : null}
            {records.length && !displayedRecords.length ? <TrajectoryState text="没有匹配的事件" /> : null}
            {turnGroups.map((group) => {
              const collapsed = collapsedTurns.has(group.key);
              return <section className="trajectory-turn" key={group.key}>
                <button
                  className="trajectory-turn-header"
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() => toggleTurn(group.key)}
                >
                  <span className="trajectory-turn-toggle" aria-hidden="true">
                    <DshChevronRightIcon className={collapsed ? "" : "is-expanded"} />
                  </span>
                  <strong>{group.label}</strong>
                  <small>{group.records.length}</small>
                </button>
                {!collapsed ? <div className="trajectory-records">
                  {group.records.map((record) => <TrajectoryRow
                    key={record.id}
                    record={record}
                    selected={record.id === selectedId}
                    selectedRequestSeq={selectedRequestSeq}
                    onSelect={() => {
                      setSelectedRequestSeq(null);
                      setSelectedId(record.id);
                      setDetailTab("summary");
                    }}
                    onSelectRequest={(request) => {
                      setSelectedId("");
                      setSelectedRequestSeq(request.seq);
                      setDetailTab("context");
                    }}
                  />)}
                </div> : null}
              </section>;
            })}
            {error && snapshot ? <p className="trajectory-inline-error" role="status">{error}</p> : null}
          </main>
          {inspectorOpen ? <TrajectoryInspector
            record={selectedRecord}
            request={selectedRequest}
            tab={detailTab}
            onTabChange={setDetailTab}
            onClose={() => {
              setSelectedId("");
              setSelectedRequestSeq(null);
            }}
          /> : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function TrajectoryOverview({ records, selectedId, actualDuration, onSelect }) {
  const positions = useMemo(() => timelinePositions(records, actualDuration), [actualDuration, records]);
  return <div className="trajectory-overview" aria-label="轨迹时间概览">
    {lanes.map((lane) => <div className="trajectory-lane" key={lane.id}>
      <span>{lane.label}</span>
      <div>
        {positions.filter(({ record }) => lane.kinds.has(record.kind)).map(({ record, left, width }) => (
          <button
            type="button"
            key={record.id}
            className={`kind-${record.kind}${record.id === selectedId ? " is-selected" : ""}`}
            style={{ "--trajectory-left": `${left}%`, "--trajectory-width": `${width}%` }}
            title={`${record.title}${record.durationMillis === null ? "" : ` · ${formatDuration(record.durationMillis)}`}`}
            aria-label={`查看 ${record.title}`}
            onClick={() => onSelect(record.id)}
          />
        ))}
      </div>
    </div>)}
  </div>;
}

function TrajectoryRow({ record, selected, selectedRequestSeq, onSelect, onSelectRequest }) {
  return <div
    role="button"
    tabIndex={0}
    className={`trajectory-record${selected ? " is-selected" : ""}`}
    aria-current={selected ? "true" : undefined}
    onClick={onSelect}
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onSelect();
    }}
  >
    {record.requests.map((request, requestIndex) => <button
      type="button"
      key={request.seq}
      className={`trajectory-request-point${request.seq === selectedRequestSeq ? " is-selected" : ""}`}
      style={{ "--trajectory-request-offset": `${requestIndex * 9}px` }}
      data-label={`Request #${request.number}`}
      data-status={request.status}
      aria-label={`查看 Request #${request.number}`}
      aria-pressed={request.seq === selectedRequestSeq}
      onClick={(event) => {
        event.stopPropagation();
        onSelectRequest(request);
      }}
    />)}
    <span className="trajectory-record-seq">{record.index}</span>
    <span className={`trajectory-kind kind-${record.kind}`}>{kindLabels[record.kind] || record.kind}</span>
    <span className="trajectory-record-copy">
      <strong>{record.title}</strong>
      {record.preview ? <small>{record.preview}</small> : null}
    </span>
    <span className={`trajectory-status status-${record.status}`} title={statusLabels[record.status]} />
    <span className="trajectory-record-duration">{formatDuration(record.durationMillis)}</span>
  </div>;
}

function TrajectoryInspector({ record, request, tab, onTabChange, onClose }) {
  const tabs = request
    ? [
        ["summary", "摘要"],
        ["context", "上下文"],
        ["preview", "预览"],
        ["raw", "原始"],
        ["source", "来源"],
      ]
    : [
        ["summary", "摘要"],
        ["preview", "预览"],
        ["raw", "原始"],
        ["source", "来源"],
      ];
  return <aside className="trajectory-inspector" aria-label="事件详情">
    <div className="trajectory-inspector-heading">
      {request ? <>
        <span className="trajectory-request-heading-dot" aria-hidden="true" />
        <strong>Request #{request.number}</strong>
        <small>{request.turn === null ? "请求" : `轮次 ${request.turn}`}</small>
      </> : <>
        <span className={`trajectory-kind kind-${record.kind}`}>{kindLabels[record.kind] || record.kind}</span>
        <strong>{record.title}</strong>
        <small>#{record.index}</small>
      </>}
      <button type="button" className="trajectory-inspector-close" aria-label="关闭事件详情" onClick={onClose}>
        <DshCloseIcon />
      </button>
    </div>
      <div className="trajectory-tabs" role="tablist" aria-label="详情视图">
        {tabs.map(([id, label]) => <button
          type="button"
          role="tab"
          key={id}
          aria-selected={tab === id}
          onClick={() => onTabChange(id)}
        >{label}</button>)}
      </div>
      <div className="trajectory-inspector-body">
        {tab === "summary" && request ? <dl className="trajectory-summary">
          <DetailTerm label="状态" value={statusLabels[request.status] || request.status} />
          <DetailTerm label="提供方" value={request.provider || "—"} />
          <DetailTerm label="模型" value={request.model || "—"} />
          <DetailTerm label="轮次" value={request.turn === null ? "—" : String(request.turn)} />
          <DetailTerm label="步骤" value={request.step === null ? "—" : String(request.step)} />
          <DetailTerm label="时间" value={formatTime(request.timeMillis)} />
          <DetailTerm label="耗时" value={formatDuration(request.durationMillis)} />
        </dl> : null}
        {tab === "summary" && record ? <dl className="trajectory-summary">
          <DetailTerm label="事件" value={record.type} />
          <DetailTerm label="状态" value={statusLabels[record.status] || record.status} />
          <DetailTerm label="轮次" value={record.turn === null ? "—" : String(record.turn)} />
          <DetailTerm label="步骤" value={record.step === null ? "—" : String(record.step)} />
          <DetailTerm label="时间" value={formatTime(record.timeMillis)} />
          <DetailTerm label="耗时" value={formatDuration(record.durationMillis)} />
        </dl> : null}
        {tab === "context" && request ? <RequestContextPanel key={request.seq} items={request.context || []} /> : null}
        {tab === "preview" ? <InspectorPre value={request?.detail || record?.output || record?.input || record?.preview || record?.detail} /> : null}
        {tab === "raw" ? <InspectorPre value={request?.rawJson || record?.rawJson} /> : null}
        {tab === "source" ? <>
          <section className="trajectory-source"><h3>来源</h3><p>{request?.reason || record?.source || "—"}</p></section>
          <section className="trajectory-source"><h3>事件详情</h3><InspectorPre value={request?.detail || record?.detail} /></section>
        </> : null}
      </div>
  </aside>;
}

function RequestContextPanel({ items }) {
  const [expandedItems, setExpandedItems] = useState(() => new Set());
  if (!items.length) return <p className="trajectory-no-value">这个请求没有可读取的上下文快照</p>;
  return <ol className="trajectory-request-context">
    {items.map((item, index) => {
      const itemKey = `${item.messageId || "message"}-${item.order || index}`;
      const longContent = shouldCollapseRequestContext(item);
      const expanded = expandedItems.has(itemKey);
      const content = longContent && !expanded ? requestContextPreview(item.content) : item.content;
      return <li key={itemKey}>
        <header>
          <span className="trajectory-context-order">{item.order || index + 1}</span>
          <span className={`trajectory-context-role role-${item.role}`}>{contextRoleLabel(item.role)}</span>
          <strong>{item.title || contextRoleLabel(item.role)}</strong>
          {item.source ? <small>{item.source}</small> : null}
        </header>
        <div className={`trajectory-context-content${longContent && expanded ? " is-expanded" : ""}`}>{content}</div>
        {longContent ? <button
          type="button"
          className="trajectory-context-expand"
          aria-expanded={expanded}
          onClick={() => setExpandedItems((current) => {
            const next = new Set(current);
            if (next.has(itemKey)) next.delete(itemKey);
            else next.add(itemKey);
            return next;
          })}
        >
          <span>{expanded ? "收起全文" : "展开全文"}</span>
          <small>{formatContextSize(item.content)}</small>
        </button> : null}
      </li>;
    })}
  </ol>;
}

function shouldCollapseRequestContext(item) {
  const content = typeof item.content === "string" ? item.content : "";
  const lineCount = contextLineCount(content);
  if (item.kind === "tool") {
    return content.length > toolContextCollapseCharacters || lineCount > toolContextCollapseLines;
  }
  return content.length > contextCollapseCharacters || lineCount > contextCollapseLines;
}

function requestContextPreview(content) {
  const source = String(content);
  const allLines = source.split(/\r?\n/);
  let preview = allLines.slice(0, contextPreviewLines).join("\n").trimEnd();
  let truncated = allLines.length > contextPreviewLines;
  if (preview.length > contextPreviewCharacters) {
    preview = preview.slice(0, contextPreviewCharacters).trimEnd();
    truncated = true;
  }
  return truncated ? `${preview}\n…` : preview;
}

function formatContextSize(content) {
  const value = String(content);
  return `${new Intl.NumberFormat("zh-CN").format(value.length)} 字符 · ${contextLineCount(value)} 行`;
}

function contextLineCount(content) {
  return String(content).split(/\r?\n/).length;
}

function contextRoleLabel(role) {
  if (role === "system") return "系统";
  if (role === "assistant") return "AI";
  return "用户";
}

function DetailTerm({ label, value }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function InspectorPre({ value }) {
  return value ? <pre>{value}</pre> : <p className="trajectory-no-value">没有可预览的内容</p>;
}

function TrajectoryState({ text, action, onAction }) {
  return <div className="trajectory-state" role="status">
    <p>{text}</p>
    {action ? <button type="button" onClick={onAction}>{action}</button> : null}
  </div>;
}

function timelinePositions(records, actualDuration) {
  if (!records.length) return [];
  if (!actualDuration) {
    const width = 100 / records.length;
    return records.map((record, index) => ({
      record,
      left: index * width,
      width: Math.max(width - 0.2, 0.7),
    }));
  }
  const timed = records.filter((record) => record.timeMillis !== null);
  if (!timed.length) return timelinePositions(records, false);
  const start = Math.min(...timed.map((record) => record.timeMillis));
  const end = Math.max(...timed.map((record) => record.timeMillis + Math.max(record.durationMillis || 0, 4)));
  const span = Math.max(end - start, 1);
  return records.map((record, index) => {
    if (record.timeMillis === null) {
      const width = 100 / records.length;
      return { record, left: index * width, width: Math.max(width - 0.2, 0.7) };
    }
    return {
      record,
      left: ((record.timeMillis - start) / span) * 100,
      width: Math.max((Math.max(record.durationMillis || 0, 4) / span) * 100, 0.7),
    };
  });
}

function groupByTurn(records) {
  const groups = new Map();
  for (const record of records) {
    const key = record.turn === null ? "setup" : `turn:${record.turn}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: record.turn === null ? "会话准备" : `轮次 ${record.turn}`,
        records: [],
      });
    }
    groups.get(key).records.push(record);
  }
  return [...groups.values()];
}

function mergeLatest(current, next) {
  if (!current || current.runtimeThreadId !== next.runtimeThreadId) return next;
  const records = mergeRecords(current.records, next.records);
  return {
    ...next,
    records,
    hasMore: records.length < next.totalRecords,
    beforeIndex: records[0]?.index ?? null,
  };
}

function mergeOlder(current, older) {
  if (!current || current.runtimeThreadId !== older.runtimeThreadId) return older;
  const records = mergeRecords(older.records, current.records);
  return {
    ...current,
    records,
    hasMore: older.hasMore,
    beforeIndex: records[0]?.index ?? null,
  };
}

function mergeRecords(first, second) {
  return [...new Map([...first, ...second].map((record) => [record.id, record])).values()]
    .sort((left, right) => left.index - right.index);
}

function formatDuration(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function formatTime(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  }).format(new Date(value));
}

function focusableElements(root) {
  if (!root) return [];
  return [...root.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")]
    .filter((element) => element instanceof HTMLElement && !element.hidden);
}
