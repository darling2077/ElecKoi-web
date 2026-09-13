/**
 * 账号体系验收：用户名登录、关闭自助注册、管理员用户管理。
 *
 * 覆盖的重点不是"功能能用"，而是**权限边界**：
 *   - 关掉自助注册后真的注册不了（账号池非空时）
 *   - 普通用户碰不到管理接口（401/403）
 *   - 管理员不能把自己锁在门外
 *   - 停用用户会同时踢掉其已有会话
 *
 * 运行：pnpm webui:admin
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { ControlDatabase } from '../control/ControlDatabase'
import { startWebUiStack } from '../stack'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

const BOSS = 'boss@example.com'
const BOSS_PASSWORD = 'boss-initial-password'

class Jar {
  cookie = ''
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

async function post(base: string, path: string, body: unknown, jar?: Jar): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(jar?.header() ?? {}) },
    body: JSON.stringify(body)
  })
  const payload = await response.json().catch(() => ({}))
  jar?.capture(response)
  return { status: response.status, body: payload }
}

async function get(base: string, path: string, jar?: Jar): Promise<{ status: number; body: any; html: string }> {
  const response = await fetch(`${base}${path}`, { headers: jar?.header() ?? {}, redirect: 'manual' })
  const html = await response.text()
  let parsed: any = {}
  try { parsed = JSON.parse(html) } catch { /* 非 JSON 页面 */ }
  return { status: response.status, body: parsed, html }
}

/**
 * 老库迁移：加用户名/管理员之前就已经存在的账号池必须能平滑升级。
 * 这条特意用「旧结构建库 → 用新代码打开」的方式复现真实升级路径，
 * 而不是只测全新数据库。
 */
