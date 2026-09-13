/**
 * WebUI 平台插件：等价于上游 `src/main/host/plugins.ts` 的 `platformPlugin`，
 * 但把 5 个平台服务换成服务端多租户实现。
 *
 * 复用策略（与方案 §5.2 一致）：
 *   appPaths          → WebAppPaths（按租户根目录）
 *   appLog            → 复用上游 createAppLog()，附租户标签
 *   credentialCipher  → WebCredentialCipher（AES-256-GCM，替代 safeStorage）
 *   conversationFiles → 复用上游 ConversationFiles
 *   mediaAssets       → 复用上游 LocalMediaStore（URL 前缀在 WebGateway 重写）
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import { createAppLog } from '@main/platform/logging/AppLog'
import { ConversationFiles } from '@main/platform/filesystem/ConversationFiles'
import { LocalMediaStore } from '@main/platform/filesystem/LocalMediaStore'
import { join } from 'node:path'
import { WebAppPaths } from './WebAppPaths'
import { WebCredentialCipher } from './WebCredentialCipher'
import '@main/host/desktopContext'

export interface WebPlatformOptions {
  tenantId: string
  tenantRoot: string
  masterKeyBase64: string
}

export function createWebPlatformPlugin(options: WebPlatformOptions): Plugin.Object {
  const appPaths = new WebAppPaths(options.tenantId, options.tenantRoot)

  return {
    name: 'eleckoi-web-platform',
    provide: ['appPaths', 'appLog', 'credentialCipher', 'conversationFiles', 'mediaAssets'],
    apply(ctx: Context) {
      const log = createAppLog().child({ tenant: options.tenantId })
      ctx.provide('appPaths', appPaths)
      ctx.provide('appLog', log)
      // 解密失败只告警不抛错（见 WebCredentialCipher.decrypt 的说明）：
      // 上游 list() 是逐行解密的，一条解不开就会让整个供应商列表消失。
      ctx.provide('credentialCipher', new WebCredentialCipher(
        options.masterKeyBase64,
        options.tenantId,
        (message) => log.warn(message)
      ))
      ctx.provide('conversationFiles', new ConversationFiles([
        appPaths.workspace,
        join(appPaths.dshRuntime, 'sessions')
      ]))
      ctx.provide('mediaAssets', new LocalMediaStore(appPaths.media))
    }
  } satisfies Plugin.Object
}
