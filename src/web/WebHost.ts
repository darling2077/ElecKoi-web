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
 * 按 `ELECKOI_CARD_IMAGE_MODE` 装配「导入卡片时自动搬图」。
 *
 * 四种做法（用户改 compose.yml / .env 里的一个变量即可切换）：
 *
 *   self-hosted  自建公网图床：图片传进你自己的图床，导出给别人也能取到图。
 *                需要 ELECKOI_IMAGE_PUBLIC_BASE + UPLOAD_API + UPLOAD_TOKEN，
 *                并把该域加进 ELECKOI_CARD_IMAGE_ORIGINS。
 *   local        本地图床：图片落到宿主机目录，由本服务在**卡片源**上以
 *                /card-images/ 提供。与卡片帧同源，**不需要任何白名单**；
 *                代价是导出给别人后打不开（别人访问不到你的机器）。
 *   inline       内联 data: URI：不用图床、不用白名单，导出即自带图；
 *                代价是图片以 base64 写进卡片数据，只适合小图。
 *   third-party  只放行第三方图床、不搬运：把对方域填进 ELECKOI_CARD_IMAGE_ORIGINS
 *                即可显示，但数据会随卡片请求发给对方，且对方删图后卡片就空了。
 *
 * 兼容：未设置该变量时沿用旧的推断方式（配了图床三件套就是 self-hosted，否则关闭）。
 */
export function createImportImageLocalizer(database: SqliteDatabase): CardImageLocalizer | undefined {
  const read = (name: string): string => (process.env[name] ?? '').trim()
  const number = (raw: string | undefined, fallback: number): number => {
    const value = Number((raw ?? '').trim())
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  const publicBase = read('ELECKOI_IMAGE_PUBLIC_BASE')
  const uploadApi = read('ELECKOI_IMAGE_UPLOAD_API')
  const uploadToken = read('ELECKOI_IMAGE_UPLOAD_TOKEN')

  const configured = read('ELECKOI_CARD_IMAGE_MODE')
  // 未显式指定时按老规矩推断：图床三件套齐了就上自建图床，否则不搬运。
  const mode = configured !== ''
    ? configured
    : (publicBase !== '' && uploadApi !== '' && uploadToken !== '' ? 'self-hosted' : 'off')

  const common = {
    database,
    allowLocalAddresses: read('ELECKOI_IMAGE_ALLOW_LOCAL') === '1',
    concurrency: number(read('ELECKOI_IMAGE_CONCURRENCY'), 4),
    maxImages: number(read('ELECKOI_IMAGE_MAX_PER_IMPORT'), 2000),
    maxBytes: number(read('ELECKOI_IMAGE_MAX_BYTES'), 20 * 1024 * 1024),
    budgetMs: number(read('ELECKOI_IMAGE_TIME_BUDGET_MS'), 900_000),
    log: (message: string) => console.log(`[card-images]${message}`)
  }

  if (mode === 'inline') {
    return createCardImageLocalizer({
      ...common,
      target: { kind: 'dataUri', maxInlineBytes: number(read('ELECKOI_IMAGE_INLINE_MAX_BYTES'), 256 * 1024) }
    })
  }

  if (mode === 'local') {
    const directory = read('ELECKOI_IMAGE_LOCAL_DIR') || '/data/card-images'
    // 图片由卡片源提供，所以对外地址就是卡片源；没配卡片源时退化成同源（本地自用）。
    const cardOrigin = read('ELECKOI_CARD_ORIGIN')
    return createCardImageLocalizer({
      ...common,
      publicBase: cardOrigin !== '' ? cardOrigin : '',
      target: { kind: 'localDir', directory }
    })
  }

  if (mode === 'self-hosted') {
    if (publicBase === '' || uploadApi === '' || uploadToken === '') {
      console.warn('[card-images] 选择了 self-hosted，但 ELECKOI_IMAGE_PUBLIC_BASE / UPLOAD_API / UPLOAD_TOKEN 未配齐，已自动关闭搬运。')
      return undefined
    }
    return createCardImageLocalizer({
      ...common,
      publicBase,
      target: { kind: 'uploadApi', uploadApi, uploadToken }
    })
  }

  if (mode !== 'off') {
    console.warn(`[card-images] 未知的 ELECKOI_CARD_IMAGE_MODE：${mode}（可选 self-hosted / local / inline / third-party / off），已关闭搬运。`)
  }
  return undefined
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
