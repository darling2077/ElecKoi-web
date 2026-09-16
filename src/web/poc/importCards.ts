/**
 * 把一批角色卡导入某个租户（批量导入工具，不是验收脚本）。
 *
 * 走应用**自己的**导入通道 `command.characters.import.prepare/commit`，
 * 也就是浏览器里点「导入角色卡」时走的同一条路——解码、设定库、变量、正则、
 * 头像回存全部由上游代码完成，这里不自己拼 SQL，避免绕过它的一致性逻辑。
 *
 * 运行（先停掉主站容器，SQLite 在容器里是 WAL，别对着热库写）：
 *   pnpm webui:import-cards -- \
 *     --tenant-root /vol2/docker/volumes/docker_eleckoi-data/_data/tenants/t_xxx \
 *     --dir "/path/to/cards" [--limit 50] [--apply]
 *
 * 默认 dry-run：只解码并报告哪些能导入，不写库。加 --apply 才真正导入。
 *
 * ⚠️ 导入**不会**自动把卡里的外链图片搬到你的图床——那是另一个工具
 * （docker/rewrite-card-images.mjs）。本工具跑完会打印现成的下一步命令。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { WebHost } from '../WebHost'

const REQUEST_CONTEXT = { senderId: 1, windowId: undefined }

/** 上游 prepare 一次最多 50 张，超过要分批。 */
const CHUNK = 50

interface Options {
  tenantRoot: string
  dir: string
  limit: number | undefined
  apply: boolean
  source: 'eleckoi' | 'sillytavern'
}

function parseArgs(argv: string[]): Options {
  const options = { apply: false, source: 'sillytavern' as Options['source'], tenantRoot: '', dir: '', limit: undefined as number | undefined }
  const value = (index: number, flag: string): string => {
    const raw = argv[index]
    if (raw === undefined) throw new Error(`${flag} 后面要跟一个值`)
    return raw
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (arg === '--apply') options.apply = true
    else if (arg === '--tenant-root') options.tenantRoot = value(++i, arg)
    else if (arg === '--dir') options.dir = value(++i, arg)
    else if (arg === '--limit') options.limit = Number(value(++i, arg))
    else if (arg === '--source') {
      const source = value(++i, arg)
      if (source !== 'eleckoi' && source !== 'sillytavern') throw new Error('--source 只能是 eleckoi 或 sillytavern')
      options.source = source
    } else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
  }
  if (options.tenantRoot === '') throw new Error('必须提供 --tenant-root（租户目录，里面有 db/ 与 media/）')
  if (options.dir === '') throw new Error('必须提供 --dir（角色卡所在目录，递归扫描 .png/.json）')
  if (!process.env.ELECKOI_MASTER_KEY) {
    throw new Error('缺少 ELECKOI_MASTER_KEY（租户要在主密钥下挂载，从 docker/.env 取）')
  }
  return options
}

