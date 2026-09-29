/**
 * v0.2.0 的界面宿主：把 DSH 客户端前端 + ElecKoi 的 DSH 页面 + 插件宿主代理拼成一个站点。
 *
 * 背景（为什么需要这一层）：上游 v0.2.0 把主界面整体搬进了 DSH 客户端插件体系——
 *   桌面端主窗口加载 `${DSH_CLIENT_ORIGIN}/`，由 Electron 的自定义协议 `dsh-app`
 *   同时负责三件事（见 src/main/platform/electron/{mainWindowPlugin,dshClientDocument}.ts）：
 *     1. 伺服 DSH 官方 Web 前端（npm 包 @deepseek-ai/dsh-web-frontend 的 dist）；
 *     2. 伺服 ElecKoi 自己的 DSH 页面资源（out/renderer-dsh，由 vite.dsh.config.mjs 构建）；
 *     3. 其余请求反代到租户的 **DSH 插件宿主**（带宿主 cookie）。
 *   WebUI 没有 Electron 协议与 IPC，于是在自己的 HTTP 服务里做同样三件事。
 *
 * 与桌面端的一处差异：桌面端把 `injections` 通过 IPC 交给客户端自己消费；
 * 我们直接把它们渲染进 index.html（style / script / script-preload / script-src / global）。
 * 这样做还有个好处：页面首屏就有 `__DSH_BOOT_READY__` 与 `__ModuleLoader__`，
 * 不会出现"客户端先起来、门面还没到"的竞态。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Duplex } from 'node:stream'
import { extname, resolve, sep } from 'node:path'
import { WEB_BRIDGE_PATH } from './webBridge'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 插件宿主给浏览器注入的条目；字段随 kind 不同（实测自 v0.2.0 的宿主）。 */
export interface DshInjection {
  readonly kind: string
  readonly name?: string
  readonly value?: unknown
  readonly text?: string
  readonly src?: string
  readonly placement?: string
}

export interface ElecKoiClientAssets {
  readonly script: string
  readonly style?: string
}

export interface DshClientHost {
  /** 宿主地址，形如 http://127.0.0.1:PORT/?token=… */
  readonly url: string
  /** 宿主鉴权 cookie（`authenticateDshClientHost` 换取）。 */
  readonly cookie: string
  readonly injections: readonly DshInjection[]
  /** DSH 官方 Web 前端目录（index.html 与 assets 所在）。 */
  readonly frontendDirectory: string
  /** ElecKoi 的 DSH 页面资源（由 vite.dsh.config.mjs 构建）。 */
  readonly rendererDirectory: string
  readonly clientAssets: ElecKoiClientAssets
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
}

/** 与桌面端 dshClientDocument.ts 一致的启动门：先立好 ready 承诺，客户端上来就能等。 */
const BOOT_GATE = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'
/** 模块脚本先于 DOMContentLoaded 执行完毕，此时再放行客户端的 await。 */
const BOOT_RELEASE = '<script>addEventListener("DOMContentLoaded",()=>{try{globalThis.__DSH_BOOT_READY__?.resolve?.()}catch{}})</script>'

function mimeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** 内联脚本里出现 `</script` 会提前闭合标签；JSON 里的 `<` 一并转义最稳。 */
function escapeInline(text: string): string {
  return text.replace(/<\/(script)/gi, '<\\/$1').replace(/</g, '\\u003c')
}

function serializeGlobal(name: string, value: unknown, nonce: string): string {
  return `<script${nonceAttribute(nonce)}>globalThis[${JSON.stringify(name)}] = ${escapeInline(JSON.stringify(value ?? null))}</script>`
}

/** 内联脚本必须带 nonce，否则会被我们自己的 CSP（script-src 'self'）挡掉。 */
function nonceAttribute(nonce: string): string {
  return nonce === '' ? '' : ` nonce="${nonce}"`
}

/**
 * 排障用的诊断脚本（仅在 ELECKOI_DEBUG_DSH=1 时注入）。
 *
 * 为什么要包装 factory：DSH 的插件加载器只把失败条目标成 "failed"，**不打印原因**
 * （见 SPA bundle 里的上报函数）。包装 factory 与它拿到的 require，就能把
 * "哪个插件、哪一行、什么错" 打出来——排查 v0.2.0 插件激活失败时全靠它。
 */
