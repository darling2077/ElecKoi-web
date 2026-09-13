/**
 * 租户注册表：把「一个用户 = 一棵 cordis Context + 一个数据目录」的生命周期管起来。
 *
 * 关键设计：
 *  - **懒加载**：首次访问才挂载，避免重启后为所有历史用户建上下文。
 *  - **引用计数**：一个用户的多个标签页共享同一租户实例，全部断开后才开始计时回收。
 *  - **空闲回收**：超过 idleMs 无引用即 dispose，释放 SQLite 句柄与 DSH 子进程。
 *  - **挂载去重**：并发请求同时触发挂载时只挂一次（inFlight 表）。
 *  - **上限保护**：活跃租户超过 maxLive 时按 lastActive 淘汰最久未用的空闲租户。
 *
 * 注意：租户身份只能来自服务端解析出的 userId，绝不接受客户端传入的 tenantId。
 */

import { join } from 'node:path'
import { WebHost, type TenantRuntime } from './WebHost'
import type { RunQuota } from './transport/WebGateway'

interface Entry {
  runtime: TenantRuntime
  refCount: number
  lastActiveAt: number
  reaping: ReturnType<typeof setTimeout> | undefined
}

export interface TenantRegistryOptions {
  dataRoot: string
  masterKeyBase64: string
  appVersion: string
  /** 无引用后多久回收，缺省 30 分钟。 */
  idleMs?: number
  /** 同时存活的租户上限，缺省 50。 */
  maxLive?: number
  /** 按用户生成回合名额控制器；缺省不限制。 */
  runQuotaFor?: (userId: string) => RunQuota
  log?: (message: string) => void
}

export interface TenantLease {
  runtime: TenantRuntime
  release(): void
}

export class TenantRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly inFlight = new Map<string, Promise<TenantRuntime>>()
  private readonly idleMs: number
  private readonly maxLive: number
  private closed = false

  constructor(private readonly options: TenantRegistryOptions) {
    this.idleMs = options.idleMs ?? 30 * 60 * 1000
    this.maxLive = options.maxLive ?? 50
  }

  async acquire(userId: string, tenantId: string): Promise<TenantLease> {
    if (this.closed) throw new Error('租户注册表已关闭。')
    const runtime = await this.getOrMount(userId, tenantId)
    const entry = this.entries.get(userId)
    if (entry === undefined) throw new Error('租户实例在获取后被回收。')
    entry.refCount += 1
    entry.lastActiveAt = Date.now()
    if (entry.reaping !== undefined) {
      clearTimeout(entry.reaping)
      entry.reaping = undefined
    }
    let released = false
    return {
      runtime,
      release: () => {
        if (released) return
        released = true
        this.release(userId)
      }
    }
  }

  private async getOrMount(userId: string, tenantId: string): Promise<TenantRuntime> {
    const existing = this.entries.get(userId)
    if (existing !== undefined) return existing.runtime

    const pending = this.inFlight.get(userId)
    if (pending !== undefined) return pending

    const mounting = (async () => {
      await this.enforceLimit()
      const runtime = await WebHost.mountTenant({
        tenantId,
        tenantRoot: join(this.options.dataRoot, 'tenants', tenantId),
        masterKeyBase64: this.options.masterKeyBase64,
        appVersion: this.options.appVersion,
        ...(this.options.runQuotaFor === undefined ? {} : { runQuota: this.options.runQuotaFor(userId) })
      })
      if (this.closed) {
        await runtime.dispose()
        throw new Error('租户注册表已关闭。')
      }
      this.entries.set(userId, { runtime, refCount: 0, lastActiveAt: Date.now(), reaping: undefined })
      this.options.log?.(`租户已挂载：${tenantId}`)
      return runtime
    })()

    this.inFlight.set(userId, mounting)
    try {
      return await mounting
    } finally {
      this.inFlight.delete(userId)
    }
  }

  private release(userId: string): void {
    const entry = this.entries.get(userId)
    if (entry === undefined) return
    entry.refCount = Math.max(0, entry.refCount - 1)
    entry.lastActiveAt = Date.now()
    if (entry.refCount > 0 || this.closed) return
    entry.reaping = setTimeout(() => {
      void this.reap(userId)
    }, this.idleMs)
    // 回收定时器不应阻止进程退出
    entry.reaping.unref?.()
  }

  /** 空闲且无引用的租户可以回收；活跃租户永不回收。 */
  private async reap(userId: string): Promise<void> {
    const entry = this.entries.get(userId)
    if (entry === undefined || entry.refCount > 0) return
    if (Date.now() - entry.lastActiveAt < this.idleMs) return
    this.entries.delete(userId)
    this.options.log?.(`空闲回收租户：${entry.runtime.tenantId}`)
    await entry.runtime.dispose().catch(() => undefined)
  }

  /** 超过上限时淘汰最久未用的空闲租户；全都在用则拒绝新租户。 */
  private async enforceLimit(): Promise<void> {
    if (this.entries.size < this.maxLive) return
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => entry.refCount === 0)
      .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt)
    while (this.entries.size >= this.maxLive && idle.length > 0) {
      const [userId, entry] = idle.shift()!
      this.entries.delete(userId)
      if (entry.reaping !== undefined) clearTimeout(entry.reaping)
      this.options.log?.(`超出上限淘汰租户：${entry.runtime.tenantId}`)
      await entry.runtime.dispose().catch(() => undefined)
    }
    if (this.entries.size >= this.maxLive) {
      throw new Error('服务端活跃用户已达上限，请稍后再试。')
    }
  }

  stats(): { live: number; mounting: number; busy: number } {
    const list = [...this.entries.values()]
    return {
      live: list.length,
      mounting: this.inFlight.size,
      busy: list.filter((entry) => entry.refCount > 0).length
    }
  }

  /** 优雅关闭：取消全部回收定时器并释放所有租户。 */
  async close(): Promise<void> {
    this.closed = true
    const runtimes = [...this.entries.values()]
    this.entries.clear()
    for (const entry of runtimes) {
      if (entry.reaping !== undefined) clearTimeout(entry.reaping)
    }
    await Promise.all(runtimes.map((entry) => entry.runtime.dispose().catch(() => undefined)))
  }
}
