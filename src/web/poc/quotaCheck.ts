/**
 * M3 验收（续）：并发回合配额。
 *
 * 为什么这条重要：一个 Agent 回合会拉起一个独立 node 子进程（DSH runtime）。
 * 没有上限时，单个用户开多个会话就能把整台机器拖垮。
 *
 * 验证走真实链路：慢速 mock 模型制造并发窗口 → 第二个回合必须被拒 →
 * 第一个结束后必须重新放行。另外单测兜底释放（事件丢失时不能把用户永久锁死）。
 *
 * 运行：pnpm webui:quota
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { GatewayEventEnvelope } from '@shared/contracts/gateway/types'
import { WebHost } from '../WebHost'
import { QuotaService } from '../control/QuotaService'
import { startMockModelServer } from './mockModelServer'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

const REQUEST_CONTEXT = { senderId: 1, windowId: undefined }
const PNG_FREE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
void PNG_FREE

/** 单测兜底：事件丢失时，超时名额必须被回收。 */
function checkSweep(): void {
  let clock = 0
  const quota = new QuotaService({ maxConcurrentRuns: 1, runTimeoutMs: 1000, now: () => clock })
  quota.begin('u1', 'c1')
  let rejected = false
  try {
    quota.begin('u1', 'c2')
  } catch {
    rejected = true
  }
  clock = 2000 // 越过超时窗口
  let allowedAfterTimeout = false
  try {
    quota.begin('u1', 'c3')
    allowedAfterTimeout = true
  } catch {
    allowedAfterTimeout = false
  }
  record('Q-1', rejected && allowedAfterTimeout && quota.activeRuns('u1') === 1,
    `超时前第二个回合被拒=${rejected}；超时后放行=${allowedAfterTimeout}；当前占用 ${quota.activeRuns('u1')}`)

  // 同一会话重复开始不应重复占位
  const quota2 = new QuotaService({ maxConcurrentRuns: 2 })
  quota2.begin('u1', 'c1')
  quota2.begin('u1', 'c1')
  record('Q-2', quota2.activeRuns('u1') === 1, `同一会话重复 begin 后占用仍为 ${quota2.activeRuns('u1')}`)

  quota2.end('u1', 'c1')
  record('Q-3', quota2.activeRuns('u1') === 0, `end 后占用 ${quota2.activeRuns('u1')}`)
}

async function main(): Promise<void> {
  checkSweep()

  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-quota-'))
  // 慢速回复：每个分片间隔 600ms，制造足够宽的并发窗口。
  const mock = await startMockModelServer({ chunkDelayMs: 600 })
  const quota = new QuotaService({ maxConcurrentRuns: 1 })
  const tenant = await WebHost.mountTenant({
    tenantId: 'tenant-quota',
    tenantRoot: join(root, 'tenant'),
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-quota',
    runQuota: {
      begin: (conversationId) => quota.begin('user-1', conversationId),
      end: (conversationId) => quota.end('user-1', conversationId)
    }
  })

  const events: GatewayEventEnvelope[] = []
  tenant.gateway.attach({ id: 1, send: (envelope) => events.push(envelope) })
  const dispatch = <T>(name: string, input: unknown): Promise<T> =>
    tenant.gateway.dispatch({ name, input }, REQUEST_CONTEXT) as Promise<T>

  console.log(`\n== ElecKoi WebUI · 并发配额验收 ==\n租户数据：${root}\nmock 模型：${mock.url}\n`)

  try {
    const configs = await dispatch<Array<{ id: string; name: string }>>('command.models.save', {
      name: 'Mock 模型', provider: 'custom', api_key: 'mock-key', base_url: mock.url,
      proxy_url: '', model: 'mock-model', model_options: [], custom_headers: {},
      supports_tools: null, enabled: true, image_settings: {}, api_format: 'chat_completions'
    })
    const configId = configs.find((config) => config.name === 'Mock 模型')?.id
    await dispatch('command.settings.write', {
      key: 'models.active',
      value: { capability: 'chat', config_id: configId, model: 'mock-model' }
    })
    await dispatch('command.characters.create', {
      id: 'char-quota', name: '测试角色', description: '', personality: '', scenario: '', firstMessage: '', chatBackground: ''
    })
    const metadata = { characterId: 'char-quota', characterName: '测试角色', characterAvatar: '', characterPersona: {} }
    const conversationA = (await dispatch<{ conversation: { id: string } }>('command.conversations.create', { title: 'A', metadata })).conversation.id
    const conversationB = (await dispatch<{ conversation: { id: string } }>('command.conversations.create', { title: 'B', metadata })).conversation.id

    // 第一个回合占住名额
    const first = await dispatch<{ runId: string }>('command.agent.start', { conversationId: conversationA, requestId: `quota-a-${Date.now()}`, text: '第一条' })
    record('Q-4', Boolean(first.runId), `会话 A 的回合已接受（runId=${first.runId}），当前占用 ${quota.activeRuns('user-1')}`)

    // 第二个回合必须被拒
    let rejectedMessage = ''
    try {
      await dispatch('command.agent.start', { conversationId: conversationB, requestId: `quota-b1-${Date.now()}`, text: '第二条' })
    } catch (error) {
      rejectedMessage = error instanceof Error ? error.message : String(error)
    }
    record('Q-5', rejectedMessage.includes('上限'),
      `会话 B 的并发的回合被拒：${rejectedMessage || '(未被拒绝！)'}`)

    // 等 A 结束
    const settled = await waitFor(events, ['agent.run.finished', 'agent.run.failed'], 90_000)
    record('Q-6', settled.event?.name === 'agent.run.finished' && quota.activeRuns('user-1') === 0,
      `A 回合结束（${settled.event?.name}），名额已释放，当前占用 ${quota.activeRuns('user-1')}`)

    // 现在 B 应该能开始
    const second = await dispatch<{ runId: string }>('command.agent.start', { conversationId: conversationB, requestId: `quota-b2-${Date.now()}`, text: '第三条' })
    record('Q-7', Boolean(second.runId), `释放后会话 B 的回合被接受（runId=${second.runId}）`)
    await waitFor(events, ['agent.run.finished', 'agent.run.failed'], 90_000, settled.index)
    await tenant.dispose()
  } catch (error) {
    record('Q-8', false, `流程中断：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await tenant.dispose().catch(() => undefined)
    await mock.close()
    await rm(root, { recursive: true, force: true })
  }

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log(`\n== 结果：${outcomes.length - failed.length}/${outcomes.length} 通过 ==`)
  if (failed.length > 0) {
    console.log(`失败项：${failed.map((item) => item.id).join(', ')}`)
    process.exitCode = 1
  }
}

/** 只匹配 fromIndex 之后的事件，否则会立刻命中上一轮的旧事件。 */
async function waitFor(
  events: GatewayEventEnvelope[],
  names: string[],
  timeoutMs: number,
  fromIndex = 0
): Promise<{ event: GatewayEventEnvelope | undefined; index: number }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const index = events.findIndex((event, position) => position >= fromIndex && names.includes(event.name))
    if (index >= 0) return { event: events[index], index: index + 1 }
    await new Promise((done) => setTimeout(done, 200))
  }
  return { event: undefined, index: events.length }
}

await main()
