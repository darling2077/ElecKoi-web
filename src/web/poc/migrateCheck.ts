/**
 * 数据库迁移验收：v3 → v4（上游 v0.2.0 的 `0004DshTurnBinding`）。
 *
 * 为什么单独做这一条：上游没有迁移链的回退机制，`user_version` 不匹配就直接拒绝启动；
 * 而 v0.2.0 的迁移会**重建 `agent_responses`**（先 DROP 再 CREATE 再从备份表回填），
 * 一旦回填有问题就是"聊天记录整段消失"。所以这条必须在**真实库的副本**上跑过才敢上线。
 *
 * 断言：
 *   D-1 副本迁移前确实是 v3；
 *   D-2 迁移后 `user_version` 到 4，且没有残留的备份表；
 *   D-3 `agent_responses` 行数与关键字段逐行一致（重建表不能丢行、不能错位）；
 *   D-4 迁移要求的形状变化都到位（`chat_sessions.historySummary` 没了、
 *       `agent_content_parts` 没了、`agent_responses` 有新列、`agent_conversations.runtimeThreadId` 已回填）；
 *   D-5 新表建出来了（agent_pending_inputs / agent_openings / agent_setting_snapshots）；
 *   D-6 库整体 `PRAGMA integrity_check` 与外键检查通过。
 *
 * 用法（默认读生产库副本路径，可覆盖）：
 *   node out/web/migrate.mjs --db /path/to/eleckoi-common.sqlite3
 *   ELECKOI_MIGRATE_SOURCE=/vol1/.../eleckoi-common.sqlite3 pnpm webui:migrate
 */

import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSchema } from '@main/platform/sqlite/installSchema'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

/** 生产库副本的默认位置（可用 --db 或环境变量覆盖）。 */
const DEFAULT_SOURCE = '/vol1/docker/volumes/docker_eleckoi-data/_data/tenants/t_fa23cdf77157127ea18c7639/db/eleckoi-common.sqlite3'

function resolveSource(): string {
  const flag = process.argv.indexOf('--db')
  if (flag >= 0 && process.argv[flag + 1] !== undefined) return process.argv[flag + 1]!
  return process.env.ELECKOI_MIGRATE_SOURCE ?? DEFAULT_SOURCE
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
}

/** 表存在才计数：不同版本的库表名会变，写死表名会让 POC 自己先炸。 */
function countIfExists(db: Database.Database, table: string): number | undefined {
  if (!tableExists(db, table)) return undefined
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
}

interface ResponseRow {
  id: string
  conversationId: string
  turnId: string
  responseIndex: number
  speakerId: string
  status: string
  createdAt: string
  variableStateJson: string
  runtimeThreadId: string
}

