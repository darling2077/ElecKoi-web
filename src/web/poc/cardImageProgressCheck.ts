/**
 * 验收：导入角色卡时**同步**搬运卡片图片，并在界面上给出进度条。
 *
 * 要验证的是用户实际感受到的那条路径，所以这里不用假的内部调用，而是：
 *   1. 起一个本地假图床（POST /api/upload，故意加延迟让过程可观察）；
 *   2. 起真实服务，用 CDP 打开应用页面；
 *   3. **在页面里**调用 window.eleckoi.request 发起导入（与用户点「导入」同一条路）；
 *   4. 导入还在进行时，从浏览器里读进度条元素的状态；
 *   5. 导入返回后，检查库里的引用是否已改写、进度是否复位。
 *
 * 运行：pnpm webui:cardimages
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { WebHost } from '../WebHost'
import { singleTenantResolver, startWebServer } from '../http/server'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

const IMAGE_COUNT = 12

/** 一张 8×8 的合法 PNG，用来当"卡片里的外链图"。 */
function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGP8z4AATBiciOE/BQIAoGkEAc1n6m0AAAAASUVORK5CYII=',
    'base64'
  )
}

interface FakeHost {
  servers: Server[]
  /** 别家的图床：卡片里的"外链原图"从这里来（必须与自己的图床**不同源**）。 */
  sourceOrigin: string
  /** 自己的图床：上传接口与搬好后的地址。 */
  hostOrigin: string
  uploads: number
}

/**
 * 两个假服务，因为**关键点就是两个源不同**：
 *  - sourceOrigin：模拟别家图床，提供卡片里引用的原图；
 *  - hostOrigin：模拟自己的图床，提供 POST /api/upload。
 * 若图省事用同一个源，搬运器会认为"已经是我自己的地址"而跳过，
 * 验收就会假装通过——第一版就是这么写错的。
 * 上传故意延迟 120ms：真图床就是要花时间，验收要能在窗口期里观察进度条。
 */
async function startFakeHost(): Promise<FakeHost> {
  const png = tinyPng()
  const state = { uploads: 0 }
  const listen = async (handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> => {
    const server = createServer(handler)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return { server, origin: `http://127.0.0.1:${port}` }
  }

  const source = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) })
      res.end(png)
      return
    }
    res.writeHead(404).end()
  })

  const host = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // 上传完成后能按返回的地址取回原图（真实图床就是这个行为）
    if (req.method === 'GET' && url.pathname.startsWith('/u/')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) })
      res.end(png)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        state.uploads += 1
        const name = `uploaded-${state.uploads}.png`
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ files: [{ id: name, name, url: `${host.origin}/u/${name}` }] }))
        }, 400)
      })
      return
    }
    res.writeHead(404).end()
  })

  return {
    servers: [source.server, host.server],
    sourceOrigin: source.origin,
    hostOrigin: host.origin,
    uploads: 0
  }
}

/** 极简 CDP：只用 Runtime.evaluate 读页面状态。 */
class Cdp {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((done, fail) => {
      ws.addEventListener('open', () => done(), { once: true })
      ws.addEventListener('error', () => fail(new Error('CDP 连接失败')), { once: true })
    })
    return new Cdp(ws)
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 在页面里执行表达式并取回 JSON 值。 */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }) as { result?: { value?: T }; exceptionDetails?: { text?: string } }
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? '页面内执行出错')
    return result.result?.value as T
  }

  close(): void {
    this.ws.close()
  }
}

async function waitForEndpoint(port: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      const payload = await response.json() as { webSocketDebuggerUrl?: string }
      if (payload.webSocketDebuggerUrl) return payload.webSocketDebuggerUrl
    } catch {
      // 还没起来
    }
    await new Promise((done) => setTimeout(done, 300))
  }
  throw new Error('Chromium 调试端口未就绪')
}

/** 带上外链图片的极简角色卡。 */
function cardWithImages(origin: string, name: string): string {
  const images = Array.from({ length: IMAGE_COUNT }, (_, index) => `<img src="${origin}/img/${index + 1}.png">`).join('\n')
  return JSON.stringify({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name,
      description: `正文里带了 ${IMAGE_COUNT} 张外链图片。`,
      first_mes: `开场白：\n${images}`,
      alternate_greetings: [],
      character_book: { name: '设定', entries: [] },
      extensions: {}
    }
  })
}


