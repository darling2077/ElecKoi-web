/**
 * 反向代理部署验收：把服务放在 nginx/lucky 之类的代理之后，有几处会静默出错。
 *
 * 这些坑的共同点是"本机自测一切正常，一挂到公网就坏"，所以必须专门守：
 *   ① 代理未必保留 Host（nginx 默认就把 Host 换成上游地址）→ 按 Host 分流的卡片源失配、
 *      写操作的同源校验把正常登录判成跨站；
 *   ② 公网 HTTPS 但容器只收到明文 HTTP → Secure Cookie 该不该加；
 *   ③ Cookie 一刀切加 Secure 会把局域网 http://内网IP 的登录打死（带 Secure 的
 *      Set-Cookie 在明文连接上会被浏览器直接丢弃）；
 *   ④ 限流按客户端 IP 计——不信任 X-Forwarded-For 的话，所有公网用户共用一个代理 IP，
 *      累计十次失败就全站 429 十五分钟。
 *
 * 运行：pnpm webui:proxy
 */

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

// 示例域名（RFC 2606 保留域）与示例端口：仅用于构造 Host / Origin 头，
// 断言全部是拿这几个常量互相比对，与真实部署无关。
// 测试实际只请求本机回环地址（stack.server.url），不解析也不连接这些主机名。
const PROXY_HOST = 'app.example.com:57789'
const CARD_HOST = 'cards.example.com:57789'
const APP_ORIGIN = `https://${PROXY_HOST}`
const CARD_ORIGIN = `https://${CARD_HOST}`

interface Attempt {
  status: number
  cookie: string
  body: string
  location: string
}