/** 递归找出所有角色卡文件，排序保证结果可复现。 */
function collectCards(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (['.png', '.json'].includes(extname(entry).toLowerCase())) found.push(path)
    }
  }
  walk(dir)
  return found
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const tenantRoot = resolve(options.tenantRoot)
  const dir = resolve(options.dir)
  const files = collectCards(dir)
  const selected = options.limit === undefined ? files : files.slice(0, options.limit)

  console.log(`\n== 角色卡批量导入 ==`)
  console.log(`租户：${tenantRoot}`)
  console.log(`卡目录：${dir}`)
  console.log(`找到 ${files.length} 个卡文件，本次处理 ${selected.length} 个（${options.apply ? '写入' : 'dry-run'}）\n`)

  const tenant = await WebHost.mountTenant({
    tenantId: basename(tenantRoot),
    tenantRoot,
    masterKeyBase64: process.env.ELECKOI_MASTER_KEY!,
    appVersion: 'import-cards'
  })
  const dispatch = <T>(name: string, input: unknown): Promise<T> =>
    tenant.gateway.dispatch({ name, input }, REQUEST_CONTEXT) as Promise<T>

  let imported = 0
  let skipped = 0
  const failed: string[] = []

  try {
    for (let offset = 0; offset < selected.length; offset += CHUNK) {
      const batch = selected.slice(offset, offset + CHUNK)
      const payload = batch.map((path) => {
        const bytes = readFileSync(path)
        return {
          // displayName 上游限长 260，太长的文件名要截断（截断后仅影响显示名）
          displayName: basename(path).slice(0, 260),
          mimeType: extname(path).toLowerCase() === '.png' ? 'image/png' : 'application/json',
          base64: bytes.toString('base64')
        }
      })

      const preview = await dispatch<{
        token: string
        items: Array<{ name: string; importable: boolean; errorMessage: string; imageAvailable: boolean }>
      }>('command.characters.import.prepare', { source: options.source, files: payload })

      const good = preview.items.filter((item) => item.importable)
      const bad = preview.items.filter((item) => !item.importable)
      skipped += bad.length
      for (let i = 0; i < preview.items.length; i += 1) {
        const item = preview.items[i]!
        if (!item.importable) failed.push(`${batch[i] !== undefined ? basename(batch[i]!) : item.name}：${item.errorMessage}`)
      }

      const range = `${offset + 1}-${offset + batch.length}`
      if (!options.apply) {
        console.log(`  [${range}] 可导入 ${good.length} 张，失败 ${bad.length} 张（dry-run 不写库）`)
        for (const item of good.slice(0, 3)) console.log(`      · ${item.name}`)
        if (good.length > 3) console.log(`      · …其余 ${good.length - 3} 张`)
        await dispatch('command.characters.import.discard', { token: preview.token }).catch(() => undefined)
        continue
      }

      if (good.length === 0) {
        console.log(`  [${range}] 全部无法导入，跳过`)
        await dispatch('command.characters.import.discard', { token: preview.token }).catch(() => undefined)
        continue
      }

      const result = await dispatch<{ importedCharacterIds: string[]; failedMessages: string[] }>(
        'command.characters.import.commit',
        { token: preview.token }
      )
      imported += result.importedCharacterIds.length
      skipped += result.failedMessages.length
      failed.push(...result.failedMessages)
      console.log(`  [${range}] 已导入 ${result.importedCharacterIds.length} 张`)
    }
    // 搬运默认在后台跑，这里等它结束——批量工具的报告必须反映真实结果。
    await tenant.gateway.importImageHook?.waitForIdle()
  } finally {
    await tenant.dispose()
  }

  console.log(`\n== 结果 ==`)
  console.log(`导入成功 ${imported} 张，跳过/失败 ${skipped} 张`)
  if (failed.length > 0) {
    console.log('失败明细（最多 20 条）：')
    for (const line of failed.slice(0, 20)) console.log(`  ✗ ${line}`)
    if (failed.length > 20) console.log(`  …其余 ${failed.length - 20} 条`)
  }

  if (options.apply && imported > 0) {
    // 配了图床的话，导入时已经自动搬过图了（见 ELECKOI_IMAGE_* ），不该再让人手动跑脚本。
    if (tenant.gateway.importImageHook === undefined) {
      console.log('\n提示：没有配置自动搬图（ELECKOI_IMAGE_PUBLIC_BASE / UPLOAD_API / UPLOAD_TOKEN），')
      console.log('      卡里的外链图片仍是外链。要搬到自己的图床可以补配这三个变量后重新导入，')
      console.log('      或用外部脚本对本租户做一次批量搬迁：docker/rewrite-card-images.mjs')
    } else {
      console.log('\n卡里的外链图片已在导入过程中自动搬到你的图床。')
    }
  } else if (!options.apply) {
    console.log('\n确认无误后加 --apply 重新执行。')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
