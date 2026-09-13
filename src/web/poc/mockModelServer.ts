/**
 * 本地 mock 模型服务：实现 OpenAI `chat/completions` 的流式与非流式响应。
 *
 * 用途：在不使用真实密钥、不产生任何费用的前提下，验证完整 Agent 链路
 * （模型配置 → 会话 → command.agent.start → DSH 子进程 → 流式增量 → 落库）。
 *
 * 行为：对每个请求回一段固定文本，并把收到的请求记录数、是否带工具声明等
 * 观测信息暴露出来，便于断言「确实打到了模型端点」。
 */

import { createServer, type IncomingMessage } from 'node:http'

export interface MockModelOptions {
  /** 回复正文；会带上序号便于断言多次调用。 */
  replyPrefix?: string
  /** 每个流式分片之间的间隔（毫秒），用于观察增量推送。 */
  chunkDelayMs?: number
  /**
   * 逐次返回不同回复（按调用序）。给了它就以它为准，用来让同一个 mock
   * 依次吐出多条不同的正文（例如渲染回归的各个用例）。
   */
  replyText?: () => string
  /**
   * 是否按角色预设协议把正文包进 `<FINAL>…</FINAL>`。
   * 预设要求 Agent 只在最终正文上打这个标记，`DshReplyProjector` 会丢弃标记之前的
   * 过程叙述、只把标记内的内容作为正文流式下发。缺省 true，以便真实地检验流式链路。
   */
  wrapInFinalTag?: boolean
}

export interface MockModelHandle {
  readonly url: string
  readonly requests: Array<{ path: string; stream: boolean; toolCount: number; messageCount: number }>
  close(): Promise<void>
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function startMockModelServer(options: MockModelOptions = {}): Promise<MockModelHandle> {
  const prefix = options.replyPrefix ?? '你好，我是 mock 模型的回复。'
  const chunkDelayMs = options.chunkDelayMs ?? 15
  const requests: MockModelHandle['requests'] = []

  const server = createServer((req, res) => {
    void (async () => {
      const path = req.url ?? '/'
      if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock 模型未实现该路由：${path}` } }))
        return
      }

      const body = await readJson(req)
      const stream = body.stream === true
      const messages = Array.isArray(body.messages) ? body.messages : []
      const tools = Array.isArray(body.tools) ? body.tools : []
      requests.push({ path, stream, toolCount: tools.length, messageCount: messages.length })

      // replyText 优先：让调用方按调用序决定每一次回复的正文。
      const body2 = options.replyText !== undefined
        ? options.replyText()
        : `${prefix}（第 ${requests.length} 次调用）`
      // 按预设协议：标记之前是过程叙述（会被投影器丢弃），标记之内才是最终正文。
      const text = options.wrapInFinalTag === false ? body2 : `（先想一想）\n<FINAL>${body2}</FINAL>`
      const id = `chatcmpl-mock-${requests.length}`

      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        }))
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model ?? 'mock-model' }
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      // 按字符切片推送，模拟真实流式增量。
      //
      // 切片必须带上换行：`.{1,4}` 里的 `.` **不匹配换行符**，用它切会把所有换行丢掉，
      // 于是多行正文（尤其是围栏代码块）被压成一行——那会让渲染验收得出错误的结论
      // （围栏变成行内代码）。用 [\s\S] 匹配任意字符，换行才会原样进入流。
      for (const piece of text.match(/[\s\S]{1,4}/gu) ?? [text]) {
        send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
        await new Promise((done) => setTimeout(done, chunkDelayMs))
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
      res.write('data: [DONE]\n\n')
      res.end()
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(error) } }))
    })
  })

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock 模型服务未能取得端口。')

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      await new Promise<void>((done) => server.close(() => done()))
    }
  }
}
