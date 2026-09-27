/**
 * 导出文件下载页（`/exports`）。
 *
 * 为什么需要它：上游 v0.1.10 的批量导出在桌面上是"选一个目录、主进程直接写盘"，
 * 浏览器没有这种能力（也没有原生目录对话框）。Web 端把导出落到租户的 `exports` 目录后，
 * **必须有地方把它取回来**，否则功能等于没做。这一页就是那个出口：
 * 列出本租户导出目录里的文件，点名字直接下载。
 *
 * 与登录页保持同一套视觉：样式来自 `/__eleckoi/app-tokens.css`（上游构建产物里提取的
 * 主题令牌），不引入任何外部资源。
 */

import { faviconLinks } from './favicon'
import { APP_TOKENS_PATH } from './appTokens'
import { pageCss } from './pageStyles'

export interface ExportsPageEntry {
  readonly name: string
  readonly bytes: number
  readonly modified: Date
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export interface ExportsPageOptions {
  readonly entries: readonly ExportsPageEntry[]
  /** 保留时长（分钟），页面上明确告诉用户"会自动删"。 */
  readonly ttlMinutes: number
  /** 刚刚清理掉的文件数（来自跳转参数），>0 时给个反馈。 */
  readonly cleared: number
}

export function renderExportsPage(options: ExportsPageOptions): string {
  const { entries, ttlMinutes, cleared } = options
  const rows = entries.length === 0
    ? '<p class="card__hint">这里还没有导出文件。在应用里选择角色卡后使用「导出」即可。</p>'
    : `<ul class="files">${entries.map((entry) => `
      <li>
        <a href="/exports/${encodeURIComponent(entry.name)}">${escapeHtml(entry.name)}</a>
        <span>${formatBytes(entry.bytes)} · ${entry.modified.toISOString().replace('T', ' ').slice(0, 16)}</span>
      </li>`).join('')}
    </ul>`

  const toolbar = entries.length === 0
    ? ''
    : `<form method="post" action="/exports/clear" class="toolbar">
        <button type="submit">清理全部导出文件</button>
        <span>手动清理会立刻删除全部文件；不点也会在 ${ttlMinutes} 分钟后自动删除。</span>
      </form>`
  const notice = cleared > 0
    ? `<p class="card__hint">已清理 ${cleared} 个文件。</p>`
    : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${faviconLinks()}
<title>导出文件 · 电子爱</title>
<link rel="stylesheet" href="${APP_TOKENS_PATH}">
<style>
${pageCss()}
.files { list-style: none; margin: 0; padding: 0; }
.files li { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline;
  padding: .6rem 0; border-bottom: 1px solid color-mix(in oklab, currentColor 12%, transparent); }
.files li:last-child { border-bottom: 0; }
.files a { color: inherit; font-weight: 600; text-decoration: none; word-break: break-all; }
.files a:hover { text-decoration: underline; }
.files span { opacity: .65; font-size: .85em; white-space: nowrap; }
.files li span { opacity: .65; }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 18px; }
.toolbar button {
  padding: 7px 14px; border-radius: 9px; border: 1px solid color-mix(in oklab, currentColor 28%, transparent);
  background: transparent; color: inherit; font: inherit; cursor: pointer;
}
.toolbar button:hover { border-color: color-mix(in oklab, currentColor 55%, transparent); }
.toolbar span { opacity: .65; font-size: .85em; }
</style>
</head>
<body>
<main class="shell shell--top">
  <div class="shell__inner">
    <section class="card">
      <h1 class="card__title">导出文件</h1>
      <p class="card__hint">这里存放你在本服务里导出的角色卡。桌面上这一步是「选一个文件夹写进去」，
        浏览器没有这个能力，因此统一放在服务端，点文件名即可下载。
        这些文件只是下载用的中转品，<strong>${ttlMinutes} 分钟后会自动删除</strong>。</p>
      ${notice}
      ${rows}
      ${toolbar}
    </section>
    <p class="foot"><a href="/">返回应用</a></p>
  </div>
</main>
</body>
</html>`
}
