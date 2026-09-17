import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DshRuntime } from '@eleckoi/dsh-runtime'
import { describe, expect, it, vi } from 'vitest'

describe('packaged DSH runtime composition', () => {
  it('disposes one conversation session and clears its in-memory trajectory state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eleckoi-dsh-dispose-'))
    const runtime = new DshRuntime({
      configPath: resolve('resources/dsh/cordis.yml'),
      presetTemplatePath: resolve('resources/dsh/agent-preset-template/agent.cordis.yml'),
      workspaceRoot: join(root, 'workspace'),
      runtimeDataRoot: join(root, 'runtime'),
      executablePath: process.execPath
    })
    const request = vi.fn(async () => ({}))
    const internals = runtime as unknown as {
      harness: { client: { request: typeof request }; close(): Promise<void> } | undefined
      conversationSessions: Map<string, string>
      activeRuns: Map<string, { cancelled: boolean }>
      trajectoryEvents: Map<string, unknown[]>
      generationStatsProjectors: Map<string, unknown>
    }
    internals.harness = { client: { request }, close: async () => undefined }
    internals.conversationSessions.set('target', 'thread-a')
    internals.trajectoryEvents.set('target\u0000thread-a', [{}])
    internals.trajectoryEvents.set('other\u0000thread-b', [{}])
    internals.generationStatsProjectors.set('target\u0000thread-a', {})
    internals.generationStatsProjectors.set('other\u0000thread-b', {})
    const targetRoot = join(root, 'runtime', 'sessions', 'target')
    const threadRoot = join(targetRoot, 'project-a', 'thread-a')
    const snapshotPath = join(root, 'runtime', 'session-snapshots', 'thread-a.json')
    await mkdir(threadRoot, { recursive: true })
    await writeFile(join(threadRoot, 'session.jsonl'), '{"type":"session","id":"thread-a"}\n')
    await writeFile(snapshotPath, '{"runtimeThreadId":"thread-a"}')

    try {
      await runtime.disposeConversation('target')

      expect(request).toHaveBeenCalledWith('session/dispose', { sessionId: 'thread-a' })
      expect(internals.conversationSessions.has('target')).toBe(false)
      expect(internals.activeRuns.has('target')).toBe(false)
      expect([...internals.trajectoryEvents.keys()]).toEqual(['other\u0000thread-b'])
      expect([...internals.generationStatsProjectors.keys()]).toEqual(['other\u0000thread-b'])
      await expect(readdir(targetRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('boots the real Cordis plugin tree and completes the JSON-RPC handshake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eleckoi-dsh-runtime-'))
    const runtime = new DshRuntime({
      configPath: resolve('resources/dsh/cordis.yml'),
      presetTemplatePath: resolve('resources/dsh/agent-preset-template/agent.cordis.yml'),
      workspaceRoot: join(root, 'workspace'),
      runtimeDataRoot: join(root, 'runtime'),
      executablePath: process.execPath
    })

    try {
      await expect(runtime.verify()).resolves.toBeUndefined()
    } finally {
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('streams a real Agent reply through the packaged runtime and a local DeepSeek endpoint', async () => {
    const requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = []
    const server = createServer(async (request, response) => {
      let rawBody = ''
      for await (const chunk of request) rawBody += chunk.toString()
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(rawBody) as Record<string, unknown>
      })
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      })
      const base = {
        id: 'chatcmpl-local-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'deepseek-chat'
      }
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '本地 Agent 回复' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Local test server did not expose a TCP port')

    const root = await mkdtemp(join(tmpdir(), 'eleckoi-dsh-conversation-'))
    const runtime = new DshRuntime({
      configPath: resolve('resources/dsh/cordis.yml'),
      presetTemplatePath: resolve('resources/dsh/agent-preset-template/agent.cordis.yml'),
      workspaceRoot: join(root, 'workspace'),
      runtimeDataRoot: join(root, 'runtime'),
      executablePath: process.execPath,
      modelCatalog: () => [{
        configId: 'enabled-google-config',
        apiKey: 'google-test-key',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'models/gemini-3.6-flash',
        systemPrompt: '',
        apiFormat: 'google-generative-ai',
        customHeaders: {},
        contextWindow: 1_048_576,
        supportsImageInput: true
      }]
    })
    const deltas: string[] = []
    const finals: string[] = []

    try {
      await expect(runtime.stream('conversation-local-test', '你好', {
        configId: 'local-test-config',
        apiKey: 'local-test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: 'deepseek-chat',
        systemPrompt: '只返回本地测试文本。',
        apiFormat: 'openai-completions',
        customHeaders: {},
        contextWindow: 128000,
        autoCompactTokenLimit: 96000,
        temperature: 0.65,
        supportsImageInput: false
      }, {
        onDelta: (delta) => deltas.push(delta),
        onFinal: (content) => finals.push(content)
      }, {
        initialStateJson: '{}',
        schemaCode: '',
        objects: [],
        variables: [],
        stateJson: '{}'
      }, {
        characterId: 'card-a',
        characterName: '角色 A',
        persona: {},
        history: [
          { role: 'assistant', content: '你好啊', speakerName: '角色 A' }
        ],
        settingLibrary: {
          characterId: 'card-a',
          name: '设定库',
          entries: [],
          groups: [],
          promptPositions: []
        }
      }, 'runtime-thread-a', {
        disabledGroupIds: ['builtin:variables', 'builtin:other']
      })).resolves.toBe('complete')

      expect(deltas.join('')).toContain('本地 Agent 回复')
      expect(finals).toEqual(['本地 Agent 回复'])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.authorization).toBe('Bearer local-test-key')
      expect(requests[0]?.body).toMatchObject({ model: 'deepseek-chat', stream: true, temperature: 0.65 })
      const dialogue = (requests[0]?.body.messages as Array<{ role?: string; content?: unknown }>)
        .filter((message) => message.role === 'user' || message.role === 'assistant')
      expect(dialogue.slice(0, 2).map((message) => message.role)).toEqual(['assistant', 'user'])
      expect(JSON.stringify(dialogue[0]?.content)).toContain('你好啊')
      expect(JSON.stringify(dialogue[1]?.content)).toContain('你好')
      expect(dialogue.filter((message) => message.role === 'user' && message.content === '你好')).toHaveLength(1)
      expect(JSON.stringify(dialogue)).not.toContain('prior transcript')
      expect(JSON.stringify(requests[0]?.body.tools)).toContain('eleckoi_read_setting_files')
      expect(JSON.stringify(requests[0]?.body.tools)).not.toContain('eleckoi_read_variables')
      expect(JSON.stringify(requests[0]?.body.tools)).toContain('web_search')
      expect(JSON.stringify(requests[0]?.body.tools)).toContain('web_fetch')
      expect(JSON.stringify(requests[0]?.body.tools)).toContain('update_roleplay_plan')

      const persistedSessionRoot = join(root, 'runtime', 'sessions')
      expect((await readdir(persistedSessionRoot, { recursive: true })).some((entry) => entry.split(/[\\/]/).at(-1) === 'runtime-thread-a')).toBe(true)
      const persistedRoot = join(persistedSessionRoot, 'conversation-local-test')
      const settingBridge = JSON.parse(await readFile(join(persistedRoot, 'eleckoi-setting-library-state.json'), 'utf8'))
      expect(settingBridge.history).toEqual([{ role: 'assistant', content: '你好啊', speakerName: '角色 A' }])
      expect(settingBridge.variableState).toEqual({})
      await expect(runtime.stream('conversation-local-test', '你好', {
        configId: 'local-main',
        apiKey: 'local-test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: 'deepseek-chat',
        systemPrompt: '只返回本地测试文本。',
        apiFormat: 'openai-completions',
        customHeaders: {},
        contextWindow: 128000,
        autoCompactTokenLimit: 96000,
        temperature: 0.65,
        supportsImageInput: false
      }, {
        onDelta: (delta) => deltas.push(delta),
        onFinal: (content) => finals.push(content)
      }, undefined, {
        characterId: 'card-a',
        characterName: '角色 A',
        persona: {},
        history: [{ role: 'assistant', content: '你好啊', speakerName: '角色 A' }]
      }, 'runtime-thread-b', undefined, ['runtime-thread-a'])).resolves.toBe('complete')
      expect(requests).toHaveLength(2)
      const regenerationDialogue = (requests[1]?.body.messages as Array<{ role?: string; content?: unknown }>)
        .filter((message) => message.role === 'user' || message.role === 'assistant')
      expect(regenerationDialogue.slice(0, 2).map((message) => message.role)).toEqual(['assistant', 'user'])
      expect(JSON.stringify(regenerationDialogue[0]?.content)).toContain('你好啊')
      expect(JSON.stringify(regenerationDialogue[1]?.content)).toContain('你好')
      expect(JSON.stringify(regenerationDialogue)).not.toContain('本地 Agent 回复')
      expect(regenerationDialogue.filter((message) => message.role === 'user' && message.content === '你好')).toHaveLength(1)
      const persistedAfterRegeneration = await readdir(persistedSessionRoot, { recursive: true })
      expect(persistedAfterRegeneration.some((entry) => entry.split(/[\\/]/).at(-1) === 'runtime-thread-a')).toBe(false)
      expect(persistedAfterRegeneration.some((entry) => entry.split(/[\\/]/).at(-1) === 'runtime-thread-b')).toBe(true)
    } finally {
      await runtime.close()
      server.close()
      await once(server, 'close')
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('streams a real Agent reply through the native Google protocol', async () => {
    const requests: Array<{
      url: string | undefined
      apiKey: string | undefined
      body: Record<string, unknown>
    }> = []
    const server = createServer(async (request, response) => {
      let rawBody = ''
      for await (const chunk of request) rawBody += chunk.toString()
      requests.push({
        url: request.url,
        apiKey: request.headers['x-goog-api-key'] as string | undefined,
        body: JSON.parse(rawBody) as Record<string, unknown>
      })
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      })
      response.write(`data: ${JSON.stringify({
        candidates: [{
          content: { role: 'model', parts: [{ text: '本地 Google 回复' }] },
          finishReason: 'STOP'
        }],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 4,
          totalTokenCount: 12
        },
        modelVersion: 'gemini-test',
        responseId: 'google-local-test'
      })}\n\n`)
      response.end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Local test server did not expose a TCP port')

    const root = await mkdtemp(join(tmpdir(), 'eleckoi-dsh-google-'))
    const runtime = new DshRuntime({
      configPath: resolve('resources/dsh/cordis.yml'),
      presetTemplatePath: resolve('resources/dsh/agent-preset-template/agent.cordis.yml'),
      workspaceRoot: join(root, 'workspace'),
      runtimeDataRoot: join(root, 'runtime'),
      executablePath: process.execPath,
      modelCatalog: () => [{
        configId: 'enabled-google-config',
        apiKey: 'google-test-key',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'models/gemini-3.6-flash',
        systemPrompt: '',
        apiFormat: 'google-generative-ai',
        customHeaders: {},
        contextWindow: 1_048_576,
        supportsImageInput: true
      }]
    })
    const deltas: string[] = []
    const finals: string[] = []

    try {
      await expect(runtime.stream('conversation-google-test', '你好', {
        configId: 'google-local-config',
        apiKey: 'google-local-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: 'models/gemini-test',
        systemPrompt: '只返回本地测试文本。',
        apiFormat: 'google-generative-ai',
        customHeaders: {},
        contextWindow: 128_000,
        autoCompactTokenLimit: 96_000,
        temperature: 0.5,
        supportsImageInput: true
      }, {
        onDelta: (delta) => deltas.push(delta),
        onFinal: (content) => finals.push(content)
      }, undefined, {
        characterId: 'card-google',
        characterName: '角色 G',
        persona: {},
        history: []
      }, 'runtime-thread-google', {
        disabledGroupIds: ['builtin:variables', 'builtin:other']
      })).resolves.toBe('complete')

      expect(deltas.join('')).toContain('本地 Google 回复')
      expect(finals).toEqual(['本地 Google 回复'])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toContain('/v1beta/models/gemini-test:streamGenerateContent')
      expect(requests[0]?.apiKey).toBe('google-local-key')
      const googleTools = requests[0]?.body.tools as Array<{
        functionDeclarations?: Array<Record<string, unknown>>
      }>
      expect(googleTools[0]?.functionDeclarations?.[0]).toHaveProperty('parametersJsonSchema')
      expect(googleTools[0]?.functionDeclarations?.[0]).not.toHaveProperty('parameters')
    } finally {
      await runtime.close()
      server.close()
      await once(server, 'close')
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps concurrent chats and immutable request parameters isolated in one recoverable process', async () => {
    const requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = []
    const server = createServer(async (request, response) => {
      let rawBody = ''
      for await (const chunk of request) rawBody += chunk.toString()
      const body = JSON.parse(rawBody) as Record<string, unknown>
      requests.push({ authorization: request.headers.authorization, body })
      await new Promise((resolveDelay) => setTimeout(resolveDelay, body.model === 'model-a' ? 30 : 10))
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const base = { id: `chatcmpl-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model }
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: `回复-${body.model}` }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Local test server did not expose a TCP port')

    const endpoint = `http://127.0.0.1:${address.port}`
    const modelA = {
      configId: 'model-a-config', apiKey: 'key-a', baseUrl: endpoint, model: 'model-a',
      systemPrompt: 'A 系统提示', apiFormat: 'openai-completions' as const, customHeaders: {},
      contextWindow: 128_000, temperature: 0.2, topP: 0, supportsImageInput: false
    }
    const modelB = {
      configId: 'model-b-config', apiKey: 'key-b', baseUrl: endpoint, model: 'model-b',
      systemPrompt: 'B 系统提示', apiFormat: 'openai-completions' as const, customHeaders: {},
      contextWindow: 128_000, temperature: 0.8, supportsImageInput: false
    }
    const root = await mkdtemp(join(tmpdir(), 'eleckoi-dsh-multisession-'))
    const runtime = new DshRuntime({
      configPath: resolve('resources/dsh/cordis.yml'),
      presetTemplatePath: resolve('resources/dsh/agent-preset-template/agent.cordis.yml'),
      workspaceRoot: join(root, 'workspace'), runtimeDataRoot: join(root, 'runtime'),
      executablePath: process.execPath, modelCatalog: () => [modelA, modelB]
    })
    const callbacks = { onDelta: () => undefined, onFinal: () => undefined }
    const contextA = { characterId: 'a', characterName: '角色 A', persona: {}, history: [{ role: 'assistant' as const, content: '仅 A 历史' }] }
    const contextB = { characterId: 'b', characterName: '角色 B', persona: {}, history: [{ role: 'assistant' as const, content: '仅 B 历史' }] }

    try {
      await Promise.all([
        runtime.stream('conversation-a', '问题 A', modelA, callbacks, undefined, contextA, 'session-a'),
        runtime.stream('conversation-b', '问题 B', modelB, callbacks, undefined, contextB, 'session-b')
      ])
      const internals = runtime as unknown as { harness: { client: { child?: { kill(): boolean; once(event: string, listener: () => void): void } } } }
      const firstHarness = internals.harness
      expect(requests).toHaveLength(2)
      const a = requests.find((item) => item.body.model === 'model-a')
      const b = requests.find((item) => item.body.model === 'model-b')
      expect(a?.authorization).toBe('Bearer key-a')
      expect(a?.body).toMatchObject({ temperature: 0.2, top_p: 0 })
      expect(JSON.stringify(a?.body.messages)).toContain('仅 A 历史')
      expect(JSON.stringify(a?.body.messages)).not.toContain('仅 B 历史')
      expect(b?.authorization).toBe('Bearer key-b')
      expect(b?.body).toMatchObject({ temperature: 0.8 })
      expect(b?.body).not.toHaveProperty('top_p')
      expect(JSON.stringify(b?.body.messages)).toContain('仅 B 历史')
      expect(JSON.stringify(b?.body.messages)).not.toContain('仅 A 历史')

      await runtime.stream('conversation-a', '问题 A2', modelA, callbacks, undefined, contextA, 'session-a')
      expect(internals.harness).toBe(firstHarness)

      const child = (firstHarness.client as unknown as { child: { kill(): boolean; once(event: string, listener: () => void): void } }).child
      const exited = new Promise<void>((resolveExit) => child.once('exit', resolveExit))
      child.kill()
      await exited
      await runtime.stream('conversation-b', '问题 B2', modelB, callbacks, undefined, contextB, 'session-b')
      expect(internals.harness).not.toBe(firstHarness)
      const recovered = requests.at(-1)
      expect(recovered?.body.model).toBe('model-b')
      expect(JSON.stringify(recovered?.body.messages)).toContain('问题 B')
      expect(JSON.stringify(recovered?.body.messages)).not.toContain('问题 A')
    } finally {
      await runtime.close()
      server.close()
      await once(server, 'close')
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('forwards Top P through the Anthropic Messages protocol', async () => {
    const requests: Array<{
      apiKey: string | undefined
      anthropicVersion: string | undefined
      body: Record<string, unknown>
    }> = []
    const server = createServer(async (request, response) => {
      let rawBody = ''
      for await (const chunk of request) rawBody += chunk.toString()
      const body = JSON.parse(rawBody) as Record<string, unknown>
      requests.push({
        apiKey: request.headers['x-api-key'] as string | undefined,
        anthropicVersion: request.headers['anthropic-version'] as string | undefined,
        body
      })
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      })
      response.write('event: message_start\n')
      response.write(`data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg-local-anthropic',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-local-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 8, output_tokens: 0 }
        }
      })}\n\n`)
      response.write('event: content_block_start\n')
      response.write(`data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })}\n\n`)
      response.write('event: content_block_delta\n')
      response.write(`data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Anthropic 本地回复' }
      })}\n\n`)
      response.write('event: content_block_stop\n')
      response.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
      response.write('event: message_delta\n')
      response.write(`data: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 }
      })}\n\n`)
      response.write('event: message_stop\n')
      response.end(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Local test server did not expose a TCP port')

    const root = await mkdtemp(join(tmpdir(), 'eleckoi-dsh-anthropic-'))
    const runtime = new DshRuntime({
      configPath: resolve('resources/dsh/cordis.yml'),
      presetTemplatePath: resolve('resources/dsh/agent-preset-template/agent.cordis.yml'),
      workspaceRoot: join(root, 'workspace'),
      runtimeDataRoot: join(root, 'runtime'),
      executablePath: process.execPath,
      modelCatalog: () => [{
        configId: 'enabled-google-config',
        apiKey: 'google-test-key',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'models/gemini-3.6-flash',
        systemPrompt: '',
        apiFormat: 'google-generative-ai',
        customHeaders: {},
        contextWindow: 1_048_576,
        supportsImageInput: true
      }]
    })
    const finals: string[] = []

    try {
      await expect(runtime.stream('conversation-anthropic-test', '你好', {
        configId: 'local-anthropic',
        apiKey: 'local-anthropic-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: 'claude-local-test',
        systemPrompt: '只返回本地测试文本。',
        apiFormat: 'anthropic-messages',
        customHeaders: {},
        contextWindow: 128_000,
        autoCompactTokenLimit: 96_000,
        topP: 0.72,
        supportsImageInput: false
      }, {
        onDelta: () => undefined,
        onFinal: (content) => finals.push(content)
      })).resolves.toBe('complete')

      expect(finals).toEqual(['Anthropic 本地回复'])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.apiKey).toBe('local-anthropic-key')
      expect(requests[0]?.anthropicVersion).toBeTruthy()
      expect(requests[0]?.body).toMatchObject({
        model: 'claude-local-test',
        stream: true,
        top_p: 0.72
      })
      expect(requests[0]?.body).not.toHaveProperty('temperature')
    } finally {
      await runtime.close()
      server.close()
      await once(server, 'close')
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('dispatches subagent calls through the selected child provider with its own model and request parameters', async () => {
    const requests: Array<{
      authorization: string | undefined
      childRouteHeader: string | undefined
      body: Record<string, unknown>
    }> = []
    let mainCalls = 0
    const server = createServer(async (request, response) => {
      let rawBody = ''
      for await (const chunk of request) rawBody += chunk.toString()
      const body = JSON.parse(rawBody) as Record<string, unknown>
      requests.push({
        authorization: request.headers.authorization,
        childRouteHeader: request.headers['x-child'] as string | undefined,
        body
      })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const model = String(body.model)
      const base = { id: `chatcmpl-${requests.length}`, object: 'chat.completion.chunk', created: 1, model }
      const send = (choice: Record<string, unknown>) => {
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, ...choice }] })}\n\n`)
      }
      if (model === 'child-model') {
        send({ delta: { role: 'assistant', content: '' }, finish_reason: null })
        send({ delta: { content: '子模型结果' }, finish_reason: null })
        send({ delta: {}, finish_reason: 'stop' })
      } else if (mainCalls++ === 0) {
        send({ delta: { role: 'assistant', content: '' }, finish_reason: null })
        send({
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-subagent-1',
              type: 'function',
              function: {
                name: 'subagent',
                arguments: JSON.stringify({
                  description: '验证子模型路由',
                  prompt: '只回复“子模型结果”。',
                  run_in_background: false
                })
              }
            }]
          },
          finish_reason: null
        })
        send({ delta: {}, finish_reason: 'tool_calls' })
      } else {
        send({ delta: { role: 'assistant', content: '' }, finish_reason: null })
        send({ delta: { content: '主模型收到子结果' }, finish_reason: null })
        send({ delta: {}, finish_reason: 'stop' })
      }
      response.end('data: [DONE]\n\n')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Local test server did not expose a TCP port')

    const root = await mkdtemp(join(tmpdir(), 'eleckoi-dsh-subagent-'))
    const runtime = new DshRuntime({
      configPath: resolve('resources/dsh/cordis.yml'),
      presetTemplatePath: resolve('resources/dsh/agent-preset-template/agent.cordis.yml'),
      workspaceRoot: join(root, 'workspace'),
      runtimeDataRoot: join(root, 'runtime'),
      executablePath: process.execPath
    })
    const final: string[] = []
    try {
      await expect(runtime.stream(
        'conversation-subagent-test',
        '请调用子代理完成验证。',
        {
          configId: 'main-config',
          apiKey: 'main-key',
          baseUrl: `http://127.0.0.1:${address.port}`,
          model: 'main-model',
          systemPrompt: '必须调用 subagent，并等待结果。',
          apiFormat: 'openai-completions',
          customHeaders: { 'X-Main': 'main' },
          contextWindow: 128_000,
          maxTokens: 9_000,
          temperature: 0.7,
          supportsImageInput: false
        },
        { onDelta: () => undefined, onFinal: (content) => final.push(content) },
        undefined,
        undefined,
        'runtime-thread-subagent',
        undefined,
        [],
        [],
        {
          id: 'agent-preset-standard',
          versionId: 'subagent-test-v1',
          name: '测试预设',
          roleplayPlan: { steps: ['先调研', '输出最终正文'] }
        },
        undefined,
        {
          configId: 'child-config',
          apiKey: 'child-key',
          baseUrl: `http://127.0.0.1:${address.port}`,
          model: 'child-model',
          systemPrompt: '',
          apiFormat: 'openai-completions',
          customHeaders: { 'X-Child': 'child' },
          contextWindow: 96_000,
          maxTokens: 4_321,
          temperature: 0.25,
          reasoningEffort: 'high',
          supportsImageInput: false
        }
      )).resolves.toBe('complete')

      expect(final).toEqual(['主模型收到子结果'])
      expect(requests.map((item) => item.body.model)).toContain('child-model')
      const child = requests.find((item) => item.body.model === 'child-model')
      expect(child).toBeTruthy()
      expect(child?.authorization).toBe('Bearer child-key')
      expect(child?.childRouteHeader).toBe('child')
      expect(child?.body).toMatchObject({ model: 'child-model', temperature: 0.25 })
      expect(child?.body.max_tokens ?? child?.body.max_completion_tokens).toBe(4_321)
      expect(child?.body).not.toHaveProperty('reasoning_effort')
      expect(child?.body).toHaveProperty('messages')
      expect(requests.filter((item) => item.body.model === 'main-model')).toHaveLength(2)
      expect(requests.find((item) => item.body.model === 'main-model')?.authorization).toBe('Bearer main-key')
    } finally {
      await runtime.close()
      server.close()
      await once(server, 'close')
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