async function main(): Promise<void> {
  const source = resolveSource()
  console.log(`\n== 数据库迁移验收（v3 → v4）==\n源库：${source}\n`)

  if (!existsSync(source)) {
    record('D-1', false, `源库不存在：${source}（用 --db 指定真实库副本）`)
    process.exitCode = 1
    return
  }

  const staged = await mkdtemp(join(tmpdir(), 'eleckoi-migrate-'))
  const copy = join(staged, 'eleckoi-common.sqlite3')
  copyFileSync(source, copy)
  // WAL/SHM 一并带上，否则副本可能落后于主库。
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${copy}${suffix}`)
  }

  const db = new Database(copy)
  try {
    db.pragma('foreign_keys = ON')

    const versionBefore = db.pragma('user_version', { simple: true }) as number
    const before = db.prepare(
      'SELECT id, conversationId, turnId, responseIndex, speakerId, status, createdAt, variableStateJson, runtimeThreadId FROM agent_responses ORDER BY id'
    ).all() as ResponseRow[]
    // 只统计真实存在的表：v0.1.x 的库里有 49 张表，消息在 agent_turns/agent_responses 里，
    // 并没有一张叫 messages 的表（POC 自己写死表名会先炸）。
    const WATCHED_TABLES = ['agent_responses', 'agent_turns', 'agent_conversations', 'characters', 'chat_sessions'] as const
    const countsBefore = Object.fromEntries(
      WATCHED_TABLES.map((table) => [table, countIfExists(db, table) ?? -1])
    ) as Record<(typeof WATCHED_TABLES)[number], number>
    record('D-1', versionBefore === 3,
      `副本 user_version=${versionBefore}（期望 3）；agent_responses ${before.length} 行、` +
      WATCHED_TABLES.map((table) => `${table} ${countsBefore[table]}`).join('、'))

    if (versionBefore !== 3) {
      record('D-2', false, `源库不是 v3（${versionBefore}），本验收不做无意义迁移`)
      return
    }

    // ── 跑真实迁移 ──
    installSchema(db)

    const versionAfter = db.pragma('user_version', { simple: true }) as number
    const leftoverBackup = tableExists(db, 'agent_responses_v3_backup')
    record('D-2', versionAfter === 4 && !leftoverBackup,
      `迁移后 user_version=${versionAfter}（期望 4）、残留备份表=${leftoverBackup}`)

    // ── 逐行比对（重建表最容易在这里出问题）──
    const after = db.prepare(
      'SELECT id, conversationId, turnId, responseIndex, speakerId, status, createdAt, variableStateJson, runtimeThreadId FROM agent_responses ORDER BY id'
    ).all() as ResponseRow[]
    const sameLength = after.length === before.length
    let firstDiff = ''
    if (sameLength) {
      for (let index = 0; index < before.length; index += 1) {
        const a = before[index]!
        const b = after[index]!
        for (const key of Object.keys(a) as Array<keyof ResponseRow>) {
          if (a[key] !== b[key]) {
            firstDiff = `第 ${index} 行 ${key}：${String(a[key]).slice(0, 40)} → ${String(b[key]).slice(0, 40)}`
            break
          }
        }
        if (firstDiff !== '') break
      }
    } else {
      firstDiff = `行数 ${before.length} → ${after.length}`
    }
    record('D-3', sameLength && firstDiff === '',
      firstDiff === ''
        ? `${after.length} 行逐字段一致（id/conversationId/turnId/responseIndex/speakerId/status/createdAt/variableStateJson/runtimeThreadId）`
        : `不一致：${firstDiff}`)

    // ── 形状变化 ──
    const responsesColumns = columnNames(db, 'agent_responses')
    const conversationsColumns = columnNames(db, 'agent_conversations')
    const sessionColumns = columnNames(db, 'chat_sessions')
    const emptyThreads = (db.prepare(
      "SELECT COUNT(*) AS n FROM agent_conversations WHERE runtimeThreadId IS NULL OR runtimeThreadId = ''"
    ).get() as { n: number }).n
    const shapeOk = responsesColumns.includes('dshTurn')
      && responsesColumns.includes('storedRegexRulesJson')
      && !sessionColumns.includes('historySummary')
      && !tableExists(db, 'agent_content_parts')
      && conversationsColumns.includes('runtimeThreadId')
    record('D-4', shapeOk,
      `agent_responses 新列=${responsesColumns.includes('dshTurn') && responsesColumns.includes('storedRegexRulesJson')}、` +
      `chat_sessions 去掉 historySummary=${!sessionColumns.includes('historySummary')}、` +
      `agent_content_parts 已删=${!tableExists(db, 'agent_content_parts')}、` +
      `agent_conversations.runtimeThreadId 就位=${conversationsColumns.includes('runtimeThreadId')}（空值 ${emptyThreads} 行）`)

    // ── 新表 ──
    const newTables = ['agent_pending_inputs', 'agent_openings', 'agent_setting_snapshots']
    const missing = newTables.filter((name) => !tableExists(db, name))
    record('D-5', missing.length === 0,
      missing.length === 0 ? `新表已建：${newTables.join('、')}` : `缺表：${missing.join('、')}`)

    // ── 完整性 ──
    const integrity = (db.pragma('integrity_check', { simple: true }) as string)
    const foreignKeys = db.pragma('foreign_key_check') as unknown[]
    const countsAfter = Object.fromEntries(
      WATCHED_TABLES.map((table) => [table, countIfExists(db, table) ?? -1])
    ) as Record<(typeof WATCHED_TABLES)[number], number>
    const countsSame = WATCHED_TABLES.every((table) => countsBefore[table] === countsAfter[table])
    record('D-6', integrity === 'ok' && foreignKeys.length === 0 && countsSame,
      `integrity_check=${integrity}、外键问题 ${foreignKeys.length} 条；` +
      WATCHED_TABLES.map((table) => `${table} ${countsBefore[table]}→${countsAfter[table]}`).join('、'))

    console.log(`        副本大小 ${Math.round(statSync(copy).size / 1024)} KB（迁移后）`)
  } finally {
    db.close()
    rmSync(staged, { recursive: true, force: true })
  }

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log(`\n== 结果：${outcomes.length - failed.length}/${outcomes.length} 通过 ==`)
  if (failed.length > 0) {
    console.log(`未通过：${failed.map((item) => item.id).join('、')}`)
    process.exitCode = 1
  }
}

await main()
