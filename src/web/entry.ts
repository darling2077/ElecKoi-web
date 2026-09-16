/**
 * WebUI 生产入口（多租户形态）。
 *
 * 只负责：读环境变量 → 组装运行时栈（stack.ts）→ 装信号处理。
 * 具体接线都在 stack.ts，验收测试跑的是同一套。
 *
 * 安全边界：租户身份**只**来自服务端会话 Cookie；客户端传来的任何 id 都不参与解析。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startWebUiStack } from './stack'

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

const dataRoot = process.env.ELECKOI_DATA_DIR ?? '/data'
const appRoot = process.env.ELECKOI_APP_ROOT ?? process.cwd()
const rendererDir = process.env.ELECKOI_RENDERER_DIR ?? resolve(appRoot, 'out', 'renderer')
const allowRegistration = envFlag('ELECKOI_ALLOW_REGISTRATION', true)
const idleMs = Number(process.env.ELECKOI_TENANT_IDLE_MINUTES ?? 30) * 60 * 1000
const maxLive = Number(process.env.ELECKOI_MAX_LIVE_TENANTS ?? 50)

let masterKeyBase64 = process.env.ELECKOI_MASTER_KEY ?? ''
if (!masterKeyBase64 && process.env.ELECKOI_ALLOW_EPHEMERAL_KEY === '1') {
  masterKeyBase64 = randomBytes(32).toString('base64')
  console.warn('[web] 使用临时主密钥；重启后用户已保存的 API Key 将无法解密。')
}
if (!masterKeyBase64) {
  console.error('[web] 缺少 ELECKOI_MASTER_KEY（32 字节 base64）。生成：openssl rand -base64 32')
  process.exit(1)
}
if (!existsSync(rendererDir)) {
  console.error(`[web] 找不到渲染产物：${rendererDir}。请先执行 electron-vite build。`)
  process.exit(1)
}

const stack = await startWebUiStack({
  dataRoot,
  rendererDir,
  masterKeyBase64,
  appVersion: process.env.ELECKOI_VERSION ?? '0.1.0-web',
  host: process.env.ELECKOI_HOST ?? '127.0.0.1',
  port: Number(process.env.ELECKOI_PORT ?? 8790),
  allowRegistration,
  idleMs,
  maxLive,
  ...(process.env.ELECKOI_CARD_ORIGIN ? { cardOrigin: process.env.ELECKOI_CARD_ORIGIN } : {}),
  cardImageOrigins: (process.env.ELECKOI_CARD_IMAGE_ORIGINS ?? '').split(','),
  ...(process.env.ELECKOI_SOURCE_URL ? { sourceUrl: process.env.ELECKOI_SOURCE_URL } : {}),
  maxConcurrentRuns: Number(process.env.ELECKOI_MAX_CONCURRENT_RUNS ?? 2),
  adminEmails: (process.env.ELECKOI_ADMIN_EMAILS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
  log: (message) => console.log(`[web] ${message}`)
})

// 过期会话不清理会让 sessions 表无限增长。
const sessionSweeper = setInterval(() => {
  const removed = stack.control.deleteExpiredSessions()
  if (removed > 0) console.log(`[auth] 清理过期会话 ${removed} 条`)
}, 60 * 60 * 1000)
sessionSweeper.unref()

console.log(`\nElecKoi WebUI 已启动：${stack.server.url}`)
console.log(`数据目录：${dataRoot}　开放注册：${allowRegistration ? '是' : '否（账号池为空时仍可创建首个账号）'}　租户空闲回收：${idleMs / 60000} 分钟`)
console.log(`内置账号数：${stack.control.listTenants().length}`)
if (!process.env.ELECKOI_SOURCE_URL) {
  console.warn('[web] 未配置 ELECKOI_SOURCE_URL：AGPL-3.0 §13 要求向网络使用者提供对应源码，请尽快补齐。')
}
console.log(process.env.ELECKOI_CARD_ORIGIN
  ? `卡片源：${process.env.ELECKOI_CARD_ORIGIN}（富内容已跨源隔离）\n`
  : `卡片源：未配置——富内容与宿主同源，仅限本地自用，请勿开放公网。\n`)
if ((process.env.ELECKOI_CARD_IMAGE_ORIGINS ?? '').trim() !== '') {
  console.log(`卡片可加载的外部图片源：${process.env.ELECKOI_CARD_IMAGE_ORIGINS}\n`)
}

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n收到 ${signal}，正在关闭……`)
  clearInterval(sessionSweeper)
  await stack.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
