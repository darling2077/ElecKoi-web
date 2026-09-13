/**
 * 「我们自己的页面与应用是一套 UI」验收：登录 / 账号 / 用户管理。
 *
 * 这一版的三个页面不再自带色板，而是引用 /__eleckoi/app-tokens.css
 * ——从上游构建产物里提取的 `:root` 令牌与 Noto Sans 字体。
 * 于是要守住两条：
 *   ① 令牌确实来自构建产物（不是我们抄的一份常量，上游改版要能跟着变）；
 *   ② 页面真的用上了它（真实浏览器里的**计算样式**，不是"HTML 里写了 var()"）。
 *
 * 做法：把服务端渲染出来的 HTML 原样抓下来，追加一段只读探针脚本，
 * 作为同源公开文件重新提供给浏览器——这样量到的仍是真实 HTML + 真实 CSS + 真实字体。
 * 副作用是这份副本没有 CSP，所以页面自己的 CSP 另由 A-5 断言（必须放行样式表与字体）。
 *
 * 运行：pnpm webui:appearance
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startWebUiStack } from '../stack'
import { APP_TOKENS_PATH } from '../http/appTokens'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

/** 旧的青绿配色：只要还留一个，就说明这页没真正改用应用令牌。 */
const LEGACY_PALETTE = ['#0e1a1f', '#16262d', '#24373f', '--abyss', '--kelp', '--tide', 'Georgia']

const PROBE_PAGE = '__appearanceprobe.html'
/** 登录并跳转到被测页面（跑在探针页上）。 */
const PROBE_DRIVER = '__appearanceprobe-driver.js'
/** 量计算样式（被注入到被测页面里）。 */
const PROBE_SCRIPT = '__appearanceprobe.js'

/** 只读探针：量计算样式，写进 <pre>，供 --dump-dom 抓取。 */
function probeScript(): string {
  return `(() => {
  const params = new URLSearchParams(location.search);
  // ?theme=dark 用来单独验证暗色令牌块；不传则用页面自己根据应用设置定下的主题。
  const forced = params.get('theme') || '';
  if (forced) document.documentElement.dataset.theme = forced;
  const host = document.createElement('pre');
  host.id = 'probe';
  host.textContent = 'pending';
  document.body.append(host);
  const report = () => {
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const button = document.querySelector('.btn');
    const input = document.querySelector('.input');
    const card = document.querySelector('.card');
    const link = document.querySelector('link[rel=stylesheet]');
    host.textContent = 'REPORT:' + JSON.stringify({
      theme: document.documentElement.dataset.theme || '',
      blue: root.getPropertyValue('--blue').trim(),
      backdrop: root.getPropertyValue('--shell-backdrop').trim(),
      accent: root.getPropertyValue('--on-accent').trim(),
      bodyBg: body.backgroundColor,
      bodyColor: body.color,
      bodyFont: body.fontFamily,
      btnBg: button ? getComputedStyle(button).backgroundColor : '',
      btnRadius: button ? getComputedStyle(button).borderRadius : '',
      inputBg: input ? getComputedStyle(input).backgroundColor : '',
      cardRadius: card ? getComputedStyle(card).borderRadius : '',
      tokensHref: link ? link.getAttribute('href') : '',
      remembered: (function () {
        try { return window.localStorage.getItem('eleckoi:theme') || ''; } catch (error) { return 'ERROR'; }
      })(),
      faceCount: document.fonts.size,
      notoLoaded: document.fonts.check('400 14px "Noto Sans"')
    });
  };
  // 先跑完页面自己的脚本（用户管理页要拉列表），再量最终样式。
  const done = () => setTimeout(report, 300);
  if (document.readyState === 'complete') done();
  else window.addEventListener('load', done);
})();
`
}

