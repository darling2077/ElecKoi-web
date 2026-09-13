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

  async function request(name, input) {
    try {
      const response = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, input })
      });
      const payload = await response.json();
      if (payload && typeof payload === 'object' && 'ok' in payload) return payload;
      return { ok: false, error: { code: 'INTERNAL', message: '服务端返回了无法识别的响应。' } };
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL', message: '与桌面服务的连接已断开。' } };
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
