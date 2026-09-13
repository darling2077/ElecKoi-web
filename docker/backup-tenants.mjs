#!/usr/bin/env node
/**
 * 租户数据备份与恢复。
 *
 * 为什么需要：上游没有迁移链（`user_version` 不匹配就直接拒绝启动），
 * 也没有账号级导出接口。对自建服务来说，**备份是唯一的数据保险**。
 *
 * 数据布局（见 docs/webui/ElecKoi-Docker-WebUI-多用户方案.md §3.2）：
 *   /data/registry.sqlite            控制面：用户、会话、租户、配额、审计
 *   /data/tenants/<tenantId>/        每个用户一个目录
 *       ├── db/eleckoi-common.sqlite3   产品库
 *       ├── media/                      角色图、聊天背景、卡片素材
 *       ├── workspace/                  Agent 工作目录
 *       └── dsh-runtime/                DSH 会话与预设（含 JSONL 事件日志）
 *
 * SQLite 一律用 `VACUUM INTO` 取一致性快照，避免直接拷贝时 WAL 未合并导致数据缺失。
 *
 * 用法：
 *   node docker/backup-tenants.mjs backup  --data /data --out /backup/eleckoi-2026-09-13.tgz
 *   node docker/backup-tenants.mjs verify  --archive /backup/eleckoi-2026-09-13.tgz
 *   node docker/backup-tenants.mjs restore --archive /backup/…tgz --into /data-restored
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import Database from 'better-sqlite3'

/**
 * 在**独立子进程**里对单个数据库做一致性快照。
 *
 * 为什么不开子进程不行：better-sqlite3 的 Database 析构器会调用
 * `RemoveEnvironmentCleanupHook`，当这类对象在进程退出阶段才被 GC 时会触发
 * 原生断言 `Assertion failed: (env) != nullptr` 并 SIGABRT。
 * 账号池一大（每个租户一个库）GC 压力上来就会中途崩溃——实测 5 个租户即复现，
 * 而只测 2 个租户时看不出来。
 *
 * 放进子进程后，即使子进程在退出阶段崩掉，快照文件也已经写完；
 * 这里只以「产物是否可用」为准，不迷信退出码。
 */
