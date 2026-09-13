/**
 * 认证服务。
 *
 * 设计要点：
 *  - 口令用 Node 内置 scrypt（零新依赖；生产若要 Argon2id 可后续替换）。
 *  - 会话令牌 32 字节随机，**库中只存 SHA-256 哈希**，原文只在 Set-Cookie 出现一次。
 *  - 邮箱统一小写并做基本格式校验；重复注册不泄露"该邮箱已存在"以外的信息。
 *  - 所有失败路径返回同一错误文案，避免账号枚举。
 */

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { ControlDatabase, UserRecord } from './ControlDatabase'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SCRYPT_KEYLEN = 64
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const

export interface AuthResult {
  token: string
  userId: string
  email: string
  username: string | null
  isAdmin: boolean
  expiresAt: number
}

export class AuthError extends Error {
  constructor(
    readonly code: 'INVALID_CREDENTIALS' | 'INVALID_INPUT' | 'EMAIL_TAKEN' | 'USERNAME_TAKEN' | 'DISABLED' | 'NOT_FOUND',
    message: string
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,32}$/

function normalizeUsername(username: string): string {
  return username.trim()
}

/** 用户名单独校验：允许字母数字下划线连字符，避免和邮箱混淆。 */
export function assertValidUsername(username: string): void {
  if (!USERNAME_PATTERN.test(normalizeUsername(username))) {
    throw new AuthError('INVALID_INPUT', '用户名需为 3 到 32 位的字母、数字、下划线或连字符。')
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function assertValidCredentials(email: string, password: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new AuthError('INVALID_INPUT', '邮箱格式不正确。')
  }
  if (password.length < 8 || password.length > 200) {
    throw new AuthError('INVALID_INPUT', '密码长度需在 8 到 200 个字符之间。')
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS)
  return `scrypt$${SCRYPT_OPTIONS.N}$${SCRYPT_OPTIONS.r}$${SCRYPT_OPTIONS.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [string, string, string, string, string, string]
  try {
    const expected = Buffer.from(hashRaw, 'base64url')
    const derived = scryptSync(password, Buffer.from(saltRaw, 'base64url'), expected.length, {
      N: Number(nRaw), r: Number(rRaw), p: Number(pRaw), maxmem: 64 * 1024 * 1024
    })
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export class AuthService {
  constructor(private readonly control: ControlDatabase) {}

  /**
   * 注册。tenantId 由调用方生成并落库，保证租户目录名不可由邮箱/用户名推导。
   */
  register(input: {
    email: string
    password: string
    tenantId: string
    username?: string | null
    isAdmin?: boolean
    /** 由管理员代建时记录操作者，便于审计。 */
    createdBy?: string
  }): { user: UserRecord; tenantId: string } {
    const email = normalizeEmail(input.email)
    assertValidCredentials(email, input.password)
    if (this.control.findUserByEmail(email) !== undefined) {
      throw new AuthError('EMAIL_TAKEN', '该邮箱已被注册。')
    }
    const username = input.username === undefined || input.username === null || input.username.trim() === ''
      ? null
      : normalizeUsername(input.username)
    if (username !== null) {
      assertValidUsername(username)
      if (this.control.findUserByUsername(username) !== undefined) {
        throw new AuthError('USERNAME_TAKEN', '该用户名已被占用。')
      }
    }
    const user = { id: randomUUID(), email, username, passwordHash: hashPassword(input.password), isAdmin: input.isAdmin === true }
    this.control.createUser(user)
    this.control.ensureTenant(user.id, input.tenantId)
    this.control.appendAudit(input.createdBy ?? user.id, input.createdBy === undefined ? 'register' : 'admin_create_user', email)
    return { user: this.control.findUserById(user.id)!, tenantId: input.tenantId }
  }

  /**
   * 启动时按邮箱提升管理员。
   * 用配置而非硬编码，避免把某个人的邮箱写死在代码里。
   */
  promoteAdmins(emails: readonly string[]): string[] {
    const promoted: string[] = []
    for (const raw of emails) {
      const user = this.control.findUserByEmail(normalizeEmail(raw))
      if (user === undefined) continue
      if (user.is_admin === 1) continue
      this.control.setAdmin(user.id, true)
      this.control.appendAudit(user.id, 'admin_promoted', 'by ELECKOI_ADMIN_EMAILS')
      promoted.push(user.email)
    }
    return promoted
  }

  /** 管理员重置他人密码：不需要旧密码，并吊销该用户全部会话。 */
  setPassword(userId: string, next: string, actorId?: string): void {
    const user = this.control.findUserById(userId)
    if (user === undefined) throw new AuthError('NOT_FOUND', '用户不存在。')
    if (next.length < 8 || next.length > 200) {
      throw new AuthError('INVALID_INPUT', '密码长度需在 8 到 200 个字符之间。')
    }
    this.control.updatePasswordHash(user.id, hashPassword(next))
    this.control.deleteUserSessions(user.id)
    this.control.appendAudit(user.id, 'password_reset_by_admin', actorId ?? '')
  }

  /** identifier 既可以是邮箱也可以是用户名。 */
  login(input: { identifier: string; password: string; userAgent?: string; ip?: string }): AuthResult {
    const identifier = input.identifier.trim()
    const user = this.control.findUserByIdentifier(identifier)
    // 用户不存在时也执行一次同构的哈希校验，避免用响应时间区分账号是否存在。
    const ok = user === undefined
      ? (verifyPassword(input.password, hashPassword('placeholder')), false)
      : verifyPassword(input.password, user.password_hash)
    if (user === undefined || !ok) {
      this.control.appendAudit(user?.id ?? null, 'login_failed', identifier)
      throw new AuthError('INVALID_CREDENTIALS', '账号或密码不正确。')
    }
    if (user.disabled !== 0) throw new AuthError('DISABLED', '该账号已被停用。')

    const token = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + SESSION_TTL_MS
    this.control.createSession({
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt,
      userAgent: input.userAgent ?? '',
      ip: input.ip ?? ''
    })
    this.control.appendAudit(user.id, 'login', user.email)
    return {
      token,
      userId: user.id,
      email: user.email,
      username: user.username,
      isAdmin: user.is_admin === 1,
      expiresAt
    }
  }

  /** 校验令牌；成功时刷新 last_seen 并返回用户。 */
  verify(token: string | undefined): { userId: string; email: string; username: string | null; isAdmin: boolean } | undefined {
    if (!token) return undefined
    const tokenHash = hashToken(token)
    const session = this.control.findSession(tokenHash)
    if (session === undefined) return undefined
    const user = this.control.findUserById(session.user_id)
    if (user === undefined || user.disabled !== 0) return undefined
    this.control.touchSession(tokenHash)
    return { userId: user.id, email: user.email, username: user.username, isAdmin: user.is_admin === 1 }
  }

  /**
   * 修改密码。必须校验当前密码；成功后吊销该用户的**其他**会话
   * （当前会话保留，避免用户改完密码立刻被踢出）。
   */
  changePassword(input: { userId: string; current: string; next: string; keepTokenHash?: string }): void {
    const user = this.control.findUserById(input.userId)
    if (user === undefined) throw new AuthError('INVALID_CREDENTIALS', '账号不存在。')
    if (!verifyPassword(input.current, user.password_hash)) {
      this.control.appendAudit(user.id, 'password_change_failed', '当前密码不正确')
      throw new AuthError('INVALID_CREDENTIALS', '当前密码不正确。')
    }
    if (input.next.length < 8 || input.next.length > 200) {
      throw new AuthError('INVALID_INPUT', '新密码长度需在 8 到 200 个字符之间。')
    }
    if (input.next === input.current) {
      throw new AuthError('INVALID_INPUT', '新密码不能与当前密码相同。')
    }
    this.control.updatePasswordHash(user.id, hashPassword(input.next))
    this.control.deleteUserSessions(user.id, input.keepTokenHash)
    this.control.appendAudit(user.id, 'password_changed', '')
  }

  logout(token: string | undefined): void {
    if (!token) return
    this.control.deleteSession(hashToken(token))
  }

  /** 生成不可由用户信息推导的租户目录名。 */
  static newTenantId(): string {
    return `t_${randomBytes(12).toString('hex')}`
  }
}
