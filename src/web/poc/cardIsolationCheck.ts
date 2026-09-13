/**
 * M3 验收：富内容卡片的跨源隔离（方案 A）。
 *
 * 这是「能不能开放公网」的关键断言。上游用 `srcDoc` 渲染卡片，srcdoc 继承父文档源，
 * 于是卡片里的 JS 可以直接 `parent.eleckoi.request(...)` 调通全部 IPC。
 * 本方案把卡片放到**独立源**上承载，父文档只通过 postMessage 投递 HTML。
 *
 * 验证方式（真实浏览器，不是模拟）：
 *   应用源   http://127.0.0.1:<port>
 *   卡片源   http://127.0.0.2:<port>     ← 与上面是不同源，但由同一进程服务
 *   在应用源上放一个测试页，加载卡片帧并投递一段「恶意卡片」HTML，
 *   该 HTML 尝试访问 parent.eleckoi / parent.document，把结果回报给父页，
 *   最后由无头 Chromium 导出 DOM 供断言。
 *
 * 运行：pnpm webui:cardisolation
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { WebHost } from '../WebHost'
import { singleTenantResolver, startWebServer } from '../http/server'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

const TEST_PAGE = '__cardtest.html'
const TEST_SCRIPT = '__cardtest.js'

/** 测试页：在应用源上加载卡片帧，投递恶意卡片，收集结果写入 DOM。 */
function renderTestPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>card-isolation-test</title></head>
<body>
<pre id="out">pending</pre>
<script src="/${TEST_SCRIPT}"></script>
</body></html>
`
}

/**
 * 测试页脚本必须外链：应用文档现在带 CSP（script-src 'self'），内联脚本会被拦。
 * 这本身就是 CSP 生效的旁证。
 */
function renderTestScript(): string {
  return `(() => {
  const cardOrigin = (window.__ELECKOI_WEB__ && window.__ELECKOI_WEB__.cardOrigin) || '';
  const beacon = new URLSearchParams(location.search).get('beacon') || '';
  const results = { cardOrigin, bridge: 'unknown', parentDocument: 'unknown', postMessage: 'unknown' };
  const out = document.getElementById('out');

  // 回传方式用页面跳转而不是 sendBeacon：应用 CSP 是 connect-src 'self'，
  // beacon/fetch 会被拦，而导航不受该指令约束。
  function send(payload) {
    if (!beacon) return;
    location.href = beacon + (beacon.includes('?') ? '&' : '?') + 'r=' + encodeURIComponent(JSON.stringify(payload));
  }

  // 第一时间回报「脚本已执行」，便于区分「页面没加载」与「逻辑卡住」。
  send({ stage: 'started', cardOrigin });

  function report() {
    out.textContent = 'RESULT ' + JSON.stringify(results);
    send(results);
  }

  // 应用源上的桥：卡片只要能读到它就说明隔离失败。
  window.eleckoi = { request: async () => ({ ok: true, data: 'LEAKED' }), subscribe: () => () => {} };

  const frame = document.createElement('iframe');
  frame.src = cardOrigin + '/__eleckoi/card-frame.html';
  document.body.appendChild(frame);

  addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === 'card-result') {
      results.bridge = data.bridge;
      results.parentDocument = data.parentDocument;
      results.postMessage = data.postMessage;
      report();
      return;
    }
    if (data.type === 'eleckoi:card-ready') {
      const card = '<!doctype html><html><body><script>' +
        'const r = {};' +
        'try { const v = parent.eleckoi; r.bridge = (v && typeof v.request === "function") ? "LEAKED" : "blocked"; }' +
        'catch (e) { r.bridge = "blocked"; }' +
        'try { const d = parent.document; r.parentDocument = d ? "LEAKED" : "blocked"; }' +
        'catch (e) { r.parentDocument = "blocked"; }' +
        'r.postMessage = (typeof parent.postMessage === "function") ? "ok" : "broken";' +
        'parent.postMessage({ type: "card-result", bridge: r.bridge, parentDocument: r.parentDocument, postMessage: r.postMessage }, "*");' +
        '<\\/script></body></html>';
      frame.contentWindow.postMessage({ type: 'eleckoi:card-document', html: card }, cardOrigin);
    }
  });

  // 兜底：即使卡片帧完全没反应也要回报一次，避免测试挂死。
  setTimeout(report, 6000);
})();
`
}

/**
 * 收结果的本地端点。
 *
 * 不用 `--dump-dom` 是因为卡片帧会 `document.write` 替换文档，页面永远到不了
 * "load 完成 + 网络空闲"，dump-dom 会挂住。改为让页面主动把结果 beacon 回来：
 * 结果一到就杀掉浏览器，不依赖快照时机。
 */
async function startReceiver(): Promise<{ url: string; result: Promise<string>; close(): Promise<void> }> {
  const { createServer } = await import('node:http')
  const chunks: string[] = []
  let settle: (value: string) => void = () => undefined
  const result = new Promise<string>((resolveResult) => { settle = resolveResult })
  const server = createServer((req, res) => {
    const body: Buffer[] = []
    req.on('data', (chunk: Buffer) => body.push(chunk))
    req.on('end', () => {
      res.writeHead(204, { 'access-control-allow-origin': '*' })
      res.end()
      // 首选查询串回传：应用 CSP 是 connect-src 'self'，sendBeacon 会被拦，
      // 而页面跳转不受 connect-src 约束。
      const query = new URL(req.url ?? '/', 'http://placeholder').searchParams.get('r')
      const text = query === null ? Buffer.concat(body).toString('utf8') : query
      chunks.push(text)
      if (text.includes('"bridge"')) settle(text)
      else console.log(`        · 浏览器回报：${text}`)
    })
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/result`,
    result,
    close: () => new Promise<void>((done) => server.close(() => done()))
  }
}

