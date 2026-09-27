/**
 * 注入到渲染层的 Web 桥。
 *
 * 它必须与上游 preload 暴露的 `window.eleckoi` 完全同形：
 *   request(name, input) -> Promise<{ok:true,data} | {ok:false,error:{code,message,details?}}>
 *   subscribe(listener)  -> () => void      // listener 收到 { name, payload }
 *
 * 渲染层 src/renderer/src/bridge/desktopClient.ts 只依赖这两个方法，
 * 因此这份桥让 UI 源码保持零改动。
 *
 * 传输选型：请求走 POST /api/rpc，事件走 SSE GET /api/events。
 * 不用 WebSocket 是因为 SSE 零依赖、自带断线重连，且本项目事件方向是单向的。
 */

export const WEB_BRIDGE_PATH = '/__eleckoi/web-bridge.js'

/**
 * @param eventStream 是否建立 SSE 事件流。关闭后 request 仍可用，只是收不到服务端事件；
 *   用于无头浏览器快照等「必须让网络进入空闲」的诊断场景。
 * @param cardOrigin 卡片源；写进 window.__ELECKOI_WEB__ 供渲染层读取。
 *   刻意放进本脚本而不是单独的内联 <script>，这样应用文档的 CSP 就能保持
 *   `script-src 'self'` 而不必开 'unsafe-inline'。
 */
