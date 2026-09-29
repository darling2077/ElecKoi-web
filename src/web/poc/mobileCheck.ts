/**
 * 手机竖屏验收（v0.2.0 架构）。
 *
 * ⚠️ 语义换代说明：旧版断言的是**我们自己注入到旧 React 外壳上的移动端 CSS**
 * （聊天区/侧栏宽度、抽屉自动收起、字号预览、壁纸等十来项）。v0.2.0 把界面换成了
 * DSH 客户端，那套注入不再适用，逐条比对旧选择器没有意义。
 *
 * 现在断言用户真正在意的三件事：
 *   M-phone / M-phone-small  390px 与 360px 视口下应用能挂载、且**没有横向溢出**；
 *   M-text                   主内容区在窄屏下仍有可用宽度（≥240px）；
 *   M-mount                  挂载确实成功（不是停在 "Failed to load plugin" 错误页）。
 *
 * 仍然用 CDP 的 Emulation.setDeviceMetricsOverride 精确设视口：
 * 无头 Chromium 对 `--window-size` 有 500px 下限，传 390 会被静默钳到 500，
 * 那样"测了手机布局"是假的（这个坑以前真踩过）。
 *
 * 运行：pnpm webui:mobile
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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

interface Viewport {
  key: string
  label: string
  width: number
  height: number
}

const VIEWPORTS: Viewport[] = [
  { key: 'phone', label: '手机竖屏 iPhone 14', width: 390, height: 844 },
  { key: 'phone-small', label: '小屏安卓', width: 360, height: 740 }
]

interface Layout {
  assets?: unknown
  failures?: string[]
  href: string
  htmlLength: number
  mounted: boolean
  bootFailed: boolean
  innerWidth: number
  scrollWidth: number
  mainWidth: number
  text: string
}

/** 在指定视口下打开应用并量一次布局。 */
async function measure(base: string, token: string, viewport: Viewport): Promise<Layout> {
  const profile = mkdtempSync(join(tmpdir(), 'eleckoi-mobile-'))
  const port = 9500 + Math.floor(Math.random() * 400)
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
      if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined
        failures.push(String(details?.exception?.description ?? details?.text ?? '').slice(0, 200))
      }
      if (method === 'Network.responseReceived') {
        const response = params.response as { status?: number; url?: string } | undefined
        if ((response?.status ?? 0) >= 400) failures.push(`${response?.status} ${String(response?.url ?? '').slice(0, 80)}`)
      }
    })
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Network.setCookie', { name: 'eleckoi_session', value: token, url: base, path: '/' })
    // 设备度量必须在导航前设好，否则量到的是桌面布局。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 2, mobile: process.env.ELECKOI_MOBILE_UA === '1'
    })
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url: `${base}/` })

    let layout: Layout = { href: '', htmlLength: -1, mounted: false, bootFailed: false, innerWidth: 0, scrollWidth: 0, mainWidth: 0, text: '' }
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      layout = await cdp.evaluate<Layout>(`(() => {
        const doc = document.documentElement
        const candidates = [document.querySelector('main'), ...Array.from(document.body?.children ?? [])]
        const mainWidth = candidates.reduce((widest, el) => {
          if (!el) return widest
          const rect = el.getBoundingClientRect()
          return rect.width > widest ? rect.width : widest
        }, 0)
        return {
          href: location.href,
          htmlLength: document.body ? document.body.innerHTML.length : -1,
          assets: typeof globalThis.__ELECKOI_CLIENT_ASSETS__,
          mounted: typeof globalThis.__ELECKOI_DSH_APP__ === 'function',
          bootFailed: (document.body?.innerText ?? '').includes('Failed to load plugin'),
          innerWidth: window.innerWidth,
          scrollWidth: doc ? doc.scrollWidth : 0,
          mainWidth: Math.round(mainWidth),
          text: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 60)
        }
      })()`)
      if (layout.mounted) break
      await new Promise((done) => setTimeout(done, 1000))
    }
    if (failures.length > 0) layout.failures = failures.slice(0, 3)
    return layout
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

  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-mobile-'))
  const stack = await startWebUiStack({
    dataRoot: root,
    rendererDir: resolve('out/renderer'),
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-mobile',
    port: 0,
    allowRegistration: true
  })
  const base = stack.server.url
  console.log(`\n== 手机竖屏验收（v0.2.0 架构）==\n服务地址：${base}\n`)

  const jar: Record<string, string> = {}
  const capture = (response: Response): void => {
    for (const entry of response.headers.getSetCookie?.() ?? []) {
      const pair = entry.split(';')[0] ?? ''
      if (pair.startsWith('eleckoi_session=')) jar.cookie = pair
    }
  }
  const rpc = async <T>(name: string, input: unknown): Promise<T> => {
    const response = await fetch(`${base}/api/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...jar },
      body: JSON.stringify({ name, input })
    })
    return ((await response.json()) as { data?: T }).data as T
  }

  try {
    capture(await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mobile@example.com', password: 'mobile-check-password' })
    }))
    // 造一个角色，让界面不是空态（空态与真实使用时的宽度表现不同）。
    await rpc('command.characters.create', {
      id: 'char-mobile', name: '窄屏角色', description: '手机验收用。', personality: '配合。'
    })

    // 先确认服务端确实把门面与桥注入了文档（否则浏览器那边一定起不来）。
    const appHtml = await (await fetch(`${base}/`, { headers: jar })).text()
    record('M-html',
      appHtml.includes('__ModuleLoader__') && appHtml.includes('/__eleckoi/web-bridge.js')
        && appHtml.includes('__ELECKOI_CLIENT_ASSETS__'),
      `应用文档 ${appHtml.length} 字节，含门面=${appHtml.includes('__ModuleLoader__')}、` +
      `含桥=${appHtml.includes('/__eleckoi/web-bridge.js')}、含资源表=${appHtml.includes('__ELECKOI_CLIENT_ASSETS__')}`)

    const token = (jar.cookie ?? '').replace('eleckoi_session=', '')
    let smallestMain = Number.POSITIVE_INFINITY
    let phoneLayout: Layout | undefined
    for (const viewport of VIEWPORTS) {
      const layout = await measure(base, token, viewport)
      if (viewport.key === 'phone') phoneLayout = layout
      const noOverflow = layout.scrollWidth <= layout.innerWidth + 2
      record(`M-${viewport.key}`,
        layout.mounted && noOverflow && !layout.bootFailed,
        `${viewport.label}：视口 ${layout.innerWidth}px、文档宽 ${layout.scrollWidth}px、` +
        `页面 ${layout.href}（${layout.htmlLength} 字节，资源表=${String(layout.assets)}）` +
        (layout.failures && layout.failures.length > 0 ? `、报错：${layout.failures.join(' ｜ ')}` : '') + `、` +
        `主内容 ${layout.mainWidth}px、已挂载=${layout.mounted}${layout.bootFailed ? '（页面报 Failed to load plugin）' : ''}`)
      if (layout.mainWidth > 0) smallestMain = Math.min(smallestMain, layout.mainWidth)
    }

    record('M-text', smallestMain >= 240,
      `窄屏下主内容区最小宽度 ${Number.isFinite(smallestMain) ? `${smallestMain}px` : '(未取到)'}（要求 ≥240px）`)

    record('M-mount', phoneLayout?.mounted === true,
      phoneLayout?.mounted === true
        ? `应用在 390px 视口下挂载成功：${phoneLayout.text}`
        : `未挂载：${phoneLayout?.text ?? '(未取到)'}`)
  } catch (error) {
    record('M-error', false, `流程中断：${error instanceof Error ? error.message : String(error)}`)
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