/**
 * 四种做法各跑一遍导入，检查"搬完之后卡里的引用长什么样"。
 *
 * 这条是给用户看的承诺：改 ELECKOI_CARD_IMAGE_MODE 一个变量，行为就跟着变，
 * 且都不需要动上游代码。用真实导入 + 真实 HTTP 取回验证，不看内部实现。
 */
async function checkMode(
  mode: string,
  env: Record<string, string>,
  expectation: { pattern: RegExp; fetchable: boolean; label: string }
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `eleckoi-mode-${mode}-`))
  const fake = await startFakeHost()
  // 每个模式都用独立的租户，互不影响。
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ELECKOI_IMAGE_') || key === 'ELECKOI_CARD_IMAGE_MODE' || key === 'ELECKOI_CARD_ORIGIN') delete process.env[key]
  }
  process.env.ELECKOI_CARD_IMAGE_MODE = mode
  process.env.ELECKOI_IMAGE_ALLOW_LOCAL = '1'
  process.env.ELECKOI_IMAGE_LOCALIZE_MODE = 'inline'
  // __HOST__ 占位符替换成本次假图床的地址（每次端口都不同，没法写死）
  for (const [key, value] of Object.entries(env)) process.env[key] = value.replace('__HOST__', fake.hostOrigin)

  const tenant = await WebHost.mountTenant({
    tenantId: `tenant-mode-${mode}`,
    tenantRoot: join(root, 'tenant'),
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-cardimages'
  })
  const server = await startWebServer({
    host: '127.0.0.1',
    port: 0,
    rendererDir: resolve('out/renderer'),
    // local 模式必须把它挂上，否则 /card-images/ 无人提供（生产里由 entry.ts 决定）
    ...(mode === 'local' ? { cardImageDir: process.env.ELECKOI_IMAGE_LOCAL_DIR ?? '/data/card-images' } : {}),
    resolveSession: singleTenantResolver(tenant.gateway, tenant.context.mediaAssets)
  })
  const base = server.url

  try {
    const card = cardWithImages(fake.sourceOrigin, `模式-${mode}-${Date.now()}`)
    void fake
    const prepared = await fetch(`${base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'command.characters.import.prepare',
        input: {
          source: 'sillytavern',
          files: [{ displayName: 'mode.json', mimeType: 'application/json', base64: Buffer.from(card, 'utf8').toString('base64') }]
        }
      })
    }).then((r) => r.json()) as { ok: boolean; data?: { token: string } }
    if (!prepared.ok || prepared.data === undefined) throw new Error('prepare 失败')
    const committed = await fetch(`${base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'command.characters.import.commit', input: { token: prepared.data.token } })
    }).then((r) => r.json()) as { ok: boolean }
    if (!committed.ok) throw new Error('commit 失败')

    const database = new Database(join(root, 'tenant', 'db', 'eleckoi-common.sqlite3'), { readonly: true })
    const rows = database.prepare('SELECT content FROM character_text_contents').all() as Array<{ content: string }>
    database.close()
    const text = rows.map((row) => row.content).join('\n')
    const outside = text.match(new RegExp(`${fake.sourceOrigin}/img/`, 'g'))?.length ?? 0
    const matched = (text.match(expectation.pattern) ?? []).length
    record(`MODE-${mode}`, matched >= IMAGE_COUNT && outside === 0,
      `${expectation.label}：改写 ${matched}/${IMAGE_COUNT} 处，残留原地址 ${outside} 处`)

    // self-hosted / local 的图应当能被取回；inline 是 data: URI，不需要取回。
    if (expectation.fetchable && matched > 0) {
      const raw = (text.match(expectation.pattern) ?? [''])[0]
      // local 模式在没配卡片源时给的是相对地址（/card-images/xxx），补上服务地址再取。
      const probe = raw.startsWith('http') ? raw : `${base}${raw}`
      const response = await fetch(probe).catch(() => undefined)
      record(`MODE-${mode}-取回`, response !== undefined && response.status === 200 && (response.headers.get('content-type') ?? '').startsWith('image/'),
        `${expectation.label}：搬完的地址可直接取回 → HTTP ${response?.status ?? '失败'} ${response?.headers.get('content-type') ?? ''}`)
    }
  } finally {
    await server.close()
    await tenant.dispose()
    for (const server of fake.servers) server.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'eleckoi-cardimages-'))
  const fake = await startFakeHost()
  // WebHost 在挂载租户时按环境变量装配自动搬图，所以先设好再挂载。
  process.env.ELECKOI_IMAGE_PUBLIC_BASE = fake.hostOrigin
  process.env.ELECKOI_IMAGE_UPLOAD_API = fake.hostOrigin
  process.env.ELECKOI_IMAGE_UPLOAD_TOKEN = 'test-token'
  process.env.ELECKOI_IMAGE_LOCALIZE_MODE = 'inline'
  process.env.ELECKOI_IMAGE_CONCURRENCY = '3'
  // 假图床就在本机，而生产默认会跳过本机地址（卡作者写死的 localhost 开发地址）。
  process.env.ELECKOI_IMAGE_ALLOW_LOCAL = '1'

  const tenant = await WebHost.mountTenant({
    tenantId: 'tenant-card-images',
    tenantRoot: join(root, 'tenant'),
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-cardimages'
  })
  const server = await startWebServer({
    host: '127.0.0.1',
    port: 0,
    rendererDir: resolve('out/renderer'),
    resolveSession: singleTenantResolver(tenant.gateway, tenant.context.mediaAssets)
  })
  const base = server.url
  console.log(`\n== 导入卡片时的搬图进度验收 ==\n服务：${base}\n假图床（原图）：${fake.sourceOrigin}\n自己的图床（上传）：${fake.hostOrigin}\n`)

  const port = 9300 + Math.floor(Math.random() * 400)
  const profile = mkdtempSync(join(tmpdir(), 'eleckoi-cardimages-chrome-'))
  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-sync', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`, 'about:blank'
  ], { stdio: 'ignore' })

  try {
    // ── P-1：未导入时进度是空闲的 ──
    const idle = await (await fetch(`${base}/api/card-images/progress`)).json() as { ok: boolean; data: { active: boolean } }
    record('CI-1', idle.ok && idle.data.active === false, `未导入时 active=${idle.data.active}`)

    const browserWs = await waitForEndpoint(port)
    const browser = await Cdp.connect(browserWs)
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()) as Array<{ id: string; webSocketDebuggerUrl: string }>
    const pageInfo = list.find((item) => item.id === targetId)
    if (pageInfo === undefined) throw new Error('找不到新建页面目标')
    const page = await Cdp.connect(pageInfo.webSocketDebuggerUrl)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Page.navigate', { url: `${base}/` })

    // 等桥脚本就位
    const deadline = Date.now() + 30_000
    let bridgeReady = false
    while (Date.now() < deadline) {
      bridgeReady = await page.evaluate<boolean>('Boolean(window.eleckoi && window.eleckoi.request)').catch(() => false)
      if (bridgeReady) break
      await new Promise((done) => setTimeout(done, 300))
    }
    record('CI-2', bridgeReady, '应用页面里的桥脚本已就位（window.eleckoi.request 可用）')

    // ── 在页面里发起导入（与用户点「导入」同一条路）──
    const card = cardWithImages(fake.sourceOrigin, `进度验收-${Date.now()}`)
    const started = Date.now()
    const importPromise = page.evaluate<{ ok: boolean; data?: { importedCharacterIds?: string[] }; error?: { message: string } }>(`
      (async () => {
        const prepared = await window.eleckoi.request('command.characters.import.prepare', {
          source: 'sillytavern',
          files: [{ displayName: 'progress.json', mimeType: 'application/json', base64: ${JSON.stringify(Buffer.from(card, 'utf8').toString('base64'))} }]
        });
        if (!prepared.ok) return prepared;
        return await window.eleckoi.request('command.characters.import.commit', { token: prepared.data.token });
      })()
    `)

    // ── P-3：导入进行中，进度条必须可见且计数在涨 ──
    let sawVisible = false
    let sawText = ''
    let maxDone = 0
    const observations: string[] = []
    while (Date.now() - started < 60_000) {
      const snapshot = await page.evaluate<{ display: string; text: string; width: string }>(`
        (() => {
          const node = document.querySelector('[data-eleckoi-card-images]');
          if (!node) return { display: 'missing', text: '', width: '' };
          const bar = node.lastElementChild && node.lastElementChild.firstElementChild;
          return { display: node.style.display, text: node.textContent || '', width: bar ? bar.style.width : '' };
        })()
      `).catch(() => ({ display: 'error', text: '', width: '' }))
      if (snapshot.display === 'block') {
        sawVisible = true
        if (snapshot.text !== sawText) observations.push(`${snapshot.text}｜条宽 ${snapshot.width}`)
        sawText = snapshot.text
        const match = /(\d+)\/(\d+)/.exec(snapshot.text)
        if (match) maxDone = Math.max(maxDone, Number(match[1]))
      }
      const settled = await Promise.race([importPromise.then(() => true), Promise.resolve(false)])
      if (settled && !sawVisible) break
      if (settled) break
      await new Promise((done) => setTimeout(done, 120))
    }

    record('CI-3', sawVisible, sawVisible
      ? `导入进行中进度条可见，观察到 ${observations.length} 次变化：${observations.slice(0, 3).join(' → ')}`
      : '导入期间没有看到进度条（这是用户最直接的感受，必须可见）')
    record('CI-4', maxDone > 0 && maxDone <= IMAGE_COUNT,
      `进度条计数推进到 ${maxDone}/${IMAGE_COUNT}`)

    const imported = await importPromise
    record('CI-5', imported.ok === true && (imported.data?.importedCharacterIds?.length ?? 0) === 1,
      imported.ok ? '导入返回成功（进度条走完才返回）' : `导入失败：${imported.error?.message ?? '未知'}`)

    // ── P-6：库里引用已改写，且没有残留外链原地址 ──
    const database = new Database(join(root, 'tenant', 'db', 'eleckoi-common.sqlite3'), { readonly: true })
    let rewritten = 0
    let leftover = 0
    for (const row of database.prepare('SELECT content FROM character_text_contents').all() as Array<{ content: string }>) {
      rewritten += (row.content.match(new RegExp(`${fake.hostOrigin}/u/`, 'g')) ?? []).length
      leftover += (row.content.match(new RegExp(`${fake.sourceOrigin}/img/`, 'g')) ?? []).length
    }
    database.close()
    record('CI-6', rewritten === IMAGE_COUNT && leftover === 0,
      `导入结束即已改写 ${rewritten}/${IMAGE_COUNT} 处引用，残留原地址 ${leftover} 处`)

    // ── P-7：结束后进度复位 ──
    const after = await (await fetch(`${base}/api/card-images/progress`)).json() as { data: { active: boolean; lastLocalized?: number } }
    // 统计口径是"改写了几处引用"：同一张图可能同时出现在正文与设定条目里，所以是 2 倍。
    record('CI-7', after.data.active === false && (after.data.lastLocalized ?? 0) >= IMAGE_COUNT,
      `结束后 active=${after.data.active}，本次改写引用 ${after.data.lastLocalized} 处`)

    // ── P-8：进度接口不泄露信息给未登录以外的路径（只做形状检查）──
    const shape = await page.evaluate<string>(`fetch('/api/card-images/progress').then(r => r.headers.get('content-type') || '')`)
    record('CI-8', shape.includes('application/json'), `进度接口返回 ${shape}`)

    page.close()
    browser.close()
  } finally {
    if (!chrome.killed) chrome.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
    await server.close()
    await tenant.dispose()
    for (const server of fake.servers) server.close()
    await rm(root, { recursive: true, force: true })
  }

  // ── 四种做法各跑一遍 ──
  await checkMode('self-hosted', {
    ELECKOI_IMAGE_PUBLIC_BASE: '__HOST__',
    ELECKOI_IMAGE_UPLOAD_API: '__HOST__',
    ELECKOI_IMAGE_UPLOAD_TOKEN: 'test-token'
  }, { pattern: /http:\/\/127\.0\.0\.1:\d+\/u\//g, fetchable: true, label: 'self-hosted：传进图床' })
    .catch((error) => record('MODE-self-hosted', false, String(error)))

  await checkMode('local', { ELECKOI_IMAGE_LOCAL_DIR: join(tmpdir(), `eleckoi-card-images-${Date.now()}`) }, {
    pattern: /\/card-images\/[a-f0-9]{32}\.png/g,
    fetchable: true,
    label: 'local：存本地目录并由本服务提供'
  }).catch((error) => record('MODE-local', false, String(error)))

  await checkMode('inline', {}, {
    pattern: /data:image\/png;base64,/g,
    fetchable: false,
    label: 'inline：内联成 data URI'
  }).catch((error) => record('MODE-inline', false, String(error)))

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log(`\n== 结果：${outcomes.length - failed.length}/${outcomes.length} 通过 ==`)
  if (failed.length > 0) {
    console.log(`失败项：${failed.map((item) => item.id).join(', ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
