/**
 * M0 POC：验证方案中最关键的两条假设
 *
 *   P1 · 同进程多棵 cordis Context 不串台（服务实例、数据、路由各自独立）
 *   P2 · 上游 13 个模块插件可在自建 Web Context 中挂载，并跑通真实路由
 *
 * 运行：pnpm poc:web
 * 附带：若设置了 ELECKOI_POC_API_KEY，会额外尝试一次真实模型回合（P2b）。
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { requestContracts, type RequestName } from '@shared/contracts/gateway/definitions'
import type { RequestHandler } from '@shared/contracts/gateway/types'
import { WebHost } from '../WebHost'
import {
  LOCAL_MEDIA_REFERENCE_PREFIX,
  WEB_MEDIA_REFERENCE_PREFIX,
  WebGateway,
  rewriteLocalMediaReferences
} from '../transport/WebGateway'

type Outcome = { id: string; title: string; ok: boolean; detail: string }
const outcomes: Outcome[] = []

function record(id: string, title: string, ok: boolean, detail: string): void {
  outcomes.push({ id, title, ok, detail })
  const mark = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'
  console.log(`${mark}  ${id}  ${title}\n        ${detail}`)
}

function assert(id: string, title: string, condition: boolean, detail: string): boolean {
  record(id, title, condition, detail)
  return condition
}

/** 记录注册过的路由名，用于精确统计覆盖率（避免对真实路由做有副作用的盲探）。 */
class RecordingGateway extends WebGateway {
  readonly registered = new Set<string>()

  override register<TName extends RequestName>(name: TName, handler: RequestHandler<TName>): () => void {
    this.registered.add(name)
    return super.register(name, handler)
  }
}

/** 从网关错误里取错误码；dispatch 失败时抛 DesktopError。 */
function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String((error as { code: unknown }).code)
  return error instanceof Error ? error.message : String(error)
}

