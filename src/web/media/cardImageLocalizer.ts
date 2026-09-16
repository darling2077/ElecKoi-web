/**
 * 导入角色卡时**自动**把卡里的外链图片搬到你自己的图床，并就地改写引用。
 *
 * 为什么在应用内做：原来只有一个外部脚本（docker/rewrite-card-images.mjs），
 * 用它就得停容器、记参数、手动跑一遍——导入一张卡却要做这些，不合理。
 * 现在挂在网关的 `command.characters.import.commit` 之后，浏览器里点「导入」
 * 就走完：解码入库 → 扫描新卡里的外链图片 → 下载 → 传图床 → 改写引用。
 *
 * 与外部脚本的关系：脚本仍在，用于**已有数据**的一次性批量搬迁与离线场景；
 * 这里只处理"刚刚导入的那些角色"。
 *
 * 安全边界：只搬**图片**（按魔数判定，不认扩展名），只写自己的图床；
 * 单图有体积上限、单次导入有张数与时间预算，超了就停下并如实报告。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SqliteDatabase } from '@main/platform/sqlite/SqliteDatabase'

/** 会被扫描的表与列——角色卡的数据散在这几处（与外部脚本保持一致）。 */
const SCAN_TARGETS: Array<{ table: string; column: string; key: string[]; owner: string }> = [
  { table: 'character_text_contents', column: 'content', key: ['characterId', 'kind'], owner: 'characterId' },
  { table: 'character_regex_rules', column: 'replacement', key: ['characterId', 'id'], owner: 'characterId' },
  { table: 'character_regex_rules', column: 'pattern', key: ['characterId', 'id'], owner: 'characterId' },
  { table: 'setting_entry_contents', column: 'payloadJson', key: ['characterId', 'entryId', 'revisionId'], owner: 'characterId' },
  { table: 'variable_config_version_contents', column: 'content', key: ['characterId', 'versionId', 'kind'], owner: 'characterId' },
  { table: 'characters', column: 'chatBackground', key: ['id'], owner: 'id' }
]

/**
 * 一眼就不是图片的后缀，以及本机地址：不发请求。
 * 方向很重要——这里只做**排除**，绝不用后缀去认定图片（图床的无扩展名路径太多）。
 */
const NON_IMAGE_EXT = /\.(css|js|mjs|cjs|json|html?|xml|txt|mp3|mp4|webm|ogg|wav|m4a|woff2?|ttf|otf|eot|map|pdf|zip)(\?|#|$)/i

function isLocalAddress(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local')
  } catch {
    return false
  }
}

const MIME_BY_KIND: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml'
}

/**
 * 图片搬到哪儿去。对应 compose 里的四种做法（见 docs/webui/卡片外链图片本地化.md）：
 *   - uploadApi：自建公网图床（导出后别人也能取到图）
 *   - localDir：本地图床，由本服务在卡片源上以 /card-images/ 提供（导出后别人看不到）
 *   - dataUri：内联成 data: URI（不用图床，导出即自带，代价是卡片数据变大）
 */
export type CardImageTarget =
  | { kind: 'uploadApi'; uploadApi: string; uploadToken: string }
  | { kind: 'localDir'; directory: string }
  | { kind: 'dataUri'; maxInlineBytes: number }

export interface CardImageLocalizerOptions {
  database: SqliteDatabase
  /** 对外地址前缀：用于识别「已经搬过了」，也是改写后写进卡里的前缀（内联模式不需要）。 */
  publicBase?: string
  target: CardImageTarget
  maxImages?: number
  maxBytes?: number
  timeoutMs?: number
  budgetMs?: number
  /** 同时搬运几张。串行搬 300 张要几分钟，导入就得干等；4 路并发能把这段压到一分钟级。 */
  concurrency?: number
  /**
   * 允许搬运本机地址（127.0.0.1/localhost/::1）。
   * 默认为假：卡里写死本机地址的多半是作者自己的开发地址，服务端搬不到、也不该搬。
   * 只有验收（假图床就跑在本机）或确实在本机跑图床时才打开。
   */
  allowLocalAddresses?: boolean
  /** 进度回调：图片总数已知时先报一次 total，每搬完一张报一次 done。 */
  onProgress?: (progress: { phase: 'idle' | 'working' | 'done'; done: number; total: number }) => void
  log?: (message: string) => void
}

