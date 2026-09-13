/**
 * M2 验收：多租户 + 鉴权，全部经**真实 HTTP**验证。
 *
 * 覆盖：
 *   - 未登录门禁（页面 302 / 接口 401 / 媒体不放行）
 *   - 登录页可达且可注册
 *   - 注册即登录，Cookie 生效后能拿到应用页面与桥脚本
 *   - 两个用户经 /api/rpc 的数据完全隔离（这是整个改造的核心安全属性）
 *   - 口令错误被拒、登出后会话立即失效
 *   - 每个用户有独立租户目录
 *
 * 运行：pnpm webui:multitenant
 */

import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { LocalMediaStore } from '@main/platform/filesystem/LocalMediaStore'
import { createMediaSigner } from '../mediaSignature'
import { startWebUiStack } from '../stack'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

/** 1×1 透明 PNG。 */
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

/** 极简 cookie 罐：只保留服务端下发的 eleckoi_session。 */
class Jar {
  private cookie = ''
  capture(response: Response): void {
    const raw = response.headers.getSetCookie?.() ?? []
    for (const entry of raw) {
      const pair = entry.split(';')[0] ?? ''
      if (pair.startsWith('eleckoi_session=')) this.cookie = pair
    }
  }
  header(): Record<string, string> {
    return this.cookie ? { cookie: this.cookie } : {}
  }
  get empty(): boolean {
    return this.cookie === ''
  }
}

