/**
 * 构建期把 better-sqlite3 顶到 13.x —— Node 24 下的「优雅关闭即崩溃」修复。
 *
 * 背景（详见 docs/webui/better-sqlite3-退出断言与容器重启.md）：
 *   better-sqlite3 12.x 用 Node 原生 `node::ObjectWrap` 包装 Database/Statement。
 *   Node 24 给 ObjectWrap 加了环境清理钩子，析构时会调 `RemoveEnvironmentCleanupHook`，
 *   而 Node 侧 `CHECK_NOT_NULL(env)` 没有兜底。进程退出时 Node 先拆掉 Environment，
 *   V8 随后做最后一次 GC 回收残留的 Statement → 钩子拿到 env == nullptr → 断言 → SIGABRT。
 *   后果：**每一次正常关闭都被记成崩溃**，`restart: unless-stopped` 下表现为容器反复重启。
 *   v13 已改用 node-addon-api（N-API），析构不再走那个钩子；公开 API 未变，无需改代码。
 *
 * 为什么在构建期覆盖，而不是直接改依赖声明：
 *   上游把版本精确锁在 12.11.1，而 `scripts/check-upstream-diff.mjs` 要求 package.json
 *   与基线**逐字一致**（只允许新增 script）。直接改会破坏「一条线 rebase 上游」这个前提。
 *   因此覆盖只发生在镜像里，仓库中的 package.json / pnpm-lock.yaml 保持上游原样。
 *   代价：本地开发树仍是上游锁的 12.x，本文件与 Dockerfile 的调用是「镜像 ≠ 本地树」的唯一来源。
 *
 * 用法（由 docker/Dockerfile 调用，不手工提交其副作用）：
 *   node scripts/webui-pin-better-sqlite3.mjs          # 写入 pnpm.overrides（幂等）
 *   node scripts/webui-pin-better-sqlite3.mjs --verify # 校验装到 13.x 且原生模块真能用
 *
 * 何时删掉：上游把 better-sqlite3 升到 13.x（或 Node 侧修掉该断言）之后，
 * 删掉本脚本、Dockerfile 里的两步调用、以及上面提到的那篇文档。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

/** 目标版本。v13 起为 N-API 实现，是这条断言消失的版本线。 */
const PINNED_VERSION = '13.0.3'
/** 可接受的最低主版本（留出上游把 13.x 往上顶的空间，但挡住退回 12.x）。 */
const MIN_MAJOR = 13

const root = process.cwd()
const packageJsonPath = resolve(root, 'package.json')
const verifyOnly = process.argv.includes('--verify')

function fail(message) {
  console.error(`[pin-better-sqlite3] ✗ ${message}`)
  process.exit(1)
}

/** 读实际装到磁盘上的版本（走 node_modules，而不是任何声明）。 */
function installedVersion() {
  const manifest = resolve(root, 'node_modules/better-sqlite3/package.json')
  if (!existsSync(manifest)) fail(`找不到已安装的 better-sqlite3：${manifest}`)
  return JSON.parse(readFileSync(manifest, 'utf8')).version
}

if (verifyOnly) {
  const version = installedVersion()
  const major = Number.parseInt(version.split('.')[0], 10)
  if (!(major >= MIN_MAJOR)) {
    fail(`装到的是 better-sqlite3 ${version}，需要 >= ${MIN_MAJOR}.x —— 覆盖没生效，`
      + '构建必须停下来：12.x 在 Node 24 上会让每次优雅关闭都变成 SIGABRT。')
  }
  // 只比版本号不够：v13 走 N-API 预编译产物，拿错平台/架构的二进制要到 require 时才炸。
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  try {
    db.exec('create table t(x integer)')
    db.prepare('insert into t values (?)').run(42)
    const row = db.prepare('select x from t').get()
    if (row?.x !== 42) fail(`原生模块自检结果不对：${JSON.stringify(row)}`)
  } finally {
    db.close()
  }
  console.log(`[pin-better-sqlite3] ✓ better-sqlite3 ${version}（N-API），原生模块自检通过`)
  process.exit(0)
}

const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
manifest.pnpm = manifest.pnpm ?? {}
manifest.pnpm.overrides = { ...(manifest.pnpm.overrides ?? {}), 'better-sqlite3': PINNED_VERSION }
writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`[pin-better-sqlite3] 已在 ${packageJsonPath} 写入 pnpm.overrides["better-sqlite3"] = ${PINNED_VERSION}`)
