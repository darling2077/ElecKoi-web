/**
 * M0-P4：把渲染产物用 HTTP 跑起来，验证「UI 零改动」这条主张的服务端部分。
 *
 * 用法：ELECKOI_WEB_ENTRY=src/web/poc/serve.ts ELECKOI_WEB_OUTFILE=serve.mjs pnpm exec vite build --config src/web/vite.web.config.ts
 *       node out/web/serve.mjs
 *
 * 数据落在 ELECKOI_POC_DATA（缺省 /tmp/eleckoi-web-serve），便于反复启动观察持久化。
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WebHost } from '../WebHost'
import { singleTenantResolver, startWebServer } from '../http/server'

const dataRoot = process.env.ELECKOI_POC_DATA ?? process.env.ELECKOI_DATA_DIR ?? '/tmp/eleckoi-web-serve'
const tenantRoot = join(dataRoot, 'tenants', 'tenant-demo')
mkdirSync(tenantRoot, { recursive: true })

/**
 * 主密钥必须显式提供：它用于派生每租户的数据密钥加密用户 API Key，
 * 丢失即无法解密。开发态允许临时生成，容器内由 compose 强制注入。
 */
let masterKeyBase64 = process.env.ELECKOI_MASTER_KEY ?? ''
if (!masterKeyBase64) {
  masterKeyBase64 = randomBytes(32).toString('base64')
  console.warn('[web] 未提供 ELECKOI_MASTER_KEY，本次启动使用临时密钥；重启后已保存的 API Key 将无法解密。')
}

const tenant = await WebHost.mountTenant({
  tenantId: 'tenant-demo',
  tenantRoot,
  masterKeyBase64,
  appVersion: '0.1.0-web'
})

const server = await startWebServer({
  host: process.env.ELECKOI_HOST ?? '127.0.0.1',
  port: Number(process.env.ELECKOI_PORT ?? 8790),
  rendererDir: resolve('out/renderer'),
  resolveSession: singleTenantResolver(tenant.gateway, tenant.context.mediaAssets),
  log: (message) => console.log(`[web] ${message}`)
})

console.log(`\nElecKoi WebUI POC 已启动：${server.url}`)
console.log(`租户数据目录：${tenantRoot}`)
console.log('按 Ctrl+C 结束。\n')

async function shutdown(): Promise<void> {
  await server.close()
  await tenant.dispose()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
