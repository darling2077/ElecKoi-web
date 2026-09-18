/**
 * 消息渲染验收：角色卡状态栏里的代码块必须真的渲染成代码块。
 *
 * 这个问题**上游已在 v0.1.1 自行修复**（提交 fd30638「新增轨迹与动态设定并修复聊天显示」，
 * 新增 `src/renderer/src/ui/messages/normalizeMarkdownForRendering.js` 与单测
 * `tests/message-markdown.test.jsx`）。我们原先写过一个等价补丁
 * （patches/0003），升级时已删除——不重复维护上游已有的修复。
 *
 * 那为什么还留这篇检查？两个理由：
 *   ① 上游的单测是 `renderToStaticMarkup` 静态渲染，而这个问题第一次就是
 *      "看起来该好、实际没渲染"；这里在**真实浏览器**里量最终 DOM。
 *   ② 用**用户实际的内容形态**回归——真实数据里包标签是 `<StatusBlock>`
 *      （大小写混合、非标准 HTML），上游单测用的是小写 `<status>`。
 *
 * 断言：
 *   - 事故写法必须出现 <pre><code>，且不残留围栏原文；
 *   - 原本正常的写法（标签+空行、裸围栏）继续正常；
 *   - 普通正文与行内 HTML 不受影响。
 *
 * ⚠️ 本检查跑的是 `out/renderer` 里的**构建产物**。上游升级后必须先重建 UI
 * （`pnpm exec electron-vite build`），否则测的是旧前端——这个坑真实发生过一次：
 * 升级到 v0.1.1 后没重建，于是"上游的修复看起来没生效"，白排查了很久。
 * 下面 R-0 就是这个防呆断言。
 *
 * 运行：pnpm webui:render
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startWebUiStack } from '../stack'
import { startMockModelServer } from './mockModelServer'


const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

const PROBE_PAGE = '__renderprobe.html'
const PROBE_DRIVER = '__renderprobe-driver.js'
const PROBE_SCRIPT = '__renderprobe.js'
/** 注入探针后的应用页副本。 */
const RENDER_TARGET = '__render-target.html'

/** 四条待渲染的消息：第一条是修复目标，其余是对照组。 */
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
    body: ['他说 <b>不要闹</b>，然后转过身去。', '', '第二段仍要正常分段。'].join('\n')
  }
]