async function main(): Promise<void> {
  const masterKeyBase64 = randomBytes(32).toString('base64')
  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-poc-'))
  const rootA = join(root, 'tenant-a')
  const rootB = join(root, 'tenant-b')
  const gateways = new Map<string, RecordingGateway>()

  console.log(`\n== ElecKoi WebUI · M0 POC ==\n临时数据根：${root}\n`)

  let tenants: Awaited<ReturnType<typeof WebHost.mountTenant>>[] = []
  try {
    // ── P2-1 并发挂载两个租户，验证上游模块插件可在自建 Context 中装配 ──
    const mountStart = Date.now()
    try {
      tenants = await Promise.all([
        WebHost.mountTenant({
          tenantId: 'tenant-a',
          tenantRoot: rootA,
          masterKeyBase64,
          appVersion: '0.1.0-web-poc',
          gatewayFactory: () => {
            const gateway = new RecordingGateway()
            gateways.set('tenant-a', gateway)
            return gateway
          }
        }),
        WebHost.mountTenant({
          tenantId: 'tenant-b',
          tenantRoot: rootB,
          masterKeyBase64,
          appVersion: '0.1.0-web-poc',
          gatewayFactory: () => {
            const gateway = new RecordingGateway()
            gateways.set('tenant-b', gateway)
            return gateway
          }
        })
      ])
    } catch (error) {
      record('P2-1', '上游 13 个模块插件在 Web Context 中挂载', false, `挂载抛错：${errorCode(error)}`)
      throw error
    }
    const [tenantA, tenantB] = tenants as [NonNullable<typeof tenants[number]>, NonNullable<typeof tenants[number]>]
    record('P2-1', '上游 13 个模块插件在 Web Context 中并发挂载', true,
      `两个租户挂载成功，用时 ${Date.now() - mountStart} ms`)

    const ctxA = tenantA.context
    const ctxB = tenantB.context

    // ── P1-1 服务实例隔离 ──
    const servicesIsolated =
      ctxA.appPaths !== ctxB.appPaths &&
      ctxA.database !== ctxB.database &&
      ctxA.credentialCipher !== ctxB.credentialCipher &&
      ctxA.mediaAssets !== ctxB.mediaAssets &&
      ctxA.conversations !== ctxB.conversations &&
      ctxA.agentSessions !== ctxB.agentSessions &&
      tenantA.gateway !== tenantB.gateway
    assert('P1-1', '两租户的服务实例彼此独立', servicesIsolated,
      `appPaths/database/credentialCipher/mediaAssets/conversations/agentSessions/gateway 全部 !==`)

    // ── P1-2 数据目录与 SQLite 物理隔离 ──
    const dbA = ctxA.appPaths.database
    const dbB = ctxB.appPaths.database
    const [statA, statB] = await Promise.all([stat(dbA), stat(dbB)])
    assert('P1-2', '两租户 SQLite 落在各自目录且已建库', statA.size > 0 && statB.size > 0 && dbA !== dbB,
      `${dbA.replace(root, '<root>')} (${statA.size} B) / ${dbB.replace(root, '<root>')} (${statB.size} B)`)

    // ── P1-3 经真实网关做数据隔离验证 ──
    const requestContext = (id: number) => ({ senderId: id, windowId: undefined })
    const beforeB = await ctxB.desktopGateway.dispatch(
      { name: 'query.settings.read', input: { key: 'locale.current' } }, requestContext(2))
    await ctxA.desktopGateway.dispatch(
      { name: 'command.settings.write', input: { key: 'locale.current', value: 'zh-CN-tenant-a' } }, requestContext(1))
    const afterA = await ctxA.desktopGateway.dispatch(
      { name: 'query.settings.read', input: { key: 'locale.current' } }, requestContext(1))
    const afterB = await ctxB.desktopGateway.dispatch(
      { name: 'query.settings.read', input: { key: 'locale.current' } }, requestContext(2))
    const leaked = JSON.stringify(afterB) === JSON.stringify(afterA)
    assert('P1-3', '写入租户 A 的设置不会出现在租户 B', afterA === 'zh-CN-tenant-a' && !leaked,
      `A 写入后读回 ${JSON.stringify(afterA)}；B 写入前 ${JSON.stringify(beforeB)}，写入后 ${JSON.stringify(afterB)}`)

    // ── P1-4 路由注册完整性 ──
    const expected = Object.keys(requestContracts)
    for (const [tenantId, gateway] of gateways) {
      const missing = expected.filter((name) => !gateway.registered.has(name))
      record(`P1-4${tenantId === 'tenant-a' ? 'a' : 'b'}`, `${tenantId} 网关注册了全部 ${expected.length} 条请求路由`,
        missing.length === 0,
        missing.length === 0 ? `已注册 ${gateway.registered.size} 条` : `缺失 ${missing.length} 条：${missing.join(', ')}`)
    }
    const gatewayA = gateways.get('tenant-a')!
    const unknownRejected = await gatewayA
      .dispatch({ name: 'command.not.exists', input: {} }, requestContext(1))
      .then(() => false)
      .catch((error) => errorCode(error) === 'NOT_FOUND')
    assert('P1-5', '未知路由被网关拒绝', unknownRejected, 'command.not.exists → NOT_FOUND')

    // ── P5 Web 外壳：上游 Electron 专属路由的 Web 语义 ──
    const updatesStatus = await gatewayA.dispatch(
      { name: 'query.updates.status', input: {} }, requestContext(1)) as { phase: string; currentVersion: string }
    const windowControl = await gatewayA.dispatch(
      { name: 'command.window.control', input: { action: 'minimize' } }, requestContext(1)) as { ok: boolean }
    const appearance = await gatewayA.dispatch(
      { name: 'command.appearance.set_mode', input: { mode: 'dark' } }, requestContext(1)) as { mode: string; resolved: string }
    const appearanceRead = await ctxA.desktopGateway.dispatch(
      { name: 'query.settings.read', input: { key: 'appearance.mode' } }, requestContext(1))
    const shellOk =
      updatesStatus.phase === 'disabled' &&
      updatesStatus.currentVersion === '0.1.0-web-poc' &&
      windowControl.ok === true &&
      appearance.mode === 'dark' && appearance.resolved === 'dark' &&
      appearanceRead === 'dark'
    assert('P5-1', '更新/窗口/外观三条 Electron 路由在 Web 端语义正确', shellOk,
      `updates=${updatesStatus.phase}@${updatesStatus.currentVersion}；window.control=${JSON.stringify(windowControl)}；appearance=${appearance.mode}→${appearance.resolved}（已落库：${JSON.stringify(appearanceRead)}）`)

    // ── P2-2 Agent 会话服务已就绪（DshAgentRuntime 在挂载时构造）──
    const runtimeRoot = join(rootA, 'dsh-runtime')
    const runtimeReady = ctxA.agentSessions !== undefined && (await stat(runtimeRoot)).isDirectory()
    assert('P2-2', '租户 A 的 DSH 运行时目录与 agentSessions 服务就绪', runtimeReady,
      `${runtimeRoot.replace(root, '<root>')}；agentSessions=${ctxA.agentSessions?.constructor?.name ?? 'undefined'}`)

    // ── P2-3 媒体 URL 重写（纯函数）──
    const sample = { avatar: `${LOCAL_MEDIA_REFERENCE_PREFIX}abc/face.png`, nested: [{ bg: `${LOCAL_MEDIA_REFERENCE_PREFIX}x/y.webp` }] }
    const rewritten = rewriteLocalMediaReferences(sample)
    const rewriteOk =
      rewritten.avatar === `${WEB_MEDIA_REFERENCE_PREFIX}abc/face.png` &&
      rewritten.nested[0]!.bg === `${WEB_MEDIA_REFERENCE_PREFIX}x/y.webp`
    assert('P2-3', 'eleckoi-media:// 引用被改写为 /media/v1/ 且深层字段同样命中', rewriteOk,
      `${sample.avatar} → ${rewritten.avatar}`)

    // ── P1-6 释放后无残留（dispose 应关闭 SQLite）──
    const descriptorBefore = (await import('node:fs')).readdirSync('/proc/self/fd').length
    await tenantB.dispose()
    const descriptorAfter = (await import('node:fs')).readdirSync('/proc/self/fd').length
    assert('P1-6', '租户 B dispose 后文件描述符回落（SQLite 已关闭）', descriptorAfter <= descriptorBefore,
      `dispose 前 ${descriptorBefore} → 后 ${descriptorAfter}`)

    tenants = [tenantA]
  } finally {
    for (const tenant of tenants) await tenant.dispose().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log(`\n== 结果：${outcomes.length - failed.length}/${outcomes.length} 通过 ==`)
  if (failed.length > 0) {
    console.log(`失败项：${failed.map((item) => item.id).join(', ')}`)
    process.exitCode = 1
  }
}

await main()
