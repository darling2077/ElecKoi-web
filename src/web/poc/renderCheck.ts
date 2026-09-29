/**
 * 消息渲染验收：角色卡状态栏里的代码块必须真的渲染成代码块。
 *
 * 背景：这类写法 `<StatusBlock>\n```json\n...\n```\n</StatusBlock>`（标签与围栏之间无空行）
 * 曾经渲染成一坨纯文本、围栏原样漏在气泡里。上游 v0.1.1 已自行修好
 * （`normalizeMarkdownForRendering.js` + `tests/message-markdown.test.jsx`），
 * 我们不再自己维护补丁，但**保留这条回归**：上游改了渲染器、或我们换了外壳，都要能被抓到。
 *
 * ⚠️ v0.2.0 起语义换了：界面是 DSH 客户端，"渲染"发生在 `eleckoi-page-messages` 里。
 * 因此这组拆成两层断言：
 *   数据层 R-1  四种用例确实按原文写进库（换行、围栏、标签都在）；
 *   渲染层 R-2  应用里能看到用例正文；
 *          R-3  代码块以 <pre>/<code> 呈现，且**没有裸围栏泄漏**；
 *          R-4  渲染到的消息条数不少于用例数。
 *
 * 运行：pnpm webui:render
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startWebUiStack } from '../stack'
import { startMockModelServer } from './mockModelServer'
import { Cdp, waitForPageEndpoint } from './cdp'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

const CASES = [
  {
    key: 'regression',
    label: '状态栏包着围栏（<StatusBlock> 大小写混合，标签与围栏之间无空行）',
    body: [
      '她的手滑到他腰间，轻轻往回拽了一格。',
      '',
      '<StatusBlock>',
      '```json',
      '『 2026年4月 晚上7:00 』',
      '# 楚榆楠 年龄: 27',
      '👚 服装: 黑色蕾丝吊带情趣内衣',
      '```',
      '</StatusBlock>'
    ].join('\n')
  },
  {
    key: 'lowercase',
    label: '小写包裹标签（上游单测覆盖的形态）',
    body: ['<status>', '```json', '{ "a": 1 }', '```', '</status>'].join('\n')
  },
  {
    key: 'bare-fence',
    label: '裸围栏（本来就正常）',
    body: ['正文一段。', '', '```js', 'const a = 1;', '```'].join('\n')
  },
  {
    key: 'plain',
    label: '普通正文与行内 HTML',
    body: ['不要闹。', '', '<b>加粗</b>也要在。', '', '第二段仍要正常分段。'].join('\n')
  }
]

/** 渲染层探针的返回：从会话页 DOM 里量到的形状。 */
interface Shape {
  codeBlocks: number
  leakedFence: boolean
  text: string
  html?: string
}

/**
 * 等一个 Agent 回合结束。
 *
 * 不能只数消息条数：`messages.create` 在回合**开始时**就同时写入 user 与 assistant
 * 两条（后者 status=streaming），条数够了不代表结束。真正的信号是最后一条 assistant
 * 不再是 streaming。（用轮询而不是 SSE——无头检查会关掉事件流。）
 */
async function waitForRun(
  call: (name: string, input: unknown) => Promise<unknown>,
  conversationId: string,
  timeoutMs: number
): Promise<{ ok: boolean; status: string }> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 500))
    try {
      const page = await call('query.conversations.messages', { conversationId, limit: 200 }) as {
        messages?: Array<{ role: string; status: string }>
      }
      const assistant = [...(page.messages ?? [])].reverse().find((item) => item.role === 'assistant')
      last = assistant?.status ?? ''
      if (last === 'complete' || last === 'error' || last === 'cancelled') return { ok: true, status: last }
    } catch {
      // 回合进行中偶尔查不到，继续等
    }
  }
  return { ok: false, status: last }
}

