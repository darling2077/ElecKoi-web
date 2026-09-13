/**
 * HTTP Cookie 辅助（只依赖 node:http，不引入框架）。
 *
 * 会话 Cookie 一律 HttpOnly + SameSite=Lax + Path=/。
 * Secure 的判定见 `sessionCookie` 的第三个参数：既可以用 ELECKOI_SECURE_COOKIES=1
 * 强制开启，也会**按请求是否真的走 HTTPS** 自动决定——这样同一套部署里
 * 公网 HTTPS 入口拿到 Secure Cookie，而局域网 http://内网IP 仍能正常登录
 * （带 Secure 的 Set-Cookie 在明文连接上会被浏览器直接丢弃，一刀切开反而会把内网访问打死）。
 */

import type { IncomingMessage } from 'node:http'

export const SESSION_COOKIE = 'eleckoi_session'

export function parseCookies(header: string | undefined): Map<string, string> {
  const jar = new Map<string, string>()
  if (!header) return jar
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name) jar.set(name, decodeURIComponent(value))
  }
  return jar
}

export function readSessionToken(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie).get(SESSION_COOKIE)
}

/**
 * 客户端到**反向代理**这一段是否加密。
 *
 * 容器自己通常只收到明文 HTTP，真正的 TLS 由代理终结，因此要看
 * X-Forwarded-Proto（由 ELECKOI_TRUST_PROXY 控制是否采信）。
 */
export function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted === true) return true
  if (process.env.ELECKOI_TRUST_PROXY !== '1') return false
  const proto = req.headers['x-forwarded-proto']
  const first = (Array.isArray(proto) ? proto[0] : proto?.split(',')[0])?.trim().toLowerCase()
  return first === 'https'
}

/** Cookie 是否需要 Secure：强制开关，或本次请求确实是 HTTPS。 */
export function shouldSecureCookie(req: IncomingMessage): boolean {
  return process.env.ELECKOI_SECURE_COOKIES === '1' || isSecureRequest(req)
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure = false): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ]
  if (secure) attributes.push('Secure')
  return attributes.join('; ')
}

export function clearedSessionCookie(secure = false): string {
  const attributes = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) attributes.push('Secure')
  return attributes.join('; ')
}

/** 取客户端地址；反向代理后需信任 X-Forwarded-For（由 ELECKOI_TRUST_PROXY 开启）。 */
export function clientIp(req: IncomingMessage): string {
  if (process.env.ELECKOI_TRUST_PROXY === '1') {
    const forwarded = req.headers['x-forwarded-for']
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]
    if (first?.trim()) return first.trim()
  }
  return req.socket.remoteAddress ?? ''
}

/**
 * 请求对外呈现的 Host（含端口）。
 *
 * 反向代理未必保留原始 Host：nginx 默认就把 Host 换成上游地址（$proxy_host）。
 * 一旦被换掉，按 Host 分流的卡片源会失配、同源校验会把正常请求判成跨站。
 * 因此信任代理时优先采信 X-Forwarded-Host；代理没给就退回 Host，行为与以前一致。
 */
export function effectiveHost(req: IncomingMessage): string | undefined {
  if (process.env.ELECKOI_TRUST_PROXY === '1') {
    const forwarded = req.headers['x-forwarded-host']
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])?.trim()
    if (first) return first
  }
  return req.headers.host
}

/** 把配置里的源归一成 `scheme://host[:port]`，顺带丢掉末尾斜杠之类的写法差异。 */
function normalizeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

/**
 * 只允许同源表单/脚本发起的写操作，挡掉最朴素的 CSRF。
 *
 * 判定有两条路：请求的 Origin 与"对外 Host"一致，**或者** Origin 在本服务
 * 公开声明过的源列表里。后者是给反向代理准备的：代理换了 Host 时第一条会失配，
 * 而白名单是部署者自己配的，放宽不到别人身上。
 */
export function assertSameOrigin(req: IncomingMessage, allowedOrigins: readonly string[] = []): void {
  const origin = req.headers.origin
  if (origin === undefined) return // 同源 fetch 在部分场景不带 Origin
  const normalized = normalizeOrigin(origin)
  if (normalized === undefined) throw new Error('Origin 头不合法。')
  if (allowedOrigins.some((allowed) => normalizeOrigin(allowed) === normalized)) return
  const host = effectiveHost(req)
  if (host === undefined) return
  // 比 host 而不是整个 origin：URL 会把默认端口归一掉，https 与 http 的差别这里不追究
  if (new URL(normalized).host !== host) throw new Error('跨站请求被拒绝。')
}
