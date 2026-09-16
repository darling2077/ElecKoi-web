#!/usr/bin/env node
/**
 * 把角色卡里的**外部图床图片**搬到自己的图床，并改写卡里的引用。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────────
 * 角色卡经常把立绘直接写成外部图床地址（`<img src="https://i.postimg.cc/...">`
 * 这类），而 Web 端的卡片帧 CSP 默认是 `img-src 'self' data: blob:`，
 * 外域图片一律被浏览器拦掉 —— 卡片显示成一片黑（已用真实浏览器验证：
 * 白名单外的图连请求都发不出去）。
 *
 * 把图搬到自己能公网访问的图床 + 把卡片里的引用改成自己的域，有两个好处：
 *   1. 卡片能正常显示（前提：该域配进 ELECKOI_CARD_IMAGE_ORIGINS）；
 *   2. 卡片**导出给别人**时，引用的仍是你自己的图床，不会因为原图床删图而失效。
 *
 * ── 与安全的关系 ────────────────────────────────────────────────────────
 * 放宽到自己的域和放宽到第三方图床是两件事：卡片只能通过图片 URL 发 GET，
 * 数据最多落在**你自己服务器的访问日志**里，攻击者读不到；而第三方图床的图是
 * 公开可访问的，等于直接泄给第三方。所以本工具只应指向你自己的域。
 *
 * ── 三种搬运方式（选一种，对应 docs/webui/卡片外链图片本地化.md 的方案表）──
 *   --upload-dir <目录>            图落到本地目录 → 方案 3（纯自用；别人导出后打不开）
 *   --upload-api <URL> --upload-token <令牌>
 *                                  传进自建图床服务 → 方案 4（导出后别人也能取到图）
 *   --inline                       内联成 data: URI → 方案 2（不用图床、导出即自带，
 *                                  但只适合小图：base64 会写进卡片数据，随每次渲染下发）
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node docker/rewrite-card-images.mjs <库文件|租户目录|数据根目录> \
 *     --public-base https://img.example.com \
 *     --upload-dir /srv/images \
 *     [--apply] [--max-bytes 20971520] [--timeout-ms 20000]
 *
 *   默认 dry-run（只报告要搬哪些图，不下载不改库）；加 --apply 才真正执行。
 *   加了 --apply 会先把库文件另存一份 `<库名>.before-image-rewrite-<时间戳>`。
 *
 * 幂等：已经是自己域名的引用会被跳过，可以反复执行。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

const DB_RELATIVE = join('db', 'eleckoi-common.sqlite3')

/** 会被扫描的表与列 —— 角色卡的数据都散在这几处。 */
const SCAN_TARGETS = [
  { table: 'character_text_contents', column: 'content', key: ['characterId', 'kind'] },
  { table: 'character_regex_rules', column: 'replacement', key: ['characterId', 'id'] },
  { table: 'character_regex_rules', column: 'pattern', key: ['characterId', 'id'] },
  { table: 'setting_entry_contents', column: 'payloadJson', key: ['characterId', 'entryId', 'revisionId'] },
  { table: 'variable_config_version_contents', column: 'content', key: ['characterId', 'versionId', 'kind'] },
  { table: 'characters', column: 'chatBackground', key: ['id'] }
]

