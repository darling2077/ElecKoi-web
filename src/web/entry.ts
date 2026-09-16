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

/**
 * 「本地图床」模式的图片目录。
 *
 * 只有 ELECKOI_CARD_IMAGE_MODE=local 才需要：图片落到这里，由本服务在卡片源上以
 * /card-images/ 提供。返回 undefined 时该路由不挂载（其他三种模式都不需要它）。
 */
function readCardImageDir(): string | undefined {
  if ((process.env.ELECKOI_CARD_IMAGE_MODE ?? '').trim() !== 'local') return undefined
  return (process.env.ELECKOI_IMAGE_LOCAL_DIR ?? '').trim() || '/data/card-images'
}

/**
 * `POST /api/rpc` 的请求体上限。
 *
 * 导入角色卡是把整张卡的 base64 塞进一次请求的，上游契约单文件允许到 132 MB，
 * 8 MB 的老上限会让稍大的卡或批量导入直接失败——而且浏览器只看到「连接已断开」，
 * 完全看不出原因。这里默认给到 128 MB，可用 ELECKOI_MAX_BODY_BYTES 调整。
 */
function readMaxBodyBytes(): number {
  const raw = (process.env.ELECKOI_MAX_BODY_BYTES ?? '').trim()
  const bytes = Number(raw)
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 128 * 1024 * 1024
}
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
  maxBodyBytes: readMaxBodyBytes(),
  ...(readCardImageDir() === undefined ? {} : { cardImageDir: readCardImageDir() as string }),
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
console.log(`单次请求体上限：${(readMaxBodyBytes() / 1048576).toFixed(0)} MB（导入大卡或批量导入顶到时会提示 413，可用 ELECKOI_MAX_BODY_BYTES 调整）\n`)

if ((process.env.ELECKOI_CARD_IMAGE_ORIGINS ?? '').trim() !== '') {
  console.log(`卡片可加载的外部图片源：${process.env.ELECKOI_CARD_IMAGE_ORIGINS}\n`)
}

// 导入卡片时自动搬图是否就绪——出问题时第一眼要看的就是这行。
{
  const publicBase = (process.env.ELECKOI_IMAGE_PUBLIC_BASE ?? '').trim()
  const uploadApi = (process.env.ELECKOI_IMAGE_UPLOAD_API ?? '').trim()
  const token = (process.env.ELECKOI_IMAGE_UPLOAD_TOKEN ?? '').trim()
  const mode = (process.env.ELECKOI_CARD_IMAGE_MODE ?? '').trim()
  const when = (process.env.ELECKOI_IMAGE_LOCALIZE_MODE ?? '').trim() === 'background' ? 'background（导入立即返回）' : 'inline（导入等到搬完）'
  if (mode === 'inline') {
    console.log(`卡片图片做法：inline —— 导入时内联成 data: URI（不需要图床与白名单，导出即自带图），搬运时机 ${when}\n`)
  } else if (mode === 'local') {
    console.log(`卡片图片做法：local —— 导入时存到 ${readCardImageDir()}，由本服务在卡片源 /card-images/ 提供（不需要白名单，导出后别人看不到），搬运时机 ${when}\n`)
  } else if (mode === 'third-party') {
    console.log(`卡片图片做法：third-party —— 只放行第三方图床、不搬运。放行清单：${(process.env.ELECKOI_CARD_IMAGE_ORIGINS ?? '').trim() || '（空！请设 ELECKOI_CARD_IMAGE_ORIGINS）'}\n`)
  } else if (mode === 'off') {
    console.log('卡片图片做法：off —— 不搬运，卡片里的外链图片会被 CSP 拦掉（显示为黑块）\n')
  } else if (publicBase !== '' && uploadApi !== '' && token !== '') {
    console.log(`卡片图片做法：self-hosted —— 导入时搬到 ${publicBase}，搬运时机 ${when}\n`)
  } else {
    console.log('卡片图片做法：未配置（未设 ELECKOI_CARD_IMAGE_MODE，且图床三件套不全）——不会搬运\n')
  }
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