async function rpc(base: string, jar: Jar, name: string, input: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...jar.header() },
    body: JSON.stringify({ name, input })
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-m2-'))
  const masterKeyBase64 = randomBytes(32).toString('base64')
  const stack = await startWebUiStack({
    dataRoot: root,
    rendererDir: resolve('out/renderer'),
    masterKeyBase64,
    appVersion: '0.1.0-web-m2',
    port: 0,
    allowRegistration: true,
    idleMs: 60_000,
    sourceUrl: 'https://github.com/example/eleckoi-webui'
  })
  const base = stack.server.url
  console.log(`\n== ElecKoi WebUI · M2 多租户验收 ==\n数据目录：${root}\n服务地址：${base}\n`)

  try {
    // ── 未登录门禁 ──
    const anonymousPage = await fetch(`${base}/`, { redirect: 'manual' })
    record('M2-1', anonymousPage.status === 302 && anonymousPage.headers.get('location') === '/login',
      `GET / → ${anonymousPage.status} location=${anonymousPage.headers.get('location')}`)

    const loginPage = await fetch(`${base}/login`)
    const loginHtml = await loginPage.text()
    record('M2-2', loginPage.status === 200 && loginHtml.includes('电子爱') && loginHtml.includes('/api/auth/'),
      `GET /login → ${loginPage.status}，${loginHtml.length} 字节，含表单与认证接口调用`)

    const loginCsp = loginPage.headers.get('content-security-policy') ?? ''
    record('M2-2b', loginCsp.includes("default-src 'none'") && loginCsp.includes("script-src 'unsafe-inline'") && loginCsp.includes("connect-src 'self'"),
      `登录页独立 CSP：${loginCsp.slice(0, 60)}…`)

    record('M2-2c', loginHtml.includes('https://github.com/example/eleckoi-webui') && loginHtml.includes('对应源代码'),
      '登录页带 AGPL §13 要求的对应源码入口')

    const anonymousRpc = await rpc(base, new Jar(), 'query.settings.read', { key: 'locale.current' })
    record('M2-3', anonymousRpc.status === 401,
      `未登录 POST /api/rpc → ${anonymousRpc.status} ${JSON.stringify(anonymousRpc.body?.error?.message ?? '')}`)

    const anonymousMedia = await fetch(`${base}/media/v1/deadbeef/avatar/x.png`, { redirect: 'manual' })
    record('M2-4', anonymousMedia.status === 302 || anonymousMedia.status === 401,
      `未登录 GET /media/v1/... → ${anonymousMedia.status}（不放行）`)

    // ── 注册两个用户 ──
    const jarA = new Jar()
    const jarB = new Jar()
    for (const [jar, email] of [[jarA, 'alice@example.com'], [jarB, 'bob@example.com']] as const) {
      const response = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'correct-horse-battery' })
      })
      jar.capture(response)
      if (!response.ok) throw new Error(`注册 ${email} 失败：${response.status} ${await response.text()}`)
    }
    record('M2-5', !jarA.empty && !jarB.empty, '两个用户注册成功并各自拿到会话 Cookie')

    // ── 登录后可用 ──
    const appPage = await fetch(`${base}/`, { headers: jarA.header(), redirect: 'manual' })
    const appHtml = await appPage.text()
    record('M2-6', appPage.status === 200 && appHtml.includes('/__eleckoi/web-bridge.js'),
      `带会话 GET / → ${appPage.status}，已注入 Web 桥`)

    // ── 跨租户数据隔离（核心）──
    const writeA = await rpc(base, jarA, 'command.settings.write', { key: 'locale.current', value: 'zh-CN-alice' })
    const readA = await rpc(base, jarA, 'query.settings.read', { key: 'locale.current' })
    const readB = await rpc(base, jarB, 'query.settings.read', { key: 'locale.current' })
    const isolated = readA.body?.data === 'zh-CN-alice' && readB.body?.data !== 'zh-CN-alice'
    record('M2-7', isolated,
      `A 写入 ${JSON.stringify(writeA.body?.data)}；A 读回 ${JSON.stringify(readA.body?.data)}；B 读回 ${JSON.stringify(readB.body?.data)}`)

    // ── 独立租户目录 ──
    const tenantDirs = await readdir(join(root, 'tenants'))
    record('M2-8', tenantDirs.length === 2,
      `tenants/ 下有 ${tenantDirs.length} 个目录：${tenantDirs.join(', ')}`)

    // ── 口令错误 ──
    const wrong = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'wrong-password' })
    })
    record('M2-9', wrong.status === 401, `错误口令 → ${wrong.status}`)

    // ── 登出 ──
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: jarA.header() })
    const afterLogout = await fetch(`${base}/api/auth/me`, { headers: jarA.header() })
    record('M2-10', afterLogout.status === 401, `登出后 /api/auth/me → ${afterLogout.status}`)

    // ── 租户注册表状态 ──
    const stats = stack.tenants.stats()
    record('M2-11', stats.live === 2 && stats.busy === 0,
      `活跃租户 ${stats.live}、挂载中 ${stats.mounting}、被引用 ${stats.busy}`)

    // ── 签名媒体：跨源卡片帧取图所依赖的路径 ──
    const tenantRecord = stack.control.listTenants()[0]!
    const mediaStore = new LocalMediaStore(join(root, 'tenants', tenantRecord.tenant_id, 'media'))
    const prepared = mediaStore.prepareImage('char-media', 'avatar', PNG_DATA_URL)
    prepared.commit()
    const resourcePath = prepared.reference.replace('eleckoi-media://asset/v1/', '')

    const signer = createMediaSigner(masterKeyBase64, tenantRecord.tenant_id)
    const signedUrl = signer.sign(`/media/v1/${resourcePath}`)
    const withoutCookie = await fetch(`${base}${signedUrl}`)
    const body = await withoutCookie.arrayBuffer()
    record('M2-12', withoutCookie.status === 200 && body.byteLength > 0,
      `无 Cookie 带签名取媒体 → ${withoutCookie.status} ${withoutCookie.headers.get('content-type')} ${body.byteLength} B`)

    const tampered = signedUrl.replace(/sig=[^&]+/, 'sig=deadbeef')
    const tamperedResponse = await fetch(`${base}${tampered}`, { redirect: 'manual' })
    record('M2-13', tamperedResponse.status !== 200,
      `篡改签名 → ${tamperedResponse.status}（回落会话门禁）`)

    const unsigned = await fetch(`${base}/media/v1/${resourcePath}`, { redirect: 'manual' })
    record('M2-14', unsigned.status !== 200,
      `无签名无 Cookie → ${unsigned.status}（不放行）`)
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