const DIAGNOSTIC_SCRIPT = `<script>(() => {
  const loader = globalThis.__ModuleLoader__;
  if (!loader || typeof loader.load !== 'function') return;
  // 留一个句柄，便于从浏览器控制台/诊断脚本读取失败条目（loader 只报状态不报原因）。
  if (typeof loader.create === 'function') {
    const originalCreate = loader.create.bind(loader);
    loader.create = (options) => {
      const modules = originalCreate(options);
      globalThis.__eleckoiDiagModules = modules;
      // 注册由模块系统自己接管（不再走 facade.load），所以在这一层包 register：
      // 上游只把失败标成状态、不打印原因，这里补上"谁、为什么"。
      if (typeof modules.register === 'function') {
        const originalRegister = modules.register.bind(modules);
        modules.register = (...args) => {
          const result = originalRegister(...args);
          const id = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].id) || '';
          if (id.includes('eleckoi')) {
            console.log('[diag] register', id, args.map((a) => typeof a).join(','));
          }
          return result;
        };
      }
      return modules;
    };
  }
  const original = loader.load.bind(loader);
  loader.load = (registration) => {
    const factory = registration && registration.factory;
    if (typeof factory === 'function') {
      registration.factory = (require) => {
        const trace = (id) => {
          try { return require(id) } catch (error) {
            console.error('[diag] require 失败', registration.id, id, error && error.message);
            throw error;
          }
        };
        trace.resolve = require.resolve;
        try { return factory(trace) } catch (error) {
          console.error('[diag] factory 抛错', registration.id, error && (error.stack || error.message));
          throw error;
        }
      };
    }
    return original(registration);
  };
})()</script>`

/** 把宿主的注入项渲染成 HTML（head 与 body 两段）。 */
export function renderInjectionTags(injections: readonly DshInjection[], nonce = ''): { head: string; body: string } {
  const head: string[] = []
  const body: string[] = []
  for (const item of injections) {
    const atBody = item.placement === 'body'
    switch (item.kind) {
      case 'style':
        if (item.text !== undefined) head.push(`<style>${item.text}</style>`)
        break
      case 'global':
        if (item.name !== undefined) head.push(serializeGlobal(item.name, item.value, nonce))
        break
      case 'script':
        if (item.text !== undefined) (atBody ? body : head).push(`<script${nonceAttribute(nonce)}>${escapeInline(item.text)}</script>`)
        break
      case 'script-src':
        if (item.src !== undefined) (atBody ? body : head).push(`<script src="${item.src}"></script>`)
        break
      case 'script-preload':
        // 关键：这些是"模块要被执行"而不是"只预取"。上游在 Electron 里由客户端 import 它们，
        // 我们这里用 type=module 的内联顺序脚本执行——只有执行了才会把自己注册进
        // __ModuleLoader__ 的队列，SPA 的 facade.create() 才拿得到 @deepseek-ai/dsh-client-modules。
        if (item.src !== undefined) {
          head.push(`<script type="module" src="${item.src}"></script>`)
          head.push(`<link rel="modulepreload" href="${item.src}">`)
        }
        break
      default:
        // 未知 kind 不静默丢：上游加新注入类型时要能一眼看见（宿主日志里会留痕）。
        break
    }
  }
  return { head: head.join(''), body: body.join('') }
}

/** 用宿主注入 + ElecKoi 资源表组装 index.html。 */
export function decorateDshDocument(html: string, host: DshClientHost, nonce = ''): string {
  const tags = renderInjectionTags(host.injections, nonce)
  const assets: string[] = []
  if (host.clientAssets.style !== undefined) assets.push(`<link rel="stylesheet" href="${host.clientAssets.style}">`)
  assets.push(`<script${nonceAttribute(nonce)}>globalThis.__ELECKOI_CLIENT_ASSETS__ = ${escapeInline(JSON.stringify(host.clientAssets))}</script>`)
  const diagnostic = process.env.ELECKOI_DEBUG_DSH === '1'
    ? DIAGNOSTIC_SCRIPT.replace('<script>', `<script${nonceAttribute(nonce)}>`)
    : ''
  // 桥脚本必须最先到位：ElecKoi 的 DSH 插件在 **apply 阶段**就 `new CharacterCatalog(window.eleckoi)`
  // （见 packages/dsh-client-characters/src/client.js 等），拿不到桥就抛错、插件状态变 failed，
  // 而 shell 插件又 inject 这些插件的服务 → 整块界面起不来。这正是「保留我们的桥脚本」的意义。
  const bridge = `<script src="${WEB_BRIDGE_PATH}"></script>`
  const head = BOOT_GATE + bridge + tags.head + diagnostic + assets.join('')
  const withHead = html.includes('<head>') ? html.replace('<head>', `<head>${head}`) : head + html
  const withBody = tags.body === '' ? withHead : withHead.replace('</body>', `${tags.body}</body>`)
  const release = BOOT_RELEASE.replace('<script>', `<script${nonceAttribute(nonce)}>`)
  return withBody.includes('</body>')
    ? withBody.replace('</body>', `${release}</body>`)
    : withBody + release
}

