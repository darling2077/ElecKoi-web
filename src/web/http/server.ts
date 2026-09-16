/**
 * WebUI HTTP 服务。
 *
 * 职责：
 *   GET  /                        → out/renderer 静态产物（注入 Web 桥），未登录则跳转 /login
 *   GET  /login                   → 我们自己的登录/注册页（不涉及上游 UI）
 *   POST /api/auth/{login,register,logout}
 *   GET  /api/auth/me
 *   GET  /__eleckoi/web-bridge.js → 桥脚本
 *   POST /api/rpc                 → 网关请求（复用 WebGateway.dispatch 的契约校验）
 *   GET  /api/events              → SSE 事件流
 *   GET  /media/v1/*              → 当前租户的媒体文件
 *
 * 租户身份的解析完全由 resolveSession 决定：它只应依据服务端会话 Cookie，
 * **绝不接受客户端传入的 userId / tenantId**。
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { GatewayEventEnvelope, RequestContext } from '@shared/contracts/gateway/types'
import { failure, success } from '@shared/foundation/result'
import { LOCAL_MEDIA_REFERENCE_PREFIX, type WebGateway } from '../transport/WebGateway'
import { readSignedMedia } from '../mediaSignature'
import { CARD_FRAME_PATH, cardFrameCsp, renderCardFrame, resolveCardImageOrigins } from './cardFrame'
import { faviconLinks } from './favicon'
import { APP_TOKENS_PATH, readAppTokens } from './appTokens'
import { WEB_CHROME_CSS_PATH, WEB_CHROME_JS_PATH, buildWebChromeCss, buildWebChromeScript } from './webChrome'
import { securityHeaders } from './securityHeaders'
import { effectiveHost } from './cookies'
import { WEB_BRIDGE_PATH, buildWebBridgeSource } from './webBridge'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

/** 媒体路由前缀；上游的 `eleckoi-media://asset/v1/` 会被改写成它。 */
export const MEDIA_PREFIX = '/media/v1/'

/** 一次已鉴权的会话绑定；release 必须被调用，否则租户引用计数会泄漏。 */
export interface SessionBinding {
  gateway: WebGateway
  mediaStore: { pathForReference(reference: string): string | undefined }
  release(): void
}

export interface AuthHandler {
  /** 处理认证相关路由；返回 true 表示已处理。 */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
}

export interface WebServerOptions {
  host?: string
  port?: number
  rendererDir: string
  /** 依据服务端会话解析租户；未登录返回 undefined。 */
  resolveSession(req: IncomingMessage): Promise<SessionBinding | undefined> | SessionBinding | undefined
  /** 提供后启用登录门禁与 /login 页；缺省为单租户无鉴权模式（仅测试用）。 */
  auth?: AuthHandler
  /**
   * 签名媒体：跨源卡片帧不携带会话 Cookie，只能靠 URL 签名取媒体。
   * 提供后，带有效签名的 /media/v1/* 无需登录即可访问。
   */
  signedMedia?: {
    masterKeyBase64: string
    storeForTenant(tenantId: string): SessionBinding['mediaStore'] | undefined
  }
  /**
   * 卡片源（如 https://cards.example.com）。设置后：
   *  - 命中该 Host 的请求进入「卡片模式」：只提供卡片帧页面与签名媒体，其余一律 404；
   *  - 应用页面会注入 window.__ELECKOI_WEB__.cardOrigin，渲染层据此改用跨源帧。
   * 未设置时卡片与宿主同源——**仅限本地自用，不可开放公网**。
   */
  cardOrigin?: string
  /**
   * 额外允许卡片加载图片/媒体的源（逗号分隔已由调用方拆分）。
   * 用于角色卡把立绘放在外部图床的常见写法；只应填**自己的**域，见 cardFrame.ts 的说明。
   */
  cardImageOrigins?: readonly string[]
  /**
   * 免鉴权即可访问的静态路径白名单（默认空）。
   * 只用于健康检查与端到端测试的辅助页面；**生产不要设置**。
   */
  publicPaths?: readonly string[]
  /**
   * 允许向卡片帧投递文档的应用源白名单（精确 origin）。
   * 配置了 cardOrigin 时**必须**同时提供，否则卡片帧会拒绝一切投递。
   */
  appOrigins?: readonly string[]
  log?: (message: string) => void
}

