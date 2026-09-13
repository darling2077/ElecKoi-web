/**
 * 媒体签名 URL。
 *
 * 为什么需要：富内容卡片被隔离到**独立源**（cards.*）后，帧内不携带应用源的
 * 会话 Cookie，`<img src="/media/v1/...">` 无法通过会话鉴权。签名 URL 让媒体
 * 在无 Cookie 的情况下也能被安全访问，且可过期、可绑定租户。
 *
 * 签名载荷：`media|<tenantId>|<资源路径>|<过期时间>`，HMAC-SHA256。
 * 密钥由主密钥派生（HKDF），不落盘、不入库。
 */

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

const KEY_INFO = 'eleckoi-media-url'
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

export interface MediaSignatureParams {
  tenantId: string
  /** 形如 `<ownerHash>/<slot>/<fileName>`，不含前导斜杠与查询串。 */
  resourcePath: string
  expiresAt: number
}

export function deriveMediaKey(masterKeyBase64: string): Buffer {
  const master = Buffer.from(masterKeyBase64, 'base64')
  return Buffer.from(hkdfSync('sha256', master, Buffer.from('eleckoi-media', 'utf8'), Buffer.from(KEY_INFO, 'utf8'), 32))
}

function payload(params: MediaSignatureParams): string {
  return `media|${params.tenantId}|${params.resourcePath}|${params.expiresAt}`
}

export function signMedia(params: MediaSignatureParams, key: Buffer): string {
  return createHmac('sha256', key).update(payload(params)).digest('base64url')
}

export function verifyMedia(params: MediaSignatureParams, signature: string, key: Buffer): boolean {
  if (!Number.isFinite(params.expiresAt) || params.expiresAt <= Date.now()) return false
  const expected = Buffer.from(signMedia(params, key), 'utf8')
  const provided = Buffer.from(signature, 'utf8')
  return expected.length === provided.length && timingSafeEqual(expected, provided)
}

/** 构建带签名的浏览器可用 URL（相对路径，同源或跨源都能用）。 */
export function signedMediaUrl(params: MediaSignatureParams, key: Buffer): string {
  const query = new URLSearchParams({
    t: params.tenantId,
    exp: String(params.expiresAt),
    sig: signMedia(params, key)
  })
  return `/media/v1/${params.resourcePath}?${query.toString()}`
}

export interface MediaSigner {
  /** 输入 `/media/v1/<resourcePath>`，输出带签名的完整路径。 */
  sign(webPath: string): string
}

export function createMediaSigner(masterKeyBase64: string, tenantId: string, ttlMs = DEFAULT_TTL_MS): MediaSigner {
  const key = deriveMediaKey(masterKeyBase64)
  return {
    sign(webPath: string): string {
      const prefix = '/media/v1/'
      if (!webPath.startsWith(prefix)) return webPath
      const resourcePath = webPath.slice(prefix.length)
      if (!resourcePath || resourcePath.includes('?')) return webPath
      return signedMediaUrl({ tenantId, resourcePath, expiresAt: Date.now() + ttlMs }, key)
    }
  }
}

/** 从请求里解析并校验签名；通过则返回租户与资源路径。 */
export function readSignedMedia(
  searchParams: URLSearchParams,
  resourcePath: string,
  masterKeyBase64: string
): { tenantId: string } | undefined {
  const tenantId = searchParams.get('t')
  const expiresAt = Number(searchParams.get('exp'))
  const signature = searchParams.get('sig')
  if (!tenantId || !signature) return undefined
  const key = deriveMediaKey(masterKeyBase64)
  return verifyMedia({ tenantId, resourcePath, expiresAt }, signature, key) ? { tenantId } : undefined
}
