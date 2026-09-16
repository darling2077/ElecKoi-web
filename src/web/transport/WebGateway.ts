/**
 * Web 传输网关。
 *
 * 复用上游 DesktopGateway 的 register / dispatch（含契约的 zod 双向校验），
 * 只把「Electron 语义」的部分覆盖掉：
 *   - broadcast() : 上游遍历 BrowserWindow；Web 端推给本租户的所有 WS 连接
 *   - dispose()   : 关闭连接后交回父类清理 handlers
 *
 * 刻意不覆盖：
 *   - start() : 上游走 ipcMain.handle，在 electron 替身下是空操作；HTTP/WS 层直接调 dispatch
 *   - send()  : 上游签名绑定 WebContents；实测上游模块从未调用 gateway.send，故不覆盖
 *
 * 另外承担媒体 URL 前缀重写：上游产出 `eleckoi-media://asset/v1/...`，
 * 浏览器无法解析，这里在出站结果上改写为 `/media/v1/...`（方案 §5.3 做法 A）。
 */

import type {
  EventPayload,
  GatewayEventEnvelope,
  GatewayRequestEnvelope,
  RequestContext
} from '@shared/contracts/gateway/types'
import type { EventName } from '@shared/contracts/gateway/definitions'
import { DesktopGateway } from '@main/gateway/DesktopGateway'
import {
  abortCardImageJob,
  beginCardImageJob,
  finishCardImageJob,
  updateCardImageJob
} from '../media/cardImageJobs'

export const LOCAL_MEDIA_REFERENCE_PREFIX = 'eleckoi-media://asset/v1/'
export const WEB_MEDIA_REFERENCE_PREFIX = '/media/v1/'

export interface WebConnection {
  /** 稳定连接标识，作为 RequestContext.senderId 传给上游（上游仅用作限流键）。 */
  readonly id: number
  send(envelope: GatewayEventEnvelope): void
}

/** 会占用一个 Agent 回合名额的路由。 */
const RUN_START_ROUTES = new Set(['command.agent.start', 'command.agent.regenerate'])
/** 回合结束后释放名额的事件。 */
const RUN_SETTLE_EVENTS = new Set(['agent.run.finished', 'agent.run.failed'])

export interface RunQuota {
  begin(conversationId: string): void
  end(conversationId: string): void
}

/** 导入角色卡后自动搬运卡片图片的钩子（由 WebHost 在挂载租户时注入）。 */
export interface ImportImageHook {
  localizeCharacters(
    characterIds: readonly string[],
    onProgress?: (progress: { phase: 'working'; done: number; total: number }) => void
  ): Promise<{
    localized: number
    urlsLocalized: number
    skipped: number
    failed: number
    deferred: number
  }>
  waitForIdle(): Promise<void>
}

/** 导入提交这条路由：它的返回值里带着刚导入的角色 id。 */
const IMPORT_COMMIT = 'command.characters.import.commit'

export class WebGateway extends DesktopGateway {
  private readonly connections = new Set<WebConnection>()
  /** 媒体 URL 重写开关：默认开启，保留开关便于对照实验。 */
  rewriteMediaUrls = true
  /**
   * 媒体签名器。跨源卡片帧不携带会话 Cookie，需要签名 URL 才能取到媒体。
   * 未设置时只做前缀重写（同源、靠会话鉴权的场景）。
   */
  mediaSigner: { sign(webPath: string): string } | undefined
  /**
   * 回合名额。一个回合会拉起一个 node 子进程，因此必须在**进入处理器之前**占位，
   * 超限的请求根本不应该被执行。
   */
  runQuota: RunQuota | undefined
  /**
   * 导入后的图片搬运钩子。设置后，`command.characters.import.commit` 返回前会
   * 把新卡里的外链图片搬到自己的图床并改写引用——导入这一步就把事情做完，
   * 用户不需要再去跑外部脚本。
   */
  importImageHook: ImportImageHook | undefined
  /**
   * 搬运时机：
   *  - `background`（默认）：导入立刻返回，搬运在后台继续，完成后广播刷新。
   *    几百张图的大卡必须走这个——阻塞住导入请求会被反向代理掐断（504）。
   *  - `inline`：等搬运完再返回。小卡（一两张图）这样最直观。
   */
  importImageMode: 'background' | 'inline' = 'background'
  /** 搬运完成后的通知（用于让前端刷新被改写的模块）。 */
  onImagesLocalized: ((modules: readonly string[]) => void) | undefined

  attach(connection: WebConnection): () => void {
    this.connections.add(connection)
    return () => {
      this.connections.delete(connection)
    }
  }

  connectionCount(): number {
    return this.connections.size
  }

  override broadcast<TName extends EventName>(name: TName, payload: EventPayload<TName>): void {
    if (RUN_SETTLE_EVENTS.has(name)) {
      const conversationId = (payload as { conversationId?: unknown }).conversationId
      if (typeof conversationId === 'string') this.runQuota?.end(conversationId)
    }
    const envelope: GatewayEventEnvelope = { name, payload }
    for (const connection of this.connections) connection.send(envelope)
  }