function parseArgs(argv) {
  const options = { apply: false, maxBytes: 20 * 1024 * 1024, timeoutMs: 20000, inputs: [], inlineMaxBytes: 256 * 1024 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') options.apply = true
    else if (arg === '--public-base') options.publicBase = argv[++i]
    else if (arg === '--upload-dir') options.uploadDir = argv[++i]
    else if (arg === '--upload-api') options.uploadApi = argv[++i]
    else if (arg === '--upload-token') options.uploadToken = argv[++i]
    else if (arg === '--upload-folder') options.uploadFolder = argv[++i]
    else if (arg === '--inline') options.inline = true
    else if (arg === '--inline-max-bytes') options.inlineMaxBytes = Number(argv[++i])
    else if (arg === '--max-bytes') options.maxBytes = Number(argv[++i])
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
    else options.inputs.push(arg)
  }
  if (options.inputs.length === 0) {
    throw new Error([
      '用法：node docker/rewrite-card-images.mjs <库文件|租户目录|数据根目录> （三选一）',
      '        --upload-dir <目录>           图片落到本地目录，交给你自己的静态服务',
      '        --upload-api <URL> --upload-token <令牌>   传进图床服务（Zipline）',
      '        --inline                      直接内联成 data: URI（不用图床，导出即自带）',
      '      [--public-base <URL>] [--apply] [--upload-folder <ID>]',
      '      [--inline-max-bytes N] [--max-bytes N] [--timeout-ms N]'
    ].join('\n'))
  }
  const usesApi = options.uploadApi !== undefined
  const usesDir = options.uploadDir !== undefined
  const chosen = [usesApi, usesDir, options.inline === true].filter(Boolean).length
  if (chosen !== 1) {
    throw new Error('--upload-dir / --upload-api / --inline 三种搬运方式必须且只能选一个')
  }
  if (usesApi && options.uploadToken === undefined) {
    throw new Error('用 --upload-api 时必须同时提供 --upload-token（图床后台生成的 API 令牌）')
  }
  // 内联模式没有「自己的域名」这回事，不需要 --public-base。
  if (!options.inline && options.publicBase === undefined) {
    throw new Error('必须提供 --public-base（图床对外的公网地址，用于识别「已经搬过的引用」）')
  }

  if (options.publicBase !== undefined) {
    const base = new URL(options.publicBase)
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('--public-base 只支持 http/https')
    options.publicBase = options.publicBase.replace(/\/+$/, '')
    options.baseOrigin = base.origin
  }
  if (usesDir) options.uploadDir = resolve(options.uploadDir)
  if (usesApi) options.uploadApi = options.uploadApi.replace(/\/+$/, '')
  return options
}

function collectDatabases(input) {
  const target = resolve(input)
  if (!existsSync(target)) throw new Error(`路径不存在：${target}`)
  if (statSync(target).isFile()) return [target]
  const direct = join(target, DB_RELATIVE)
  if (existsSync(direct)) return [direct]
  // 传进来的可能是「数据根目录」（下面有 tenants/），也可能直接就是 tenants/ 本身，
  // 两种都要认——否则对着 tenants/ 跑会静默地「一个库都没找到」。
  const tenantsRoot = join(target, 'tenants')
  const root = existsSync(tenantsRoot) ? tenantsRoot : target
  return readdirSync(root).map((e) => join(root, e, DB_RELATIVE)).filter(existsSync).sort()
}

/** 从一段文本里找出所有外部图片 URL（跳过我方域名与 data:/blob:）。 */
function findImageUrls(text, baseOrigin) {
  if (typeof text !== 'string' || text === '') return []
  const found = new Set()
  const re = /https?:\/\/[^\s"'`<>]+/gi
  for (const match of text.matchAll(re)) {
    // 文件名里带括号很常见（浏览器下载重名时加 `(1)`），所以匹配时允许括号，
    // 只裁掉「多余的」右括号——这样 Markdown 的 `[文字](链接)` 和 `xx(1).png` 都对。
    // 卡里的 HTML/CSS 常被嵌在 JS 字符串里，命名空间声明会写成
    // `xmlns=\"http://www.w3.org/2000/svg\"`，正则会在 `"` 前停下、把 JS 的转义
    // 反斜杠留在末尾，所以要一并裁掉。
    let raw = match[0].replace(/[.,;:\\]+$/, '')
    while (raw.endsWith(')') && (raw.match(/\(/g)?.length ?? 0) < (raw.match(/\)/g)?.length ?? 0)) {
      raw = raw.slice(0, -1)
    }
    let url
    try { url = new URL(raw) } catch { continue }
    if (baseOrigin !== undefined && url.origin === baseOrigin) continue
    // 不靠扩展名或关键词猜：图床的路径形态太多（无扩展名、查询串变换、
    // 文件名带括号……），猜错的代价是静默漏掉一张图。
    // 一律收作候选，下载后用魔数判定是不是图片。
    found.add(raw)
  }
  return [...found]
}

/** 明确不是图片的 URL：XML 命名空间之类的规范地址，抓了也只会白费一次请求。 */
const NON_IMAGE_URL = /^https?:\/\/www\.w3\.org\//i

/**
 * 一眼就不是图片的后缀。注意方向：这里只做「排除」，绝不用后缀去**认定**图片——
 * 图床的无扩展名路径太多了。排除掉样式表/脚本/字体这些只会白白发一次请求的目标。
 */
const NON_IMAGE_EXT = /\.(css|js|mjs|cjs|json|html?|xml|txt|woff2?|ttf|otf|eot|map)(\?|#|$)/i

/** 本机地址：公网图床场景下抓不到，也没必要抓（改写后指向的是公网域名）。 */
function isLocalAddress(raw) {
  let host
  try { host = new URL(raw).hostname.toLowerCase() } catch { return false }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local')
}

function tableExists(db, name) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name))
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().some((c) => c.name === column)
}