async function main(): Promise<void> {
  // 代理部署的典型开关：信任 X-Forwarded-*，让限流按真实客户端 IP 计。
  process.env.ELECKOI_TRUST_PROXY = '1'
  process.env.ELECKOI_DISABLE_EVENT_STREAM = '1'

  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-proxy-'))
  const stack = await startWebUiStack({
    dataRoot: root,
    rendererDir: resolve('out/renderer'),
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-proxy',
    port: 0,
    allowRegistration: true,
    cardOrigin: CARD_ORIGIN,
    appOrigins: [APP_ORIGIN]
  })
  const base = stack.server.url
  const email = 'proxy@example.com'
  const password = 'proxy-check-password'
  console.log(`\n== 反向代理部署验收 ==\n服务地址：${base}（模拟对外 ${APP_ORIGIN} / 卡片 ${CARD_ORIGIN}）\n`)

  /** 模拟代理转发：可控制 Host、X-Forwarded-* 与 Origin。 */
  async function viaProxy(
    path: string,
    options: {
      method?: string
      body?: unknown
      host?: string
      forwardedHost?: string
      forwardedProto?: string
      forwardedFor?: string
      origin?: string
      cookie?: string
    } = {}
  ): Promise<Attempt> {
    const headers: Record<string, string> = {}
    if (options.method === 'POST') headers['content-type'] = 'application/json'
    if (options.host !== undefined) headers.host = options.host
    if (options.forwardedHost !== undefined) headers['x-forwarded-host'] = options.forwardedHost
    if (options.forwardedProto !== undefined) headers['x-forwarded-proto'] = options.forwardedProto
    if (options.forwardedFor !== undefined) headers['x-forwarded-for'] = options.forwardedFor
    if (options.origin !== undefined) headers.origin = options.origin
    if (options.cookie !== undefined) headers.cookie = options.cookie
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: 'manual'
    })
    const setCookie = response.headers.getSetCookie?.() ?? []
    return {
      status: response.status,
      cookie: setCookie.find((entry) => entry.startsWith('eleckoi_session=')) ?? '',
      body: await response.text(),
      location: response.headers.get('location') ?? ''
    }
  }

  /** 取某个路径的响应头（沿用代理那套头，且不跟随重定向）。 */
  async function cspOf(path: string, forwardedHost: string, cookie?: string): Promise<string> {
    const headers: Record<string, string> = {
      'x-forwarded-host': forwardedHost,
      'x-forwarded-proto': 'https'
    }
    if (cookie !== undefined && cookie !== '') headers.cookie = cookie
    const response = await fetch(`${base}${path}`, { headers, redirect: 'manual' })
    return response.headers.get('content-security-policy') ?? ''
  }

  try {
    // 先建账号：后面几条断言都要真正登录成功才有意义。
    // 用不带 Origin 的直连注册（同源 fetch 在部分场景本就不带 Origin）。
    const registered = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, username: 'proxy', password })
    })
    if (registered.status !== 200) {
      throw new Error(`注册测试账号失败：${registered.status} ${await registered.text()}`)
    }

    // ── P-1 代理保留原始 Host：登录应当成功 ──
    const kept = await viaProxy('/api/auth/login', {
      method: 'POST',
      host: PROXY_HOST,
      forwardedProto: 'https',
      origin: APP_ORIGIN,
      body: { email, password }
    })
    record('P-1', kept.status === 200 && kept.cookie !== '',
      `保留 Host 时登录 → ${kept.status}${kept.cookie === '' ? '（未下发会话 Cookie）' : '，已下发会话 Cookie'}`)

    // ── P-2 代理改写了 Host（nginx 默认行为）：靠 X-Forwarded-Host 仍应放行 ──
    // 这正是"本机测得好好的，挂了代理就登录不了"的经典成因。
    const rewritten = await viaProxy('/api/auth/login', {
      method: 'POST',
      host: '127.0.0.1:8790',
      forwardedHost: PROXY_HOST,
      forwardedProto: 'https',
      origin: APP_ORIGIN,
      body: { email, password }
    })
    record('P-2', rewritten.status === 200,
      rewritten.status === 200
        ? '代理把 Host 换成上游地址时，X-Forwarded-Host 让同源校验仍然通过'
        : `Host 被改写后登录失败：${rewritten.status} ${rewritten.body.slice(0, 80)}`)

    // ── P-3 白名单不是"放行一切"：陌生来源照样拒 ──
    const foreign = await viaProxy('/api/auth/login', {
      method: 'POST',
      host: '127.0.0.1:8790',
      forwardedHost: PROXY_HOST,
      forwardedProto: 'https',
      origin: 'https://evil.example.com',
      body: { email, password }
    })
    const foreignOk = foreign.status === 403 && foreign.body.includes('跨站')
    record('P-3', foreignOk, `陌生 Origin → ${foreign.status}${foreign.body.includes('跨站') ? '（跨站请求被拒绝）' : ''}`)

    // ── P-4 HTTPS 入口的 Cookie 带 Secure，明文入口的不带 ──
    const https = await viaProxy('/api/auth/login', {
      method: 'POST',
      host: PROXY_HOST,
      forwardedProto: 'https',
      origin: APP_ORIGIN,
      body: { email, password }
    })
    const plain = await viaProxy('/api/auth/login', {
      method: 'POST',
      host: '192.0.2.10:8790',
      origin: 'http://192.0.2.10:8790',
      body: { email, password }
    })
    const httpsSecure = https.cookie.includes('Secure')
    const plainSecure = plain.cookie.includes('Secure')
    record('P-4', httpsSecure && !plainSecure,
      `经代理的 HTTPS 请求 → Secure=${httpsSecure}；局域网明文请求 → Secure=${plainSecure}`
      + (plainSecure ? '（一刀切加 Secure 会让明文入口登录不上）' : '（明文入口仍可登录）'))

    // ── P-5 限流按真实客户端 IP：一个 IP 打满不该拖垮别人 ──
    for (let i = 0; i < 10; i += 1) {
      await viaProxy('/api/auth/login', {
        method: 'POST',
        host: PROXY_HOST,
        forwardedFor: '203.0.113.9',
        origin: APP_ORIGIN,
        body: { identifier: 'nobody@example.com', password: 'wrong-password-1234' }
      })
    }
    const blocked = await viaProxy('/api/auth/login', {
      method: 'POST',
      host: PROXY_HOST,
      forwardedFor: '203.0.113.9',
      origin: APP_ORIGIN,
      body: { identifier: 'nobody@example.com', password: 'wrong-password-1234' }
    })
    const otherClient = await viaProxy('/api/auth/login', {
      method: 'POST',
      host: PROXY_HOST,
      forwardedFor: '198.51.100.7',
      origin: APP_ORIGIN,
      body: { email, password }
    })
    const throttleOk = blocked.status === 429 && otherClient.status === 200
    record('P-5', throttleOk,
      `打满的客户端 → ${blocked.status}，另一个客户端 → ${otherClient.status}`
      + (throttleOk ? '（限流按 X-Forwarded-For 隔离）' : '（疑似共用代理 IP 导致互相拖累）'))

    // ── P-6 卡片源按对外 Host 分流 ──
    const cardFrame = await viaProxy('/__eleckoi/card-frame.html', {
      host: '127.0.0.1:8790',
      forwardedHost: CARD_HOST,
      forwardedProto: 'https'
    })
    const appOriginRequest = await viaProxy('/__eleckoi/card-frame.html', {
      host: '127.0.0.1:8790',
      forwardedHost: PROXY_HOST,
      forwardedProto: 'https'
    })
    const routed = cardFrame.status === 200 && cardFrame.body.includes('card-document')
    const notLeaked = appOriginRequest.status !== 200 && !appOriginRequest.body.includes('card-document')
    record('P-6', routed && notLeaked,
      `卡片域请求卡片帧 → ${cardFrame.status}；应用域请求同一路径 → ${appOriginRequest.status}`
      + (routed && notLeaked ? '（跨源隔离成立：卡片帧不在应用源上提供）' : '（同一路径在应用源上也拿到了卡片帧，隔离被破坏）'))

    // ── P-7 卡片帧只允许被应用源嵌入 ──
    const cardCsp = await cspOf('/__eleckoi/card-frame.html', CARD_HOST)
    const frameAncestors = /frame-ancestors ([^;]+)/.exec(cardCsp)?.at(1)?.trim() ?? ''
    record('P-7', frameAncestors === APP_ORIGIN,
      frameAncestors === APP_ORIGIN
        ? `卡片帧 frame-ancestors = ${frameAncestors}（只有应用源能嵌它）`
        : `卡片帧 frame-ancestors 期望 ${APP_ORIGIN}，实际 ${frameAncestors === '' ? '(缺失)' : frameAncestors}`)

    // ── P-8 应用文档的 CSP 必须放行卡片源，否则卡片一律被浏览器拦掉 ──
    const sessionCookie = https.cookie.split(';')[0] ?? ''
    const appCsp = await cspOf('/', PROXY_HOST, sessionCookie)
    const frameSrc = /frame-src ([^;]+)/.exec(appCsp)?.at(1)?.trim() ?? ''
    record('P-8', frameSrc.includes(CARD_ORIGIN),
      frameSrc.includes(CARD_ORIGIN)
        ? `应用 CSP 的 frame-src = ${frameSrc}（放行卡片源）`
        : `应用 CSP 的 frame-src 期望含 ${CARD_ORIGIN}，实际 ${frameSrc === '' ? '(缺失)' : frameSrc}`)
  } finally {
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
