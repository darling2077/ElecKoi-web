/**
 * 「Web 外壳」验收：隐藏桌面端窗口按钮 + 账号区 + 账号管理页。
 *
 * 关键的一条是**升级探针**：我们的样式挂在 `.client-titlebar .window-controls`
 * 这个上游类名上。上游若改了它，注入会失效、旧按钮会重新出现。因此这里在真实浏览器里
 * 断言该钩子仍然命中——上游一改就报警，而不是等用户发现。
 *
 * 运行：pnpm webui:chrome
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startWebUiStack } from '../stack'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

const TEST_PAGE = '__chrometest.html'
const TEST_SCRIPT = '__chrometest.js'

/**
 * 测试页：先用 fetch 登录（拿到会话 Cookie），再整页跳到应用。
 *
 * 不能把应用放进 iframe 读它的 DOM——我们自己的加固（X-Frame-Options: DENY、
 * frame-ancestors 'none'）不允许应用被任何页面嵌套，包括同源测试页。
 * 于是改成跳转，再用无头浏览器的 DOM 快照做断言。
 */
function renderTestPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>chrome-test</title></head>
<body><pre id="out">pending</pre><script src="/${TEST_SCRIPT}"></script></body></html>
`
}

function renderTestScript(): string {
  return `(() => {
  const params = new URLSearchParams(location.search);
  const beacon = params.get('beacon') || '';
  const email = params.get('email') || '';
  const password = params.get('password') || '';
  const out = document.getElementById('out');
  (async () => {
    const login = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!login.ok) { out.textContent = 'LOGIN-FAILED ' + login.status; return; }
    location.replace('/');
  })().catch((error) => { out.textContent = 'ERROR ' + String(error); });
})();
`
}

/**
 * 登录后整页跳转到应用，再取最终 DOM 快照。
 * 必须用异步 spawn：被测服务就在本进程内，spawnSync 会阻塞事件循环让浏览器等不到响应。
 */
function captureAppDom(url: string, timeoutMs = 90_000): Promise<{ dom: string; note: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'eleckoi-chrome-'))
  return new Promise((resolveDom) => {
    const child = spawn('chromium', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--disable-sync', '--disable-features=Translate,BackForwardCache',
      `--user-data-dir=${profile}`, '--virtual-time-budget=8000', '--dump-dom', url
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let dom = ''
    let stderr = ''
    let settled = false
    const finish = (note: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      rmSync(profile, { recursive: true, force: true })
      resolveDom({ dom, note })
    }
    const timer = setTimeout(() => finish(`超时 ${timeoutMs} ms`), timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { dom += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('close', () => {
      if (dom.length > 0) return finish('')
      const errors = stderr.split('\n').filter((line: string) => line.includes('ERROR') && !line.includes('dbus') && !line.includes('gcm'))
      finish(`空输出｜${errors.slice(-2).join(' | ')}`)
    })
  })
}

async function main(): Promise<void> {
  // 无头快照必须让网络进入空闲：桥的 SSE 长连接会让 --virtual-time-budget 永不结束。
  process.env.ELECKOI_DISABLE_EVENT_STREAM = '1'

  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-chrome-'))
  const rendererDir = resolve('out/renderer')
  mkdirSync(rendererDir, { recursive: true })
  const pagePath = join(rendererDir, TEST_PAGE)
  const scriptPath = join(rendererDir, TEST_SCRIPT)
  writeFileSync(pagePath, renderTestPage())
  writeFileSync(scriptPath, renderTestScript())

  const stack = await startWebUiStack({
    dataRoot: root,
    rendererDir,
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-chrome',
    port: 0,
    allowRegistration: true,
    // 测试页需要免鉴权才能加载（否则会被 302 到 /login，脚本根本没机会执行）
    publicPaths: [`/${TEST_PAGE}`, `/${TEST_SCRIPT}`]
  })
  const base = stack.server.url
  const email = 'chrome@example.com'
  const password = 'chrome-check-password'
  console.log(`\n== Web 外壳验收 ==\n服务地址：${base}\n`)

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

    // ── 静态资源 ──
    const css = await (await fetch(`${base}/__eleckoi/web-chrome.css`)).text()
    record('C-1', css.includes('.client-titlebar .window-controls') && css.includes('display: none'),
      '外壳样式已提供，且明确隐藏 .window-controls')

    const appHtml = await (await fetch(`${base}/`, { headers: jar })).text()
    record('C-2', appHtml.includes('/__eleckoi/web-chrome.css') && appHtml.includes('/__eleckoi/web-chrome.js'),
      '应用页面已注入外壳样式与脚本（均为同源外链，无需放宽 CSP）')

    // ── 账号管理页 ──
    const account = await fetch(`${base}/account`, { headers: jar })
    const accountHtml = await account.text()
    record('C-3', account.status === 200 && accountHtml.includes(email) && accountHtml.includes('修改密码'),
      `/account → ${account.status}，含邮箱与修改密码表单`)

    const anonymousAccount = await fetch(`${base}/account`, { redirect: 'manual' })
    record('C-4', anonymousAccount.status === 302, `未登录访问 /account → ${anonymousAccount.status} → ${anonymousAccount.headers.get('location')}`)

    // ── 改密码 ──
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

    // ── 真实浏览器 ──
    const { dom, note } = await captureAppDom(
      `${base}/${TEST_PAGE}?email=${encodeURIComponent(email)}&password=${encodeURIComponent('brand-new-password')}`
    )
    const diag = /DIAG[^<]*/.exec(dom)?.[0]
    writeFileSync('/tmp/chrome-dom.html', dom)
    console.log(`        · 浏览器最终 DOM 已存到 /tmp/chrome-dom.html；诊断=${diag ?? '(无，说明已跳转)'}`)
    const hook = /data-eleckoi-web-chrome="([a-z]+)"/.exec(dom)?.[1]
    const controlsPresent = dom.includes('class="window-controls"')
    const accountRendered = dom.includes('eleckoi-web-account__trigger') && dom.includes(email)

    record('C-6', hook === 'hooked' && controlsPresent,
      hook === undefined
        ? `升级探针未命中：DOM 里没有外壳标记（${note || `DOM ${dom.length} 字节`}）——上游可能改了类名`
        : `升级探针：上游 .client-titlebar .window-controls 钩子仍命中（${hook}），上游控件仍在 DOM 中`)

    record('C-7', accountRendered,
      accountRendered
        ? `账号区已在真实浏览器里渲染，并显示登录邮箱 ${email}`
        : `账号区未渲染（DOM ${dom.length} 字节${note === '' ? '' : `｜${note}`}）`)

    record('C-8', dom.includes('账号管理') && dom.includes('退出登录'),
      '账号区菜单含「账号管理」与「退出登录」')
  } catch (error) {
    record('C-9', false, `流程中断：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await stack.close()
    rmSync(pagePath, { force: true })
    rmSync(scriptPath, { force: true })
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
