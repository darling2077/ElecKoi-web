/**
 * Web 租户宿主：等价于上游 DesktopHost，但
 *   - 平台层换成 Web 实现（方案 §5.2）
 *   - 不挂载 Electron 专属插件（mediaProtocol / mainWindowPlugin / updatesPlugin）
 *   - 网关换成 WebGateway
 *
 * 上游模块插件**原样挂载**，挂载顺序与 DesktopHost 保持一致，避免依赖解析顺序差异。
 */

import { Context } from '@deepseek-ai/cordis'
import { agentPlugin } from '@main/modules/agent'
import { agentPresetsPlugin } from '@main/modules/agentPresets'
import { agentToolsPlugin } from '@main/modules/agentTools'
import { authorSdkPlugin } from '@main/modules/authorSdk'
import { characterTransferPlugin } from '@main/modules/characterTransfer'
import { compatibilityPlugin } from '@main/modules/compatibility'
import { conversationsPlugin } from '@main/modules/conversations'
import { modelsPlugin } from '@main/modules/models'
import { personasPlugin } from '@main/modules/personas'
import { regexRulesPlugin } from '@main/modules/regexRules'
import { settingLibrariesPlugin } from '@main/modules/settingLibraries'
import { settingsPlugin } from '@main/modules/settings'
import { variablesPlugin } from '@main/modules/variables'
import { sqlitePlugin } from '@main/host/plugins'
import { createWebPlatformPlugin } from './platform/webPlatformPlugin'
import { createWebShellPlugin } from './modules/webShellPlugin'
import { WebGateway, type RunQuota } from './transport/WebGateway'
import type { SqliteDatabase } from '@main/platform/sqlite/SqliteDatabase'
import { createCardImageLocalizer, type CardImageLocalizer } from './media/cardImageLocalizer'
import { createMediaSigner } from './mediaSignature'
import type { Plugin } from '@deepseek-ai/cordis'

/** 上游 Electron 专属插件清单，仅作对照记录：Web 端不挂载。 */
export const SKIPPED_UPSTREAM_PLUGINS = [
  'mediaProtocolPlugin',
  'mainWindowPlugin',
  'updatesPlugin'
] as const

export interface MountTenantOptions {
  tenantId: string
  tenantRoot: string
  masterKeyBase64: string
  /** 对外暴露的版本号，用于 query.updates.status。 */
  appVersion: string
  /** 允许注入网关子类（POC 用于统计路由注册，M2 用于按租户扩展）。 */
  gatewayFactory?: () => WebGateway
  /** 该租户的回合名额控制（通常绑定到具体用户）。 */
  runQuota?: RunQuota
}

export interface TenantRuntime {
  readonly tenantId: string
  readonly context: Context
  readonly gateway: WebGateway
  dispose(): Promise<void>
}

function createWebGatewayPlugin(gateway: WebGateway): Plugin.Object {
  return {
    name: 'eleckoi-web-gateway',
    provide: 'desktopGateway',
    apply(ctx: Context) {
      ctx.provide('desktopGateway', gateway)
      return () => gateway.dispose()
    }
  }
}

/**
 * 按环境变量装配「导入卡片时自动搬图」。
 *
 * 需要三个变量同时就位才启用；缺任何一个都返回 undefined（= 不启用，行为与以前一致）：
 *   ELECKOI_IMAGE_PUBLIC_BASE   图床对外地址，如 https://img.kidamita.top:57789
 *   ELECKOI_IMAGE_UPLOAD_API    上传接口地址，通常与上面同源
 *   ELECKOI_IMAGE_UPLOAD_TOKEN  图床后台生成的 API 令牌
 *
 * 另外三个可调（都有默认值）：ELECKOI_IMAGE_MAX_PER_IMPORT、ELECKOI_IMAGE_TIME_BUDGET_MS、
 * ELECKOI_IMAGE_MAX_BYTES。
 */
