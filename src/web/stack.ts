/**
 * WebUI 运行时栈的组装工厂。
 *
 * 生产入口（entry.ts）与验收测试都走这里，保证被测的就是上线的那套接线。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { LocalMediaStore } from '@main/platform/filesystem/LocalMediaStore'
import { ControlDatabase } from './control/ControlDatabase'
import { QuotaService } from './control/QuotaService'
import { AuthService } from './control/AuthService'
import { createAuthHandler } from './http/authController'
import { resolveAppOrigins } from './http/server'
import { readSessionToken } from './http/cookies'
import { startWebServer, type SessionBinding, type WebServerHandle } from './http/server'
import { TenantRegistry } from './TenantRegistry'

export interface WebUiStackOptions {
  /** POST /api/rpc 的请求体上限（字节）；导入角色卡会一次性上传整张卡。 */
  maxBodyBytes?: number
  /** 本地图床（ELECKOI_CARD_IMAGE_MODE=local）的图片目录。 */
  cardImageDir?: string
  /** 卡片图片策略（放开档）与黑名单，见 cardFrame.ts。 */
  cardImagePolicy?: { allowAnyHttps?: boolean; allowAnyHttp?: boolean }
  cardImageBlockedHosts?: readonly string[]
  dataRoot: string
  rendererDir: string
  masterKeyBase64: string
  appVersion: string
  host?: string
  port?: number
  allowRegistration?: boolean
  /** AGPL §13 要求的对应源码地址。 */
  sourceUrl?: string
  /** 每用户同时进行的 Agent 回合上限，缺省 2。 */
  maxConcurrentRuns?: number
  /** 免鉴权静态路径白名单（仅测试/健康检查用，生产留空）。 */
  publicPaths?: readonly string[]
  /** 启动时按邮箱提升为管理员；用配置而非硬编码，避免把某个人写死在代码里。 */
  adminEmails?: readonly string[]
  /** 卡片源（如 https://cards.example.com）；未设置则卡片与宿主同源（不可公网）。 */
  cardOrigin?: string
  /** 额外允许卡片加载图片/媒体的源（见 server.ts 的 resolveCardImageOrigins）。 */
  cardImageOrigins?: readonly string[]
  /**
   * 对外公开的应用源（反向代理后的地址也要列进来）。
   * 同时用于三处：卡片帧的投递白名单、卡片帧的 frame-ancestors、写操作的同源校验。
   */
  appOrigins?: readonly string[]
  idleMs?: number
  maxLive?: number
  log?: (message: string) => void
}

export interface WebUiStack {
  readonly server: WebServerHandle
  readonly control: ControlDatabase
  readonly auth: AuthService
  readonly tenants: TenantRegistry
  close(): Promise<void>
}

export async function startWebUiStack(options: WebUiStackOptions): Promise<WebUiStack> {
  mkdirSync(join(options.dataRoot, 'tenants'), { recursive: true })

  const control = new ControlDatabase(join(options.dataRoot, 'registry.sqlite'))
  control.open()
  const auth = new AuthService(control)
  const promoted = auth.promoteAdmins(options.adminEmails ?? [])
  if (promoted.length > 0) options.log?.(`已提升为管理员：${promoted.join('、')}`)
  const quota = new QuotaService({
    ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns })
  })
  const tenants = new TenantRegistry({
    dataRoot: options.dataRoot,
    masterKeyBase64: options.masterKeyBase64,
    appVersion: options.appVersion,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.maxLive === undefined ? {} : { maxLive: options.maxLive }),
    runQuotaFor: (userId) => ({
      begin: (conversationId) => quota.begin(userId, conversationId),
      end: (conversationId) => quota.end(userId, conversationId)
    }),
    // exactOptionalPropertyTypes 下不能显式传 undefined
    ...(options.log === undefined ? {} : { log: options.log })
  })

  // 白名单只解析一次：卡片帧与同源校验必须用同一份，否则会出现
  // "卡片收得到文档但登录被判跨站"这种自相矛盾的故障。
  const appOrigins = resolveAppOrigins(options.appOrigins)

  const server = await startWebServer({
      // exactOptionalPropertyTypes：未配置时不要把这些键传成 undefined
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
      ...(options.cardImageDir === undefined ? {} : { cardImageDir: options.cardImageDir }),
      ...(options.cardImagePolicy === undefined ? {} : { cardImagePolicy: options.cardImagePolicy }),
      ...(options.cardImageBlockedHosts === undefined ? {} : { cardImageBlockedHosts: options.cardImageBlockedHosts }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    rendererDir: options.rendererDir,
    ...(options.cardOrigin === undefined ? {} : { cardOrigin: options.cardOrigin }),
    ...(options.cardImageOrigins === undefined ? {} : { cardImageOrigins: options.cardImageOrigins }),
    appOrigins,
    ...(options.publicPaths === undefined ? {} : { publicPaths: options.publicPaths }),
    auth: createAuthHandler({
      auth,
      control,
      allowRegistration: options.allowRegistration ?? true,
      dataRoot: options.dataRoot,
      allowedOrigins: appOrigins,
      ...(options.sourceUrl === undefined ? {} : { sourceUrl: options.sourceUrl }),
      ...(options.log === undefined ? {} : { log: options.log })
    }),
    async resolveSession(req): Promise<SessionBinding | undefined> {
      const session = auth.verify(readSessionToken(req))
      if (session === undefined) return undefined
      const tenant = control.findTenant(session.userId)
      if (tenant === undefined) return undefined
      const lease = await tenants.acquire(session.userId, tenant.tenant_id)
      control.touchTenant(session.userId)
      return {
        gateway: lease.runtime.gateway,
        mediaStore: lease.runtime.context.mediaAssets,
        release: lease.release
      }
    },
    // 跨源卡片帧没有会话 Cookie，靠签名 URL 取媒体。
    // 这里不需要挂载租户：媒体就是一个目录，直接构造 store 更轻。
    signedMedia: {
      masterKeyBase64: options.masterKeyBase64,
      storeForTenant(tenantId) {
        if (control.findTenantByTenantId(tenantId) === undefined) return undefined
        return new LocalMediaStore(join(options.dataRoot, 'tenants', tenantId, 'media'))
      }
    },
    ...(options.log === undefined ? {} : { log: options.log })
  })

  return {
    server,
    control,
    auth,
    tenants,
    async close() {
      await server.close()
      await tenants.close()
      control.close()
    }
  }
}
