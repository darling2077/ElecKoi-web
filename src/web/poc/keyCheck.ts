/**
 * 凭据加密验收：主密钥不可变 + 坏密文不拖垮功能。
 *
 * 这一篇来自一次真实事故：主密钥被换过之后，
 *  ① `query.models.list` 整个查询抛错 → 界面上**所有** API 供应商凭空消失；
 *  ② 重新添加也不行 —— 上游 `save()` 会拿旧密文比对（`decrypt(previous.apiKey)`），
 *     同样抛错，用户被彻底锁在外面。
 * 两条都出在上游逐行解密的写法上（`ModelRepository.ts` 第 18、30 行），
 * 我们只能在自己的 `WebCredentialCipher` 里把爆炸半径压到"这一条要重填"。
 *
 * 运行：pnpm webui:keys
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { WebHost } from '../WebHost'
import { WebCredentialCipher } from '../platform/WebCredentialCipher'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

/** 收集告警，顺便验证"失败有痕迹"而不是静默。 */
const warnings: string[] = []

async function main(): Promise<void> {
  process.env.ELECKOI_DISABLE_EVENT_STREAM = '1'

  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-keys-'))
  const tenantId = 'tenant-keys'
  const tenantRoot = join(root, 'tenant')
  const masterKey = randomBytes(32).toString('base64')
  const tenant = await WebHost.mountTenant({
    tenantId,
    tenantRoot,
    masterKeyBase64: masterKey,
    appVersion: '0.1.0-web-keys'
  })
  const dbPath = join(tenantRoot, 'db', 'eleckoi-common.sqlite3')
  console.log(`\n== 凭据加密验收 ==\n租户库：${dbPath}\n`)

  const REQUEST_CONTEXT = { senderId: 1, windowId: undefined }
  // 无入参的路由其契约是 z.object({})，传 undefined 会被判为格式错误，必须给 {}。
  const dispatch = (name: string, input: unknown = {}): Promise<unknown> =>
    tenant.gateway.dispatch({ name, input }, REQUEST_CONTEXT)

  try {
    // ── K-1 正常往返：存进去能读出来 ──
    // 契约要求完整对象（strict），所以以默认配置为模板再覆盖，
    // 这样上游一旦给 ModelConfig 加字段，这里会跟着暴露而不是悄悄漏测。
    const template = (await dispatch('query.models.list') as Array<Record<string, unknown>>)[0]!
    await dispatch('command.models.save', {
      ...template,
      id: 'probe-provider',
      name: '探针供应商',
      provider: 'custom',
      api_key: 'sk-probe-0123456789',
      base_url: 'https://api.example.com/v1',
      model: 'probe-model',
      api_format: 'chat_completions'
    })
    const listed = await dispatch('query.models.list') as Array<{ id: string; api_key: string }>
    const probe = listed.find((item) => item.id === 'probe-provider')
    record('K-1', probe?.api_key === 'sk-probe-0123456789',
      probe?.api_key === 'sk-probe-0123456789'
        ? '写入后读回的 API Key 与写入一致（HKDF 派生 + AES-GCM 往返正常）'
        : `读回的 Key 不符：${String(probe?.api_key).slice(0, 12)}…`)

    // ── K-2 落库的确实是密文，不是明文 ──
    const raw = new Database(dbPath, { readonly: true })
    const stored = raw.prepare("select apiKey from model_configs where id = 'probe-provider'").get() as { apiKey: string }
    raw.close()
    record('K-2', stored.apiKey.startsWith('web-aes-v1:') && !stored.apiKey.includes('sk-probe'),
      `库里存的是 ${stored.apiKey.slice(0, 18)}…（不含明文），前缀与桌面端 desktop-safe-v1 区分开`)

    // ── K-3 换一把主密钥后：解密失败必须**降级**而不是抛错 ──
    // 这里直接换掉租户上下文里的 cipher，等价于"主密钥被换过"。
    const rotated = new WebCredentialCipher(randomBytes(32).toString('base64'), tenantId, (message) => warnings.push(message))
    const rotatedPlain = rotated.decrypt(stored.apiKey)
    record('K-3', rotatedPlain === '' && warnings.length === 1,
      rotatedPlain === ''
        ? `换了密钥后 decrypt 返回空串并告警 1 条，而不是抛异常（${warnings[0]?.slice(0, 42) ?? ''}…）`
        : '换了密钥后仍然解出了内容，说明混淆了主密钥')

    // ── K-4 坏格式（桌面端数据 / 截断）同样降级，不抛 ──
    const badCases = ['desktop-safe-v1:abc:def', 'web-aes-v1:1:onlythree', 'web-aes-v1:9:a:b:c', 'not-a-cipher']
    const badResults = badCases.map((value) => rotated.decrypt(value))
    record('K-4', badResults.every((value) => value === ''),
      `桌面端格式 / 字段不全 / 版本不支持 / 完全不是密文 —— 四种都返回空串（不抛错），共告警 ${warnings.length} 条`)

    // ── K-5 真实库里的坏密文：列表与保存都必须还能用 ──
    // 直接把库里的密文改成"换了密钥后解不开"的样子，模拟事故现场。
    const writer = new Database(dbPath)
    writer.prepare("update model_configs set apiKey = ? where id = 'probe-provider'").run(rotated.encrypt('sk-encrypted-under-another-key'))
    writer.close()

    let listError = ''
    let afterCorruption: Array<{ id: string; api_key: string }> = []
    try {
      afterCorruption = await dispatch('query.models.list') as Array<{ id: string; api_key: string }>
    } catch (error) {
      listError = error instanceof Error ? error.message : String(error)
    }
    const stillListed = afterCorruption.find((item) => item.id === 'probe-provider')
    record('K-5', listError === '' && stillListed !== undefined && stillListed.api_key === '',
      listError === ''
        ? `列表照常返回 ${afterCorruption.length} 条，坏凭据那条 api_key 为空串（可被界面重新填写）`
        : `列表整体失败：${listError.slice(0, 70)} —— 这正是"供应商全部消失"的成因`)

    // ── K-6 覆盖保存：坏密文不能把保存也堵死 ──
    // 保存契约要求**完整对象**（modelConfigSchema.partial({ id: true }) 只让 id 可选），
    // 界面上的"重新填写 Key 再保存"正是整份提交，这里照做。
    let saveError = ''
    try {
      await dispatch('command.models.save', { ...stillListed, api_key: 'sk-refilled-987654321' })
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error)
    }
    const relisted = await dispatch('query.models.list') as Array<{ id: string; api_key: string }>
    const refilled = relisted.find((item) => item.id === 'probe-provider')
    record('K-6', saveError === '' && refilled?.api_key === 'sk-refilled-987654321',
      saveError === '' && refilled?.api_key === 'sk-refilled-987654321'
        ? '在坏密文之上重新保存成功，新 Key 已按当前主密钥加密（用户可自助恢复）'
        : `重新保存失败：${saveError.slice(0, 70) || '读回值不符'}`)

    // ── K-7 未改密钥时不会把已存的好 Key 弄丢 ──
    const current = (await dispatch('query.models.list') as Array<Record<string, unknown>>)
      .find((item) => item.id === 'probe-provider')!
    await dispatch('command.models.save', { ...current, name: '改名不改密钥' })
    const renamed = (await dispatch('query.models.list') as Array<{ id: string; name: string; api_key: string }>)
      .find((item) => item.id === 'probe-provider')
    record('K-7', renamed?.name === '改名不改密钥' && renamed?.api_key === 'sk-refilled-987654321',
      renamed?.api_key === 'sk-refilled-987654321'
        ? '只改名字时旧密钥原样保留（save 里"密钥未变则沿用原密文"的分支正确）'
        : '只改名字却动了密钥')

    // ── K-8 租户隔离：别的租户解不开这个租户的密文 ──
    const otherTenant = new WebCredentialCipher(masterKey, 'tenant-other', (message) => warnings.push(message))
    const crossTenant = otherTenant.decrypt(
      (new Database(dbPath, { readonly: true }).prepare("select apiKey from model_configs where id = 'probe-provider'").get() as { apiKey: string }).apiKey
    )
    record('K-8', crossTenant === '',
      crossTenant === ''
        ? '同一主密钥、不同租户 → 解不开（HKDF 盐是租户 id，跨租户无法互读）'
        : '跨租户竟然解开了，租户隔离失效')
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log(`\n== 结果：${outcomes.length - failed.length}/${outcomes.length} 通过 ==\n`)
  if (failed.length > 0) {
    console.log('未通过：' + failed.map((outcome) => outcome.id).join('、'))
    process.exitCode = 1
  }
}

await main()
