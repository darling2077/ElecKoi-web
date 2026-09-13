/**
 * 控制面数据库。
 *
 * 与上游产品库（每租户一个 eleckoi-common.sqlite3）**物理分离**：
 * 上游库的结构受 check-database-schema 约束，不容我们增删表；
 * 而用户、会话、租户与配额是本移植自己的概念，必须有自己的库。
 *
 * 用 better-sqlite3 直连而非 drizzle：控制面不参与上游 schema 生成链，
 * 保持独立能避免上游改基线时牵连到这里。
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface UserRecord {
  id: string
  email: string
  /** 可选登录名；为空表示只能用邮箱登录。 */
  username: string | null
  password_hash: string
  created_at: number
  disabled: number
  /** 1 = 管理员，可进入用户管理。 */
  is_admin: number
}

/** 对外暴露的用户信息（不含口令哈希）。 */
export interface UserSummary {
  id: string
  email: string
  username: string | null
  createdAt: number
  disabled: boolean
  isAdmin: boolean
}

export interface TenantRecord {
  user_id: string
  tenant_id: string
  created_at: number
  last_active_at: number
}

export interface SessionRecord {
  token_hash: string
  user_id: string
  expires_at: number
}

const SCHEMA = `
create table if not exists users (
  id            text primary key,
  email         text not null unique,
  username      text,
  password_hash text not null,
  created_at    integer not null,
  disabled      integer not null default 0,
  is_admin      integer not null default 0
);

create table if not exists sessions (
  token_hash   text primary key,
  user_id      text not null references users(id) on delete cascade,
  created_at   integer not null,
  expires_at   integer not null,
  last_seen_at integer not null,
  user_agent   text not null default '',
  ip           text not null default ''
);
create index if not exists sessions_user_idx on sessions(user_id);

create table if not exists tenants (
  user_id        text primary key references users(id) on delete cascade,
  tenant_id      text not null unique,
  created_at     integer not null,
  last_active_at integer not null
);

create table if not exists quota_counters (
  user_id text not null references users(id) on delete cascade,
  key     text not null,
  used    integer not null default 0,
  primary key (user_id, key)
);

create table if not exists audit_log (
  id      integer primary key autoincrement,
  at      integer not null,
  user_id text,
  action  text not null,
  detail  text not null default ''
);
create index if not exists audit_log_at_idx on audit_log(at);
`

/**
 * 老库补列。
 *
 * 控制面是我们自己的库，可以直接改结构；而账号池在加用户名/管理员之前就已经存在，
 * 因此必须能在启动时平滑升级，不能要求重建。
 */
function migrateUsers(database: Database.Database): void {
  const columns = new Set(
    (database.prepare('pragma table_info(users)').all() as Array<{ name: string }>).map((column) => column.name)
  )
  if (!columns.has('username')) database.exec('alter table users add column username text')
  if (!columns.has('is_admin')) database.exec('alter table users add column is_admin integer not null default 0')
  database.exec('create unique index if not exists users_username_idx on users(username) where username is not null')
}

export class ControlDatabase {
  private database: Database.Database | undefined

  constructor(private readonly path: string) {}

  open(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const database = new Database(this.path)
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')
    database.pragma('busy_timeout = 5000')
    database.exec(SCHEMA)
    migrateUsers(database)
    this.database = database
  }

  private get db(): Database.Database {
    if (this.database === undefined) throw new Error('控制面数据库尚未打开。')
    return this.database
  }

  close(): void {
    this.database?.close()
    this.database = undefined
  }

  // ── 用户 ──
  createUser(user: { id: string; email: string; username?: string | null; passwordHash: string; isAdmin?: boolean }): void {
    this.db.prepare(
      'insert into users (id, email, username, password_hash, created_at, is_admin) values (?, ?, ?, ?, ?, ?)'
    ).run(user.id, user.email, user.username ?? null, user.passwordHash, Date.now(), user.isAdmin === true ? 1 : 0)
  }

  countUsers(): number {
    return Number((this.db.prepare('select count(*) as n from users').get() as { n: number }).n)
  }

  listUsers(): UserRecord[] {
    return this.db.prepare('select * from users order by created_at').all() as UserRecord[]
  }

  findUserByUsername(username: string): UserRecord | undefined {
    return this.db.prepare('select * from users where username = ? collate nocase').get(username) as UserRecord | undefined
  }

  /** 登录用：identifier 既可以是邮箱也可以是用户名。 */
  findUserByIdentifier(identifier: string): UserRecord | undefined {
    return this.findUserByEmail(identifier) ?? this.findUserByUsername(identifier)
  }