/** 从 ElecKoi 构建产物里解析出入口脚本/样式的文件名（对齐桌面端实现）。 */
export function resolveElecKoiClientAssets(rendererDirectory: string): ElecKoiClientAssets {
  const htmlPath = resolve(rendererDirectory, 'src/renderer/dsh.html')
  const html = readFileSync(htmlPath, 'utf8')
  const script = /<script\b[^>]*\bsrc="(?:\.\.\/)+assets\/([^"]+\.js)"/i.exec(html)?.[1]
  const style = /<link\b[^>]*\bhref="(?:\.\.\/)+assets\/([^"]+\.css)"/i.exec(html)?.[1]
  if (script === undefined || style === undefined) {
    throw new Error(`ElecKoi DSH 渲染产物不完整（缺入口脚本或样式）：${htmlPath}`)
  }
  return { script: `/eleckoi/assets/${script}`, style: `/eleckoi/assets/${style}` }
}

/** DSH 前端自己的资源路径（与桌面端 isDshClientAsset 一致）。 */
export function isDshClientAsset(pathname: string): boolean {
  return pathname === '/' || pathname === '/index.html' || pathname.startsWith('/assets/')
    || pathname === '/favicon.svg' || pathname === '/favicon-dark.svg'
    || pathname === '/manifest.webmanifest'
}

function sendFile(
  res: ServerResponse,
  file: string,
  method: string,
  decorate?: (html: string) => string,
  documentHeaders?: Record<string, string>
): void {
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const type = mimeFor(file)
  const isHtml = extname(file).toLowerCase() === '.html'
  const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'no-store' }
  if (!isHtml) headers['x-content-type-options'] = 'nosniff'
  // 文档必须带上我们自己的安全头：CSP 里的 frame-src 放行了卡片源，
  // 少了它卡片会被浏览器一律拦掉（proxy 组 P-8 就是这么抓出来的）。
  else if (documentHeaders !== undefined) Object.assign(headers, documentHeaders)
  if (method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return
  }
  // 我们伺服的前端产物（DSH 前端的 JS、ElecKoi 页面）里同样写着 dsh-app:// 链接，
  // 浏览器解析不了，必须一并对文本类资源做改写；二进制原样发出。
  const rewritable = isRewritableType(type)
  const text = rewritable ? readFileSync(file, 'utf8') : ''
  const body = !rewritable
    ? readFileSync(file)
    : rewriteDshAppUrls(isHtml && decorate !== undefined ? decorate(text) : text)
  res.writeHead(200, { ...headers, 'content-length': String(Buffer.byteLength(body)) })
  res.end(body)
}

/** 伺服 DSH 官方前端（index.html 会带上注入项与 ElecKoi 资源）。 */
export function serveDshClientAsset(
  req: IncomingMessage,
  res: ServerResponse,
  host: DshClientHost,
  pathname: string,
  documentHeaders?: Record<string, string>,
  nonce = ''
): void {
  const root = resolve(host.frontendDirectory)
  const relative = pathname === '/' ? '/index.html' : pathname
  const target = resolve(root, `.${relative}`)
  if (!target.startsWith(root + sep)) {
    res.writeHead(403).end()
    return
  }
  const isDocument = relative === '/index.html'
  sendFile(res, target, req.method ?? 'GET', isDocument ? (html) => decorateDshDocument(html, host, nonce) : undefined, documentHeaders)
}

/** 伺服 ElecKoi 的 DSH 页面资源（`/eleckoi/assets/...`）。 */
export function serveElecKoiClientAsset(
  req: IncomingMessage,
  res: ServerResponse,
  host: DshClientHost,
  pathname: string
): void {
  const root = resolve(host.rendererDirectory, 'assets')
  const target = resolve(root, `.${pathname.slice('/eleckoi/assets'.length)}`)
  if (!target.startsWith(root + sep)) {
    res.writeHead(403).end()
    return
  }
  sendFile(res, target, req.method ?? 'GET')
}