function scanDatabase(db, baseOrigin) {
  const hits = []
  for (const target of SCAN_TARGETS) {
    if (!tableExists(db, target.table) || !columnExists(db, target.table, target.column)) continue
    const keyList = target.key.join(', ')
    for (const row of db.prepare(`SELECT ${keyList}, "${target.column}" AS value FROM "${target.table}"`).all()) {
      const urls = findImageUrls(row.value, baseOrigin)
      if (urls.length > 0) hits.push({ target, row, urls })
    }
  }
  return hits
}

/** 图片魔数判定 —— 有些图床不给扩展名或返回 application/octet-stream。 */
function sniffImage(buffer) {
  if (buffer.length < 12) return undefined
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'gif'
  if (buffer.subarray(4, 12).toString('ascii').startsWith('ftyp')) return 'avif'
  // SVG 是文本（XML），没有魔数，靠开头特征识别
  const head = buffer.subarray(0, 512).toString('utf8')
  if (/^\s*(<\?xml|<svg)/i.test(head) || /<svg[\s>]/i.test(head)) return 'svg'
  return undefined
}

async function download(url, { maxBytes, timeoutMs }) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'ElecKoi-card-image-rewriter/1.0' }
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new Error(`超过大小上限（声明 ${declared} 字节）`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxBytes) throw new Error(`超过大小上限（${buffer.length} 字节）`)
  const kind = sniffImage(buffer)
  if (kind === undefined) throw new Error('不是可识别的图片（魔数不匹配）')
  return { buffer, kind }
}

/** 扩展名 → MIME。Zipline 会拿它判断类型，给错了会出现「下载而非预览」。 */
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', svg: 'image/svg+xml'
}

/**
 * 把图片传进图床服务（Zipline），返回它给出的**公开访问地址**。
 *
 * 不用拼接路径而是取服务返回的 url，是因为文件名格式、files.route 前缀、
 * 域名都由图床配置决定，只有它自己知道最终地址长什么样。
 * 但返回的 url 里的域名取决于你用哪个入口调的 API（内网 IP 还是公网域名），
 * 所以这里只取 path，再套回 --public-base —— 这样从哪调都不会写错域名。
 */
async function uploadToImageHost(buffer, kind, fileName, options) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: MIME[kind] ?? 'application/octet-stream' }), fileName)
  const response = await fetch(`${options.uploadApi}/api/upload`, {
    method: 'POST',
    headers: {
      // Zipline 的令牌就是原样放 Authorization（没有 Bearer 前缀）
      authorization: options.uploadToken,
      ...(options.uploadFolder === undefined ? {} : { 'x-zipline-folder': options.uploadFolder })
    },
    body: form,
    signal: AbortSignal.timeout(Math.max(options.timeoutMs, 30_000))
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`图床返回 HTTP ${response.status}：${text.slice(0, 200)}`)
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error(`图床返回的不是 JSON：${text.slice(0, 200)}`) }
  const file = payload?.files?.[0]
  if (file?.url === undefined) throw new Error(`图床没有返回文件地址：${text.slice(0, 200)}`)
  const path = new URL(file.url, options.uploadApi).pathname
  return `${options.publicBase}${path}`
}