  override async dispatch(envelope: GatewayRequestEnvelope, context: RequestContext): Promise<unknown> {
    const holdsSlot = RUN_START_ROUTES.has(envelope.name) && this.runQuota !== undefined
    const conversationId = holdsSlot
      ? (envelope.input as { conversationId?: unknown } | null | undefined)?.conversationId
      : undefined
    const slot = holdsSlot && typeof conversationId === 'string' ? conversationId : undefined
    if (slot !== undefined) this.runQuota!.begin(slot)
    let result: unknown
    try {
      // 入站先把下发给渲染层的媒体 URL 还原成上游认识的规范引用，
      // 否则「读出来再存回去」会丢失引用并删掉媒体文件。
      result = await super.dispatch({
        name: envelope.name,
        input: restoreMediaReferencesDeep(envelope.input)
      }, context)
    } catch (error) {
      // 请求没被接受就不该占着名额（例如契约校验失败）。
      if (slot !== undefined) this.runQuota!.end(slot)
      throw error
    }
    // 导入完成即搬运卡片图片。放在这里（而不是上游的导入代码里）有两个好处：
    // 不改上游文件，且浏览器与批量工具走的是同一条 dispatch，行为完全一致。
    if (envelope.name === IMPORT_COMMIT && this.importImageHook !== undefined) {
      if (this.importImageMode === 'inline') await this.localizeImportedImages(result)
      else void this.localizeImportedImages(result)
    }
    if (!this.rewriteMediaUrls) return result
    return rewriteLocalMediaReferences(result, this.mediaSigner === undefined ? undefined : this.mediaSigner.sign)
  }

  /**
   * 把刚导入的角色卡里的外链图片搬到自己的图床。
   *
   * **失败不能让导入失败**：卡已经进库了，图片搬不动只是显示不出来，
   * 所以这里吞掉异常并记日志——用户可以稍后用外部脚本重跑（它是幂等的）。
   */
  private async localizeImportedImages(result: unknown): Promise<void> {
    const ids = (result as { importedCharacterIds?: unknown } | null | undefined)?.importedCharacterIds
    if (!Array.isArray(ids) || ids.length === 0) return
    beginCardImageJob(this)
    try {
      const outcome = await this.importImageHook!.localizeCharacters(
        ids.filter((id): id is string => typeof id === 'string'),
        (progress) => updateCardImageJob(this, progress)
      )
      finishCardImageJob(this, outcome)
      if (outcome.localized > 0) this.onImagesLocalized?.(['personas', 'variables', 'regexRules', 'settingLibraries'])
    } catch (error) {
      // 出错也要复位进度状态，否则界面上的进度条会一直挂着。
      abortCardImageJob(this)
      console.error(`[card-images] 导入后搬运图片失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  override dispose(): void {
    this.connections.clear()
    super.dispose()
  }
}

/**
 * 把出站数据里的 `eleckoi-media://asset/v1/...` 改写为 `/media/v1/...`。
 *
 * 走 JSON 往返是因为上游 dispatch 的返回值已经过 zod 解析，一定是纯 JSON 数据；
 * 这样不必关心媒体引用藏在哪个字段层级。代价是每条请求多一次序列化，
 * M1 若成为热点可改为按契约标注的定点改写。
 *
 * 提供 sign 时进一步把每个媒体路径替换为带签名与有效期的 URL——
 * 这是跨源卡片帧能够取到媒体的前提（帧内没有应用源的会话 Cookie）。
 */
export function rewriteLocalMediaReferences<T>(value: T, sign?: (webPath: string) => string): T {
  if (value === null || value === undefined) return value
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return value
  if (!serialized.includes(LOCAL_MEDIA_REFERENCE_PREFIX)) return value
  const rewritten = serialized.replaceAll(LOCAL_MEDIA_REFERENCE_PREFIX, WEB_MEDIA_REFERENCE_PREFIX)
  const signed = sign === undefined ? rewritten : rewritten.replace(MEDIA_PATH_PATTERN, (match) => sign(match))
  return JSON.parse(signed) as T
}

/** 匹配 JSON 串里出现的 `/media/v1/<ownerHash>/<slot>/<fileName>`。 */
const MEDIA_PATH_PATTERN = /\/media\/v1\/[A-Za-z0-9._/-]+/g

/**
 * 完整匹配一个媒体 URL（可带签名查询串与源前缀）。
 *
 * 渲染层会把网关下发的值**原样回存**：用户在头像编辑器里点保存时，
 * `command.persona.save` 收到的是 `/media/v1/…?t=…&exp=…&sig=…`。
 * 而上游 `LocalMediaStore.prepareImage` 只认 `eleckoi-media://asset/v1/` 前缀，
 * 认不出就按"未知值"处理——fileName 记为空，commit 时**把该槽位下的文件全部删掉**。
 * 所以入站必须先还原成规范引用。
 */
const WEB_MEDIA_URL = /^(?:https?:\/\/[^/]+)?\/media\/v1\/([A-Za-z0-9._/-]+)(?:\?[^?]*)?$/

export function restoreMediaReference(value: string): string {
  const match = WEB_MEDIA_URL.exec(value)
  const resourcePath = match?.[1]
  return resourcePath === undefined ? value : `${LOCAL_MEDIA_REFERENCE_PREFIX}${resourcePath}`
}

/** 深度还原入参里的媒体引用；只处理「整串就是一个媒体 URL」的情况，避免误伤正文。 */
export function restoreMediaReferencesDeep<T>(value: T): T {
  if (typeof value === 'string') return restoreMediaReference(value) as unknown as T
  if (Array.isArray(value)) return value.map((item) => restoreMediaReferencesDeep(item)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = restoreMediaReferencesDeep(item)
    }
    return result as T
  }
  return value
}
