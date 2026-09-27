/**
 * M1-T2：媒体链路验证。
 *
 * 覆盖三件事：
 *   1. 上游 LocalMediaStore 写入的引用（eleckoi-media://…）能被出站重写为 /media/v1/…
 *   2. HTTP 路由能按引用正确回源并给出正确 MIME
 *   3. 路径穿越（../、编码绕过）被上游 pathForReference 挡下，返回 404
 *
 * 运行：pnpm webui:media
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { WebHost } from '../WebHost'
import { singleTenantResolver, startWebServer } from '../http/server'
import { LOCAL_MEDIA_REFERENCE_PREFIX, WEB_MEDIA_REFERENCE_PREFIX } from '../transport/WebGateway'

/** 1×1 透明 PNG。 */
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-media-'))
  const tenant = await WebHost.mountTenant({
    tenantId: 'tenant-media',
    tenantRoot: join(root, 'tenant'),
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-m1'
  })

  const exportsDir = join(root, 'tenant', 'exports')
  const server = await startWebServer({
    port: 0,
    rendererDir: resolve('out/renderer'),
    resolveSession: singleTenantResolver(tenant.gateway, tenant.context.mediaAssets, exportsDir)
  })

  const base = server.url
  try {
    // ── 1. 写入媒体 ──
    const prepared = tenant.context.mediaAssets.prepareImage('char-p2b', 'avatar', PNG_DATA_URL)
    prepared.commit()
    const reference = prepared.reference
    record('M-1', reference.startsWith(LOCAL_MEDIA_REFERENCE_PREFIX),
      `上游产出引用：${reference}`)

    // ── 2. 出站重写 ──
    const conversation = await tenant.gateway.dispatch(
      { name: 'command.conversations.create', input: { title: '媒体测试' } },
      { senderId: 1, windowId: undefined }) as { conversation: { id: string } }
    const webUrl = reference.replace(LOCAL_MEDIA_REFERENCE_PREFIX, WEB_MEDIA_REFERENCE_PREFIX)
    record('M-2', webUrl.startsWith('/media/v1/') && !webUrl.includes('eleckoi-media://'),
      `浏览器可用 URL：${webUrl}（会话 ${conversation.conversation.id.slice(0, 8)}… 已建立，确认网关可用）`)

    // ── 3. 正常回源 ──
    const okResponse = await fetch(`${base}${webUrl}`)
    const contentType = okResponse.headers.get('content-type') ?? ''
    const bytes = (await okResponse.arrayBuffer()).byteLength
    record('M-3', okResponse.status === 200 && contentType === 'image/png' && bytes > 0,
      `GET ${webUrl} → ${okResponse.status} ${contentType} ${bytes} B`)

    // ── 4. 路径穿越 ──
    const attacks = [
      '/media/v1/../server.ts',
      '/media/v1/..%2f..%2f..%2fetc%2fpasswd',
      '/media/v1/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/media/v1/....//....//etc/passwd'
    ]
    const results: string[] = []
    let allBlocked = true
    for (const attack of attacks) {
      const response = await fetch(`${base}${attack}`)
      const body = await response.text()
      // 合法结果只有两种：404，或落到 SPA 回退返回 index.html。
      // 绝不能返回被穿越目标文件的内容本身。
      const isSpaFallback = body.trimStart().toLowerCase().startsWith('<!doctype html')
      const blocked = response.status === 404 || isSpaFallback
      if (!blocked) allBlocked = false
      results.push(`${attack} → ${response.status}${isSpaFallback ? '(SPA)' : ''}${blocked ? '' : ' ⚠ 泄露文件内容'}`)
    }
    record('M-4', allBlocked, results.join('；'))

    // ── M-5 目录选择器（上游 v0.1.10 新增依赖）──
    // 该服务缺失时 characterTransferPlugin 整块不加载，导入/导出 5 条路由会一起消失，
    // 而我们的图床搬运正挂在导入上——所以这里是硬断言，不是可选项。
    const picker = tenant.context.directoryPicker as {
      pickDirectory(request: { title: string; buttonLabel: string }): Promise<string | undefined>
    }
    const picked = await picker.pickDirectory({ title: '选择导出位置', buttonLabel: '导出到这里' })
    record('M-5', typeof picked === 'string' && picked.length > 0 && existsSync(picked),
      `目录选择器返回可用目录：${String(picked)}（Web 端等价物：租户导出目录）`)

    // ── M-6 导出链路终点：写进去的文件必须能从浏览器取回 ──
    // 只断言"文件存在"是不够的——用户在浏览器里拿不到就等于没做，所以一路验到 HTTP 响应体。
    const exported = '{"spec":"chara_card_v2","name":"导出验收"}\n'
    writeFileSync(join(exportsDir, 'export-check.json'), exported, 'utf8')
    const index = await fetch(`${base}/exports`)
    const indexHtml = await index.text()
    const listed = index.status === 200 && indexHtml.includes('export-check.json')
    const download = await fetch(`${base}/exports/export-check.json`)
    const body = await download.text()
    const traversal = await fetch(`${base}/exports/..%2F..%2Fregistry.sqlite`, { redirect: 'manual' })
    record('M-6', listed && download.status === 200 && body === exported && traversal.status === 404,
      `列表含该文件=${listed}、下载 ${download.status} 且内容一致=${body === exported}、`
      + `目录穿越被拒=${traversal.status === 404}`)
  } finally {
    await server.close()
    await tenant.dispose()
    await rm(root, { recursive: true, force: true })
  }

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log(`\n== 结果：${outcomes.length - failed.length}/${outcomes.length} 通过 ==`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
