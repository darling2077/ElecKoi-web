/**
 * 验收：请求体超限时必须是**能读懂的 413**，而不是把连接掐掉。
 *
 * 背景（真实故障）：导入角色卡是把整张卡的 base64 塞进一次 `POST /api/rpc` 的，
 * 上游契约单文件就允许到 132 MB。老实现给请求体设了 8 MB 上限，超了直接
 * `req.destroy()` —— 浏览器侧只会看到「与桌面服务的连接已断开」，
 * 于是"上传大图 / 批量导入"失败时完全看不出原因。
 *
 * 这里用真实 HTTP 请求验证三件事：
 *   1. 上限以内的请求照常被处理；
 *   2. 超限的请求拿到 413 + 明确文案（含上限数值与下一步），且 fetch 不抛异常；
 *   3. 超限之后连接仍可用（不会把服务打坏）。
 *
 * 运行：pnpm webui:uploadlimit
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { WebHost } from '../WebHost'
import { startWebServer, singleTenantResolver } from '../http/server'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

/** 造一个恰好 sizeBytes 的 JSON 请求体。 */
function bodyOf(sizeBytes: number): string {
  const skeleton = JSON.stringify({ name: 'query.app.bootstrap', input: { blob: '' } })
  const filler = Math.max(0, sizeBytes - skeleton.length)
  return JSON.stringify({ name: 'query.app.bootstrap', input: { blob: 'A'.repeat(filler) } })
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'eleckoi-uploadlimit-'))
  const limit = 4 * 1024 * 1024
  const tenant = await WebHost.mountTenant({
    tenantId: 'tenant-upload-limit',
    tenantRoot: join(root, 'tenant'),
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-uploadlimit'
  })
  const server = await startWebServer({
    host: '127.0.0.1',
    port: 0,
    rendererDir: resolve('out/renderer'),
    maxBodyBytes: limit,
    resolveSession: singleTenantResolver(tenant.gateway, tenant.context.mediaAssets)
  })
  const base = server.url
  console.log(`\n== 请求体上限验收 ==\n服务：${base}\n上限：${(limit / 1048576).toFixed(0)} MB\n`)

  const post = async (body: string): Promise<{ status: number; text: string; threw: boolean }> => {
    try {
      const response = await fetch(`${base}/api/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
      })
      return { status: response.status, text: await response.text(), threw: false }
    } catch (error) {
      return { status: 0, text: error instanceof Error ? error.message : String(error), threw: true }
    }
  }

  try {
    // ── 1. 上限以内：正常被处理（这里方法名不存在，但那是处理器层的错误，不是传输层的）──
    const small = await post(bodyOf(512 * 1024))
    record('UL-1', !small.threw && small.status === 200 && small.text.includes('"ok":false'),
      `1 MB 以内的请求正常往返：HTTP ${small.status}，${small.text.length} 字节响应`)

    // ── 2. 刚好在上限附近：仍应被处理 ──
    const nearLimit = await post(bodyOf(limit - 64 * 1024))
    record('UL-2', !nearLimit.threw && nearLimit.status === 200,
      `接近上限（${((limit - 64 * 1024) / 1048576).toFixed(1)} MB）的请求仍被处理：HTTP ${nearLimit.status}`)

    // ── 3. 超限：必须是可读的 413，而不是断线 ──
    const over = await post(bodyOf(limit + 512 * 1024))
    const readable = !over.threw && over.status === 413
    let message = ''
    try {
      message = (JSON.parse(over.text) as { error?: { message?: string } }).error?.message ?? ''
    } catch {
      message = over.text
    }
    record('UL-3', readable,
      readable
        ? `超限请求拿到 HTTP 413（没有断线）：${message.slice(0, 80)}`
        : `超限请求失败：threw=${over.threw} status=${over.status} ${over.text.slice(0, 80)}`)

    // ── 4. 文案要能指导下一步：含上限数值与可调变量 ──
    const actionable = message.includes('请求体过大') && message.includes('MB') && message.includes('ELECKOI_MAX_BODY_BYTES')
    record('UL-4', actionable, `413 文案给出上限与下一步：${message}`)

    // ── 5. 超限之后服务仍可用（没有把连接池或事件循环打坏）──
    const after = await post(bodyOf(256 * 1024))
    record('UL-5', !after.threw && after.status === 200,
      `超限请求之后仍能正常请求：HTTP ${after.status}`)
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