function probePage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>appearance-probe</title></head>
<body><pre id="out">pending</pre><script src="/${PROBE_DRIVER}"></script></body></html>
`
}

/** 探针页专用的登录+跳转脚本：先拿会话 Cookie，再整页跳到目标页。 */
function probeDriver(): string {
  return `(() => {
  const params = new URLSearchParams(location.search);
  const out = document.getElementById('out');
  const email = params.get('email') || '';
  const password = params.get('password') || '';
  const target = params.get('target') || '';
  // 其余参数（如 theme=dark）要跟着带到目标页，否则整页跳转会丢查询串。
  const carry = new URLSearchParams();
  for (const [key, value] of params) {
    if (key !== 'email' && key !== 'password' && key !== 'target') carry.set(key, value);
  }
  const suffix = carry.toString() === '' ? '' : '?' + carry.toString();
  (async () => {
    const login = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!login.ok) { out.textContent = 'LOGIN-FAILED ' + login.status; return; }
    location.replace(target + suffix);
  })().catch((error) => { out.textContent = 'ERROR ' + String(error); });
})();
`
}

/**
 * 抓取服务端渲染的页面，追加探针后作为同源公开文件写回。
 * 浏览器打开的就是服务端真实吐出的 HTML。
 */
function injectProbe(html: string): string {
  return html.replace('</body>', `<script src="/${PROBE_SCRIPT}"></script></body>`)
}

async function runChromium(
  args: string[],
  timeoutMs = 90_000
): Promise<{ stdout: string; note: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'eleckoi-appearance-'))
  return new Promise((resolveRun) => {
    const child = spawn('chromium', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--disable-sync', '--disable-features=Translate,BackForwardCache',
      '--hide-scrollbars', '--force-device-scale-factor=1',
      `--user-data-dir=${profile}`, ...args
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
      const errors = stderr.split('\n').filter((line: string) =>
        line.includes('ERROR') && !line.includes('dbus') && !line.includes('gcm'))
      finish(`空输出｜${errors.slice(-2).join(' | ')}`)
    })
  })
}

/** 从 DOM 快照里取出探针报告。 */
function readReport(dom: string): Record<string, string | boolean> | undefined {
  const match = dom.match(/REPORT:(\{.*?\})<\/pre>/s)
  if (match === null) return undefined
  // --dump-dom 会把 JSON 里的引号转义（&quot;），先还原
  const raw = match[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  try {
    return JSON.parse(raw) as Record<string, string | boolean>
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  // 无头快照必须让网络进入空闲：桥的 SSE 长连接会让 --virtual-time-budget 永不结束。
  process.env.ELECKOI_DISABLE_EVENT_STREAM = '1'

  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-appearance-'))
  const rendererDir = resolve('out/renderer')
  mkdirSync(rendererDir, { recursive: true })
  const probePath = join(rendererDir, PROBE_PAGE)
  const driverPath = join(rendererDir, PROBE_DRIVER)
  const scriptPath = join(rendererDir, PROBE_SCRIPT)
  writeFileSync(probePath, probePage())
  writeFileSync(driverPath, probeDriver())
  writeFileSync(scriptPath, probeScript())

  const shotDir = process.env.ELECKOI_SHOT_DIR ?? join(tmpdir(), 'eleckoi-appearance-shots')
  mkdirSync(shotDir, { recursive: true })

  // 注入副本的文件名要先定下来：publicPaths 只能在启动时登记。
  // 文件本身稍后（抓到页面之后）再写，公开路径只按名单放行，不看启动时的文件是否存在。
  const pages = [
    { name: '登录页', path: '/login', file: '__appearance-login.html' },
    { name: '账号管理页', path: '/account', file: '__appearance-account.html' },
    { name: '用户管理页', path: '/admin/users', file: '__appearance-adminusers.html' }
  ] as const
  const injectedPaths = pages.map((page) => join(rendererDir, page.file))
  const injectedUrls = pages.map((page) => `/${page.file}`)

  const stack = await startWebUiStack({
    dataRoot: root,
    rendererDir,
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-appearance',
    port: 0,
    allowRegistration: true,
    publicPaths: [`/${PROBE_PAGE}`, `/${PROBE_DRIVER}`, `/${PROBE_SCRIPT}`, ...injectedUrls]
  })
  const base = stack.server.url
  const email = 'appearance@example.com'
  const password = 'appearance-check-password'
  console.log(`\n== 自有页面外观一致性验收 ==\n服务地址：${base}\n截图目录：${shotDir}\n`)

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
      body: JSON.stringify({ email, username: 'appearance', password })
    }))

    // ── A-1 令牌样式表确实提炼自构建产物 ──
    const tokensResponse = await fetch(`${base}${APP_TOKENS_PATH}`)
    const tokens = await tokensResponse.text()
    const tokensOk = tokensResponse.status === 200
      && (tokensResponse.headers.get('content-type') ?? '').includes('text/css')
      && tokens.includes('--shell-backdrop')
      && tokens.includes(':root[data-theme="dark"]')
      && tokens.includes('@font-face')
      && tokens.includes('/assets/noto-sans-')
      && tokens.includes('从上游构建产物提取')
    record('A-1', tokensOk,
      `${APP_TOKENS_PATH} → ${tokensResponse.status}，${tokens.length} 字节，含明暗两套 :root 与应用同款字体`)

    // 媒体查询里的那块必须被排除：脱离 @media 后它会无条件生效，把亮色主题吃掉。
    record('A-2', !tokens.includes(':not([data-theme])') && !tokens.includes('@media'),
      tokens.includes(':not([data-theme])')
        ? '令牌里混进了 prefers-color-scheme 下的 :root:not([data-theme]) 块'
        : '未混入媒体查询块（页面自定 data-theme，跟随应用设置）')

    // ── A-3 三个页面都改用了应用令牌，且不再自带旧青绿色板 ──
    const captured = new Map<string, string>()
    const offenders: string[] = []
    for (const page of pages) {
      const response = await fetch(`${base}${page.path}`, {
        headers: page.path === '/login' ? {} : jar,
        redirect: 'manual'
      })
      const html = await response.text()
      captured.set(page.path, html)
      const legacy = LEGACY_PALETTE.filter((needle) => html.includes(needle))
      if (response.status !== 200) offenders.push(`${page.name} → ${response.status}`)
      else if (!html.includes(APP_TOKENS_PATH)) offenders.push(`${page.name} 未引用令牌样式表`)
      else if (legacy.length > 0) offenders.push(`${page.name} 残留旧色板 ${legacy.join('/')}`)
      // 主题必须由 data-theme 决定，而不是写死
      else if (!html.includes('dataset.theme')) offenders.push(`${page.name} 未按应用外观设置主题`)
    }
    record('A-3', offenders.length === 0,
      offenders.length === 0
        ? '登录 / 账号管理 / 用户管理三页均引用应用令牌，无旧色板残留，主题随应用设置'
        : offenders.join('；'))

    // ── A-4 页面 CSP 必须放行样式表与字体（否则令牌与 Noto Sans 会被拦） ──
    const cspProblems: string[] = []
    for (const page of pages) {
      const response = await fetch(`${base}${page.path}`, {
        headers: page.path === '/login' ? {} : jar,
        redirect: 'manual'
      })
      const csp = response.headers.get('content-security-policy') ?? ''
      if (!/style-src[^;]*'self'/.test(csp)) cspProblems.push(`${page.name} 的 style-src 未放行 'self'`)
      if (!/font-src[^;]*'self'/.test(csp)) cspProblems.push(`${page.name} 的 font-src 未放行 'self'`)
    }
    record('A-4', cspProblems.length === 0,
      cspProblems.length === 0
        ? "三个页面的 CSP 均放行 style-src 'self' 与 font-src 'self'（外链令牌样式表 + 网络字体可加载）"
        : cspProblems.join('；'))

    // ── A-5 真实浏览器里的计算样式 ──
    for (const page of pages) {
      writeFileSync(join(rendererDir, page.file), injectProbe(captured.get(page.path) ?? ''))
    }
    const browserUrl = (page: (typeof pages)[number], extra = ''): string =>
      `${base}/${PROBE_PAGE}?target=${encodeURIComponent(`/${page.file}`)}`
      + `&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}${extra}`
    const reports = new Map<string, Record<string, string | boolean>>()
    for (const page of pages) {
      const { stdout, note } = await runChromium([
        '--virtual-time-budget=8000', '--dump-dom', browserUrl(page)
      ])
      const report = readReport(stdout)
      if (report === undefined) {
        record(`A-5·${page.name}`, false, `未取到计算样式${note === '' ? '' : `｜${note}`}`)
        continue
      }
      reports.set(page.path, report)
    }

    // ── A-6 计算样式必须等于应用令牌值（不是"写了 var()"就算数） ──
    const expected = readTokenValues(tokens)
    const mismatches: string[] = []
    for (const [path, report] of reports) {
      const label = pages.find((page) => page.path === path)?.name ?? path
      if (report.bodyBg !== expected.backdrop) {
        mismatches.push(`${label} 背景 ${String(report.bodyBg)} ≠ 令牌 --shell-backdrop ${expected.backdrop}`)
      }
      if (!String(report.bodyFont).includes('Noto Sans')) {
        mismatches.push(`${label} 正文字体 ${String(report.bodyFont)} 未含 Noto Sans`)
      }
      if (report.btnBg !== expected.blue) {
        mismatches.push(`${label} 主按钮 ${String(report.btnBg)} ≠ 令牌 --blue ${expected.blue}`)
      }
      if (!String(report.tokensHref).includes(APP_TOKENS_PATH)) {
        mismatches.push(`${label} 首个样式表 ${String(report.tokensHref)} 不是令牌样式表`)
      }
      if (report.notoLoaded !== true && Number(report.faceCount) === 0) {
        mismatches.push(`${label} Noto Sans 网络字体未加载（faceCount=${String(report.faceCount)}）`)
      }
      if (report.theme !== 'light' && report.theme !== 'dark') {
        mismatches.push(`${label} 主题未定：${String(report.theme)}`)
      }
    }
    record('A-6', mismatches.length === 0,
      mismatches.length === 0
        ? `三个页面的计算样式与令牌一致：背景 ${expected.backdrop}、主按钮 ${expected.blue}、字体 Noto Sans（真实浏览器实测）`
        : mismatches.join('；'))

    // ── A-7 亮/暗两套主题都要能落地 ──
    // 用 ?theme=dark 直接定主题（而不是靠浏览器旗标改 prefers-color-scheme）：
    // 要验的是「令牌的暗色块确实生效」，页面自己怎么选主题由 A-3/A-6 覆盖。
    const darkProbe = await runChromium([
      '--virtual-time-budget=8000', '--dump-dom', browserUrl(pages[0], '&theme=dark')
    ])
    const darkReport = readReport(darkProbe.stdout)
    const darkOk = darkReport !== undefined
      && darkReport.theme === 'dark'
      && darkReport.blue === expected.blueDarkLiteral
      && darkReport.bodyBg === expected.backdropDark
    record('A-7', darkOk,
      darkOk
        ? `暗色主题下取到 --blue ${expected.blueDarkLiteral}、背景 ${expected.backdropDark}，与应用暗色令牌一致`
        : `暗色令牌未生效（--blue ${String(darkReport?.blue)}、背景 ${String(darkReport?.bodyBg)}，期望 ${expected.blueDarkLiteral} / ${expected.backdropDark}）`)

    // ── A-10 登录页要能记住上次登录时的主题（否则门里门外会一明一暗） ──
    // 账号/用户管理页把解析结果记进 localStorage；登录页据此决定自己的主题。
    // 无记录时落到 light —— 上游 appearance.mode 的默认值就是 light，不是跟随系统。
    const themeProblems: string[] = []
    for (const page of pages) {
      const report = reports.get(page.path)
      if (report === undefined) continue
      if (page.path === '/login') {
        if (report.remembered !== '') themeProblems.push(`${page.name} 不应写入主题记录（得到 ${String(report.remembered)}）`)
        if (report.theme !== 'light') themeProblems.push(`${page.name} 无记录时应为 light，实际 ${String(report.theme)}`)
      } else if (report.remembered !== report.theme) {
        themeProblems.push(`${page.name} 未记住主题（localStorage=${String(report.remembered)}，实际主题 ${String(report.theme)}）`)
      }
    }
    record('A-10', themeProblems.length === 0,
      themeProblems.length === 0
        ? '账号页与用户管理页把主题记进 localStorage；登录页无记录时按上游默认的 light，不跟随系统'
        : themeProblems.join('；'))

    // ── A-8 截图，供人眼复核 ──
    const shots: string[] = []
    for (const page of pages) {
      const file = join(shotDir, `${page.path.replace(/\W+/g, '') || 'root'}.png`)
      await runChromium([
        '--virtual-time-budget=8000', '--window-size=1180,900', '--hide-scrollbars',
        `--screenshot=${file}`, browserUrl(page)
      ])
      shots.push(file)
    }
    const shotExists = shots.every((file) => {
      try { return statSync(file).size > 5000 } catch { return false }
    })
    // 顺带出一张暗色登录页：令牌的暗色块在真实浏览器里也要能看（仅供人眼复核）
    const darkShot = join(shotDir, 'login-dark.png')
    await runChromium([
      '--virtual-time-budget=8000', '--window-size=1180,900', '--hide-scrollbars',
      `--screenshot=${darkShot}`, browserUrl(pages[0], '&theme=dark')
    ])
    record('A-8', shotExists, `截图已生成：${shots.join('、')}、${darkShot}`)

    // ── A-9 顺带截一张应用本体，供人眼对照我们的页面是否同一套外观 ──
    const appShot = join(shotDir, 'app.png')
    await runChromium([
      '--virtual-time-budget=9000', '--window-size=1180,900', '--hide-scrollbars',
      `--screenshot=${appShot}`,
      `${base}/${PROBE_PAGE}?target=${encodeURIComponent('/')}`
      + `&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`
    ])
    let appShotOk = false
    try { appShotOk = statSync(appShot).size > 5000 } catch { appShotOk = false }
    record('A-9', appShotOk, `应用本体截图：${appShot}（与本页截图并排即可看出是否同一套外观）`)
  } finally {
    for (const path of [probePath, driverPath, scriptPath, ...injectedPaths]) rmSync(path, { force: true })
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

/** 从令牌 CSS 里取出我们要比对的几个值。 */
function readTokenValues(css: string): {
  backdrop: string
  blue: string
  backdropDark: string
  blueDark: string
  blueDarkLiteral: string
} {
  const block = (selector: RegExp): string => {
    const match = selector.exec(css)
    if (match === null) return ''
    const open = css.indexOf('{', match.index)
    const close = css.indexOf('}', open)
    return css.slice(open, close)
  }
  const read = (source: string, name: string): string => {
    const match = source.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))
    return match === null ? '' : match[1]!.trim()
  }
  const light = block(/:root\s*\{/)
  const dark = block(/:root\[data-theme="dark"\]\s*\{/) || light
  const blueDark = read(dark, '--blue')
  return {
    backdrop: toRgb(read(light, '--shell-backdrop')),
    blue: toRgb(read(light, '--blue')),
    backdropDark: toRgb(read(dark, '--shell-backdrop')),
    blueDark: toRgb(blueDark),
    // 自定义属性经 getPropertyValue 取回的是字面量，不会规范化成 rgb()
    blueDarkLiteral: blueDark
  }
}

/** 十六进制令牌 → 浏览器 getComputedStyle 返回的 rgb() 形式。 */
function toRgb(value: string): string {
  let hex = value.trim().replace('#', '')
  if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.split('').map((char) => char + char).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return value.trim()
  return `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`
}

await main()
