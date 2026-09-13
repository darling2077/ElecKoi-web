/**
 * 认证与账号管理路由处理器。
 *
 * 覆盖：
 *   /login                 登录页（用户名或邮箱 + 密码）
 *   /account               账号管理页（改密码等）
 *   /admin/users           用户管理页（仅管理员）
 *   /api/auth/*            登录、登出、当前用户、改密码
 *   /api/admin/users*      管理员用户管理接口
 *
 * 注册策略：默认关闭自助注册；仅当**账号池为空**时允许注册（引导首个管理员，
 * 且该账号自动成为管理员），之后一律由管理员在用户管理里创建。
 */

import { readdirSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { AuthHandler } from './server'
import { readBody, sendJson, sendText } from './server'
import {
  assertSameOrigin,
  clientIp,
  clearedSessionCookie,
  readSessionToken,
  sessionCookie,
  shouldSecureCookie
} from './cookies'
import { renderLoginPage } from './loginPage'
import { renderAccountPage } from './accountPage'
import { renderAdminUsersPage } from './adminUsersPage'
import { normalizeTheme, type PageTheme } from './pageTheme'
import { securityHeaders } from './securityHeaders'
import { AuthError, AuthService, assertValidUsername, hashToken } from '../control/AuthService'
import type { ControlDatabase, UserRecord, UserSummary } from '../control/ControlDatabase'
import { failure, success } from '@shared/foundation/result'

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 10

export interface AuthControllerOptions {
  auth: AuthService
  control: ControlDatabase
  /** 是否允许自助注册；账号池为空时无论如何都允许（引导首个账号）。 */
  allowRegistration: boolean
  sourceUrl?: string
  dataRoot: string
  /**
   * 本服务对外公开的源（反向代理后的公网地址等）。
   * 写操作的同源校验会把它与"对外 Host"一并采信——代理换了 Host 时不至于把
   * 正常登录判成跨站。必须与卡片帧的投递白名单同源（stack.ts 传的是同一份）。
   */
  allowedOrigins?: readonly string[]
  log?: (message: string) => void
}

interface Attempt {
  count: number
  resetAt: number
}

function toSummary(user: UserRecord): UserSummary {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    createdAt: user.created_at,
    disabled: user.disabled !== 0,
    isAdmin: user.is_admin === 1
  }
}

/** 统计租户占用：媒体目录大小 + 业务行数。直读租户库，避免为统计挂载整个租户。 */
function readUsage(dataRoot: string, tenantId: string): { mediaBytes: number; conversationCount: number; characterCount: number } {
  let mediaBytes = 0
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        try { mediaBytes += statSync(full).size } catch { /* 并发删除时忽略 */ }
      }
    }
  }
  walk(join(dataRoot, 'tenants', tenantId, 'media'))
  let conversationCount = 0
  let characterCount = 0
  try {
    const database = new Database(join(dataRoot, 'tenants', tenantId, 'db', 'eleckoi-common.sqlite3'), { readonly: true })
    try {
      conversationCount = Number((database.prepare('select count(*) as n from chat_sessions').get() as { n: number }).n)
      characterCount = Number((database.prepare('select count(*) as n from characters').get() as { n: number }).n)
    } finally {
      database.close()
    }
  } catch { /* 库尚未建立时按 0 计 */ }
  return { mediaBytes, conversationCount, characterCount }
}

/**
 * 读该账号在应用里的外观设置，让我们自己的页面与之一致。
 *
 * 直读 `desktop_preferences`（上游 UserSettingsStore 的存储位置）。
 * 键不存在或库不可读时落到 light：上游 `appearance.mode` 的默认值就是 light
 * （`nativeTheme.themeSource = 存储值 ?? 'light'`），与操作系统无关。
 * 这里若回退成 system，系统是暗色的用户就会在亮色应用里撞见暗色的账号页。
 */
function readTheme(dataRoot: string, tenantId: string): PageTheme {
  try {
    const database = new Database(join(dataRoot, 'tenants', tenantId, 'db', 'eleckoi-common.sqlite3'), { readonly: true })
    try {
      const row = database
        .prepare("select value_json as value from desktop_preferences where key = 'appearance.mode'")
        .get() as { value: string } | undefined
      if (row === undefined) return 'light'
      return normalizeTheme(JSON.parse(row.value) as unknown)
    } finally {
      database.close()
    }
  } catch {
    // 库还没建立（新账号尚未打开过应用）：上游默认就是亮色
    return 'light'
  }
}

