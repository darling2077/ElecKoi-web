/**
 * M1-P2b：完整 Agent 回合端到端验证（本地 mock 模型，不使用真实密钥）。
 *
 * 链路：command.models.save → models.active → conversations.create
 *       → command.agent.start → DSH 子进程 → mock 模型流式响应
 *       → agent.output.delta 事件 → agent.run.finished → SQLite 落库
 *
 * 运行：pnpm webui:agent
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { GatewayEventEnvelope } from '@shared/contracts/gateway/types'
import { WebHost } from '../WebHost'
import { startMockModelServer } from './mockModelServer'

type Outcome = { id: string; title: string; ok: boolean; detail: string }
const outcomes: Outcome[] = []

function record(id: string, title: string, ok: boolean, detail: string): void {
  outcomes.push({ id, title, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}  ${title}\n        ${detail}`)
}

const REQUEST_CONTEXT = { senderId: 1, windowId: undefined }

async function main(): Promise<void> {
  const masterKeyBase64 = randomBytes(32).toString('base64')
  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-agent-'))
  const mock = await startMockModelServer({ replyPrefix: '你好，我是 mock 模型的回复。', chunkDelayMs: 10 })
  console.log(`\n== ElecKoi WebUI · M1-P2b Agent 回合 ==\n租户数据：${root}\nmock 模型：${mock.url}\n`)

  const tenant = await WebHost.mountTenant({
    tenantId: 'tenant-agent',
    tenantRoot: join(root, 'tenant'),
    masterKeyBase64,
    appVersion: '0.1.0-web-m1'
  })

  const events: GatewayEventEnvelope[] = []
  const detach = tenant.gateway.attach({
    id: 1,
    send: (envelope) => {
      events.push(envelope)
      if (envelope.name === 'agent.process.updated') {
        const item = (envelope.payload as { item?: { kind?: string; title?: string } }).item
        console.log(`        · 过程项 ${item?.kind ?? '?'} ${item?.title ?? ''}`)
      }
    }
  })

  const dispatch = <T>(name: string, input: unknown): Promise<T> =>
    tenant.gateway.dispatch({ name, input }, REQUEST_CONTEXT) as Promise<T>

  try {
    // ── 1. 配置模型（指向 mock）──
    const configs = await dispatch<Array<{ id: string; name: string }>>('command.models.save', {
      name: 'Mock 模型',
      provider: 'custom',
      api_key: 'mock-key',
      base_url: mock.url,
      proxy_url: '',
      model: 'mock-model',
      model_options: [],
      custom_headers: {},
      supports_tools: null,
      enabled: true,
      image_settings: {},
      api_format: 'chat_completions'
    })
    // models.ensureDefault() 会先建一个默认配置，因此必须按名字取回我们自己写入的那个。
    const configId = configs.find((config) => config.name === 'Mock 模型')?.id
    record('P2b-1', '通过 command.models.save 写入 mock 模型配置', Boolean(configId),
      `config_id=${configId}，列表共 ${configs.length} 个：${configs.map((config) => config.name).join(', ')}`)

    await dispatch('command.settings.write', {
      key: 'models.active',
      value: {
        capability: 'chat',
        config_id: configId,
        model: 'mock-model'
      }
    })
    record('P2b-2', '激活该模型为当前 chat 模型', true, `models.active.config_id=${configId}`)

    // ── 2. 建角色并关联会话 ──
    // 上游的设定库提交路径要求会话带 characterId（SettingLibraryRepository.ts:171），
    // 因此不能测试「无角色会话」——那也不是真实使用场景。
    await dispatch('command.characters.create', {
      id: 'char-p2b',
      name: '测试角色',
      description: 'P2b 端到端测试用角色。',
      personality: '配合测试。',
      scenario: '本地 mock 环境。',
      firstMessage: '',
      chatBackground: ''
    })
    record('P2b-2b', '创建角色', true, 'characterId=char-p2b')

    const created = await dispatch<{ conversation: { id: string } }>('command.conversations.create', {
      title: 'P2b 测试会话',
      metadata: {
        characterId: 'char-p2b',
        characterName: '测试角色',
        characterAvatar: '',
        characterPersona: {}
      }
    })
    const conversationId = created.conversation?.id
    record('P2b-3', '创建并关联角色的会话', Boolean(conversationId), `conversationId=${conversationId}`)

    // ── 3. 发起 Agent 回合 ──
    const startedAt = Date.now()
    const started = await dispatch<{ runId: string; messageId: string }>('command.agent.start', {
      conversationId,
      // 上游 v0.1.5 起 requestId 必填（停止/重新生成链路按它匹配事件），格式与渲染层一致
      requestId: `p2b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: '你好，请自我介绍一下。'
    })
    record('P2b-4', 'command.agent.start 被接受', Boolean(started.runId),
      `runId=${started.runId}`)

    // ── 4. 等待回合结束 ──
    const finished = await waitFor(events, ['agent.run.finished', 'agent.run.failed'], 120_000)
    const isFinished = finished?.name === 'agent.run.finished'
    record('P2b-5', 'Agent 回合正常结束（非失败）', isFinished,
      isFinished
        ? `耗时 ${Date.now() - startedAt} ms`
        : `失败：${JSON.stringify((finished?.payload as { code?: string; message?: string }) ?? {})?.slice(0, 300)}`)

    // ── 5. 流式增量 ──
    const deltas = events.filter((event) => event.name === 'agent.output.delta')
    const streamed = deltas.map((event) => (event.payload as { delta: string }).delta).join('')
    const tagStripped = !streamed.includes('<FINAL>') && !streamed.includes('</FINAL>')
    record('P2b-6', '收到增量流式推送且 <FINAL> 标记已被剥离', deltas.length > 1 && tagStripped,
      `${deltas.length} 个增量，拼接 ${streamed.length} 字：${JSON.stringify(streamed.slice(0, 60))}`)

    // ── 6. 落库 ──
    const page = await dispatch<{ messages: Array<{ role: string; content: string }> }>('query.conversations.messages', {
      conversationId
    })
    const messages = page.messages ?? []
    const assistant = messages.filter((message) => message.role === 'assistant')
    const persisted = assistant.some((message) => message.content.includes('mock 模型的回复') && !message.content.includes('<FINAL>'))
    record('P2b-7', '回复已落库且可从 query.conversations.messages 读回', persisted,
      `共 ${messages.length} 条消息，assistant ${assistant.length} 条：${JSON.stringify(assistant[0]?.content?.slice(0, 60) ?? '')}`)

    record('P2b-8', 'mock 模型端点确实被调用', mock.requests.length > 0,
      `收到 ${mock.requests.length} 次请求（stream=${mock.requests[0]?.stream}，tools=${mock.requests[0]?.toolCount}，messages=${mock.requests[0]?.messageCount}）`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.log(`\n\u001b[31m流程中断\u001b[0m  ${detail}`)
    if (error && typeof error === 'object' && 'details' in error) {
      console.log(`        ${JSON.stringify((error as { details: unknown }).details).slice(0, 400)}`)
    }
    process.exitCode = 1
  } finally {
    detach()
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

async function waitFor(
  events: GatewayEventEnvelope[],
  names: string[],
  timeoutMs: number
): Promise<GatewayEventEnvelope | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = events.find((event) => names.includes(event.name))
    if (hit) return hit
    await new Promise((done) => setTimeout(done, 200))
  }
  return undefined
}

await main()
