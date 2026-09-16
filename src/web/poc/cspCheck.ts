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
import { cardFrameCsp, resolveCardImageOrigins } from '../http/cardFrame'
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

    // 卡片帧的图片白名单（ELECKOI_CARD_IMAGE_ORIGINS）。
    // 卡片里的外链图片默认被 img-src 拦掉，用户把它自己的图床配进来才放行。
    const base = cardFrameCsp(['https://ai.example.com'])
    const withImages = cardFrameCsp(['https://ai.example.com'], resolveCardImageOrigins([' https://img.example.com/ ']))
    record('CSP-8',
      base.includes("img-src 'self' data: blob:") && base.includes("connect-src 'none'")
      && withImages.includes("img-src 'self' data: blob: https://img.example.com")
      && withImages.includes("media-src 'self' data: blob: https://img.example.com")
      // 放宽的只能是「加载」，绝不能顺手把回传通道打开
      && withImages.includes("connect-src 'none'")
      && withImages.includes("script-src 'unsafe-inline' 'unsafe-eval'"),
      '默认不放开外部图片源；配置后只放宽 img-src/media-src，connect-src 仍为 none、脚本策略不变')

    // 放开档（third-party）：img-src 用 https: 通配，但仍然不许 fetch/XHR 外传。
    const permissive = cardFrameCsp(['https://ai.example.com'], [], { allowAnyHttps: true })
    record('CSP-10',
      permissive.includes("img-src 'self' data: blob: https:")
      && permissive.includes("media-src 'self' data: blob: https:")
      && permissive.includes("connect-src 'none'")
      && !permissive.includes("script-src 'unsafe-inline' 'unsafe-eval' https:"),
      '放开档：任意 https 图床可显示，connect-src 仍为 none、脚本策略不变')
    const httpToo = cardFrameCsp([], [], { allowAnyHttps: true, allowAnyHttp: true })
    record('CSP-11', httpToo.includes('http:') && !permissive.includes('http:'),
      'http 图床默认不放行，需显式开启')

    const rejected: string[] = []
    for (const bad of ['https://img.example.com/a/b', 'https://img.example.com/?x=1', 'https://*.example.com', 'ftp://img.example.com', '不是URL']) {
      try { resolveCardImageOrigins([bad]); rejected.push(`漏放行 ${bad}`) } catch { /* 预期 */ }
    }
    record('CSP-9', rejected.length === 0,
      rejected.length === 0
        ? '带路径/查询/通配符/非 http 的写法都被拒绝（白名单只接受纯源）'
        : rejected.join('；'))
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