export function createImportImageLocalizer(database: SqliteDatabase): CardImageLocalizer | undefined {
  const publicBase = (process.env.ELECKOI_IMAGE_PUBLIC_BASE ?? '').trim()
  const uploadApi = (process.env.ELECKOI_IMAGE_UPLOAD_API ?? '').trim()
  const uploadToken = (process.env.ELECKOI_IMAGE_UPLOAD_TOKEN ?? '').trim()
  if (publicBase === '' || uploadApi === '' || uploadToken === '') return undefined
  const number = (raw: string | undefined, fallback: number): number => {
    const value = Number((raw ?? '').trim())
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  return createCardImageLocalizer({
    database,
    publicBase,
    uploadApi,
    uploadToken,
    allowLocalAddresses: (process.env.ELECKOI_IMAGE_ALLOW_LOCAL ?? '').trim() === '1',
    concurrency: number(process.env.ELECKOI_IMAGE_CONCURRENCY, 4),
    maxImages: number(process.env.ELECKOI_IMAGE_MAX_PER_IMPORT, 2000),
    maxBytes: number(process.env.ELECKOI_IMAGE_MAX_BYTES, 20 * 1024 * 1024),
    budgetMs: number(process.env.ELECKOI_IMAGE_TIME_BUDGET_MS, 900_000),
    log: (message) => console.log(`[card-images]${message}`)
  })
}

export class WebHost {
  static async mountTenant(options: MountTenantOptions): Promise<TenantRuntime> {
    const context = new Context()
    const gateway = options.gatewayFactory?.() ?? new WebGateway()
    // 媒体签名按租户派生：跨源卡片帧不携带会话 Cookie，需要签名 URL 才能取媒体。
    gateway.mediaSigner = createMediaSigner(options.masterKeyBase64, options.tenantId)
    if (options.runQuota !== undefined) gateway.runQuota = options.runQuota

    // — 基础层 —
    await context.plugin(createWebPlatformPlugin({
      tenantId: options.tenantId,
      tenantRoot: options.tenantRoot,
      masterKeyBase64: options.masterKeyBase64
    }))
    await context.plugin(createWebGatewayPlugin(gateway))
    await context.plugin(sqlitePlugin)          // 上游原样复用（inject: appPaths）
    await context.plugin(compatibilityPlugin)
    await context.plugin(variablesPlugin)
    await context.plugin(agentPresetsPlugin)
    await context.plugin(agentToolsPlugin)
    await context.plugin(regexRulesPlugin)
    await context.plugin(settingLibrariesPlugin)
    await context.plugin(conversationsPlugin)
    await context.plugin(settingsPlugin)
    await context.plugin(personasPlugin)
    await context.plugin(characterTransferPlugin)
    await context.plugin(modelsPlugin)

    // — Web 外壳：补上上游由 Electron 专属插件注册的路由 —
    await context.plugin(createWebShellPlugin({ appVersion: options.appVersion }))

    // — 交互层（依赖 foundation 全部就绪）—
    await context.plugin(agentPlugin)
    await context.plugin(authorSdkPlugin)

    const mounted = context.desktopGateway as WebGateway
    if (mounted !== gateway) throw new Error('desktopGateway 服务不是本租户的网关实例。')

    // 导入卡片后自动搬图：没配图床就自动关闭（不影响任何既有行为）。
    const localizer = createImportImageLocalizer(context.database)
    if (localizer !== undefined) {
      mounted.importImageHook = localizer
      // 搬运完成后让前端刷新角色列表：卡片内容被改写了，不刷新会一直显示旧的黑图。
      mounted.onImagesLocalized = () => mounted.broadcast('records.changed', { module: 'personas' })
      // 默认同步：导入请求等图片搬完才返回，界面上的进度条走完才算导入成功。
      // 这样卡一出现在列表里就是"图已经搬好"的最终态，不存在中途改引用的窗口。
      mounted.importImageMode = (process.env.ELECKOI_IMAGE_LOCALIZE_MODE ?? '').trim() === 'background'
        ? 'background'
        : 'inline'
    }
    let disposed = false

    return {
      tenantId: options.tenantId,
      context,
      gateway,
      async dispose() {
        if (disposed) return
        disposed = true
        await context.fiber.dispose()
      }
    }
  }
}