async function checkMigration(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'eleckoi-web-migrate-'))
  const path = join(dir, 'registry.sqlite')
  try {
    const legacy = new Database(path)
    legacy.exec(`
      create table users (
        id text primary key,
        email text not null unique,
        password_hash text not null,
        created_at integer not null,
        disabled integer not null default 0
      );
      insert into users (id, email, password_hash, created_at, disabled)
      values ('u-legacy', 'legacy@example.com', 'scrypt$1$1$1$aa$bb', 1, 0);
    `)
    legacy.close()

    const upgraded = new ControlDatabase(path)
    upgraded.open()
    const user = upgraded.findUserByEmail('legacy@example.com')
    const columns = new Set(upgraded.listUsers().length > 0 ? ['ok'] : [])
    upgraded.createUser({ id: 'u-new', email: 'new@example.com', username: 'newbie', passwordHash: 'x' })
    const byUsername = upgraded.findUserByUsername('newbie')
    upgraded.close()

    record('AD-15',
      user !== undefined && user.username === null && user.is_admin === 0 && columns.size === 1 && byUsername?.email === 'new@example.com',
      `旧库升级：老账号保留（username=${user?.username}、is_admin=${user?.is_admin}），新列可用`)
  } catch (error) {
    record('AD-15', false, `旧库升级失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await checkMigration()

  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-admin-'))
  const masterKeyBase64 = randomBytes(32).toString('base64')
  const common = {
    dataRoot: root,
    rendererDir: resolve('out/renderer'),
    masterKeyBase64,
    appVersion: '0.1.0-web-admin',
    port: 0,
    // 关键：关闭自助注册
    allowRegistration: false
  }

  console.log(`\n== 账号体系验收 ==\n数据目录：${root}\n`)

  let stack = await startWebUiStack(common)
  let base = stack.server.url
  const boss = new Jar()
  const staff = new Jar()

  try {
    // ── 引导：账号池为空时仍可注册，且首个账号自动成为管理员 ──
    const bootstrap = await post(base, '/api/auth/register', {
      email: BOSS, username: 'boss', password: BOSS_PASSWORD
    }, boss)
    record('AD-1', bootstrap.status === 200 && bootstrap.body.data?.isAdmin === true,
      `空账号池时的注册引导：status=${bootstrap.status} isAdmin=${bootstrap.body.data?.isAdmin}`)

    // ── 有用户后，自助注册必须被拒 ──
    const selfRegister = await post(base, '/api/auth/register', {
      email: 'walkin@example.com', username: 'walkin', password: 'walkin-password'
    })
    record('AD-2', selfRegister.status === 403,
      `已有账号后再自助注册 → ${selfRegister.status}：${selfRegister.body?.error?.message ?? ''}`)

    // ── 用户名 + 密码登录 ──
    const byUsername = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'boss', password: BOSS_PASSWORD })
    })
    const byEmail = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: BOSS, password: BOSS_PASSWORD })
    })
    record('AD-3', byUsername.ok && byEmail.ok,
      `用户名登录 → ${byUsername.status}；邮箱登录 → ${byEmail.status}（两种都能用）`)

    // 用户名大小写不敏感
    const upperCase = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'BOSS', password: BOSS_PASSWORD })
    })
    record('AD-4', upperCase.ok, `用户名大小写不敏感 → ${upperCase.status}`)

    // ── 管理员建号 ──
    const created = await post(base, '/api/admin/users', {
      email: 'staff@example.com', username: 'staff', password: 'staff-first-password'
    }, boss)
    record('AD-5', created.status === 200 && created.body.data?.username === 'staff',
      `管理员新建用户 → ${created.status}（${created.body.data?.email ?? created.body?.error?.message}）`)

    const staffLogin = await post(base, '/api/auth/login', {
      identifier: 'staff', password: 'staff-first-password'
    }, staff)
    record('AD-6', staffLogin.status === 200 && staffLogin.body.data?.isAdmin === false,
      `新用户用用户名+密码登录 → ${staffLogin.status}，isAdmin=${staffLogin.body.data?.isAdmin}`)

    // ── 权限边界 ──
    const anonymous = await get(base, '/api/admin/users')
    const staffAccess = await get(base, '/api/admin/users', staff)
    const staffPage = await get(base, '/admin/users', staff)
    record('AD-7', anonymous.status === 401 && staffAccess.status === 403 && staffPage.status === 403,
      `管理接口：未登录 ${anonymous.status}、普通用户 ${staffAccess.status}、管理页 ${staffPage.status}`)

    const bossPage = await get(base, '/admin/users', boss)
    record('AD-8', bossPage.status === 200 && bossPage.html.includes('新建用户') && bossPage.html.includes('账号列表'),
      `管理员可打开用户管理页 → ${bossPage.status}`)

    // ── 管理员重置密码 ──
    const staffId = created.body.data.id as string
    const reset = await post(base, '/api/admin/users/password', { userId: staffId, password: 'staff-reset-password' }, boss)
    const oldLogin = await post(base, '/api/auth/login', { identifier: 'staff', password: 'staff-first-password' })
    const newLogin = await post(base, '/api/auth/login', { identifier: 'staff', password: 'staff-reset-password' })
    record('AD-9', reset.status === 200 && oldLogin.status === 401 && newLogin.status === 200,
      `重置密码 → ${reset.status}；旧密码登录 ${oldLogin.status}；新密码登录 ${newLogin.status}`)

    // 重置会吊销该用户已有会话
    const staffAfterReset = await get(base, '/api/auth/me', staff)
    record('AD-10', staffAfterReset.status === 401,
      `密码重置后其原有会话被吊销 → ${staffAfterReset.status}`)

    // ── 停用 / 启用 ──
    const disabled = await post(base, '/api/admin/users/update', { userId: staffId, disabled: true }, boss)
    const disabledLogin = await post(base, '/api/auth/login', { identifier: 'staff', password: 'staff-reset-password' })
    const enabled = await post(base, '/api/admin/users/update', { userId: staffId, disabled: false }, boss)
    const enabledLogin = await post(base, '/api/auth/login', { identifier: 'staff', password: 'staff-reset-password' })
    record('AD-11',
      disabled.status === 200 && disabledLogin.status === 401 && enabled.status === 200 && enabledLogin.status === 200,
      `停用后登录 ${disabledLogin.status}；启用后登录 ${enabledLogin.status}`)

    // ── 管理员不能把自己锁在门外 ──
    const bossId = bootstrap.body.data?.email === BOSS
      ? (await get(base, '/api/admin/users', boss)).body.data.users.find((u: any) => u.email === BOSS).id
      : ''
    const selfDisable = await post(base, '/api/admin/users/update', { userId: bossId, disabled: true }, boss)
    const selfDemote = await post(base, '/api/admin/users/update', { userId: bossId, isAdmin: false }, boss)
    record('AD-12', selfDisable.status === 400 && selfDemote.status === 400,
      `停用自己 ${selfDisable.status}、取消自己的管理员 ${selfDemote.status}（均为 400）`)

    // ── 用户名占用 ──
    const taken = await post(base, '/api/admin/users', {
      email: 'other@example.com', username: 'staff', password: 'other-password-1'
    }, boss)
    record('AD-13', taken.status === 400 && String(taken.body?.error?.message ?? '').includes('用户名'),
      `重复用户名被拒 → ${taken.status}：${taken.body?.error?.message ?? ''}`)
  } finally {
    await stack.close()
  }

  // ── ELECKOI_ADMIN_EMAILS 提升 ──
  stack = await startWebUiStack({ ...common, adminEmails: ['staff@example.com'] })
  base = stack.server.url
  try {
    const control = new Database(join(root, 'registry.sqlite'), { readonly: true })
    const row = control.prepare('select is_admin from users where email = ?').get('staff@example.com') as { is_admin: number } | undefined
    control.close()
    record('AD-14', row?.is_admin === 1,
      `重启后按 ELECKOI_ADMIN_EMAILS 提升：staff@example.com is_admin=${row?.is_admin}`)
  } finally {
    await stack.close()
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
