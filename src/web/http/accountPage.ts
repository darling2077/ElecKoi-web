/**
 * 账号管理页（我们自己的页面，不涉及上游 UI）。
 *
 * 与应用同一套设计语言：令牌来自 /__eleckoi/app-tokens.css（上游构建产物提取），
 * 主题跟随该账号在应用里的外观设置。这里是「门厅内侧」，应当和门一样安静。
 */

import { faviconLinks } from './favicon'
import { APP_TOKENS_PATH } from './appTokens'
import { pageCss } from './pageStyles'
import type { PageTheme } from './pageTheme'
import { themeBootstrap } from './pageTheme'

export interface AccountPageOptions {
  email: string
  /** 可选登录名；为空表示只能用邮箱登录。 */
  username: string | null
  isAdmin: boolean
  createdAt: number
  /** 该账号的数据占用，用于让用户对资源有概念。 */
  usage: {
    mediaBytes: number
    conversationCount: number
    characterCount: number
  }
  /** 该账号在应用里选择的外观；system 表示跟随系统。 */
  theme: PageTheme
  sourceUrl?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDate(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char
  ))
}

export function renderAccountPage(options: AccountPageOptions): string {
  const sourceLink = (() => {
    if (!options.sourceUrl) return ''
    try {
      const url = new URL(options.sourceUrl)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
      return `<p class="foot">本服务基于 ElecKoi 构建，<a href="${escapeHtml(url.toString())}" rel="noopener noreferrer">查看对应源代码</a>。</p>`
    } catch {
      return ''
    }
  })()

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${faviconLinks()}
<title>账号管理 · 电子爱</title>
<link rel="stylesheet" href="${APP_TOKENS_PATH}">
<style>
${pageCss()}
</style>
<script>${themeBootstrap(options.theme)}</script>
</head>
<body>
<div class="shell shell--top">
  <div class="shell__inner">
    <div class="topbar">
      <div class="brand" style="margin:0">
        <span class="brand__dot"></span>
        <span class="brand__name">账号管理</span>
      </div>
      <nav class="topbar__links">
        ${options.isAdmin ? '<a href="/admin/users">用户管理</a>' : ''}
        <a href="/">返回应用</a>
      </nav>
    </div>
    <section class="card">
      <h2 class="card__title">${escapeHtml(options.email)}</h2>
      <p class="card__hint">这个账号的数据只保存在本服务上。</p>
      <dl class="rows">
        <dt>用户名</dt>
        <dd>${options.username === null ? '<span class="tag">未设置，只能用邮箱登录</span>' : escapeHtml(options.username)}</dd>
        <dt>权限</dt>
        <dd>${options.isAdmin ? '<span class="tag tag--accent">管理员</span>' : '普通用户'}</dd>
        <dt>注册时间</dt>
        <dd>${formatDate(options.createdAt)}</dd>
        <dt>媒体占用</dt>
        <dd>${formatBytes(options.usage.mediaBytes)}</dd>
        <dt>角色 / 会话</dt>
        <dd>${options.usage.characterCount} 个角色 · ${options.usage.conversationCount} 个会话</dd>
      </dl>
    </section>

    <section class="card">
      <h2 class="card__title">修改密码</h2>
      <p class="card__hint">至少 8 个字符；改完其他设备需要重新登录。</p>
      <form id="passwordForm" novalidate>
        <p class="ok" id="ok" role="status" aria-live="polite"></p>
        <p class="error" id="error" role="alert" aria-live="polite"></p>
        <div class="field">
          <label class="field__label" for="current">当前密码</label>
          <input class="input" id="current" name="current" type="password" autocomplete="current-password" required>
        </div>
        <div class="field">
          <label class="field__label" for="next">新密码</label>
          <input class="input" id="next" name="next" type="password" autocomplete="new-password" required>
        </div>
        <div class="field" style="display:flex;gap:8px;margin:18px 0 0">
          <button class="btn" id="submit" type="submit">修改密码</button>
          <button class="btn btn--ghost" id="logout" type="button">退出登录</button>
        </div>
      </form>
    </section>

    ${sourceLink}
  </div>
</div>

<script>
(() => {
  const form = document.getElementById('passwordForm');
  const ok = document.getElementById('ok');
  const error = document.getElementById('error');
  const submit = document.getElementById('submit');

  function clear() {
    ok.className = 'ok';
    error.className = 'error';
    ok.textContent = '';
    error.textContent = '';
  }
  function say(text, kind) {
    clear();
    const box = kind === 'ok' ? ok : error;
    box.textContent = text;
    box.className = (kind === 'ok' ? 'ok ok--on' : 'error error--on');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear();
    submit.disabled = true;
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          current: document.getElementById('current').value,
          next: document.getElementById('next').value
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) {
        say((payload && payload.error && payload.error.message) || '修改失败，请重试。', 'bad');
        return;
      }
      form.reset();
      say('密码已修改。', 'ok');
    } catch (err) {
      say('无法连接到服务器，请检查网络后重试。', 'bad');
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById('logout').addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (err) { /* 继续跳转 */ }
    location.replace('/login');
  });
})();
</script>
</body>
</html>
`
}
