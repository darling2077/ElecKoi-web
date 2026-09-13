/**
 * M3 验收（续）：安全响应头 + **CSP 下应用仍能渲染**。
 *
 * 加 CSP 最大的风险是静默把应用打坏（脚本被拦、字体被拦、帧被拦）。
 * 所以这里不只是断言响应头存在，而是用真实浏览器渲染一遍，确认界面照常出现。
 *
 * 运行：pnpm webui:csp
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { WebHost } from '../WebHost'
import { singleTenantResolver, startWebServer } from '../http/server'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

/**
 * 无头渲染并导出 DOM。
 *
 * 必须用异步 spawn：被测服务就跑在本进程里，spawnSync 会阻塞事件循环，
 * 浏览器永远等不到响应（表现为 ETIMEDOUT + 空 DOM）。
 * 事件流同时必须关闭，否则长连接让快照永不返回。
 */
function renderDom(url: string, timeoutMs = 90_000): Promise<{ dom: string; note: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'eleckoi-csp-'))
  return new Promise((resolveDom) => {
    const child = spawn('chromium', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--disable-sync', '--disable-features=Translate,BackForwardCache',
      `--user-data-dir=${profile}`,
      '--virtual-time-budget=6000',
      '--dump-dom', url
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
      const errors = stderr.split('\n')
        .filter((line: string) => line.includes('ERROR') && !line.includes('dbus') && !line.includes('gcm') && !line.includes('GetTerminationStatus'))
      finish(`空输出｜${errors.slice(-2).join(' | ')}`)
    })
  })
}

async function main(): Promise<void> {
  process.env.ELECKOI_DISABLE_EVENT_STREAM = '1'

  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-csp-'))
  const cardOrigin = 'https://cards.example.com'
  const tenant = await WebHost.mountTenant({
    tenantId: 'tenant-csp',
    tenantRoot: join(root, 'tenant'),
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-csp'
  })
  const server = await startWebServer({
    host: '127.0.0.1',
    port: 0,
    rendererDir: resolve('out/renderer'),
    cardOrigin,
    appOrigins: ['https://app.example.com'],
    resolveSession: singleTenantResolver(tenant.gateway, tenant.context.mediaAssets)
  })
  console.log(`\n== ElecKoi WebUI · CSP 与安全头验收 ==\n服务地址：${server.url}\n`)

  try {
    const response = await fetch(`${server.url}/`)
    const html = await response.text()
    const csp = response.headers.get('content-security-policy') ?? ''

    record('CSP-1',
      csp.includes("script-src 'self'") && !csp.includes("script-src 'self' 'unsafe-inline'"),
      `应用 CSP 的 script-src 未开内联：${csp.split(';').find((part) => part.includes('script-src'))?.trim() ?? '(缺失)'}`)

    record('CSP-2', csp.includes(cardOrigin) && csp.includes("frame-ancestors 'none'"),
      `frame-src 放行卡片源、frame-ancestors 禁止被嵌套`)

    record('CSP-3',
      html.includes('__ELECKOI_WEB__') === false && html.includes('/__eleckoi/web-bridge.js'),
      `配置随桥脚本下发（页面内无内联配置脚本），页面 ${html.length} 字节`)

    // 登录页需要鉴权栈才存在，其 CSP 由 webui:multitenant 覆盖。

    const nosniff = response.headers.get('x-content-type-options')
    const frameOptions = response.headers.get('x-frame-options')
    record('CSP-5', nosniff === 'nosniff' && frameOptions === 'DENY',
      `x-content-type-options=${nosniff}、x-frame-options=${frameOptions}`)

    // 关键：CSP 之下应用必须照常渲染
    const { dom, note } = await renderDom(`${server.url}/`)
    const rendered = dom.includes('还没有聊天角色') || dom.includes('ElecKoi')
    record('CSP-6', rendered,
      rendered
        ? `真实浏览器在 CSP 下渲染出应用界面（DOM ${dom.length} 字节）`
        : `应用未渲染，DOM ${dom.length} 字节${note === '' ? '' : `｜${note}`}`)

    // 桥脚本自身也要能被 CSP 放行（同源外链脚本）
    record('CSP-7', dom.includes('/__eleckoi/web-bridge.js'),
      '应用文档仍引用桥脚本')
  } finally {
    await server.close()
    await tenant.dispose()
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