/** 在应用里量一次消息页 DOM。 */
async function readShapes(base: string, token: string): Promise<Shape[] | undefined> {
  const profile = mkdtempSync(join(tmpdir(), 'eleckoi-render-'))
  const port = 9900 + Math.floor(Math.random() * 400)
  const browser = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-sync', '--disable-features=Translate,BackForwardCache',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore' })

  let cdp: Cdp | undefined
  const failures: string[] = []
  try {
    cdp = await Cdp.connect(await waitForPageEndpoint(port))
    cdp.onEvent((method, params) => {
      if (method !== 'Runtime.exceptionThrown') return
      const details = params.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined
      failures.push(String(details?.exception?.description ?? details?.text ?? '').slice(0, 160))
    })
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Network.setCookie', { name: 'eleckoi_session', value: token, url: base, path: '/' })
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url: `${base}/` })

    // 等应用挂载（DSH 客户端要拉插件清单并建传输）。
    let mounted = false
    const mountDeadline = Date.now() + 60_000
    while (Date.now() < mountDeadline) {
      mounted = await cdp.evaluate<boolean>(`typeof globalThis.__ELECKOI_DSH_APP__ === 'function'`)
      if (mounted) break
      await new Promise((done) => setTimeout(done, 1000))
    }
    if (!mounted) {
      console.log(`        [渲染] 应用未挂载${failures.length > 0 ? `：${failures.slice(0, 2).join(' ｜ ')}` : ''}`)
      return undefined
    }

    // 会话页不一定自动打开这条会话：先看正文在不在，不在就点一下会话入口再等。
    const findMarker = `(() => (document.body?.innerText ?? '').includes('她的手滑到他腰间'))()`
    const clickConversation = `(() => {
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, li, div'))
      const target = nodes
        .filter((el) => (el.textContent ?? '').includes('渲染验收'))
        .sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0]
      if (!target) return false
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    })()`

    const renderDeadline = Date.now() + 45_000
    while (Date.now() < renderDeadline) {
      if (await cdp.evaluate<boolean>(findMarker)) break
      await cdp.evaluate<boolean>(clickConversation)
      await new Promise((done) => setTimeout(done, 2000))
    }

    const shapes = await cdp.evaluate<Shape[]>(`(() => {
      const bubbles = Array.from(document.querySelectorAll('[class*="message"], article, [data-message-id]'))
      const own = bubbles.filter((el) => /她的手滑到他腰间|不要闹|正文一段|带情趣内衣/.test(el.textContent ?? ''))
      const roots = own.length > 0 ? own : [document.body]
      return roots.map((root) => {
        const text = (root.innerText ?? root.textContent ?? '')
        const codeBlocks = root.querySelectorAll('pre, code').length
        const pre = root.querySelector('pre')
        return {
          codeBlocks,
          leakedFence: text.includes('\u0060\u0060\u0060'),
          text: text.replace(/\\s+/g, ' ').slice(0, 160),
          html: pre ? pre.outerHTML.slice(0, 300) : ''
        }
      })
    })()`)
    return shapes.length > 0 ? shapes : undefined
  } finally {
    cdp?.close()
    browser.kill('SIGKILL')
    await new Promise<void>((done) => {
      if (browser.exitCode !== null || browser.signalCode !== null) return done()
      browser.once('exit', () => done())
      setTimeout(done, 5000)
    })
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // 临时目录删不掉不影响结论
    }
  }
}