function snapshotDatabaseInChild(sourcePath, targetPath) {
  const snippet = [
    "const Database = require('better-sqlite3')",
    'const db = new Database(process.argv[1], { readonly: true })',
    "db.prepare('VACUUM INTO ?').run(process.argv[2])",
    'db.close()'
  ].join(';')
  let childError = ''
  try {
    execFileSync(process.execPath, ['-e', snippet, sourcePath, targetPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    childError = String(error?.stderr ?? error?.message ?? error).slice(0, 200)
  }
  // 以产物为准：能只读打开且通过完整性检查才算成功。
  if (!existsSync(targetPath)) fail(`快照失败（未生成文件）：${sourcePath}${childError === '' ? '' : `｜${childError}`}`)
  const check = new Database(targetPath, { readonly: true })
  try {
    const result = check.pragma('integrity_check', { simple: true })
    if (result !== 'ok') fail(`快照完整性检查未通过：${sourcePath}（${result}）`)
  } finally {
    check.close()
  }
}

const MANIFEST = 'manifest.json'

function fail(message) {
  console.error(`错误：${message}`)
  process.exit(1)
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`${name} 缺少取值`)
  return value
}

/** 取一致性快照（走子进程），目标文件必须不存在。 */
function snapshotDatabase(sourcePath, targetPath) {
  mkdirSync(resolve(targetPath, '..'), { recursive: true })
  rmSync(targetPath, { force: true })
  snapshotDatabaseInChild(sourcePath, targetPath)
}

function listTenantDirectories(dataDir) {
  const tenantsDir = join(dataDir, 'tenants')
  if (!existsSync(tenantsDir)) return []
  return readdirSync(tenantsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function commandBackup() {
  const dataDir = resolve(argValue('--data', process.env.ELECKOI_DATA_DIR ?? '/data'))
  const out = resolve(argValue('--out', ''))
  if (out === '') fail('backup 需要 --out <归档路径>')
  const registry = join(dataDir, 'registry.sqlite')
  if (!existsSync(registry)) fail(`找不到控制面数据库：${registry}`)

  const staging = mkdtempSync(join(tmpdir(), 'eleckoi-backup-'))
  try {
    snapshotDatabase(registry, join(staging, 'registry.sqlite'))

    const tenants = listTenantDirectories(dataDir)
    for (const tenantId of tenants) {
      const source = join(dataDir, 'tenants', tenantId)
      const target = join(staging, 'tenants', tenantId)
      mkdirSync(target, { recursive: true })
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (entry.name === 'db') continue
        cpSync(join(source, entry.name), join(target, entry.name), { recursive: true, force: true })
      }
      const tenantDatabase = join(source, 'db', 'eleckoi-common.sqlite3')
      if (existsSync(tenantDatabase)) {
        snapshotDatabase(tenantDatabase, join(target, 'db', 'eleckoi-common.sqlite3'))
      }
    }

    writeFileSync(join(staging, MANIFEST), JSON.stringify({
      format: 'eleckoi-webui-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      source: dataDir,
      tenants
    }, null, 2))

    mkdirSync(resolve(out, '..'), { recursive: true })
    execFileSync('tar', ['-czf', out, '-C', staging, '.'], { stdio: 'inherit' })
    const size = statSync(out).size
    console.log(`备份完成：${out}（${(size / 1024 / 1024).toFixed(1)} MB，${tenants.length} 个租户）`)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** 解包到临时目录并做结构 + 完整性校验，返回解包路径（调用方负责清理）。 */
function extractAndVerify(archive) {
  if (!existsSync(archive)) fail(`找不到归档：${archive}`)
  const staging = mkdtempSync(join(tmpdir(), 'eleckoi-restore-'))
  execFileSync('tar', ['-xzf', archive, '-C', staging], { stdio: 'inherit' })

  const manifestPath = join(staging, MANIFEST)
  if (!existsSync(manifestPath)) {
    rmSync(staging, { recursive: true, force: true })
    fail('归档缺少 manifest.json，可能不是本工具生成的备份')
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.format !== 'eleckoi-webui-backup') {
    rmSync(staging, { recursive: true, force: true })
    fail(`归档格式不匹配：${manifest.format}`)
  }

  const registry = join(staging, 'registry.sqlite')
  if (!existsSync(registry)) {
    rmSync(staging, { recursive: true, force: true })
    fail('归档缺少控制面数据库')
  }

  const database = new Database(registry, { readonly: true })
  let users = 0
  let tenants = 0
  let broken = []
  try {
    users = database.prepare('select count(*) as n from users').get().n
    tenants = database.prepare('select count(*) as n from tenants').get().n
  } finally {
    database.close()
  }

  for (const tenantId of manifest.tenants ?? []) {
    const tenantDatabase = join(staging, 'tenants', tenantId, 'db', 'eleckoi-common.sqlite3')
    if (!existsSync(tenantDatabase)) {
      broken.push(`${tenantId}（缺数据库）`)
      continue
    }
    const tenantDb = new Database(tenantDatabase, { readonly: true })
    try {
      const result = tenantDb.pragma('integrity_check', { simple: true })
      if (result !== 'ok') broken.push(`${tenantId}（${result}）`)
    } finally {
      tenantDb.close()
    }
  }
  return { staging, manifest, users, tenants, broken }
}

function commandVerify() {
  const archive = resolve(argValue('--archive', ''))
  if (archive === '') fail('verify 需要 --archive <归档路径>')
  const { staging, manifest, users, tenants, broken } = extractAndVerify(archive)
  try {
    console.log(`归档：${basename(archive)}`)
    console.log(`生成时间：${manifest.createdAt}`)
    console.log(`用户 ${users} 个、租户记录 ${tenants} 条、租户目录 ${(manifest.tenants ?? []).length} 个`)
    if (broken.length > 0) {
      console.error(`完整性检查未通过：${broken.join('、')}`)
      process.exit(1)
    }
    console.log('完整性检查通过。')
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function commandRestore() {
  const archive = resolve(argValue('--archive', ''))
  const into = resolve(argValue('--into', ''))
  if (archive === '' || into === '') fail('restore 需要 --archive <归档路径> 与 --into <目标目录>')
  if (existsSync(join(into, 'registry.sqlite'))) fail(`目标目录已有数据：${into}（先移走或换目录，避免覆盖）`)

  const { staging, manifest, users, tenants } = extractAndVerify(archive)
  try {
    mkdirSync(into, { recursive: true })
    cpSync(staging, into, { recursive: true, force: true })
    rmSync(join(into, MANIFEST), { force: true })
    console.log(`恢复完成：${into}`)
    console.log(`用户 ${users} 个、租户记录 ${tenants} 条、租户目录 ${(manifest.tenants ?? []).length} 个`)
    console.log('提示：恢复的是归档时刻的状态，请确认服务已停止后再启动，避免两个实例写同一份数据。')
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

const command = process.argv[2]
if (command === 'backup') commandBackup()
else if (command === 'verify') commandVerify()
else if (command === 'restore') commandRestore()
else {
  console.error('用法：backup --data <目录> --out <归档> ｜ verify --archive <归档> ｜ restore --archive <归档> --into <目录>')
  process.exit(2)
}