  setUsername(userId: string, username: string | null): void {
    this.db.prepare('update users set username = ? where id = ?').run(username, userId)
  }

  setAdmin(userId: string, isAdmin: boolean): void {
    this.db.prepare('update users set is_admin = ? where id = ?').run(isAdmin ? 1 : 0, userId)
  }

  setDisabled(userId: string, disabled: boolean): void {
    this.db.prepare('update users set disabled = ? where id = ?').run(disabled ? 1 : 0, userId)
  }

  findUserByEmail(email: string): UserRecord | undefined {
    return this.db.prepare('select * from users where email = ?').get(email) as UserRecord | undefined
  }

  findUserById(id: string): UserRecord | undefined {
    return this.db.prepare('select * from users where id = ?').get(id) as UserRecord | undefined
  }

  updatePasswordHash(userId: string, passwordHash: string): void {
    this.db.prepare('update users set password_hash = ? where id = ?').run(passwordHash, userId)
  }

  // ── 会话 ──
  createSession(session: {
    tokenHash: string
    userId: string
    expiresAt: number
    userAgent: string
    ip: string
  }): void {
    const now = Date.now()
    this.db.prepare(
      'insert into sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip) values (?, ?, ?, ?, ?, ?, ?)'
    ).run(session.tokenHash, session.userId, now, session.expiresAt, now, session.userAgent, session.ip)
  }

  /** 取回未过期会话；过期即顺手删除，避免表无限增长。 */
  findSession(tokenHash: string): SessionRecord | undefined {
    const row = this.db.prepare('select token_hash, user_id, expires_at from sessions where token_hash = ?')
      .get(tokenHash) as SessionRecord | undefined
    if (row === undefined) return undefined
    if (row.expires_at <= Date.now()) {
      this.deleteSession(tokenHash)
      return undefined
    }
    return row
  }

  touchSession(tokenHash: string): void {
    this.db.prepare('update sessions set last_seen_at = ? where token_hash = ?').run(Date.now(), tokenHash)
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('delete from sessions where token_hash = ?').run(tokenHash)
  }

  /** 吊销某用户的会话；keepTokenHash 用于保留当前这一个。 */
  deleteUserSessions(userId: string, keepTokenHash?: string): number {
    if (keepTokenHash === undefined) {
      return this.db.prepare('delete from sessions where user_id = ?').run(userId).changes
    }
    return this.db.prepare('delete from sessions where user_id = ? and token_hash != ?')
      .run(userId, keepTokenHash).changes
  }

  deleteExpiredSessions(): number {
    return this.db.prepare('delete from sessions where expires_at <= ?').run(Date.now()).changes
  }

  // ── 租户 ──
  ensureTenant(userId: string, tenantId: string): TenantRecord {
    const existing = this.findTenant(userId)
    if (existing !== undefined) return existing
    const now = Date.now()
    this.db.prepare('insert into tenants (user_id, tenant_id, created_at, last_active_at) values (?, ?, ?, ?)')
      .run(userId, tenantId, now, now)
    return { user_id: userId, tenant_id: tenantId, created_at: now, last_active_at: now }
  }

  findTenant(userId: string): TenantRecord | undefined {
    return this.db.prepare('select * from tenants where user_id = ?').get(userId) as TenantRecord | undefined
  }

  /** 按租户目录名反查；签名媒体路由用它校验 tenantId 确实属于某个用户。 */
  findTenantByTenantId(tenantId: string): TenantRecord | undefined {
    return this.db.prepare('select * from tenants where tenant_id = ?').get(tenantId) as TenantRecord | undefined
  }

  touchTenant(userId: string): void {
    this.db.prepare('update tenants set last_active_at = ? where user_id = ?').run(Date.now(), userId)
  }

  listTenants(): TenantRecord[] {
    return this.db.prepare('select * from tenants order by last_active_at desc').all() as TenantRecord[]
  }

  // ── 审计 ──
  appendAudit(userId: string | null, action: string, detail = ''): void {
    this.db.prepare('insert into audit_log (at, user_id, action, detail) values (?, ?, ?, ?)')
      .run(Date.now(), userId, action, detail)
  }

  recentAudit(limit = 50): Array<{ at: number; user_id: string | null; action: string; detail: string }> {
    return this.db.prepare('select at, user_id, action, detail from audit_log order by id desc limit ?')
      .all(limit) as Array<{ at: number; user_id: string | null; action: string; detail: string }>
  }
}
