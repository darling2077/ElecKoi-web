#!/usr/bin/env node
/**
 * 数据迁移：Agent 预设的工具配置内容键 `tool_policy` → `tool_configuration`
 *
 * ── 背景 ────────────────────────────────────────────────────────────────
 * 上游 v0.1.2（提交 d5d02ec）把预设内容的键名从 `tool_policy` 改成了
 * `tool_configuration`，但**没有提供数据迁移**。而 `ensureInitialized()` 的补种
 * 条件是「当前没有激活预设」，老库升级上来后预设行还在，于是：
 *
 *   预设行存在 → 不触发补种 → 内容表里仍然是 tool_policy
 *   → 代码读 tool_configuration 拿到 undefined → 抛「预设缺少工具配置。」
 *   → 预设页面直接打不开（新建的库不受影响，所以只打全新安装测不出来）
 *
 * 另一个入口同样中招：卸载桌面端**不会**删除用户数据目录里的
 * `eleckoi-common.sqlite3`，所以「重装一遍」仍然读的是老库。
 *
 * ── 只改键名，不改内容 ──────────────────────────────────────────────────
 * 两版的 JSON 结构完全一致（`version` 都是 4，字段名也没变），因此重命名即可，
 * 不需要转换 payload。已用真实租户库验证：迁移前 `get()` 抛错，迁移后正常读出。
 *
 * ── 冲突处理 ────────────────────────────────────────────────────────────
 * 万一同一预设下新旧两个键都存在（例如先行手工补过新键），保留新键那一行、
 * 删掉旧的，避免撞上 `(presetId, kind)` 的唯一约束。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node docker/migrate-preset-tool-policy.mjs <库文件 | 租户目录 | 数据根目录>
 *   # 默认 dry-run（只报告，不写入）；确认后再加 --apply
 *   node docker/migrate-preset-tool-policy.mjs /data --apply
 *
 * 三种入参都支持：
 *   /data/tenants/<id>/db/eleckoi-common.sqlite3   直接给库文件
 *   /data/tenants/<id>                             租户目录
 *   /data                                          数据根目录（遍历所有租户）
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

const LEGACY_KIND = 'tool_policy'
const CURRENT_KIND = 'tool_configuration'
const DB_RELATIVE = join('db', 'eleckoi-common.sqlite3')

const LEGACY_TABLE = 'agent_preset_contents'
const VERSION_TABLE = 'agent_preset_version_contents'

/** 表 → 用于判断「同一主体」的列（唯一约束去掉 kind 之后的那部分）。 */
const TARGETS = [
  { table: LEGACY_TABLE, keyColumns: ['presetId'] },
  { table: VERSION_TABLE, keyColumns: ['presetId', 'versionId'] }
]

function collectDatabases(input) {
  const target = resolve(input)
  // 路径写错要报错（手工执行时能立刻发现），但"目录在、只是还没有内容"是
  // 全新安装的正常状态——入口脚本每次启动都会调用它，不能因此启动失败。
  if (!existsSync(target)) throw new Error(`路径不存在：${target}`)
  if (statSync(target).isFile()) return [target]

  const direct = join(target, DB_RELATIVE)
  if (existsSync(direct)) return [direct]

  const tenantsRoot = join(target, 'tenants')
  if (!existsSync(tenantsRoot)) return []

  return readdirSync(tenantsRoot)
    .map((entry) => join(tenantsRoot, entry, DB_RELATIVE))
    .filter((candidate) => existsSync(candidate))
    .sort()
}

/**
 * 把驱动层的错误翻译成能照着做的提示。
 * 最常见的两种失败都不是"脚本坏了"，而是环境问题：
 *   - SQLITE_READONLY：数据卷里的文件属主不是容器用户（uid 10001），
 *     常见于从 root 时代的部署继承数据、或用 root 恢复过备份。
 *   - 库损坏：先跑 backup-tenants 的 verify 确认。
 */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/readonly/i.test(message)) {
    return `${message}\n     数据库文件不可写。容器以 uid 10001 运行；`
      + `若文件属主不对，在宿主机执行：chown -R 10001:10001 <数据卷路径>`
  }
  if (/corrupt|malformed/i.test(message)) {
    return `${message}\n     数据库可能已损坏，先跑 backup-tenants.mjs verify 确认。`
  }
  return message
}

function tableExists(db, name) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name))
}