function backupDatabase(databasePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${databasePath}.before-image-rewrite-${stamp}`
  copyFileSync(databasePath, target)
  return target
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const databases = options.inputs.flatMap((input) => collectDatabases(input))
  if (databases.length === 0) { console.log('没有找到任何 eleckoi-common.sqlite3，什么都没做。'); return }

  const where = options.inline === true
    ? `方式：内联成 data: URI（上限 ${(options.inlineMaxBytes / 1024).toFixed(0)}KB，超过的保留外链）`
    : options.uploadApi === undefined
      ? `落盘：${options.uploadDir}`
      : `图床：${options.uploadApi}（API 上传${options.uploadFolder === undefined ? '' : `，文件夹 ${options.uploadFolder}`}）`
  console.log(options.apply
    ? `模式：写入（--apply）\n${options.publicBase === undefined ? '' : `对外地址：${options.publicBase}\n`}${where}\n`
    : `模式：dry-run（只报告，不下载不改库；确认后加 --apply）\n${options.publicBase === undefined ? '' : `对外地址：${options.publicBase}\n`}${where}\n`)
  if (options.apply && options.uploadDir !== undefined) mkdirSync(options.uploadDir, { recursive: true })

  const downloaded = new Map() // 原 URL → 新地址（完整 URL）
  const skipped = new Set()    // 下载到了但不是图片，保持原样
  const ignored = new Set()    // 一眼就不是图片 / 本机地址，连请求都不发
  const tooBigForInline = []   // 内联模式里超过上限、保留外链的
  const allUrls = new Set()    // 见过的所有 URL，用于结论里的总数
  let totalRewrites = 0
  let totalFailures = 0

  for (const databasePath of databases) {
    const db = new Database(databasePath, { readonly: !options.apply })
    try {
      const hits = scanDatabase(db, options.baseOrigin)
      const uniqueUrls = [...new Set(hits.flatMap((h) => h.urls))]
      console.log(`${databasePath}`)
      if (uniqueUrls.length === 0) { console.log('  没有外部图片引用，无需处理\n'); continue }
      console.log(`  发现 ${uniqueUrls.length} 个外部 URL，分布在 ${hits.length} 条记录里（逐个下载后用魔数判定是否为图片）`)

      // ── 下载（同一 URL 只下一次）──
      for (const url of uniqueUrls) {
        allUrls.add(url)
        if (downloaded.has(url)) continue
        if (NON_IMAGE_URL.test(url) || NON_IMAGE_EXT.test(url) || isLocalAddress(url)) {
          ignored.add(url)
          console.log(`    – ${url.slice(0, 72)}…：${isLocalAddress(url) ? '本机地址' : '不是图片的地址'}，跳过`)
          continue
        }
        if (!options.apply) { downloaded.set(url, '(dry-run)'); continue }
        try {
          let attempt
          try {
            attempt = await download(url, options)
          } catch (first) {
            const message = first instanceof Error ? first.message : String(first)
            // 免费图床常打嗝（连接重置、超时、5xx）。HTTP 404/403 之类的确定性
            // 失败不值得重试，网络类错误才重试一次。
            if (/^HTTP (4\d\d)/.test(message)) throw first
            await new Promise((resolve) => setTimeout(resolve, 1200))
            attempt = await download(url, options)
          }
          const { buffer, kind } = attempt
          const name = `${createHash('sha256').update(buffer).digest('hex').slice(0, 32)}.${kind}`
          let target
          if (options.inline === true) {
            // 内联：图直接变成 data: URI 写进卡片数据。
            // CSP 本来就允许 img-src/media-src 的 data:，所以不用配任何白名单，
            // 导出给别人也自带图。代价是体积涨约 1/3，且会随卡片数据每次下发。
            if (buffer.length > options.inlineMaxBytes) {
              tooBigForInline.push(url)
              console.log(`    – ${url.slice(0, 72)}…：${(buffer.length / 1024).toFixed(0)}KB 超过内联上限，保留外链`)
              continue
            }
            target = `data:${MIME[kind] ?? 'application/octet-stream'};base64,${buffer.toString('base64')}`
          } else if (options.uploadApi === undefined) {
            const file = join(options.uploadDir, name)
            if (!existsSync(file)) writeFileSync(file, buffer)
            target = `${options.publicBase}/${name}`
          } else {
            target = await uploadToImageHost(buffer, kind, name, options)
          }
          downloaded.set(url, target)
          console.log(`    ↓ ${url.slice(0, 72)}… → ${options.inline === true ? `内联 data: URI（${(buffer.length / 1024).toFixed(0)}KB 原始大小）` : `${target.slice(0, 96)}…（${(buffer.length / 1024).toFixed(0)}KB）`}`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes('不是可识别的图片')) {
            skipped.add(url)
            console.log(`    – ${url.slice(0, 72)}…：不是图片，保留原样`)
          } else {
            totalFailures += 1
            console.error(`    ✗ ${url.slice(0, 72)}…：${message}`)
          }
        }
      }

      if (!options.apply) {
        for (const url of uniqueUrls) console.log(`    ? ${url}`)
        console.log(`  预览：上面这些会被逐个下载判定；是图片的改写为 ${options.publicBase}/…，不是图片的保留原样\n`)
        continue
      }

      // ── 改写 ──
      const backup = backupDatabase(databasePath)
      let rewrites = 0
      db.transaction(() => {
        for (const hit of hits) {
          let text = hit.row.value
          for (const url of hit.urls) {
            const target = downloaded.get(url)
            if (target === undefined || target === '(dry-run)') continue
            text = text.split(url).join(target)
          }
          if (text === hit.row.value) continue
          const where = hit.target.key.map((k) => `${k} = ?`).join(' AND ')
          const args = hit.target.key.map((k) => hit.row[k])
          db.prepare(`UPDATE "${hit.target.table}" SET "${hit.target.column}" = ? WHERE ${where}`).run(text, ...args)
          rewrites += 1
        }
      })()
      totalRewrites += rewrites
      console.log(`  ✓ 改写 ${rewrites} 条记录；改前备份：${backup.split('/').pop()}\n`)
    } finally {
      db.close()
    }
  }

  const imageCount = [...downloaded.values()].filter((v) => v !== '(dry-run)').length
  console.log(`结论：改写 ${totalRewrites} 条记录；扫描到 ${allUrls.size} 个不同 URL —— `
    + `判定为图片 ${imageCount} 个、不是图片 ${skipped.size} 个、直接跳过 ${ignored.size} 个`
    + (totalFailures > 0 ? `，下载失败 ${totalFailures} 个（见上）。` : '。'))
  if (options.apply && totalRewrites > 0 && options.inline !== true) {
    console.log('')
    console.log('别忘了把图床域名加进卡片帧白名单，否则外链仍会被 CSP 拦掉：')
    console.log('  ELECKOI_CARD_IMAGE_ORIGINS=' + options.baseOrigin)
  }
  if (options.inline === true && tooBigForInline.length > 0) {
    console.log('')
    console.log(`有 ${tooBigForInline.length} 张图超过内联上限（保留为外链，别人导出后仍依赖原图床）：`)
    for (const url of tooBigForInline) console.log('  ' + url)
    console.log('想全部内联就调大 --inline-max-bytes —— 但卡片数据会同比变大。')
  }
  if (!options.apply) console.log('确认无误后加 --apply 重新执行。')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