export function createAuthHandler(options: AuthControllerOptions): AuthHandler {
  const attempts = new Map<string, Attempt>()

  function throttle(key: string): boolean {
    const now = Date.now()
    const entry = attempts.get(key)
    if (entry === undefined || entry.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
      return true
    }
    entry.count += 1
    return entry.count <= MAX_ATTEMPTS
  }

  function clearThrottle(key: string): void {
    attempts.delete(key)
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readBody(req, 64 * 1024)
    return JSON.parse(raw || '{}') as Record<string, unknown>
  }

  function originAllowed(req: IncomingMessage, res: ServerResponse): boolean {
    try {
      assertSameOrigin(req, options.allowedOrigins ?? [])
      return true
    } catch (error) {
      sendJson(res, 403, failure(error instanceof Error ? error : new Error('跨站请求被拒绝。')))
      return false
    }
  }

  function htmlHeaders(res: ServerResponse): void {
    for (const [name, value] of Object.entries(securityHeaders('login', ''))) res.setHeader(name, value)
  }

  /** 账号池为空时允许注册，用于引导首个管理员。 */
  function registrationOpen(): boolean {
    return options.allowRegistration || options.control.countUsers() === 0
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req)
    if (!throttle(`ip:${ip}`)) {
      sendJson(res, 429, failure(new Error('尝试过于频繁，请稍后再试。')))
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, failure(new Error('请求体不是合法 JSON。')))
      return
    }
    // identifier 为新字段；同时兼容旧客户端的 email 字段。
    const identifier = String(body.identifier ?? body.email ?? '').trim()
    const password = String(body.password ?? '')
    if (!throttle(`id:${identifier.toLowerCase()}`)) {
      sendJson(res, 429, failure(new Error('尝试过于频繁，请稍后再试。')))
      return
    }
    try {
      const result = options.auth.login({
        identifier,
        password,
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
        ip
      })
      clearThrottle(`id:${identifier.toLowerCase()}`)
      res.setHeader('set-cookie', sessionCookie(result.token, SESSION_TTL_SECONDS, shouldSecureCookie(req)))
      sendJson(res, 200, success({ email: result.email, username: result.username, isAdmin: result.isAdmin }))
    } catch (error) {
      sendJson(res, 401, failure(new Error(error instanceof AuthError ? error.message : '登录失败，请稍后再试。')))
    }
  }

  async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!registrationOpen()) {
      sendJson(res, 403, failure(new Error('本服务未开放自助注册，请联系管理员开通账号。')))
      return
    }
    if (!throttle(`ip:${clientIp(req)}`)) {
      sendJson(res, 429, failure(new Error('尝试过于频繁，请稍后再试。')))
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, failure(new Error('请求体不是合法 JSON。')))
      return
    }
    try {
      // 首个账号自动成为管理员，否则服务将无人可管理。
      const bootstrap = options.control.countUsers() === 0
      const created = options.auth.register({
        email: String(body.email ?? ''),
        password: String(body.password ?? ''),
        username: body.username === undefined || String(body.username).trim() === '' ? null : String(body.username),
        tenantId: AuthService.newTenantId(),
        isAdmin: bootstrap
      })
      const result = options.auth.login({
        identifier: created.user.email,
        password: String(body.password ?? ''),
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
        ip: clientIp(req)
      })
      res.setHeader('set-cookie', sessionCookie(result.token, SESSION_TTL_SECONDS, shouldSecureCookie(req)))
      sendJson(res, 200, success({ email: result.email, username: result.username, isAdmin: result.isAdmin }))
    } catch (error) {
      sendJson(res, 400, failure(new Error(error instanceof AuthError ? error.message : '注册失败，请稍后再试。')))
    }
  }

  /** 管理接口的统一前置检查；失败时已写出响应。 */
  function requireAdmin(req: IncomingMessage, res: ServerResponse): { userId: string; email: string } | undefined {
    const session = options.auth.verify(readSessionToken(req))
    if (session === undefined) {
      sendJson(res, 401, failure(new Error('登录状态已失效，请重新登录。')))
      return undefined
    }
    if (!session.isAdmin) {
      sendJson(res, 403, failure(new Error('需要管理员权限。')))
      return undefined
    }
    return { userId: session.userId, email: session.email }
  }

  async function handleAdminApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const actor = requireAdmin(req, res)
    if (actor === undefined) return
    if (!originAllowed(req, res)) return

    try {
      if (path === '/api/admin/users' && req.method === 'GET') {
        const users = options.control.listUsers().map((user) => {
          const tenant = options.control.findTenant(user.id)
          return {
            ...toSummary(user),
            usage: tenant === undefined ? null : readUsage(options.dataRoot, tenant.tenant_id)
          }
        })
        sendJson(res, 200, success({ users, registrationOpen: registrationOpen() }))
        return
      }

      if (path === '/api/admin/users' && req.method === 'POST') {
        const body = await readJson(req)
        const created = options.auth.register({
          email: String(body.email ?? ''),
          password: String(body.password ?? ''),
          username: body.username === undefined || String(body.username).trim() === '' ? null : String(body.username),
          tenantId: AuthService.newTenantId(),
          isAdmin: body.isAdmin === true,
          createdBy: actor.userId
        })
        sendJson(res, 200, success(toSummary(created.user)))
        return
      }

      if (path === '/api/admin/users/update' && req.method === 'POST') {
        const body = await readJson(req)
        const userId = String(body.userId ?? '')
        const target = options.control.findUserById(userId)
        if (target === undefined) throw new AuthError('NOT_FOUND', '用户不存在。')
        // 防止管理员把自己锁在门外。
        if (target.id === actor.userId && (body.disabled === true || body.isAdmin === false)) {
          throw new AuthError('INVALID_INPUT', '不能停用自己，也不能取消自己的管理员权限。')
        }
        if (body.username !== undefined) {
          const nextUsername = String(body.username).trim()
          if (nextUsername === '') {
            options.control.setUsername(userId, null)
          } else {
            assertValidUsername(nextUsername)
            const existing = options.control.findUserByUsername(nextUsername)
            if (existing !== undefined && existing.id !== userId) {
              throw new AuthError('USERNAME_TAKEN', '该用户名已被占用。')
            }
            options.control.setUsername(userId, nextUsername)
          }
        }
        if (body.isAdmin !== undefined) options.control.setAdmin(userId, body.isAdmin === true)
        if (body.disabled !== undefined) {
          options.control.setDisabled(userId, body.disabled === true)
          // 停用即踢下线，否则已签发的会话仍然可用。
          if (body.disabled === true) options.control.deleteUserSessions(userId)
        }
        options.control.appendAudit(userId, 'admin_update_user', JSON.stringify({
          username: body.username, isAdmin: body.isAdmin, disabled: body.disabled
        }))
        sendJson(res, 200, success(toSummary(options.control.findUserById(userId)!)))
        return
      }

      if (path === '/api/admin/users/password' && req.method === 'POST') {
        const body = await readJson(req)
        options.auth.setPassword(String(body.userId ?? ''), String(body.password ?? ''), actor.userId)
        sendJson(res, 200, success({ ok: true }))
        return
      }

      sendJson(res, 404, failure(new Error('接口不存在。')))
    } catch (error) {
      const status = error instanceof AuthError && error.code === 'NOT_FOUND' ? 404 : 400
      sendJson(res, status, failure(error instanceof Error ? error : new Error('操作失败。')))
    }
  }

  return {
    async handle(req, res) {
      const path = (req.url ?? '/').split('?')[0] ?? '/'
      const method = req.method ?? 'GET'

      if (path.startsWith('/api/admin/')) {
        await handleAdminApi(req, res, path)
        return true
      }

      if (path === '/login' && method === 'GET') {
        const session = options.auth.verify(readSessionToken(req))
        if (session !== undefined) {
          res.writeHead(302, { location: '/', 'cache-control': 'no-store' })
          res.end()
          return true
        }
        htmlHeaders(res)
        sendText(res, 200, renderLoginPage({
          allowRegistration: registrationOpen(),
          defaultMode: options.control.countUsers() === 0 ? 'register' : 'login',
          ...(options.sourceUrl === undefined ? {} : { sourceUrl: options.sourceUrl })
        }), 'text/html; charset=utf-8')
        return true
      }

      if (path === '/account' && method === 'GET') {
        const session = options.auth.verify(readSessionToken(req))
        if (session === undefined) {
          res.writeHead(302, { location: '/login', 'cache-control': 'no-store' })
          res.end()
          return true
        }
        const user = options.control.findUserById(session.userId)
        const tenant = options.control.findTenant(session.userId)
        htmlHeaders(res)
        sendText(res, 200, renderAccountPage({
          email: session.email,
          username: session.username,
          isAdmin: session.isAdmin,
          createdAt: user?.created_at ?? Date.now(),
          usage: tenant === undefined
            ? { mediaBytes: 0, conversationCount: 0, characterCount: 0 }
            : readUsage(options.dataRoot, tenant.tenant_id),
          theme: tenant === undefined ? 'light' : readTheme(options.dataRoot, tenant.tenant_id),
          ...(options.sourceUrl === undefined ? {} : { sourceUrl: options.sourceUrl })
        }), 'text/html; charset=utf-8')
        return true
      }

      if (path === '/admin/users' && method === 'GET') {
        const session = options.auth.verify(readSessionToken(req))
        if (session === undefined) {
          res.writeHead(302, { location: '/login', 'cache-control': 'no-store' })
          res.end()
          return true
        }
        if (!session.isAdmin) {
          htmlHeaders(res)
          sendText(res, 403, '需要管理员权限。', 'text/plain; charset=utf-8')
          return true
        }
        const actorTenant = options.control.findTenant(session.userId)
        htmlHeaders(res)
        sendText(res, 200, renderAdminUsersPage({
          actorEmail: session.email,
          registrationOpen: registrationOpen(),
          theme: actorTenant === undefined ? 'light' : readTheme(options.dataRoot, actorTenant.tenant_id)
        }), 'text/html; charset=utf-8')
        return true
      }

      if (path === '/api/auth/login' && method === 'POST') {
        if (!originAllowed(req, res)) return true
        await handleLogin(req, res)
        return true
      }

      if (path === '/api/auth/register' && method === 'POST') {
        if (!originAllowed(req, res)) return true
        await handleRegister(req, res)
        return true
      }

      if (path === '/api/auth/logout' && method === 'POST') {
        if (!originAllowed(req, res)) return true
        options.auth.logout(readSessionToken(req))
        res.setHeader('set-cookie', clearedSessionCookie(shouldSecureCookie(req)))
        sendJson(res, 200, success({ ok: true }))
        return true
      }

      if (path === '/api/auth/password' && method === 'POST') {
        if (!originAllowed(req, res)) return true
        const session = options.auth.verify(readSessionToken(req))
        if (session === undefined) {
          sendJson(res, 401, failure(new Error('登录状态已失效，请重新登录。')))
          return true
        }
        if (!throttle(`password:${session.userId}`)) {
          sendJson(res, 429, failure(new Error('尝试过于频繁，请稍后再试。')))
          return true
        }
        let body: Record<string, unknown>
        try {
          body = await readJson(req)
        } catch {
          sendJson(res, 400, failure(new Error('请求体不是合法 JSON。')))
          return true
        }
        try {
          options.auth.changePassword({
            userId: session.userId,
            current: String(body.current ?? ''),
            next: String(body.next ?? ''),
            keepTokenHash: hashToken(readSessionToken(req) ?? '')
          })
          sendJson(res, 200, success({ ok: true }))
        } catch (error) {
          sendJson(res, 400, failure(error instanceof Error ? error : new Error('修改密码失败。')))
        }
        return true
      }

      if (path === '/api/auth/me' && method === 'GET') {
        const session = options.auth.verify(readSessionToken(req))
        if (session === undefined) {
          sendJson(res, 401, failure(new Error('未登录。')))
          return true
        }
        options.control.touchTenant(session.userId)
        sendJson(res, 200, success({ email: session.email, username: session.username, isAdmin: session.isAdmin }))
        return true
      }

      return false
    }
  }
}