export interface LocalizeOutcome {
  /** 被改写的**记录数**（一条记录里可能含很多张图）。 */
  localized: number
  /** 被改写的**引用数**（图片张数），这才是"搬了多少张图"。 */
  urlsLocalized: number
  skipped: number
  failed: number
  /** 因为张数上限或时间预算而没来得及处理的。 */
  deferred: number
}

export interface CardImageLocalizer {
  /** 传进来的 onProgress 会与选项里的那个**同时**触发（一个给界面、一个给调用方）。 */
  localizeCharacters(
    characterIds: readonly string[],
    onProgress?: (progress: { phase: 'working'; done: number; total: number }) => void
  ): Promise<LocalizeOutcome>
  /**
   * 后台模式下等待当前进行中的搬运结束。
   * 浏览器不需要它（结果通过事件通知）；批量导入工具用它保证"跑完才算完"。
   */
  waitForIdle(): Promise<void>
  readonly summary: string
}

/** 从一段文本里找出所有外部图片 URL（跳过我方域名与 data:/blob:）。 */
function findImageUrls(text: string, baseOrigin: string | undefined): string[] {
  if (text === '') return []
  const found = new Set<string>()
  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>]+/gi)) {
    // 文件名带括号很常见（`xx(1).png`），匹配时允许括号、只裁掉多余的右括号；
    // 末尾的反斜杠来自嵌在 JS 字符串里的命名空间声明，一并裁掉。
    let raw = match[0]!.replace(/[.,;:\\]+$/, '')
    while (raw.endsWith(')') && (raw.match(/\(/g)?.length ?? 0) < (raw.match(/\)/g)?.length ?? 0)) {
      raw = raw.slice(0, -1)
    }
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (baseOrigin !== undefined && url.origin === baseOrigin) continue
    found.add(raw)
  }
  return [...found]
}

/** 图片魔数判定——有些图床不给扩展名或返回 application/octet-stream。 */
function sniffImage(buffer: Buffer): string | undefined {
  if (buffer.length < 12) return undefined
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'gif'
  if (buffer.subarray(4, 12).toString('ascii').startsWith('ftyp')) return 'avif'
  const head = buffer.subarray(0, 512).toString('utf8')
  if (/^\s*(<\?xml|<svg)/i.test(head) || /<svg[\s>]/i.test(head)) return 'svg'
  return undefined
}

