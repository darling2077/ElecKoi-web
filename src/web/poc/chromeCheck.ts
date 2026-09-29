/**
 * 「Web 外壳」验收：账号体系 + 应用能在真实浏览器里挂载。
 *
 * ⚠️ v0.2.0 起语义换了一代。上游把界面搬进了 **DSH 客户端插件体系**：
 *   桌面端主窗口加载 DSH 官方 Web 前端，由宿主注入 injections 与我们的桥
 *   （`window.eleckoi`），其余请求反代到该租户的 DSH 插件宿主。
 *   旧 React 应用（`out/renderer`）在 v0.2.0 已是死代码，所以"标题栏钩子是否命中"
 *   这类断言不再有意义。
 *
 * 现在断言的是**界面可用的充要条件**，且不依赖上游任何具体类名：
 *   C-1/C-2 桥与启动门面确实进了应用文档；
 *   C-3..C-5 账号体系（注册/账号页/改密码）；
 *   C-6..C-8 真实浏览器里应用挂载成功（`__ELECKOI_DSH_APP__`）、桥就位、
 *           并且桥能完成一次真实 RPC（打通 /api/rpc）。
 *
 * 运行：pnpm webui:chrome
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startWebUiStack } from '../stack'
import { Cdp, waitForPageEndpoint } from './cdp'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

interface AppState {
  app: string
  platform: string
  bridgeRequest: string
  bridgeSubscribe: string
  bootFailed: boolean
  text: string
}

async function main(): Promise<void> {
  // 事件流是长连接，无头快照会被它拖住；这组只关心首屏挂载。
  process.env.ELECKOI_DISABLE_EVENT_STREAM = '1'

  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-chrome-'))
  const rendererDir = resolve('out/renderer')
  mkdirSync(rendererDir, { recursive: true })

  const stack = await startWebUiStack({
    dataRoot: root,
    rendererDir,
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-chrome',
    port: 0,
    allowRegistration: true
  })
  const base = stack.server.url
  const email = 'chrome@example.com'
  const password = 'chrome-check-password'
  console.log(`\n== Web 外壳验收（v0.2.0 架构）==\n服务地址：${base}\n`)

  const jar: Record<string, string> = {}
  const capture = (response: Response): void => {
    for (const entry of response.headers.getSetCookie?.() ?? []) {
      const pair = entry.split(';')[0] ?? ''
      if (pair.startsWith('eleckoi_session=')) jar.cookie = pair
    }
  }

  try {
    capture(await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    }))

    // ── C-1 桥脚本 ──
    // 桥是 ElecKoi 的 DSH 插件在 apply 阶段就要用的东西（`new XxxCatalog(window.eleckoi)`），
    // 少它整块界面起不来，所以单独断言它可达且契约完整。
    const bridge = await fetch(`${base}/__eleckoi/web-bridge.js`)
    const bridgeSource = await bridge.text()
    record('C-1', bridge.status === 200 && bridgeSource.includes('window.eleckoi') && bridgeSource.includes('request'),
      `GET /__eleckoi/web-bridge.js → ${bridge.status}，${bridgeSource.length} 字节，含 window.eleckoi 与 request`)

    // ── C-2 应用文档 ──
    const appHtml = await (await fetch(`${base}/`, { headers: jar })).text()
    const marks = {
      bridge: appHtml.includes('/__eleckoi/web-bridge.js'),
      bootReady: appHtml.includes('__DSH_BOOT_READY__'),
      moduleLoader: appHtml.includes('__ModuleLoader__'),
      clientAssets: appHtml.includes('__ELECKOI_CLIENT_ASSETS__'),
      eleckoiAssets: appHtml.includes('/eleckoi/assets/')
    }
    const missing = Object.entries(marks).filter(([, ok]) => !ok).map(([name]) => name)
    record('C-2', missing.length === 0,
      missing.length === 0
        ? '应用文档已带桥脚本、DSH 启动门面与 ElecKoi 资源表'
        : `应用文档缺：${missing.join(', ')}`)

    // ── C-3 账号页 ──
    const account = await fetch(`${base}/account`, { headers: jar })
    const accountHtml = await account.text()
    record('C-3', account.status === 200 && accountHtml.includes(email) && accountHtml.includes('修改密码'),
      `/account → ${account.status}，含邮箱与修改密码表单`)

    const anonymousAccount = await fetch(`${base}/account`, { redirect: 'manual' })
    record('C-4', anonymousAccount.status === 302, `未登录访问 /account → ${anonymousAccount.status} → ${anonymousAccount.headers.get('location')}`)

    // ── C-5 改密码 ──
    const badChange = await fetch(`${base}/api/auth/password`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...jar },
      body: JSON.stringify({ current: 'wrong-password', next: 'brand-new-password' })
    })
    const changed = await fetch(`${base}/api/auth/password`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...jar },
      body: JSON.stringify({ current: password, next: 'brand-new-password' })
    })
    const oldLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    const newLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'brand-new-password' })
    })
    record('C-5',
      badChange.status === 400 && changed.ok && oldLogin.status === 401 && newLogin.ok,
      `错误当前密码 → ${badChange.status}；正确修改 → ${changed.status}；旧密码登录 → ${oldLogin.status}；新密码登录 → ${newLogin.status}`)

    // ── C-6..C-8 真实浏览器 ──
    // 用 CDP 而不是 --dump-dom：DSH 界面要等插件清单与传输就绪才挂载，
    // 而且我们要在页面里直接调桥做一次真实 RPC。
    const profile = mkdtempSync(join(tmpdir(), 'eleckoi-chrome-'))
    const port = 9400 + Math.floor(Math.random() * 400)
    const browser = spawn('chromium', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--disable-sync', '--disable-features=Translate,BackForwardCache',
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
    ], { stdio: 'ignore' })

    let cdp: Cdp | undefined
    try {
      cdp = await Cdp.connect(await waitForPageEndpoint(port))
      await cdp.send('Network.enable')
      const token = (jar.cookie ?? '').replace('eleckoi_session=', '')
      await cdp.send('Network.setCookie', { name: 'eleckoi_session', value: token, url: base, path: '/' })
      await cdp.send('Page.enable')
      await cdp.send('Page.navigate', { url: `${base}/` })

      // 导航刚提交时 document.body 还不存在，先给它一拍再进轮询。
      await new Promise((done) => setTimeout(done, 800))

      // DSH 客户端要先拉插件清单、建好传输再挂载，给足 60 秒。
      let state: AppState = { app: 'undefined', platform: 'undefined', bridgeRequest: 'undefined', bridgeSubscribe: 'undefined', bootFailed: false, text: '' }
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        state = await cdp.evaluate<AppState>(`(() => ({
          app: typeof globalThis.__ELECKOI_DSH_APP__,
          platform: typeof globalThis.__ELECKOI_DSH_PLATFORM__,
          bridgeRequest: typeof window.eleckoi?.request,
          bridgeSubscribe: typeof window.eleckoi?.subscribe,
          bootFailed: (document.body?.innerText ?? '').includes('Failed to load plugin'),
          text: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 120)
        }))()`)
        if (state.app === 'function' && state.bridgeRequest === 'function') break
        await new Promise((done) => setTimeout(done, 1000))
      }

      record('C-6', state.app === 'function' && !state.bootFailed,
        state.app === 'function'
          ? `应用已在真实浏览器里挂载（__ELECKOI_DSH_APP__=${state.app}，平台=${state.platform}）：${state.text}`
          : `应用未挂载${state.bootFailed ? '（页面报 Failed to load plugin）' : ''}：${state.text}`)

      record('C-7', state.bridgeRequest === 'function' && state.bridgeSubscribe === 'function',
        `桥就位：request=${state.bridgeRequest}、subscribe=${state.bridgeSubscribe}`)

      // 真正跑一次 RPC：这一步打通"浏览器 → 我们的 /api/rpc → 租户运行时"。
      const rpc = await cdp.evaluate<string>(`window.eleckoi.request('query.characters.list', {})
        .then(() => 'ok')
        .catch((error) => 'err:' + String(error && error.message || error))`)
      record('C-8', rpc === 'ok', `桥完成一次真实 RPC（query.characters.list）→ ${rpc}`)
    } finally {
      cdp?.close()
      browser.kill('SIGKILL')
      // 等进程真的退出再删 profile：chromium 还在写时直接删会 ENOTEMPTY，
      // 那个异常会盖住真正的断言结果（上一版就吃过这个亏）。
      await new Promise<void>((done) => {
        if (browser.exitCode !== null || browser.signalCode !== null) return done()
        browser.once('exit', () => done())
        setTimeout(done, 5000)
      })
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // 临时目录删不掉不影响验收结论
      }
    }
  } catch (error) {
    record('C-9', false, `流程中断：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await stack.close()
    await rm(root, { recursive: true, force: true })
  }

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log(`\n== 结果：${outcomes.length - failed.length}/${outcomes.length} 通过 ==`)
  if (failed.length > 0) {
    console.log(`失败项：${failed.map((item) => item.id).join(', ')}`)
    process.exitCode = 1
  }
}

await main()