/** 用宿主地址换鉴权 cookie：宿主会回 303 + Set-Cookie（与桌面端实现一致）。 */
export async function authenticateDshClientHost(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) {
    throw new Error(`DSH 插件宿主鉴权失败（HTTP ${response.status}）。`)
  }
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/** 反代到插件宿主：换用宿主 cookie，去掉 origin/host/cookie 等会打架的头。 */
export async function forwardDshClientRequest(
  req: IncomingMessage,
  res: ServerResponse,
  host: DshClientHost,
  pathname: string,
  search: string,
  body: Buffer | undefined
): Promise<void> {
  const target = new URL(host.url)
  target.pathname = pathname
  target.search = search
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (['host', 'origin', 'cookie', 'sec-fetch-site', 'connection', 'content-length', 'transfer-encoding'].includes(name)) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  headers.set('cookie', host.cookie)
  const init: RequestInit = { method: req.method ?? 'GET', headers, redirect: 'manual' }
  if (body !== undefined && body.length > 0) init.body = new Uint8Array(body)
  const response = await fetch(target, init)
  const outgoing: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    if (['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) return
    outgoing[name] = value
  })
  if (pathname.startsWith('/plugins/')) outgoing['cache-control'] = 'no-store'
  // 必须**流式**转发：/plugins/events 是 SSE，缓冲会让客户端永远收不到事件，
  // 表现就是界面一直「连接生成中」、插件激活失败。
  // 文本类（插件包、SSE 帧、JSON）先缓冲做 dsh-app:// 改写；二进制直接流式转发。
  if (isRewritableType(response.headers.get('content-type'))) {
    const text = await response.text()
    const rewritten = rewriteDshAppUrls(text)
    res.writeHead(response.status, { ...outgoing, 'content-length': String(Buffer.byteLength(rewritten)) })
    res.end(rewritten)
    return
  }
  res.writeHead(response.status, outgoing)
  if (response.body === null) {
    res.end()
    return
  }
  const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  // 浏览器提前断开（刷新、切页）时把上游也关掉，避免连接泄漏。
  res.on('close', () => stream.destroy())
  try {
    await pipeline(stream, res)
  } catch {
    res.destroy()
  }
}

/** Electron 自定义协议前缀。浏览器解析不了它，必须改写成同源相对路径。 */
const DSH_APP_ORIGIN_PREFIX = 'dsh-app://app'

/**
 * 把 `dsh-app://app/...` 改写成同源路径。
 *
 * 为什么必须做：ElecKoi 的 DSH 页面是**按需 import** 的，源码里写死了
 * `import('dsh-app://app/eleckoi/assets/eleckoi-page-character.js')`
 * （见 packages/dsh-client-characters/src/client.js 等）。桌面端由 Electron 的自定义协议
 * 接管这个 scheme，而浏览器里它根本无法解析——动态 import 直接失败，插件状态就是 failed，
 * 界面停在「Failed to load plugin」。我们在伺服/反代时统一改写成同源路径即可，
 * 上游代码与产物都不用动。
 */
export function rewriteDshAppUrls(text: string): string {
  return text.split(`${DSH_APP_ORIGIN_PREFIX}/`).join('/').split(DSH_APP_ORIGIN_PREFIX).join('')
}

/** 需要做 URL 改写的响应类型（其余二进制原样流式转发）。 */
function isRewritableType(contentType: string | null): boolean {
  if (contentType === null) return false
  return /(javascript|ecmascript|text\/html|text\/css|application\/json|text\/plain)/i.test(contentType)
}

/** WebSocket 握手必须原样带上的头（少一个宿主就会拒绝升级）。 */
const UPGRADE_HEADERS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']

/**
 * 把 WebSocket 升级请求透传到插件宿主。
 *
 * 为什么需要：DSH 客户端的**传输走 WebSocket**（`@deepseek-ai/dsh-client-connection`）。
 * 它在拿不到 `__DSH_TRANSPORT__.streamBaseUrl` 时会连 `window.location.origin`——
 * 也就是我们的源，所以必须由我们把 upgrade 转发到宿主，否则客户端只会一直
 * 刷 `[connection] connection lost`、插件全部加载失败（这是接上 v0.2.0 界面的最后一步）。
 */
export function proxyDshUpgrade(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  host: DshClientHost
): void {
  const target = new URL(host.url)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (['host', 'origin', 'cookie', 'connection', 'upgrade'].includes(name)) continue
    if (UPGRADE_HEADERS.includes(name)) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'
  for (const name of UPGRADE_HEADERS) {
    const value = req.headers[name]
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  headers.cookie = host.cookie

  const upstream = httpRequest({
    hostname: target.hostname,
    port: target.port,
    path: req.url ?? '/',
    method: 'GET',
    headers
  })
  upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    if (process.env.ELECKOI_DEBUG_DSH === '1') {
      console.log(`[dsh] WS 升级成功 ${req.url ?? ''} → ${upstreamResponse.statusCode ?? 101}`)
    }
    const lines = [`HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`]
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value === undefined) continue
      for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`)
    }
    clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
    const teardown = (): void => {
      upstreamSocket.destroy()
      clientSocket.destroy()
    }
    upstreamSocket.on('error', teardown)
    clientSocket.on('error', teardown)
    upstreamSocket.on('close', teardown)
    clientSocket.on('close', teardown)
  })
  // 宿主没同意升级（例如 cookie 失效）：如实回状态码后断开，别让浏览器一直等。
  upstream.on('response', (response) => {
    if (process.env.ELECKOI_DEBUG_DSH === '1') {
      console.log(`[dsh] WS 升级被拒 ${req.url ?? ''} → ${response.statusCode ?? 502}`)
    }
    clientSocket.write(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ''}\r\n\r\n`)
    clientSocket.destroy()
  })
  upstream.on('error', () => clientSocket.destroy())
  upstream.end()
}