export function createCardImageLocalizer(options: CardImageLocalizerOptions): CardImageLocalizer {
  const log = options.log ?? ((message: string): void => console.log(message))
  const maxImages = options.maxImages ?? 2000
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 20_000
  const budgetMs = options.budgetMs ?? 900_000
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16))
  const allowLocal = options.allowLocalAddresses ?? false
  /**
   * 进度有两个消费者：选项里的（装配时接进任务状态）与本次调用传入的（HTTP 接口读它）。
   * 两者都在 emit 里**各调一次**——早期版本用一个可变的"当前回调"转发，
   * 结果两个回调互相调用把栈打爆了（Maximum call stack size exceeded）。
   */
  type Working = { phase: 'working'; done: number; total: number }
  type Progress = Working | { phase: 'done'; done: number; total: number }
  const baseOrigin = (() => {
    if (options.publicBase === undefined) return undefined
    try {
      return new URL(options.publicBase).origin
    } catch {
      return undefined
    }
  })()
  const where = options.target.kind === 'uploadApi'
    ? `图床 ${options.target.uploadApi}`
    : options.target.kind === 'localDir'
      ? `本地目录 ${options.target.directory}（由本服务在 /card-images/ 提供）`
      : '内联 data: URI'
  const summary = `${where}（单次最多 ${maxImages} 张、${Math.round(budgetMs / 1000)}s 预算）`

  async function downloadOnce(url: string): Promise<{ buffer: Buffer; kind: string }> {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'ElecKoi-card-image-localizer/1.0' }
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) throw new Error(`超过单图上限（${buffer.length} 字节）`)
    const kind = sniffImage(buffer)
    if (kind === undefined) throw new Error('不是可识别的图片')
    return { buffer, kind }
  }

  /**
   * 免费图床经常打嗝（连接重置、超时）。**确定性的失败不重试**——404/403 说明图
   * 真的没了，重试只是浪费时间；网络类错误才重试一次。
   */
  async function download(url: string): Promise<{ buffer: Buffer; kind: string }> {
    try {
      return await downloadOnce(url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/^HTTP 4\d\d/.test(message) || message.includes('不是可识别的图片') || message.includes('超过单图上限')) throw error
      await new Promise((resolve) => setTimeout(resolve, 1200))
      return await downloadOnce(url)
    }
  }

  /** 按目标把一张图"搬"好，返回可以直接写进卡片的地址。 */
  async function place(buffer: Buffer, kind: string): Promise<string> {
    const target = options.target
    if (target.kind === 'dataUri') {
      if (buffer.length > target.maxInlineBytes) {
        throw new Error(`超过内联上限（${(buffer.length / 1024).toFixed(0)}KB）`)
      }
      return `data:${MIME_BY_KIND[kind] ?? 'application/octet-stream'};base64,${buffer.toString('base64')}`
    }
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 32)
    const name = `${hash}.${kind}`
    if (target.kind === 'localDir') {
      await mkdir(target.directory, { recursive: true })
      const file = join(target.directory, name)
      if (!existsSync(file)) await writeFile(file, buffer)
      return `${(options.publicBase ?? '').replace(/\/+$/, '')}/card-images/${name}`
    }
    return await upload(buffer, kind)
  }

  async function upload(buffer: Buffer, kind: string): Promise<string> {
    if (options.target.kind !== 'uploadApi') throw new Error('当前搬运方式不需要上传接口')
    const { uploadApi, uploadToken } = options.target
    const name = `${createHash('sha256').update(buffer).digest('hex').slice(0, 32)}.${kind}`
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(buffer)], { type: MIME_BY_KIND[kind] ?? 'application/octet-stream' }), name)
    const response = await fetch(`${uploadApi.replace(/\/+$/, '')}/api/upload`, {
      method: 'POST',
      // Zipline 的令牌原样放在 Authorization（没有 Bearer 前缀）
      headers: { authorization: uploadToken },
      body: form,
      signal: AbortSignal.timeout(Math.max(timeoutMs, 30_000))
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`图床返回 HTTP ${response.status}：${text.slice(0, 120)}`)
    let payload: { files?: Array<{ url?: string }> }
    try {
      payload = JSON.parse(text) as typeof payload
    } catch {
      throw new Error(`图床返回的不是 JSON：${text.slice(0, 120)}`)
    }
    const url = payload.files?.[0]?.url
    if (url === undefined) throw new Error(`图床没有返回文件地址：${text.slice(0, 120)}`)
    // 只取路径再套回对外地址：从内网还是公网调 API 都能写对域名
    return `${(options.publicBase ?? '').replace(/\/+$/, '')}${new URL(url, uploadApi).pathname}`
  }

  // 后台模式下进行中的任务：waitForIdle 用它，避免进程退出把搬运掐断。
  let pending: Promise<LocalizeOutcome> | undefined

  async function localize(
    characterIds: readonly string[],
    report?: (progress: Working) => void
  ): Promise<LocalizeOutcome> {
    const emit = (progress: Progress): void => {
      options.onProgress?.(progress)
      if (progress.phase === 'working') report?.({ phase: 'working', done: progress.done, total: progress.total })
    }
      const outcome: LocalizeOutcome = { localized: 0, urlsLocalized: 0, skipped: 0, failed: 0, deferred: 0 }
      if (characterIds.length === 0) return outcome
      const native = options.database.native
      const placeholders = characterIds.map(() => '?').join(', ')

      // ── 收集候选 ──
      const rows: Array<{ target: typeof SCAN_TARGETS[number]; keys: unknown[]; value: string; urls: string[] }> = []
      const unique = new Set<string>()
      for (const target of SCAN_TARGETS) {
        let records: Array<Record<string, unknown>>
        try {
          records = native
            .prepare(`SELECT ${target.key.join(', ')}, "${target.column}" AS value FROM "${target.table}" WHERE ${target.owner} IN (${placeholders})`)
            .all(...characterIds) as Array<Record<string, unknown>>
        } catch {
          continue // 表不存在（旧库/未启用该模块）就跳过
        }
        for (const record of records) {
          const value = record.value
          if (typeof value !== 'string' || value === '') continue
          const urls = findImageUrls(value, baseOrigin)
          if (urls.length === 0) continue
          rows.push({ target, keys: target.key.map((key) => record[key]), value, urls })
          for (const url of urls) unique.add(url)
        }
      }
      log(`  扫描到 ${unique.size} 个外链图片（分布在 ${rows.length} 条记录里）`)
      if (unique.size === 0) {
        emit({ phase: 'done', done: 0, total: 0 })
        return outcome
      }

      // ── 下载 + 上传（同一 URL 只处理一次，多路并发）──
      const candidates: string[] = []
      for (const url of unique) {
        if (NON_IMAGE_EXT.test(url) || (!allowLocal && isLocalAddress(url))) outcome.skipped += 1
        else candidates.push(url)
      }
      const queue = candidates.slice(0, maxImages)
      outcome.deferred += candidates.length - queue.length
      const replacements = new Map<string, string>()
      const deadline = Date.now() + budgetMs
      let handled = 0
      emit({ phase: 'working', done: 0, total: queue.length })
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < queue.length) {
          if (Date.now() > deadline) {
            outcome.deferred += queue.length - cursor
            cursor = queue.length
            return
          }
          const url = queue[cursor++]!
          try {
            const { buffer, kind } = await download(url)
            replacements.set(url, await place(buffer, kind))
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes('不是可识别的图片') || message.includes('超过内联上限')) outcome.skipped += 1
            else {
              outcome.failed += 1
              log(`  ✗ 卡片图片搬运失败 ${url.slice(0, 72)}：${message}`)
            }
          }
          handled += 1
          emit({ phase: 'working', done: handled, total: queue.length })
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
      emit({ phase: 'done', done: handled, total: queue.length })
      if (replacements.size === 0) return outcome

      // ── 就地改写（一个事务）──
      const apply = native.transaction(() => {
        for (const row of rows) {
          let text = row.value
          for (const url of row.urls) {
            const replacement = replacements.get(url)
            if (replacement === undefined) continue
            text = text.split(url).join(replacement)
            outcome.urlsLocalized += 1
          }
          if (text === row.value) continue
          const where = row.target.key.map((key) => `${key} = ?`).join(' AND ')
          native
            .prepare(`UPDATE "${row.target.table}" SET "${row.target.column}" = ? WHERE ${where}`)
            .run(text, ...row.keys)
          outcome.localized += 1
        }
      })
      apply.immediate()
      log(`  卡片图片已搬到 ${where}：改写 ${outcome.urlsLocalized} 处引用（涉及 ${outcome.localized} 条记录）`
        + (outcome.skipped > 0 ? `，非图片 ${outcome.skipped} 个` : '')
        + (outcome.failed > 0 ? `，失败 ${outcome.failed} 个` : '')
        + (outcome.deferred > 0 ? `，因上限/预算延后 ${outcome.deferred} 个（可调大 ELECKOI_IMAGE_MAX_PER_IMPORT / ELECKOI_IMAGE_TIME_BUDGET_MS）` : ''))
      return outcome
  }

  return {
    summary,
    localizeCharacters(characterIds, progress) {
      // 串行化：同一租户短时间内连续导入多批时，避免并发抢写同一个库。
      const run = (pending ?? Promise.resolve()).then(() => localize(characterIds, progress))
      pending = run.catch(() => ({ localized: 0, urlsLocalized: 0, skipped: 0, failed: 0, deferred: 0 }))
      return run
    },
    async waitForIdle() {
      while (pending !== undefined) {
        const current = pending
        await current.catch(() => undefined)
        if (pending === current) pending = undefined
      }
    }
  }
}