export interface WebServerHandle {
  readonly url: string
  readonly port: number
  close(): Promise<void>
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function sendText(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

export function readBody(req: IncomingMessage, limitBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        rejectBody(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

/**
 * 在 </head> 前注入桥脚本；上游 index.html 保持零修改。
 *
 * 配置随桥脚本一起下发（不是单独的内联 script），因此应用文档的 CSP
 * 可以保持 script-src 'self'，无需为一行配置开 'unsafe-inline'。
 */
function injectBridge(html: string): string {
  if (html.includes(WEB_BRIDGE_PATH)) return html
  // 桥脚本 + Web 外壳：外壳把桌面端的窗口按钮换成账号区。
  // 都走同源外链，因此应用文档的 CSP 无需为它们放宽。
  const tags = [
    // 上游 index.html 没有 favicon 声明，标签页一直是浏览器默认图标。
    faviconLinks(),
    `<link rel="stylesheet" href="${WEB_CHROME_CSS_PATH}">`,
    `<script src="${WEB_BRIDGE_PATH}"></script>`,
    `<script src="${WEB_CHROME_JS_PATH}"></script>`
  ].join('\n  ')
  const index = html.indexOf('</head>')
  return index < 0 ? `${tags}\n${html}` : `${html.slice(0, index)}  ${tags}\n${html.slice(index)}`
}

/**
 * 应用源白名单：显式传入优先，否则取 ELECKOI_APP_ORIGINS（逗号分隔）。
 *
 * 抽出成函数是因为它有两个消费方——卡片帧的投递白名单，以及写操作的同源校验
 * （见 cookies.ts 的 assertSameOrigin）。两处必须是同一份名单，否则会出现
 * "卡片收得到文档但登录被判跨站"这类自相矛盾的故障。
 */
export function resolveAppOrigins(explicit?: readonly string[]): string[] {
  const raw = explicit ?? (process.env.ELECKOI_APP_ORIGINS ?? '').split(',')
  return raw.map((item) => item.trim()).filter((item) => item !== '')
}

/** 防止 ../ 逃逸出静态根目录。 */
function safeJoin(root: string, urlPath: string): string | undefined {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  const candidate = resolve(join(root, normalize(decoded)))
  const base = resolve(root)
  return candidate === base || candidate.startsWith(base + sep) ? candidate : undefined
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8790
  const cardOrigin = options.cardOrigin ?? ''
  const bridgeSource = buildWebBridgeSource({
    eventStream: process.env.ELECKOI_DISABLE_EVENT_STREAM !== '1',
    cardOrigin
  })
  /** 卡片源的 Host（含端口）；未配置卡片源时为 undefined。 */
  const cardHost = cardOrigin === '' ? undefined : new URL(cardOrigin).host
  /** 应用源白名单：卡片帧只接受来自这些源的文档投递。 */
  const appOrigins = resolveAppOrigins(options.appOrigins)
  if (cardOrigin !== '' && appOrigins.length === 0) {
    throw new Error('配置了 ELECKOI_CARD_ORIGIN 时必须同时提供 ELECKOI_APP_ORIGINS，否则卡片帧会拒绝所有文档。')
  }
  const cardImageOrigins = resolveCardImageOrigins(options.cardImageOrigins)
  const cardFrameSource = renderCardFrame({
    allowedOrigins: appOrigins,
    csp: cardFrameCsp(appOrigins, cardImageOrigins)
  })
  const openStreams = new Set<ServerResponse>()
  let nextConnectionId = 1

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      options.log?.(`请求处理失败：${String(error)}`)
      if (!res.headersSent) sendText(res, 500, '内部错误')
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    const path = url.split('?')[0] ?? '/'

    // ── 卡片源：与应用源隔离，只提供卡片帧与签名媒体 ──
    // 按"对外 Host"分流：反向代理未必保留 Host，信任代理时以 X-Forwarded-Host 为准。
    if (cardHost !== undefined && effectiveHost(req) === cardHost) {
      await handleCardOrigin(res, path, url)
      return
    }

    if (path === WEB_BRIDGE_PATH) {
      sendText(res, 200, bridgeSource, 'text/javascript; charset=utf-8')
      return
    }

    if (path === WEB_CHROME_CSS_PATH) {
      sendText(res, 200, buildWebChromeCss(), 'text/css; charset=utf-8')
      return
    }

    if (path === WEB_CHROME_JS_PATH) {
      sendText(res, 200, buildWebChromeScript(), 'text/javascript; charset=utf-8')
      return
    }

    // 上游主题令牌（登录/账号/用户管理页共用），从构建产物提取后原样下发。
    if (path === APP_TOKENS_PATH) {
      sendText(res, 200, readAppTokens(options.rendererDir), 'text/css; charset=utf-8')
      return
    }

    // 测试/健康检查用的公开静态文件：只服务文件，不触碰任何会话或产品数据。
    if (options.publicPaths?.includes(path) === true) {
      const target = safeJoin(options.rendererDir, path)
      if (target === undefined || !existsSync(target) || !statSync(target).isFile()) {
        sendText(res, 404, 'not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      })
      createReadStream(target).pipe(res)
      return
    }

    // ── 认证路由（不需要会话）──
    if (options.auth !== undefined && await options.auth.handle(req, res)) return

    // ── 签名媒体（不需要会话）──
    // 跨源卡片帧里没有应用源的会话 Cookie；带有效签名的媒体 URL 直接放行。
    // 签名绑定租户与资源路径且有有效期，因此不依赖 Cookie 也是安全的。
    if (path.startsWith(MEDIA_PREFIX) && options.signedMedia !== undefined) {
      const resourcePath = safeDecode(path.slice(MEDIA_PREFIX.length))
      const params = new URL(url, 'http://placeholder').searchParams
      const signed = resourcePath === undefined
        ? undefined
        : readSignedMedia(params, resourcePath, options.signedMedia.masterKeyBase64)
      if (signed !== undefined) {
        const store = options.signedMedia.storeForTenant(signed.tenantId)
        if (store === undefined) sendText(res, 404, 'not found')
        else serveMedia(res, store, resourcePath!)
        return
      }
    }

    // ── 需要会话的路由 ──
    const binding = await options.resolveSession(req)
    if (binding === undefined) {
      if (options.auth === undefined) {
        sendText(res, 503, '服务尚未完成初始化。')
        return
      }
      if (path.startsWith('/api/')) {
        sendJson(res, 401, failure(new Error('登录状态已失效，请重新登录。')))
        return
      }
      res.writeHead(302, { location: '/login', 'cache-control': 'no-store' })
      res.end()
      return
    }

    try {
      await handleAuthorized(req, res, path, binding)
    } finally {
      binding.release()
    }
  }

  /** decodeURIComponent 遇到畸形输入会抛错，这里统一降级为不可解析。 */
  function safeDecode(value: string): string | undefined {
    try {
      return decodeURIComponent(value)
    } catch {
      return undefined
    }
  }

  /** 按引用回源媒体文件；store 决定用哪个租户的媒体目录。 */
  function serveMedia(res: ServerResponse, store: SessionBinding['mediaStore'], resourcePath: string): void {
    const reference = `${LOCAL_MEDIA_REFERENCE_PREFIX}${resourcePath}`
    const file = store.pathForReference(reference)
    if (file === undefined || !existsSync(file)) {
      sendText(res, 404, 'not found')
      return
    }
    res.writeHead(200, {
      'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'private, max-age=300'
    })
    createReadStream(file).pipe(res)
  }

  /**
   * 卡片源请求处理。
   *
   * 严格白名单：只提供卡片帧页面与「带有效签名」的媒体，其余一律 404。
   * 这里**不解析会话、不挂载租户、不暴露任何 API**——卡片源的攻击面被压到最小。
   */
  async function handleCardOrigin(
    res: ServerResponse,
    path: string,
    url: string
  ): Promise<void> {
    if (path === CARD_FRAME_PATH) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': cardFrameCsp(appOrigins, cardImageOrigins),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer'
      })
      res.end(cardFrameSource)
      return
    }

    if (path.startsWith(MEDIA_PREFIX)) {
      const resourcePath = safeDecode(path.slice(MEDIA_PREFIX.length))
      const params = new URL(url, 'http://placeholder').searchParams
      const signed = resourcePath === undefined || options.signedMedia === undefined
        ? undefined
        : readSignedMedia(params, resourcePath, options.signedMedia.masterKeyBase64)
      if (signed === undefined) {
        sendText(res, 404, 'not found')
        return
      }
      const store = options.signedMedia!.storeForTenant(signed.tenantId)
      if (store === undefined) sendText(res, 404, 'not found')
      else serveMedia(res, store, resourcePath!)
      return
    }

    sendText(res, 404, 'not found')
  }

  async function handleAuthorized(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    binding: SessionBinding
  ): Promise<void> {
    if (path === '/api/rpc' && req.method === 'POST') {
      let envelope: { name?: unknown; input?: unknown }
      try {
        envelope = JSON.parse(await readBody(req)) as { name?: unknown; input?: unknown }
      } catch {
        sendJson(res, 400, failure(new Error('请求体不是合法 JSON')))
        return
      }
      const context: RequestContext = { senderId: nextConnectionId++, windowId: undefined }
      try {
        const data = await binding.gateway.dispatch({ name: String(envelope.name), input: envelope.input }, context)
        sendJson(res, 200, success(data))
      } catch (error) {
        // 与上游 GatewayResult 语义一致：错误也走 200 + {ok:false}，由渲染层 unwrap 抛出。
        sendJson(res, 200, failure(error))
      }
      return
    }

    if (path === '/api/events') {
      const id = nextConnectionId++
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      })
      res.write(': connected\n\n')
      openStreams.add(res)
      const detach = binding.gateway.attach({
        id,
        send: (envelope: GatewayEventEnvelope) => {
          res.write(`data: ${JSON.stringify(envelope)}\n\n`)
        }
      })
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000)
      req.on('close', () => {
        clearInterval(keepAlive)
        detach()
        openStreams.delete(res)
      })
      return
    }

