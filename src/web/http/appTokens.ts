/**
 * 把上游的**主题令牌**直接喂给我们的独立页面（登录/账号/用户管理）。
 *
 * 为什么这么做：这三个页面是我们自己的文档，拿不到应用打包进去的 CSS 变量，
 * 于是极容易做成"另一个产品"的样子。抄一份颜色常量能解决眼前，
 * 但上游一改主题就会悄悄过时；所以改为在运行时从构建产物里**提取** `:root` 令牌块
 * 并作为一个同源样式表提供，页面只写 `var(--…)`。
 *
 * 注意：`@media (prefers-color-scheme: dark) { :root:not([data-theme]) {…} }`
 * 里的那个块要排除——脱离媒体查询后它会无条件生效。我们的页面自己决定
 * `data-theme`，因此只需要 `:root` 与 `:root[data-theme="dark"]` 两块。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const APP_TOKENS_PATH = '/__eleckoi/app-tokens.css'

/** 构建产物找不到时的兜底：与上游 tokens.css 的暗色值一致，保证页面不会"裸奔"。 */
const FALLBACK = `:root {
  color-scheme: light;
  --shell-backdrop: #ffffff;
  --rail: #f0f3f6;
  --text: #111111;
  --muted: #8b8b8b;
  --soft-text: #adadad;
  --blue: #13a8ff;
  --blue-hover: #079cf0;
  --on-accent: #ffffff;
  --line: rgba(0, 0, 0, 0.055);
  --line-strong: rgba(0, 0, 0, 0.075);
  --control-bg: #ebebeb;
  --control-bg-hover: #e2e2e2;
  --field-bg: #f7f7f7;
  --surface-raised: #ffffff;
  --surface-subtle: #f5f6f8;
  --surface-muted: #eceef1;
  --active: rgba(38, 49, 72, 0.06);
  --shadow-color: rgba(0, 0, 0, 0.14);
  --glass-bg: rgba(255, 255, 255, 0.56);
  --glass-border: rgba(0, 0, 0, 0.08);
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --shell-backdrop: #13131a;
  --rail: #1a1a21;
  --text: #f2f2f5;
  --muted: #a4a4ad;
  --soft-text: #74747e;
  --blue: #36aef7;
  --blue-hover: #59bcf8;
  --on-accent: #ffffff;
  --line: rgba(255, 255, 255, 0.075);
  --line-strong: rgba(255, 255, 255, 0.11);
  --control-bg: rgba(255, 255, 255, 0.065);
  --control-bg-hover: rgba(255, 255, 255, 0.105);
  --field-bg: #1d1d25;
  --surface-raised: #1d1d25;
  --surface-subtle: #202029;
  --surface-muted: #262630;
  --active: rgba(255, 255, 255, 0.07);
  --shadow-color: rgba(0, 0, 0, 0.38);
  --glass-bg: rgba(29, 29, 37, 0.72);
  --glass-border: rgba(255, 255, 255, 0.1);
}`

let cached: string | undefined

/** 从 out/renderer/assets 里找出主样式表。 */
function findStylesheet(rendererDir: string): string | undefined {
  const assets = join(rendererDir, 'assets')
  if (!existsSync(assets)) return undefined
  const candidates = readdirSync(assets).filter((name) => name.startsWith('index-') && name.endsWith('.css'))
  if (candidates.length === 0) return undefined
  // 取体积最大的那个：主样式表一定是它。
  return candidates
    .map((name) => ({ path: join(assets, name), size: readFileSync(join(assets, name)).byteLength }))
    .sort((a, b) => b.size - a.size)[0]!.path
}

/**
 * 取出 `@font-face` 整块，并把相对字体路径改写成绝对路径。
 *
 * 上游构建产物里的 src 是 `./noto-sans-….woff2`，相对于样式表自身；
 * 我们的样式表挂在 /__eleckoi/ 下，不改写就会 404。
 * 顺带获得与应用本体完全一致的字形（拉丁部分走 Noto Sans 网络字体，
 * 中日韩字形仍由浏览器本地字体承担，与应用内表现一致）。
 */
function extractFontFaces(css: string): string[] {
  const faces: string[] = []
  const pattern = /@font-face\s*\{/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    const open = css.indexOf('{', match.index)
    let depth = 0
    let index = open
    for (; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const block = css.slice(match.index, index + 1)
    faces.push(block.replace(/url\((["']?)\.\//g, 'url($1/assets/'))
  }
  return faces
}

/** 取出以 `:root` 开头、且不属于媒体查询的那几条规则块。 */
function extractRootBlocks(css: string): string[] {
  const blocks: string[] = []
  const pattern = /:root(\[[^\]]*\])?\s*\{/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    const selector = match[0].slice(0, -1).trim()
    // 排除媒体查询里的 :root:not([data-theme]) —— 脱离媒体查询后语义会变
    if (selector.includes(':not(')) continue
    const open = css.indexOf('{', match.index)
    let depth = 0
    let index = open
    for (; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    blocks.push(css.slice(match.index, index + 1))
  }
  return blocks
}

export function readAppTokens(rendererDir: string): string {
  if (cached !== undefined) return cached
  try {
    const stylesheet = findStylesheet(rendererDir)
    if (stylesheet !== undefined) {
      const css = readFileSync(stylesheet, 'utf8')
      const blocks = extractRootBlocks(css)
      if (blocks.some((block) => block.includes('--shell-backdrop')) && blocks.length >= 2) {
        const faces = extractFontFaces(css)
        cached = [
          '/* 从上游构建产物提取的主题令牌与字体，勿手工编辑 */',
          ...faces,
          ...blocks,
          ''
        ].join('\n')
        return cached
      }
    }
  } catch {
    // 落到兜底
  }
  cached = `/* 未能从构建产物提取令牌，使用内置兜底 */\n${FALLBACK}\n`
  return cached
}

/** 供测试断言用的是否走了真实提取路径。 */
export function appTokensFromBuild(): boolean {
  return cached !== undefined && cached.includes('从上游构建产物提取')
}
