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
