/**
 * 回归：头像「读取失败」——渲染层回存网关下发的媒体 URL 会破坏数据。
 *
 * 缺陷链条（修复前）：
 *   1. 渲染层存的是 data URL，网关读回时把它重写成 `/media/v1/…?t&exp&sig`；
 *   2. 用户再次打开头像编辑器并保存时，渲染层把**收到的值原样回存**；
 *   3. 上游 `LocalMediaStore.prepareImage` 只认 `eleckoi-media://asset/v1/` 前缀，
 *      认不出该值 → fileName 记为空 → `commit()` 的 `cleanupSlot(owner, slot, '')`
 *      **把该槽位下的文件全部删掉**；
 *   4. 库里留下一个非引用字符串，之后永久 404 → 界面显示「头像图片读取失败」。
 *
 * 修法在 WebGateway 入站：把完整匹配的媒体 URL 还原成规范引用再交给上游。
 *
 * 运行：pnpm webui:avatar
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { WebHost } from '../WebHost'
import { singleTenantResolver, startWebServer } from '../http/server'
import { restoreMediaReference } from '../transport/WebGateway'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const REQUEST_CONTEXT = { senderId: 1, windowId: undefined }
const CANONICAL = 'eleckoi-media://asset/v1/'

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-avatar-'))
  const tenant = await WebHost.mountTenant({
    tenantId: 'tenant-avatar',
    tenantRoot: join(root, 'tenant'),
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-avatar'
  })
  const server = await startWebServer({
    host: '127.0.0.1',
    port: 0,
    rendererDir: resolve('out/renderer'),
    resolveSession: singleTenantResolver(tenant.gateway, tenant.context.mediaAssets)
  })
  const base = server.url
  const dispatch = <T>(name: string, input: unknown): Promise<T> =>
    tenant.gateway.dispatch({ name, input }, REQUEST_CONTEXT) as Promise<T>

  console.log(`\n== 头像回存回归 ==\n服务地址：${base}\n`)

  try {
    // ── 纯函数：还原规则 ──
    const samples: Array<[string, string]> = [
      [`${CANONICAL}aa/avatar/bb.png`, `${CANONICAL}aa/avatar/bb.png`],
      ['/media/v1/aa/avatar/bb.png', `${CANONICAL}aa/avatar/bb.png`],
      ['/media/v1/aa/avatar/bb.png?t=t_1&exp=2&sig=x', `${CANONICAL}aa/avatar/bb.png`],
      ['http://192.0.2.10:8791/media/v1/aa/avatar/bb.png?t=t_1&sig=x', `${CANONICAL}aa/avatar/bb.png`],
      ['data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
      ['普通正文里提到 /media/v1/aa/bb.png 但整串不是它', '普通正文里提到 /media/v1/aa/bb.png 但整串不是它']
    ]
    const bad = samples.filter(([input, expected]) => restoreMediaReference(input) !== expected)
    record('A-1', bad.length === 0,
      bad.length === 0
        ? `还原规则 6 例全部符合预期（含带签名、带源前缀、data URL、正文不误伤）`
        : `不符合预期：${bad.map(([input]) => input).join('、')}`)

    // ── 真实链路 ──
    const before = await dispatch<Record<string, string>>('query.persona.read', {})
    const saved = await dispatch<Record<string, string>>('command.persona.save', {
      ...before, user_name: '测试用户', user_avatar: PNG_DATA_URL
    })
    const savedAvatar = saved.user_avatar ?? ''
    record('A-2', savedAvatar.startsWith('/media/v1/'),
      `保存后下发：${savedAvatar.slice(0, 64)}…`)

    const loaded = await dispatch<Record<string, string>>('query.persona.read', {})
    const firstFetch = await fetch(`${base}${loaded.user_avatar ?? ''}`)
    record('A-3', firstFetch.ok, `首次取回 → ${firstFetch.status} ${firstFetch.headers.get('content-type') ?? ''}`)

    // 关键：把读到的值原样回存（渲染层保存时的实际行为）
    await dispatch('command.persona.save', { ...loaded })
    const after = await dispatch<Record<string, string>>('query.persona.read', {})
    const afterAvatar = after.user_avatar ?? ''
    const secondFetch = await fetch(`${base}${afterAvatar}`)
    record('A-4', secondFetch.ok && secondFetch.headers.get('content-type') === 'image/png',
      `回存后再取回 → ${secondFetch.status} ${secondFetch.headers.get('content-type') ?? ''}（修复前为 404）`)

    // 底层文件必须还在（修复前会被 cleanupSlot 删掉）
    const canonical = restoreMediaReference(afterAvatar)
    const file = tenant.context.mediaAssets.pathForReference(canonical)
    record('A-5', file !== undefined && existsSync(file),
      `底层媒体文件仍在：${canonical.slice(CANONICAL.length)}`)

    // 角色头像走同一条路径，顺带覆盖
    await dispatch('command.characters.create', {
      id: 'char-avatar', name: '测试角色', avatar: PNG_DATA_URL,
      description: '', personality: '', scenario: '', firstMessage: '', chatBackground: ''
    })
    const characters = await dispatch<{ items: Array<Record<string, string>> }>('query.characters.list', {})
    const avatar = characters.items.find((item) => item.id === 'char-avatar')?.avatar ?? ''
    const charFetch = await fetch(`${base}${avatar}`)
    record('A-6', avatar.startsWith('/media/v1/') && charFetch.ok,
      `角色头像：${avatar.slice(0, 48)}… → ${charFetch.status}`)
  } catch (error) {
    record('A-7', false, `流程中断：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await server.close()
    await tenant.dispose()
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
