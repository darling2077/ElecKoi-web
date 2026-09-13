/**
 * 备份/恢复验收。
 *
 * 步骤：起栈 → 两个用户各写一份数据 → 关栈 → 备份 → 校验 → 恢复到新目录
 *       → 打开恢复后的控制面与租户库，确认用户、租户、业务数据都还在。
 *
 * 这条断言的意义：上游没有迁移链也没有账号级导出，备份是自建服务唯一的数据保险，
 * 必须证明「备份出来的东西真能恢复回一份可用数据」，而不只是脚本跑通。
 *
 * 运行：pnpm webui:backup
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { startWebUiStack } from '../stack'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

const SCRIPT = resolve('docker/backup-tenants.mjs')

/** 子进程 stderr 必须捕获：失败时要把脚本的说明原样带回断言。 */
function run(args: string[]): string {
  const result = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const error = new Error(`退出码 ${result.status}`) as Error & { stderr?: string }
    error.stderr = result.stderr ?? ''
    throw error
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

class Jar {
  private cookie = ''
  capture(response: Response): void {
    for (const entry of response.headers.getSetCookie?.() ?? []) {
      const pair = entry.split(';')[0] ?? ''
      if (pair.startsWith('eleckoi_session=')) this.cookie = pair
    }
  }
  header(): Record<string, string> {
    return this.cookie ? { cookie: this.cookie } : {}
  }
}

async function rpc(base: string, jar: Jar, name: string, input: unknown): Promise<unknown> {
  const response = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...jar.header() },
    body: JSON.stringify({ name, input })
  })
  const body = (await response.json()) as { ok: boolean; data?: unknown }
  return body.data
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-backup-'))
  const dataRoot = join(root, 'data')
  const archive = join(root, 'backup.tgz')
  const restored = join(root, 'restored')
  const stack = await startWebUiStack({
    dataRoot,
    rendererDir: resolve('out/renderer'),
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-backup',
    port: 0,
    allowRegistration: true
  })
  const base = stack.server.url
  console.log(`\n== ElecKoi WebUI · 备份与恢复验收 ==\n数据目录：${dataRoot}\n`)

  const jarA = new Jar()
  const jarB = new Jar()
  try {
    for (const [jar, email] of [[jarA, 'alice@example.com'], [jarB, 'bob@example.com']] as const) {
      const response = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'correct-horse-battery' })
      })
      jar.capture(response)
    }
    await rpc(base, jarA, 'command.settings.write', { key: 'locale.current', value: 'zh-CN-alice' })
    await rpc(base, jarB, 'command.settings.write', { key: 'locale.current', value: 'en-US-bob' })

    // 关栈，模拟「服务已停止」的备份前提
    await stack.close()
    record('B-1', true, '两个用户各写入一份数据后关闭服务')

    const backupOutput = run(['backup', '--data', dataRoot, '--out', archive])
    const size = statSync(archive).size
    record('B-2', existsSync(archive) && size > 0,
      `备份产出 ${(size / 1024).toFixed(1)} KB｜${backupOutput.trim().split('\n').pop() ?? ''}`)

    const verifyOutput = run(['verify', '--archive', archive])
    record('B-3', verifyOutput.includes('完整性检查通过'), verifyOutput.trim().split('\n').slice(-2).join('｜'))

    // 备份期间的写入不应影响归档一致性（VACUUM INTO 取快照）
    const restoreOutput = run(['restore', '--archive', archive, '--into', restored])
    record('B-4', existsSync(join(restored, 'registry.sqlite')),
      restoreOutput.trim().split('\n')[0] ?? '（无输出）')

    // ── 恢复后的数据必须可用 ──
    const control = new Database(join(restored, 'registry.sqlite'), { readonly: true })
    const users = control.prepare('select email from users order by email').all() as Array<{ email: string }>
    const tenants = control.prepare('select tenant_id from tenants').all() as Array<{ tenant_id: string }>
    control.close()
    record('B-5', users.length === 2 && tenants.length === 2,
      `恢复后用户：${users.map((row) => row.email).join('、')}；租户 ${tenants.length} 个`)

    const tenantDirs = await readdir(join(restored, 'tenants'))
    const values: string[] = []
    for (const tenantId of tenantDirs) {
      const database = new Database(join(restored, 'tenants', tenantId, 'db', 'eleckoi-common.sqlite3'), { readonly: true })
      try {
        // 用户设置存在 desktop_preferences（上游把设备偏好放在业务 schema 之外）
        const row = database.prepare("select valueJson from desktop_preferences where key = 'locale.current'").get() as { valueJson?: string } | undefined
        if (row?.valueJson !== undefined) values.push(row.valueJson.replace(/^"|"$/g, ''))
      } finally {
        database.close()
      }
    }
    record('B-6', values.includes('zh-CN-alice') && values.includes('en-US-bob'),
      `恢复后各租户设置：${values.join('、')}`)

    // 恢复目标已有数据时必须拒绝，避免覆盖线上数据
    let refused = ''
    try {
      run(['restore', '--archive', archive, '--into', restored])
    } catch (error) {
      refused = String((error as { stderr?: string }).stderr ?? error)
    }
    record('B-7', refused.includes('已有数据'), '恢复到非空目录被拒绝（避免覆盖线上数据）')
  } catch (error) {
    record('B-8', false, `流程中断：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await stack.close().catch(() => undefined)
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
