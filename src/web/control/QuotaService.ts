/**
 * 配额：每个用户同时进行的 Agent 回合数上限。
 *
 * 为什么这条最重要：一个 Agent 回合会拉起一个独立 node 子进程（DSH runtime），
 * 常驻数十至上百 MB。没有上限时，单个用户开多个会话就能把整台机器拖垮。
 *
 * 计数口径：
 *  - 在 `command.agent.start` / `command.agent.regenerate` 被接受时占用一个名额；
 *  - 回合以 `agent.run.finished` / `agent.run.failed` 结束（或用户取消）时释放；
 *  - 另有一条兜底：超过 runTimeoutMs 仍未结束的名额强制释放，
 *    避免事件丢失导致名额永久泄漏（宁可短暂放宽，也不能把用户锁死）。
 */

export class QuotaError extends Error {
  constructor(readonly code: 'TOO_MANY_RUNS', message: string) {
    super(message)
    this.name = 'QuotaError'
  }
}

interface RunSlot {
  conversationId: string
  startedAt: number
}

export interface QuotaServiceOptions {
  /** 每用户同时进行的回合上限，缺省 2。 */
  maxConcurrentRuns?: number
  /** 单回合最长占用时间，超过则强制释放名额，缺省 30 分钟。 */
  runTimeoutMs?: number
  now?: () => number
}

export class QuotaService {
  private readonly maxConcurrentRuns: number
  private readonly runTimeoutMs: number
  private readonly now: () => number
  private readonly runs = new Map<string, RunSlot[]>()

  constructor(options: QuotaServiceOptions = {}) {
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 2
    this.runTimeoutMs = options.runTimeoutMs ?? 30 * 60 * 1000
    this.now = options.now ?? Date.now
  }

  /** 占用一个回合名额；超限抛 QuotaError。 */
  begin(userId: string, conversationId: string): void {
    const slots = this.sweep(userId)
    // 同一会话重复开始不算新增（上游本身也会拒绝并发回合）。
    if (slots.some((slot) => slot.conversationId === conversationId)) return
    if (slots.length >= this.maxConcurrentRuns) {
      throw new QuotaError('TOO_MANY_RUNS', `同时进行的回复已达上限（${this.maxConcurrentRuns} 个），请等其中一个结束后再试。`)
    }
    slots.push({ conversationId, startedAt: this.now() })
  }

  /** 回合结束，释放名额。 */
  end(userId: string, conversationId: string): void {
    const slots = this.sweep(userId)
    const index = slots.findIndex((slot) => slot.conversationId === conversationId)
    if (index >= 0) slots.splice(index, 1)
    if (slots.length === 0) this.runs.delete(userId)
  }

  activeRuns(userId: string): number {
    return this.sweep(userId).length
  }

  /**
   * 清理超时名额并返回剩余的槽位。
   *
   * 注意必须把结果写回 map：调用方（begin）会直接往返回的数组里 push，
   * 若此处返回的是游离数组，push 的槽位不会进入 map，配额就形同虚设。
   */
  private sweep(userId: string): RunSlot[] {
    const slots = this.runs.get(userId) ?? []
    const deadline = this.now() - this.runTimeoutMs
    const alive = slots.filter((slot) => slot.startedAt > deadline)
    this.runs.set(userId, alive)
    return alive
  }

  snapshot(): Array<{ userId: string; active: number }> {
    return [...this.runs.keys()].map((userId) => ({ userId, active: this.activeRuns(userId) }))
  }
}