function planFor(db, { table, keyColumns }) {
  if (!tableExists(db, table)) return { table, skip: '没有这张表', legacy: 0, conflicts: 0, renamed: 0 }

  const keyList = keyColumns.join(', ')
  const legacy = db.prepare(
    `SELECT ${keyList} FROM ${table} WHERE kind = ?`
  ).all(LEGACY_KIND)
  if (legacy.length === 0) return { table, skip: null, legacy: 0, conflicts: 0, renamed: 0 }

  const where = keyColumns.map((column) => `${column} = ?`).join(' AND ')
  const hasCurrent = db.prepare(`SELECT 1 FROM ${table} WHERE ${where} AND kind = ?`)
  const conflicts = legacy.filter((row) => hasCurrent.get(...keyColumns.map((c) => row[c]), CURRENT_KIND) !== undefined)

  return { table, skip: null, legacy: legacy.length, conflicts: conflicts.length, renamed: legacy.length - conflicts.length }
}

function applyFor(db, plan, { table, keyColumns }) {
  if (plan.skip !== null || plan.legacy === 0) return
  const where = keyColumns.map((column) => `${column} = ?`).join(' AND ')
  const deleteCurrent = db.prepare(`DELETE FROM ${table} WHERE ${where} AND kind = ?`)
  const selectLegacy = db.prepare(`SELECT ${keyColumns.join(', ')} FROM ${table} WHERE kind = ?`)

  for (const row of selectLegacy.all(LEGACY_KIND)) {
    const args = keyColumns.map((column) => row[column])
    const alreadyCurrent = db.prepare(`SELECT 1 FROM ${table} WHERE ${where} AND kind = ?`).get(...args, CURRENT_KIND)
    if (alreadyCurrent !== undefined) {
      // 新键已在，旧键是残留 → 删掉旧的，保留新的
      deleteCurrent.run(...args, LEGACY_KIND)
      continue
    }
    db.prepare(`UPDATE ${table} SET kind = ? WHERE ${where} AND kind = ?`)
      .run(CURRENT_KIND, ...args, LEGACY_KIND)
  }
}

function migrate(databasePath, apply) {
  const db = new Database(databasePath, { readonly: !apply })
  try {
    const plans = TARGETS.map((target) => ({ target, plan: planFor(db, target) }))
    const touched = plans.some(({ plan }) => plan.legacy > 0)
    if (apply && touched) {
      db.transaction(() => {
        for (const { target, plan } of plans) applyFor(db, plan, target)
      })()
    }
    return plans
  } finally {
    db.close()
  }
}

function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const inputs = args.filter((arg) => !arg.startsWith('--'))
  if (inputs.length === 0) {
    console.error('用法：node docker/migrate-preset-tool-policy.mjs <库文件|租户目录|数据根目录> [--apply]')
    process.exitCode = 2
    return
  }

  let databases
  try {
    databases = inputs.flatMap((input) => collectDatabases(input))
  } catch (error) {
    // 手工执行时路径写错要看得懂，而不是一坨堆栈
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
    return
  }
  if (databases.length === 0) {
    console.log('没有找到任何 eleckoi-common.sqlite3，什么都没做。')
    return
  }

  console.log(apply ? `模式：写入（--apply）\n` : `模式：dry-run（只报告，不改动；确认后加 --apply）\n`)
  let totalLegacy = 0
  let failed = 0
  for (const databasePath of databases) {
    let plans
    try {
      plans = migrate(databasePath, apply)
    } catch (error) {
      failed += 1
      console.error(`${databasePath}\n  ✗ 处理失败：${describeError(error)}`)
      continue
    }
    const legacy = plans.reduce((sum, { plan }) => sum + plan.legacy, 0)
    totalLegacy += legacy
    console.log(`${databasePath}`)
    for (const { target, plan } of plans) {
      if (plan.skip !== null) { console.log(`  ${target.table}：跳过（${plan.skip}）`); continue }
      if (plan.legacy === 0) { console.log(`  ${target.table}：无需迁移`); continue }
      console.log(`  ${target.table}：${LEGACY_KIND} ${plan.legacy} 行`
        + `（改名 ${plan.renamed}、删除与新键重复的 ${plan.conflicts}）`
        + (apply ? ' → 已处理' : ' → 待处理'))
    }
    console.log('')
  }

  if (failed > 0) {
    console.error(`结论：${failed} 个库处理失败（见上），其余${totalLegacy > 0 ? `处理 ${totalLegacy} 行` : '无需迁移'}。`)
    process.exitCode = 1
  } else if (totalLegacy === 0) {
    console.log('结论：所有库都已经是新键，无需迁移。')
  } else if (apply) {
    console.log(`结论：完成，共处理 ${totalLegacy} 行。请重启服务或让应用重新读取预设。`)
  } else {
    console.log(`结论：共需处理 ${totalLegacy} 行。确认无误后加 --apply 重新执行。`)
  }
}

main()