/** 启动无头浏览器，等页面把结果 beacon 回来，然后立即结束它。 */
async function captureFromBrowser(buildUrl: (beaconUrl: string) => string, timeoutMs: number): Promise<string> {
  const profile = mkdtempSync(join(tmpdir(), 'eleckoi-chromium-'))
  const receiver = await startReceiver()
  const child = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-sync',
    `--user-data-dir=${profile}`,
    buildUrl(receiver.url)
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

  try {
    return await Promise.race([
      receiver.result,
      new Promise<string>((_, rejectTimeout) => {
        setTimeout(() => {
          const useful = stderr.split('\n').filter((line) => line.includes('ERROR') && !line.includes('dbus') && !line.includes('gcm'))
          rejectTimeout(new Error(`浏览器 ${timeoutMs} ms 内未回报结果${useful.length > 0 ? `；stderr：${useful.slice(-2).join(' | ')}` : ''}`))
        }, timeoutMs)
      })
    ])
  } finally {
    child.kill('SIGKILL')
    await receiver.close()
    rmSync(profile, { recursive: true, force: true })
  }
}

/** 先占一个空闲端口，因为卡片源必须在服务启动前就确定。 */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.on('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

async function main(): Promise<void> {
  // 无头快照必须让网络进入空闲：桥的 SSE 长连接会让 --virtual-time-budget 永不结束。
  // 事件通道本身由 webui:multitenant 用真实 HTTP 覆盖。
  process.env.ELECKOI_DISABLE_EVENT_STREAM = '1'

  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-m3-'))
  const masterKeyBase64 = randomBytes(32).toString('base64')
  const rendererDir = resolve('out/renderer')
  // 测试页写进渲染产物目录（构建产物，不属于上游源码）
  mkdirSync(rendererDir, { recursive: true })
  const testPagePath = join(rendererDir, TEST_PAGE)
  const testScriptPath = join(rendererDir, TEST_SCRIPT)
  writeFileSync(testPagePath, renderTestPage())
  writeFileSync(testScriptPath, renderTestScript())

  const port = await freePort()
  // 127.0.0.2 与 127.0.0.1 是不同源，但都落在同一个监听 0.0.0.0 的进程上。
  const cardOrigin = `http://127.0.0.2:${port}`
  const appBase = `http://127.0.0.1:${port}`

  // 这里刻意用单租户无鉴权模式：跨源隔离与登录门禁互不相干，
  // 去掉门禁才能让测试页本身可被浏览器直接加载，也避免为测试在生产代码里开后门。
  const tenant = await WebHost.mountTenant({
    tenantId: 'tenant-card',
    tenantRoot: join(root, 'tenant'),
    masterKeyBase64,
    appVersion: '0.1.0-web-m3'
  })
  const server = await startWebServer({
    host: '0.0.0.0',
    port,
    rendererDir,
    cardOrigin,
    appOrigins: [appBase],
    resolveSession: singleTenantResolver(tenant.gateway, tenant.context.mediaAssets)
  })

  console.log(`\n== ElecKoi WebUI · M3 卡片跨源隔离验收 ==\n应用源：${appBase}\n卡片源：${cardOrigin}\n`)

  try {
    // 卡片源行为：只放行卡片帧与签名媒体
    const frameResponse = await fetch(`${cardOrigin}/__eleckoi/card-frame.html`)
    const csp = frameResponse.headers.get('content-security-policy') ?? ''
    record('M3-1', frameResponse.status === 200 && csp.includes("connect-src 'none'"),
      `卡片帧 ${frameResponse.status}，CSP 含 connect-src 'none'`)

    const apiOnCardOrigin = await fetch(`${cardOrigin}/api/auth/me`)
    const appOnCardOrigin = await fetch(`${cardOrigin}/`, { redirect: 'manual' })
    record('M3-2', apiOnCardOrigin.status === 404 && appOnCardOrigin.status === 404,
      `卡片源上的 /api/auth/me → ${apiOnCardOrigin.status}、/ → ${appOnCardOrigin.status}（卡片源不暴露应用与 API）`)

    const appPage = await fetch(`${appBase}/${TEST_PAGE}`)
    const appHtml = await appPage.text()
    const bridgeJs = await (await fetch(`${appBase}/__eleckoi/web-bridge.js`)).text()
    const scriptResponse = await fetch(`${appBase}/${TEST_SCRIPT}`)
    const scriptType = scriptResponse.headers.get('content-type') ?? ''
    const scriptBody = await scriptResponse.text()
    record('M3-3',
      appPage.status === 200 && appHtml.includes('/__eleckoi/web-bridge.js') && bridgeJs.includes(cardOrigin)
        && scriptResponse.status === 200 && scriptType.includes('javascript') && scriptBody.includes('sendBeacon'),
      `测试页 ${appPage.status}｜脚本 ${scriptResponse.status} ${scriptType} ${scriptBody.length}B｜桥脚本含卡片源=${bridgeJs.includes(cardOrigin)}｜页面片段=${appHtml.slice(appHtml.indexOf('<body'), appHtml.indexOf('<body') + 90).replace(/\n/g, ' ')}`)

    // 真实浏览器验证：结果由页面 beacon 回来，不依赖快照时机。
    let payload: string | undefined
    try {
      const raw = await captureFromBrowser(
        (beaconUrl) => `${appBase}/${TEST_PAGE}?beacon=${encodeURIComponent(beaconUrl)}`,
        60_000
      )
      payload = raw.trim() === '' ? undefined : raw
    } catch (error) {
      record('M3-4', false, `浏览器未产出结果：${error instanceof Error ? error.message : String(error)}`)
    }

    if (payload === undefined) {
      record('M3-5', false, '跳过：无结果')
      record('M3-6', false, '跳过：无结果')
    } else {
      const result = JSON.parse(payload) as Record<string, string>
      record('M3-4', result.cardOrigin === cardOrigin,
        `渲染层读到注入的卡片源：${result.cardOrigin}`)
      record('M3-5', result.bridge === 'blocked' && result.parentDocument === 'blocked',
        `恶意卡片访问 parent.eleckoi → ${result.bridge}；访问 parent.document → ${result.parentDocument}`)
      record('M3-6', result.postMessage === 'ok',
        `postMessage 通道仍可用（卡片正常功能不受影响）：${result.postMessage}`)
    }
  } finally {
    await server.close()
    await tenant.dispose()
    rmSync(testPagePath, { force: true })
    rmSync(testScriptPath, { force: true })
    await rm(root, { recursive: true, force: true })
  }

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log(`\n== 结果：${outcomes.length - failed.length}/${outcomes.length} 通过 ==`)
  if (failed.length > 0) {
    console.log(`失败项：${failed.map((item) => item.id).join(', ')}`)
    process.exitCode = 1
  }
}

await main()