function probePage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>render-probe</title></head>
<body><pre id="out">pending</pre><script src="/${PROBE_DRIVER}"></script></body></html>
`
}

/** 登录并跳到被测会话页（会话 id 由查询参数带入）。 */
function probeDriver(): string {
  return `(() => {
  const params = new URLSearchParams(location.search);
  const out = document.getElementById('out');
  const carry = new URLSearchParams();
  for (const [key, value] of params) {
    if (key !== 'email' && key !== 'password' && key !== 'target') carry.set(key, value);
  }
  const suffix = carry.toString() === '' ? '' : '?' + carry.toString();
  (async () => {
    const login = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: params.get('email') || '', password: params.get('password') || '' })
    });
    if (!login.ok) { out.textContent = 'LOGIN-FAILED ' + login.status; return; }
    location.replace((params.get('target') || '/') + suffix);
  })().catch((error) => { out.textContent = 'ERROR ' + String(error); });
})();
`
}

/**
 * 在应用页里量 DOM。
 *
 * 两个坑：
 *  ① 应用是 SPA，React 挂载时会替换 body，直接 append 的节点会被冲掉 ——
 *     所以挂在 <html> 上，并且每次写入前确认节点还在。
 *  ② 应用启动后不会自动选中会话，必须先点侧栏的会话项，消息区才有内容。
 */
function probeScript(): string {
  return `(() => {
  const write = (payload) => {
    let host = document.getElementById('renderprobe');
    if (!host) {
      host = document.createElement('pre');
      host.id = 'renderprobe';
      host.style.display = 'none';
      document.documentElement.append(host);
    }
    host.textContent = 'REPORT:' + JSON.stringify(payload);
  };
  write({ stage: 'early', items: document.querySelectorAll('.conversation-item').length });

  // 只取"助手"消息：用户消息也是 .markdown-message，混在一起会错位。
  const isAssistant = (bubble) => {
    const article = bubble.closest('.message');
    return article !== null && article.classList.contains('theirs');
  };
  const shapesOf = () => [...document.querySelectorAll('.markdown-message')].filter(isAssistant).map((bubble) => {
    const codes = [...bubble.querySelectorAll('[data-streamdown="code-block"], pre code, pre')];
    return {
      codeBlocks: codes.length,
      highlighted: bubble.innerHTML.includes('data-streamdown'),
      leakedFence: bubble.textContent.includes('\u0060\u0060\u0060'),
      html: bubble.innerHTML.slice(0, 900),
      text: bubble.textContent.slice(0, 80)
    };
  });

  // 点开第一个会话，等消息区渲染出来再回报。
  let clicked = false;
  let tries = 0;
  const tick = () => {
    tries += 1;
    if (!clicked) {
      const item = document.querySelector('.conversation-item');
      if (item) { item.click(); clicked = true; }
    }
    const shapes = shapesOf();
    if (shapes.length > 0 || tries > 30) {
      write({ stage: 'final', count: shapes.length, shapes, clicked, tries });
      return;
    }
    setTimeout(tick, 400);
  };
  setTimeout(tick, 1200);
})();
`
}

function injectProbe(html: string): string {
  return html.replace('</body>', `<script src="/${PROBE_SCRIPT}"></script></body>`)
}

async function runChromium(args: string[], timeoutMs = 90_000): Promise<{ stdout: string; note: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'eleckoi-render-'))
  return new Promise((resolveRun) => {
    const child = spawn('chromium', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--disable-sync', '--disable-features=Translate,BackForwardCache',
      '--hide-scrollbars', `--user-data-dir=${profile}`, ...args
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (note: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      rmSync(profile, { recursive: true, force: true })
      resolveRun({ stdout, note })
    }
    const timer = setTimeout(() => finish(`超时 ${timeoutMs} ms`), timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('close', () => {
      if (stdout.length > 0) return finish('')
      const errors = stderr.split('\n').filter((line) => line.includes('ERROR') && !line.includes('dbus') && !line.includes('gcm'))
      finish(`空输出｜${errors.slice(-2).join(' | ')}`)
    })
  })
}

interface Shape {
  codeBlocks: number
  highlighted: boolean
  leakedFence: boolean
  text: string
}

function readShapes(dom: string): Shape[] | undefined {
  const match = dom.match(/REPORT:(\{.*?\})<\/pre>/s)
  if (match === null) return undefined
  const raw = match[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  try {
    const parsed = JSON.parse(raw) as { stage?: string; count?: number; shapes?: Shape[]; bubbles?: number; items?: number }
    if (parsed.stage === 'early') {
      console.log(`        [early] 探针已运行：会话项 ${parsed.items ?? 0} 个、消息气泡 ${parsed.bubbles ?? 0} 个`)
      return undefined
    }
    return parsed.shapes
  } catch {
    return undefined
  }
}

/**
 * 等一个 Agent 回合结束。
 *
 * 注意不能只数消息条数：`messages.create` 在回合**开始时**就同时写入
 * user 与 assistant 两条（后者 status=streaming），所以"条数够了"并不代表
 * 回合结束。真正的结束信号是最后一条 assistant 不再是 streaming。
 * （用轮询而不是 SSE——渲染验收与其它无头检查一样会关掉事件流。）
 */
async function waitForRun(
  call: (name: string, input: unknown) => Promise<unknown>,
  conversationId: string,
  timeoutMs: number
): Promise<{ ok: boolean; status: string }> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 400))
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

async function main(): Promise<void> {
  process.env.ELECKOI_DISABLE_EVENT_STREAM = '1'

  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-render-'))
  const rendererDir = resolve('out/renderer')
  mkdirSync(rendererDir, { recursive: true })
  const probePath = join(rendererDir, PROBE_PAGE)
  const driverPath = join(rendererDir, PROBE_DRIVER)
  const scriptPath = join(rendererDir, PROBE_SCRIPT)
  writeFileSync(probePath, probePage())
  writeFileSync(driverPath, probeDriver())
  writeFileSync(scriptPath, probeScript())

  const stack = await startWebUiStack({
    dataRoot: root,
    rendererDir,
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-render',
    port: 0,
    allowRegistration: true,
    // 把租户生命周期打出来：第二轮失败必须能看到"谁释放了租户"
    log: (message) => console.log(`        [registry] ${message}`),
    // 注入副本的路径必须在启动时登记（publicPaths 只在启动时读一次）。
    // 文件本身稍后（抓到应用页之后）才写，公开名单不看启动时是否存在。
    publicPaths: [`/${PROBE_PAGE}`, `/${PROBE_DRIVER}`, `/${PROBE_SCRIPT}`, `/${RENDER_TARGET}`]
  })
  const base = stack.server.url
  const email = 'render@example.com'
  const password = 'render-check-password'
  console.log(`\n== 消息渲染验收（代码块）==\n服务地址：${base}\n`)

  const jar: Record<string, string> = {}
  const capture = (response: Response): void => {
    for (const entry of response.headers.getSetCookie?.() ?? []) {
      const pair = entry.split(';')[0] ?? ''
      if (pair.startsWith('eleckoi_session=')) jar.cookie = pair
    }
  }

  // 消息只能由 Agent 回合产生（没有"直接追加消息"的 RPC），
  // 所以让 mock 模型把每个用例原文当作回复吐出来——这样渲染走的是真实链路。
  let caseIndex = 0
  const mock = await startMockModelServer({
    wrapInFinalTag: false,
    replyText: () => CASES[Math.min(caseIndex++, CASES.length - 1)]!.body
  })

  type Lease = Awaited<ReturnType<typeof stack.tenants.acquire>>
  let lease: Lease | undefined
  try {
    // ── R-0 防呆：构建产物不得早于渲染层源码 ──
    // 升级上游后忘记重建 UI，会让本检查全部得出错误结论。
    const assetDir = join(rendererDir, 'assets')
    const newestAsset = readdirSync(assetDir)
      .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
      .map((name) => statSync(join(assetDir, name)).mtimeMs)
      .reduce((max, value) => Math.max(max, value), 0)
    const messageBubble = statSync(resolve('src/renderer/src/ui/messages/MessageBubble.jsx')).mtimeMs
    const normalize = statSync(resolve('src/renderer/src/ui/messages/normalizeMarkdownForRendering.js')).mtimeMs
    const newestSource = Math.max(messageBubble, normalize)
    record('R-0', newestAsset >= newestSource,
      newestAsset >= newestSource
        ? '构建产物不早于渲染层源码（测得是新前端）'
        : `构建产物比源码旧 ${Math.round((newestSource - newestAsset) / 1000)} 秒：请先 pnpm exec electron-vite build 再跑本检查`)

    capture(await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, username: 'render', password })
    }))
    // 注册后 stack 已经为该用户分配了租户；复用注册表里的实例，
    // 避免自己 mount 一个同路径的租户（两边共用同一个 SQLite 文件，会互相关闭句柄）。
    const user = stack.control.findUserByIdentifier(email) ?? stack.control.findUserByIdentifier('render')
    const mapping = user === undefined ? undefined : stack.control.findTenant(user.id)
    if (user === undefined || mapping === undefined) throw new Error('注册后拿不到用户/租户映射')
    lease = await stack.tenants.acquire(user.id, mapping.tenant_id)
    console.log(`租户：${mapping.tenant_id}（经 TenantRegistry 获取，与生产同路径）\n`)

    const runtime = lease.runtime
    // 观察流式 delta 原文：确认换行是在链路里丢的，还是 mock 就没发出来
    const deltas: string[] = []
    runtime.gateway.attach({
      id: 99,
      send: (envelope) => {
        if (envelope.name === 'agent.output.delta') {
          deltas.push((envelope.payload as { delta?: string }).delta ?? '')
        }
      }
    })
    // 回合失败是 fire-and-forget 的（execute 不会被 await），静默吞掉会让人以为"模型没回"。
    // 显式打出来，测试失败时能直接看到原因。
    process.on('unhandledRejection', (reason) => {
      console.log('        [unhandledRejection]', String(reason).slice(0, 120))
    })
    const call = <T>(name: string, input: unknown): Promise<T> =>
      runtime.gateway.dispatch({ name, input: input ?? {} }, { senderId: 1, windowId: undefined }) as Promise<T>

    // ── 夹具：mock 模型 → 角色 → 会话 → 逐条跑回合 ──
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

    // 一条用例一个回合；等这一条写完再跑下一条，避免并发写乱顺序。
    for (let index = 0; index < CASES.length; index += 1) {
      caseIndex = index
      await call('command.agent.start', { conversationId, requestId: `render-${index}-${Date.now()}`, text: `请回复第 ${CASES[index]!.key} 个用例` })
      // 每个回合产生 user + assistant 两条，所以第 n 轮结束时应为 (n+1)*2 条
      const settled = await waitForRun(call, conversationId, 120_000)
      // 落库原文是否保留换行与围栏：渲染异常时先确认"存进去的还在不在"
      const page0 = await call<{ messages?: Array<{ role: string; content: string; status: string }> }>(
        'query.conversations.messages', { conversationId, limit: 200 })
      const lastAssistant = [...(page0.messages ?? [])].reverse().find((m) => m.role === 'assistant')
      console.log(`        [stored] 第 ${index + 1} 条 status=${lastAssistant?.status} 换行数=${(lastAssistant?.content.match(/\n/g) ?? []).length} 含围栏=${lastAssistant?.content.includes('\u0060\u0060\u0060')}`)
      if (!settled.ok) throw new Error(`用例 ${CASES[index]!.key} 的回合未在时限内结束（status=${settled.status || '未知'}）`)

      if (settled.status !== 'complete') throw new Error(`用例 ${CASES[index]!.key} 的回合以 ${settled.status} 结束，模型未正常回复`)
    }
    caseIndex = CASES.length
    const joined = deltas.join('')
    console.log(`        [delta] 共 ${deltas.length} 片、合计 ${joined.length} 字符、换行 ${(joined.match(/\n/g) ?? []).length} 个`)

    // 打开会话页并注入探针：应用自己恢复"当前会话"，这里直接量 DOM 里的消息。
    const page = await fetch(`${base}/`, { headers: jar, redirect: 'manual' })
    console.log('        [fetch] / → ' + page.status + ' cookie=' + (jar.cookie ? '有' : '无'))
    if (page.status !== 200) throw new Error(`抓取应用页失败：${page.status} → ${page.headers.get('location') ?? ''}`)
    const html = await page.text()
    const injected = injectProbe(html)
    console.log('        [inject] 原页=' + html.length + ' 注入后=' + injected.length
      + ' 含探针=' + injected.includes(PROBE_SCRIPT))
    writeFileSync(join(rendererDir, RENDER_TARGET), injected)

    const url = `${base}/${PROBE_PAGE}?target=${encodeURIComponent(`/${RENDER_TARGET}`)}`
      + `&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`
    const { stdout, note } = await runChromium(['--virtual-time-budget=25000', '--dump-dom', url])
    console.log('        [dump] 长度=' + stdout.length + ' 探针节点=' + stdout.includes('id="renderprobe"')
      + ' 片段=' + JSON.stringify(stdout.slice(0, 160)))
    const shapes = readShapes(stdout)
    // 把首条的 DOM 结构打出来，便于确认渲染器实际产出的标记
    if (shapes?.[0] !== undefined) {
      console.log('        [DOM] ' + ((shapes[0] as unknown as { html?: string }).html ?? '(无)').replace(/\n/g, ' '))
    }
    if (shapes === undefined) {
      for (const id of ['R-1', 'R-2', 'R-3']) record(id, false, `浏览器未取到渲染结果${note === '' ? '' : `｜${note}`}`)
      return
    }

    const shapeOf = (key: string): Shape | undefined => {
      const index = CASES.findIndex((item) => item.key === key)
      return index < 0 ? undefined : shapes[index]
    }

    const regression = shapeOf('regression')
    record('R-1', regression !== undefined && regression.codeBlocks >= 1 && !regression.leakedFence,
      regression === undefined
        ? `只渲染出 ${shapes.length} 条消息，未取到回归用例`
        : `事故写法：代码块 ${regression.codeBlocks} 个、围栏残留=${regression.leakedFence}、高亮=${regression.highlighted}`)

    const lower = shapeOf('lowercase')
    const bare = shapeOf('bare-fence')
    record('R-2', (lower?.codeBlocks ?? 0) >= 1 && (bare?.codeBlocks ?? 0) >= 1,
      `其它形态仍正常：小写包裹标签 ${lower?.codeBlocks ?? '—'} 个、裸围栏 ${bare?.codeBlocks ?? '—'} 个`)

    const plain = shapeOf('plain')
    const plainOk = plain !== undefined
      && plain.codeBlocks === 0
      && plain.text.includes('不要闹')
      && plain.text.includes('第二段仍要正常分段')
    record('R-3', plainOk,
      plain === undefined
        ? '未取到普通正文用例'
        : `普通正文未被误改：代码块 ${plain.codeBlocks} 个、正文完整=${plain.text.includes('不要闹')}`)

    record('R-4', shapes.length >= CASES.length, `共渲染 ${shapes.length} 条消息（用例 ${CASES.length} 条）`)
    for (const item of CASES) {
      const shape = shapeOf(item.key)
      console.log(`        · ${item.label} → 代码块 ${shape?.codeBlocks ?? '—'}${shape?.highlighted ? '（已高亮）' : ''}`)
      if (item.key === 'regression' && shape !== undefined) {
        console.log('        [markup] ' + String((shape as unknown as { html?: string }).html ?? '').slice(0, 700))
      }
    }
  } finally {
    await mock.close()
    lease?.release()
    for (const path of [probePath, driverPath, scriptPath, join(rendererDir, RENDER_TARGET)]) rmSync(path, { force: true })
    await stack.close()
    await rm(root, { recursive: true, force: true })
  }

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log(`\n== 结果：${outcomes.length - failed.length}/${outcomes.length} 通过 ==\n`)
  if (failed.length > 0) {
    console.log('未通过：' + failed.map((outcome) => outcome.id).join('、'))
    process.exitCode = 1
  }
}

await main()
