/**
 * WebUI 外壳插件：补上上游由 Electron 专属插件注册的 6 条路由。
 *
 * M0-P5 实测结论（渲染层调用点）：
 *   command.window.control         windowControls.js:34,38,42 —— 调用处无 catch，
 *                                  Web 端返回 {ok:true} 让标题栏按钮静默无效即可，避免未捕获 rejection
 *   command.appearance.set_mode    appearanceApi.js:12 —— 需要真实写设置；
 *                                  上游额外依赖 nativeTheme，Web 端改为由客户端偏好提示解析 system
 *   query.updates.status           useAppUpdates.js:15 —— 挂载即调用；返回 phase:'disabled' 后
 *                                  既不会弹出更新对话框（VISIBLE_PHASES 不含 disabled），也不显示错误
 *   command.updates.check/download/install  —— 同上，统一走镜像升级语义
 *
 * 本插件不修改任何上游文件；上游若新增 Electron 专属路由，P1-4 覆盖断言会立刻报警。
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import { resolvedAppearanceModeSchema, type AppearanceMode } from '@shared/contracts/settings/schemas'
import type { UpdateStatus } from '@shared/contracts/updates/schemas'
import '@main/host/desktopContext'

export interface WebShellOptions {
  appVersion: string
  /**
   * 'system' 模式的解析结果。浏览器偏好只有客户端知道，
   * M1 由 WebSocket 连接在握手时上报 prefers-color-scheme；M0 缺省按 dark。
   */
  resolveSystemAppearance?: () => 'light' | 'dark'
}

export function createWebShellPlugin(options: WebShellOptions): Plugin.Object {
  const disabledStatus = (): UpdateStatus => ({
    phase: 'disabled',
    currentVersion: options.appVersion,
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    downloadSizeBytes: null,
    progress: null,
    message: 'WebUI 通过更新容器镜像升级。'
  })

  return {
    name: 'eleckoi-web-shell',
    inject: ['desktopGateway', 'userSettings'],
    apply(ctx: Context) {
      const resolveSystem = options.resolveSystemAppearance ?? (() => 'dark' as const)

      return [
        // 浏览器里没有窗口可控制：返回成功让调用方不再抛错。
        ctx.desktopGateway.register('command.window.control', () => ({ ok: true as const })),

        ctx.desktopGateway.register('command.appearance.set_mode', ({ mode }) => {
          const saved = ctx.userSettings.write('appearance.mode', mode as AppearanceMode)
          return {
            mode: saved,
            resolved: resolvedAppearanceModeSchema.parse(saved === 'system' ? resolveSystem() : saved)
          }
        }),

        ctx.desktopGateway.register('query.updates.status', () => disabledStatus()),

        ctx.desktopGateway.register('command.updates.check', () => {
          const status = disabledStatus()
          ctx.desktopGateway.broadcast('updates.state.changed', status)
          return status
        }),

        ctx.desktopGateway.register('command.updates.download', () => disabledStatus()),

        ctx.desktopGateway.register('command.updates.install', () => ({
          accepted: false,
          reason: 'not_ready' as const
        }))
      ]
    }
  } satisfies Plugin.Object
}
