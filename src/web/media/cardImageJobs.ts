/**
 * 「导入卡片时搬运图片」的进度状态。
 *
 * 为什么需要它：搬图要花时间（一张卡几百张图就是几分钟），而**卡在那之前已经进库了**。
 * 如果界面上不给出任何反馈，用户会以为导入完成了、直接进去聊天——此时引用还没改完，
 * 就会看到一会儿黑图、一会儿好，正是最容易被当成 bug 的中间态。
 *
 * 做法：状态挂在**网关实例**上（WeakMap），HTTP 层拿到的正好是同一个实例（绑定在会话上），
 * 因此不需要在层与层之间传递租户 id，也不会在租户回收后留下垃圾。
 */

export interface CardImageJobState {
  /** 是否正在搬运。 */
  active: boolean
  /** 正在处理的阶段：扫描、搬运、收尾。 */
  phase: 'idle' | 'scanning' | 'working' | 'done'
  /** 已处理张数与总张数（扫描完成前 total 为 0）。 */
  done: number
  total: number
  /** 上一次结束时的结果，供界面在完成后短暂展示。 */
  lastLocalized?: number
  lastFailed?: number
  lastDeferred?: number
  startedAt?: number
  finishedAt?: number
}

const IDLE: CardImageJobState = { active: false, phase: 'idle', done: 0, total: 0 }

const states = new WeakMap<object, CardImageJobState>()

export function beginCardImageJob(gateway: object): void {
  states.set(gateway, { active: true, phase: 'scanning', done: 0, total: 0, startedAt: Date.now() })
}

export function updateCardImageJob(gateway: object, progress: { phase: 'working'; done: number; total: number }): void {
  const current = states.get(gateway)
  states.set(gateway, {
    ...(current ?? IDLE),
    active: true,
    phase: progress.phase,
    done: progress.done,
    total: progress.total
  })
}

export function finishCardImageJob(
  gateway: object,
  result: { localized: number; urlsLocalized: number; failed: number; deferred: number }
): void {
  states.set(gateway, {
    active: false,
    phase: 'done',
    done: result.urlsLocalized,
    total: result.urlsLocalized,
    lastLocalized: result.urlsLocalized,
    lastFailed: result.failed,
    lastDeferred: result.deferred,
    finishedAt: Date.now()
  })
}

/** 搬运过程中出错也要复位，否则进度条会一直挂在界面上。 */
export function abortCardImageJob(gateway: object): void {
  const current = states.get(gateway)
  states.set(gateway, { ...(current ?? IDLE), active: false, phase: 'done', finishedAt: Date.now() })
}

export function readCardImageJob(gateway: object): CardImageJobState {
  return states.get(gateway) ?? IDLE
}