export function buildWebBridgeSource(options: { eventStream?: boolean; cardOrigin?: string } = {}): string {
  const eventStream = options.eventStream ?? true
  const config = JSON.stringify({ cardOrigin: options.cardOrigin ?? '' })
  return `(() => {
  window.__ELECKOI_WEB__ = ${config};
  if (window.eleckoi) return;
  const listeners = new Set();
  let eventSource = null;
  const eventStreamEnabled = ${eventStream ? 'true' : 'false'};

  function emit(envelope) {
    for (const listener of Array.from(listeners)) {
      try { listener(envelope); } catch (error) { console.error('[eleckoi] 事件监听器抛错', error); }
    }
  }

  function connect() {
    if (!eventStreamEnabled || eventSource) return;
    eventSource = new EventSource('/api/events');
    eventSource.onmessage = (message) => {
      try { emit(JSON.parse(message.data)); } catch (error) { console.error('[eleckoi] 事件解析失败', error); }
    };
    eventSource.onerror = () => {
      // EventSource 会自动重连；这里只记录一次，避免刷屏。
      if (eventSource && eventSource.readyState === EventSource.CLOSED) {
        eventSource = null;
        window.setTimeout(connect, 1000);
      }
    };
  }


  // ── 导入卡片时的搬图进度条 ─────────────────────────────────────────────
  // 为什么要它：导入时卡已经进库，但卡里的外链图片正在被下载、上传、改写引用。
  // 这段时间里如果没有任何反馈，用户会以为导入完了直接去聊天，就会看到"一会儿黑图
  // 一会儿好"的中间态。所以进度条走完之前，界面上要明确告诉用户"还在处理"。
  //
  // 前端是上游代码，不能改；这段由我们注入的桥脚本自己画，靠轮询我们自己的接口取进度。
  let progressNode = null;
  let progressBar = null;
  let progressText = null;
  let progressTimer = null;
  let progressHideTimer = null;

  function ensureProgressNode() {
    if (progressNode) return;
    progressNode = document.createElement('div');
    progressNode.setAttribute('data-eleckoi-card-images', '');
    // 只用 CSSOM 设样式：不依赖 style-src 的 'unsafe-inline'。
    const panel = progressNode.style;
    panel.position = 'fixed';
    panel.left = '50%';
    panel.transform = 'translateX(-50%)';
    panel.bottom = '24px';
    panel.zIndex = '2147483000';
    panel.minWidth = '280px';
    panel.maxWidth = 'min(420px, calc(100vw - 32px))';
    panel.padding = '12px 16px';
    panel.borderRadius = '12px';
    panel.background = 'rgba(24, 24, 27, 0.94)';
    panel.color = '#f4f4f5';
    panel.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.35)';
    panel.font = '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif';
    panel.pointerEvents = 'none';
    panel.display = 'none';

    progressText = document.createElement('div');
    const track = document.createElement('div');
    track.style.marginTop = '8px';
    track.style.height = '6px';
    track.style.borderRadius = '999px';
    track.style.background = 'rgba(255, 255, 255, 0.16)';
    track.style.overflow = 'hidden';
    progressBar = document.createElement('div');
    progressBar.style.height = '100%';
    progressBar.style.width = '0%';
    progressBar.style.borderRadius = '999px';
    progressBar.style.background = 'linear-gradient(90deg, #6366f1, #a855f7)';
    progressBar.style.transition = 'width 240ms ease';
    track.appendChild(progressBar);

    progressNode.appendChild(progressText);
    progressNode.appendChild(track);
    (document.body ?? document.documentElement).appendChild(progressNode);
  }

  function renderProgress(state) {
    ensureProgressNode();
    if (state && state.active) {
      const total = Number(state.total) || 0;
      const done = Number(state.done) || 0;
      const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
      progressText.textContent = total > 0
        ? '正在把卡片图片搬到你的图床… ' + done + '/' + total + '（' + percent + '%）'
        : '正在检查卡片里的图片…';
      progressBar.style.width = (total > 0 ? percent : 8) + '%';
      // 搬运期间铺满整个视口拦截点击：中间态下不该让用户点进对话。
      progressNode.style.display = 'block';
      progressNode.style.pointerEvents = 'auto';
      if (progressHideTimer) { clearTimeout(progressHideTimer); progressHideTimer = null; }
      return;
    }
    // 结束后短暂显示结果再消失，避免"还没看清就没了"。
    if (state && state.phase === 'done' && progressNode.style.display === 'block' && !progressHideTimer) {
      const localized = Number(state.lastLocalized) || 0;
      progressText.textContent = localized > 0
        ? '卡片图片已搬好，共 ' + localized + ' 张'
        : '这张卡没有需要搬运的图片';
      progressBar.style.width = '100%';
      progressNode.style.pointerEvents = 'none';
      progressHideTimer = setTimeout(() => {
        progressHideTimer = null;
        if (progressNode) progressNode.style.display = 'none';
      }, 2200);
    }
  }

  async function pollProgress() {
    let delay = 2500;
    try {
      const response = await fetch('/api/card-images/progress', { headers: { accept: 'application/json' } });
      const payload = await response.json();
      const state = payload && payload.ok ? payload.data : null;
      if (state && state.active) delay = 600;
      renderProgress(state);
    } catch (error) {
      delay = 5000;
    }
    progressTimer = setTimeout(pollProgress, delay);
  }

  function startProgress() {
    if (progressTimer) return;
    // 立刻显示：用户点了「导入」就该马上看到反馈，而不是等第一次轮询回来
    // （小卡只搬一两张图，几十毫秒就结束了，等轮询就什么都看不到）。
    renderProgress({ active: true, phase: 'scanning', done: 0, total: 0 });
    progressTimer = setTimeout(pollProgress, 250);
  }

  /** 导入请求返回后再读一次：没有图要搬就立刻收起，有结果则短暂展示。 */
  async function settleProgress() {
    try {
      const response = await fetch('/api/card-images/progress', { headers: { accept: 'application/json' } });
      const payload = await response.json();
      const state = payload && payload.ok ? payload.data : null;
      if (!state || !state.active) {
        // 从没启动过搬运（这张卡没有外链图）：直接把"正在检查"收掉。
        if (state === null || !state.lastLocalized) {
          if (progressNode) progressNode.style.display = 'none';
          if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
          return;
        }
      }
      renderProgress(state);
    } catch (error) {
      if (progressNode) progressNode.style.display = 'none';
    }
  }

  // ── 导出角色卡的进度与完成弹窗 ─────────────────────────────────────────
  // 桌面端导出是"选一个目录、主进程直接写盘"；浏览器没有这种能力，导出走后端写进租户的
  // exports 目录，用户得去 /exports 下载。上游 UI 不会给这个入口，所以由本脚本补上：
  //   导出期间 → 显示进度条（已落盘张数 / 已选张数，数我们自己的接口）
  //   导出完成 → 弹出面板"导出成功"，带一个「去下载」链接
  // 这样用户在应用里就完成了闭环，不需要知道 /exports 这个地址。
  //
  // 注意：本文件整段是注入页面的脚本，外层是模板字符串——这里不能用反引号，
  // 也不能写美元花括号，否则会把外层模板打断（历史上栽过）。
  let exportNode = null;
  let exportBar = null;
  let exportTitle = null;
  let exportDetail = null;
  let exportActions = null;
  let exportTimer = null;
  let exportStartedAt = 0;
  let exportTotal = 0;

  function ensureExportNode() {
    if (exportNode) return;
    exportNode = document.createElement('div');
    exportNode.setAttribute('data-eleckoi-export', '');
    exportNode.setAttribute('role', 'dialog');
    const box = exportNode.style;
    box.position = 'fixed';
    box.left = '50%';
    box.top = '50%';
    box.transform = 'translate(-50%, -50%)';
    box.zIndex = '2147483001';
    box.minWidth = '300px';
    box.maxWidth = 'min(420px, calc(100vw - 32px))';
    box.padding = '18px 20px';
    box.borderRadius = '14px';
    box.background = 'rgba(24, 24, 27, 0.97)';
    box.color = '#f4f4f5';
    box.boxShadow = '0 24px 60px rgba(0, 0, 0, 0.45)';
    box.font = '13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif';
    box.pointerEvents = 'auto';
    box.display = 'none';

    exportTitle = document.createElement('div');
    exportTitle.style.fontSize = '15px';
    exportTitle.style.fontWeight = '600';
    exportDetail = document.createElement('div');
    exportDetail.style.marginTop = '6px';
    exportDetail.style.opacity = '0.8';

    const track = document.createElement('div');
    track.style.marginTop = '12px';
    track.style.height = '6px';
    track.style.borderRadius = '999px';
    track.style.background = 'rgba(255, 255, 255, 0.16)';
    track.style.overflow = 'hidden';
    exportBar = document.createElement('div');
    exportBar.style.height = '100%';
    exportBar.style.width = '0%';
    exportBar.style.borderRadius = '999px';
    exportBar.style.background = 'linear-gradient(90deg, #6366f1, #a855f7)';
    exportBar.style.transition = 'width 240ms ease';
    track.appendChild(exportBar);

    exportActions = document.createElement('div');
    exportActions.style.marginTop = '14px';
    exportActions.style.display = 'none';
    exportActions.style.gap = '8px';

    exportNode.appendChild(exportTitle);
    exportNode.appendChild(exportDetail);
    exportNode.appendChild(track);
    exportNode.appendChild(exportActions);
    (document.body ?? document.documentElement).appendChild(exportNode);
  }

  function exportButton(label, primary, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    const style = button.style;
    style.padding = '7px 14px';
    style.borderRadius = '9px';
    style.border = primary ? '0' : '1px solid rgba(255, 255, 255, 0.28)';
    style.background = primary ? 'linear-gradient(90deg, #6366f1, #a855f7)' : 'transparent';
    style.color = '#f4f4f5';
    style.font = 'inherit';
    style.cursor = 'pointer';
    button.addEventListener('click', onClick);
    return button;
  }

  function hideExport() {
    if (exportTimer) { clearTimeout(exportTimer); exportTimer = null; }
    if (exportNode) exportNode.style.display = 'none';
  }

  function renderExport(state) {
    ensureExportNode();
    const running = state.phase === 'running';
    const total = Number(state.total) || 0;
    const done = Number(state.done) || 0;
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    exportActions.style.display = 'none';
    exportActions.textContent = '';
    exportBar.style.width = (running ? (total > 0 ? percent : 10) : 100) + '%';
    if (running) {
      exportTitle.textContent = '正在导出角色卡…';
      exportDetail.textContent = total > 0
        ? '已完成 ' + done + '/' + total + ' 张（' + percent + '%），导出期间请不要关闭页面。'
        : '正在准备导出，请稍候…';
    } else if (state.phase === 'done') {
      exportTitle.textContent = '导出成功';
      exportDetail.textContent = done > 0
        ? '共 ' + done + ' 张角色卡已放到服务端，点「去下载」即可保存到本地。'
        : '没有需要导出的角色卡。';
      exportActions.style.display = 'flex';
      const link = document.createElement('a');
      link.href = '/exports';
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = '去下载';
      link.style.padding = '7px 14px';
      link.style.borderRadius = '9px';
      link.style.background = 'linear-gradient(90deg, #6366f1, #a855f7)';
      link.style.color = '#f4f4f5';
      link.style.textDecoration = 'none';
      exportActions.appendChild(link);
      exportActions.appendChild(exportButton('关闭', false, hideExport));
    } else {
      exportTitle.textContent = '导出失败';
      exportDetail.textContent = String(state.message || '请稍后重试。');
      exportActions.style.display = 'flex';
      exportActions.appendChild(exportButton('关闭', false, hideExport));
    }
    exportNode.style.display = 'block';
  }

  async function pollExport() {
    if (!exportTotal) return;
    try {
      const response = await fetch('/api/exports/list', { headers: { accept: 'application/json' } });
      const payload = await response.json();
      const files = payload && payload.ok && payload.data && payload.data.files ? payload.data.files : [];
      const done = files.filter((file) => Number(file.modified) >= exportStartedAt - 1000).length;
      renderExport({ phase: 'running', done: done, total: exportTotal });
      if (done < exportTotal) exportTimer = setTimeout(pollExport, 400);
    } catch (error) {
      // 轮询失败不影响导出本身：退化成不确定进度，请求返回时会给出结论。
      exportTimer = setTimeout(pollExport, 1200);
    }
  }

  function startExport(total) {
    exportStartedAt = Date.now();
    exportTotal = total;
    // 同步先亮出来：用户点了导出就该立刻有反馈，而不是等第一次轮询。
    renderExport({ phase: 'running', done: 0, total: total });
    exportTimer = setTimeout(pollExport, 300);
  }

  function finishExport(result) {
    if (exportTimer) { clearTimeout(exportTimer); exportTimer = null; }
    if (result && result.ok) {
      const data = result.data || {};
      const written = data.written && data.written.length ? data.written.length : exportTotal;
      renderExport({ phase: 'done', done: written, total: exportTotal });
      return;
    }
    const message = result && result.error && result.error.message
      ? result.error.message
      : '导出没有成功，请稍后重试。';
    renderExport({ phase: 'error', message: message });
  }

  async function request(name, input) {
    // 导入提交会同步等搬图完成，这里立刻把进度条亮起来并开始轮询。
    const trackImport = name === 'command.characters.import.commit';
    if (trackImport) startProgress();
    // 批量导出：上游只会在结束时返回结果，中间过程由我们用"已落盘张数"补成进度条，
    // 并在结束后弹出带下载入口的面板（浏览器没有原生目录对话框，用户需要这个出口）。
    const exportIds = name === 'command.characters.export.files' && input && input.characterIds
      ? input.characterIds.length
      : 0;
    const trackExport = name === 'command.characters.export.files';
    if (trackExport) startExport(exportIds);
    try {
      const response = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, input })
      });
      const payload = await response.json();
      const result = payload && typeof payload === 'object' && 'ok' in payload
        ? payload
        : { ok: false, error: { code: 'INTERNAL', message: '服务端返回了无法识别的响应。' } };
      if (trackImport) settleProgress();
      if (trackExport) finishExport(result);
      return result;
    } catch (error) {
      if (trackImport) settleProgress();
      if (trackExport) finishExport({ ok: false, error: { message: '与服务的连接中断，导出结果未知。' } });
      // 真正断线时把底层原因带上：只说"连接已断开"会让排查无从下手
      // （历史上最常见的真实原因是请求体超过服务端上限）。
      // 注意：这段是注入到页面的脚本，本身套在模板字符串里——
      // 这里不能用反引号，也不能写美元花括号，否则会把外层模板打断（构建期就会失败）。
      const reason = error && error.message ? '（' + error.message + '）' : '';
      return { ok: false, error: { code: 'INTERNAL', message: '与桌面服务的连接已断开。' + reason } };
    }
  }

  window.eleckoi = {
    request,
    subscribe(listener) {
      listeners.add(listener);
      connect();
      return () => { listeners.delete(listener); };
    }
  };
  connect();
})();
`
}