    // 走到这里说明没有有效签名（或未启用签名媒体），按会话鉴权处理。
    if (path.startsWith(MEDIA_PREFIX)) {
      const resourcePath = safeDecode(path.slice(MEDIA_PREFIX.length))
      if (resourcePath === undefined) {
        sendText(res, 400, 'bad request')
        return
      }
      serveMedia(res, binding.mediaStore, resourcePath)
      return
    }

    // ── 静态产物 + SPA 回退 ──
    const target = safeJoin(options.rendererDir, path === '/' ? '/index.html' : path)
    const file = target !== undefined && existsSync(target) && statSync(target).isFile()
      ? target
      : join(options.rendererDir, 'index.html')
    if (!existsSync(file)) {
      sendText(res, 404, '未找到渲染产物，请先执行 pnpm exec electron-vite build。')
      return
    }
    const isHtml = extname(file) === '.html'
    const body = isHtml ? injectBridge(readFileSync(file, 'utf8')) : undefined
    res.writeHead(200, {
      'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      // HTML 文档带完整安全头；其余静态资源由 x-content-type-options 兜底即可。
      ...(isHtml ? securityHeaders('app', cardOrigin) : { 'x-content-type-options': 'nosniff' })
    })
    if (body !== undefined) res.end(body)
    else createReadStream(file).pipe(res)
  }

  await new Promise<void>((ready) => server.listen(port, host, ready))
  const address = server.address()
  // port 传 0 时由系统分配，必须回读真实端口，否则 url 不可用。
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  const url = `http://${host}:${boundPort}`

  return {
    url,
    port: boundPort,
    async close() {
      for (const stream of openStreams) stream.end()
      openStreams.clear()
      await new Promise<void>((done) => server.close(() => done()))
    }
  }
}

/** 单租户适配（M1 的 POC 与本地自用形态）：无鉴权、固定租户。 */
export function singleTenantResolver(gateway: WebGateway, mediaStore: SessionBinding['mediaStore']) {
  return (): SessionBinding => ({ gateway, mediaStore, release: () => undefined })
}