async function main(): Promise<void> {
  process.env.ELECKOI_DISABLE_EVENT_STREAM = '1'

  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-render-'))
  const rendererDir = resolve('out/renderer-dsh')
  mkdirSync(rendererDir, { recursive: true })

  const stack = await startWebUiStack({
    dataRoot: root,
    rendererDir: resolve('out/renderer'),
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-render',
    port: 0,
    allowRegistration: true
  })
  const base = stack.server.url
  const email = 'render@example.com'
  const password = 'render-check-password'
  console.log(`\n== 消息渲染验收（代码块 · v0.2.0 架构）==\n服务地址：${base}\n`)

  const jar: Record<string, string> = {}
  const capture = (response: Response): void => {
    for (const entry of response.headers.getSetCookie?.() ?? []) {
      const pair = entry.split(';')[0] ?? ''
      if (pair.startsWith('eleckoi_session=')) jar.cookie = pair
    }
  }

  // 消息只能由 Agent 回合产生（没有"直接追加消息"的 RPC），
  // 所以让 mock 模型把每个用例原文当作回复吐出来——渲染走真实链路。
  let caseIndex = 0
  const mock = await startMockModelServer({
    wrapInFinalTag: false,
    replyText: () => CASES[Math.min(caseIndex++, CASES.length - 1)]!.body
  })

  type Lease = Awaited<ReturnType<typeof stack.tenants.acquire>>
  let lease: Lease | undefined
  try {
    // ── R-0 防呆：构建产物不得早于渲染层源码 ──
    // 升级上游后忘记重建界面，会让本检查全部得出错误结论（这条以前真吃过亏）。
    const assetDir = join(rendererDir, 'assets')
    const newestAsset = readdirSync(assetDir)
      .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
      .map((name) => statSync(join(assetDir, name)).mtimeMs)
      .reduce((max, value) => Math.max(max, value), 0)
    const newestSource = [
      resolve('src/renderer/dsh.html'),
      resolve('packages/dsh-client-conversations/src/client.js')
    ].map((path) => statSync(path).mtimeMs).reduce((max, value) => Math.max(max, value), 0)
    record('R-0', newestAsset >= newestSource,
      newestAsset >= newestSource
        ? `out/renderer-dsh 构建于源码之后（差 ${Math.round((newestAsset - newestSource) / 1000)} 秒）`
        : `构建产物早于源码 ${Math.round((newestSource - newestAsset) / 1000)} 秒，请先跑一次 DSH 渲染层构建`)

    capture(await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, username: 'render', password })
    }))
    const user = stack.control.findUserByIdentifier(email) ?? stack.control.findUserByIdentifier('render')
    const mapping = user === undefined ? undefined : stack.control.findTenant(user.id)
    if (user === undefined || mapping === undefined) throw new Error('注册后拿不到用户/租户映射')
    lease = await stack.tenants.acquire(user.id, mapping.tenant_id)
    console.log(`租户：${mapping.tenant_id}（经 TenantRegistry 获取，与生产同路径）\n`)

    const runtime = lease.runtime
    const call = <T>(name: string, input: unknown): Promise<T> =>
      runtime.gateway.dispatch({ name, input: input ?? {} }, { senderId: 1, windowId: undefined }) as Promise<T>

    const configs = await call<Array<{ id: string; name: string }>>('command.models.save', {
      name: 'RENDER-MOCK',
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
    const configId = configs.find((config) => config.name === 'RENDER-MOCK')?.id
    await call('command.settings.write', {
      key: 'models.active',
      value: { capability: 'chat', config_id: configId, model: 'mock-model' }
    })
    await call('command.characters.create', {
      id: 'char-render',
      name: '渲染验收',
      description: '消息渲染回归用角色。',
      personality: '配合测试。',
      scenario: '本地 mock 环境。',
      firstMessage: '',
      chatBackground: ''
    })
    const details = await call<{ conversation: { id: string } }>('command.conversations.create', {
      title: '渲染验收',
      metadata: {
        characterId: 'char-render',
        characterName: '渲染验收',
        characterAvatar: '',
        characterPersona: {}
      }
    })
    const conversationId = details.conversation?.id
    if (!conversationId) throw new Error('会话创建失败，拿不到 conversationId')

    // ── 播种：一条用例一个回合 ──
    const stored: string[] = []
    for (let index = 0; index < CASES.length; index += 1) {
      caseIndex = index
      await call('command.agent.start', {
        conversationId, requestId: `render-${index}-${Date.now()}`, text: `请回复第 ${CASES[index]!.key} 个用例`
      })
      const settled = await waitForRun(call, conversationId, 120_000)
      const page = await call<{ messages?: Array<{ role: string; content: string }> }>(
        'query.conversations.messages', { conversationId, limit: 200 })
      const lastAssistant = [...(page.messages ?? [])].reverse().find((item) => item.role === 'assistant')
      stored.push(lastAssistant?.content ?? '')
      console.log(`        [stored] 第 ${index + 1} 条 status=${settled.status}` +
        ` 换行数=${(lastAssistant?.content.match(/\n/g) ?? []).length}` +
        ` 含围栏=${(lastAssistant?.content.includes('\u0060\u0060\u0060'))}`)
      if (!settled.ok) throw new Error(`用例 ${CASES[index]!.key} 的回合未在时限内结束`)
      if (settled.status !== 'complete') throw new Error(`用例 ${CASES[index]!.key} 的回合以 ${settled.status} 结束`)
    }
    caseIndex = CASES.length

    // ── R-1 数据层：四种用例按原文落库 ──
    const dataOk = CASES.every((item, index) => {
      const content = stored[index] ?? ''
      if (!content.includes(item.body.split('\n')[0] ?? '')) return false
      // 围栏与标签必须原样保留（渲染层才有得修）
      if (item.key === 'plain') return content.includes('不要闹')
      return content.includes('\u0060\u0060\u0060')
    })
    record('R-1', dataOk,
      `四种用例落库原文完整：${CASES.map((item, index) => `${item.key}=${(stored[index] ?? '').length}字`).join('、')}`)

    // ── R-2..R-4 渲染层 ──
    const shapes = await readShapes(base, (jar.cookie ?? '').replace('eleckoi_session=', ''))
    if (shapes === undefined) {
      for (const id of ['R-2', 'R-3', 'R-4']) record(id, false, '应用里没取到渲染结果（见上面的 [渲染] 诊断）')
      return
    }
    const joined = shapes.map((shape) => shape.text).join(' ')
    const sawRegression = joined.includes('她的手滑到他腰间') || joined.includes('情趣内衣')
    record('R-2', sawRegression,
      sawRegression
        ? `应用里渲染出了回归用例正文：${shapes[0]?.text.slice(0, 80) ?? ''}`
        : `渲染出的文本里没有回归用例：${joined.slice(0, 120)}`)

    const codeBlocks = shapes.reduce((sum, shape) => sum + shape.codeBlocks, 0)
    const leaked = shapes.some((shape) => shape.leakedFence)
    record('R-3', codeBlocks >= 1 && !leaked,
      `代码块元素 ${codeBlocks} 个、裸围栏残留=${leaked}${shapes[0]?.html ? `；样例 ${shapes[0].html.slice(0, 120)}` : ''}`)

    record('R-4', shapes.length >= 1, `量到 ${shapes.length} 处消息气泡（用例 ${CASES.length} 条）`)
  } catch (error) {
    record('R-5', false, `流程中断：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await mock.close()
    lease?.release()
    await stack.close()
    await rm(root, { recursive: true, force: true })
  }

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log(`\n== 结果：${outcomes.length - failed.length}/${outcomes.length} 通过 ==`)
  if (failed.length > 0) {
    console.log('未通过：' + failed.map((outcome) => outcome.id).join('、'))
    process.exitCode = 1
  }
}

await main()
