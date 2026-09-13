/**
 * 用户管理页（仅管理员）。
 *
 * 这里是运维界面，不是产品界面：信息密度优先于表现力，操作都要能一眼看清后果。
 * 危险动作（停用、取消管理员）都做成显式按钮，并禁止管理员把自己锁在门外
 * （服务端也会拒绝，不只靠前端隐藏）。
 *
 * 视觉与应用同源：令牌与字体来自 /__eleckoi/app-tokens.css，主题跟随管理员账号。
 */

import { APP_TOKENS_PATH } from './appTokens'
import { pageCss } from './pageStyles'
import type { PageTheme } from './pageTheme'
import { themeBootstrap } from './pageTheme'

export interface AdminUsersPageOptions {
  actorEmail: string
  registrationOpen: boolean
  /** 当前管理员在应用里选择的外观；system 表示跟随系统。 */
  theme: PageTheme
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char
  ))
}

export function renderAdminUsersPage(options: AdminUsersPageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>用户管理 · 电子爱</title>
<link rel="stylesheet" href="${APP_TOKENS_PATH}">
<style>
${pageCss()}
.table { min-width: 720px; }
/* 操作列不许折行：四个按钮挤成两排会让整张表看起来没对齐 */
.table th:last-child, .table td:last-child { white-space: nowrap; }
.table .actions { flex-wrap: nowrap; }
/* 用量每项各占一行，且永不从词中间断开（表格变窄时会被压到按字折行） */
.usage { line-height: 1.45; }
.usage span { display: block; white-space: nowrap; }
.usage span + span { color: var(--soft-text); }
.scroll { overflow-x: auto; }
.create { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; align-items: end; }
.check { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); padding-bottom: 9px; }
.check input { accent-color: var(--blue); width: 15px; height: 15px; margin: 0; }
/* 停用是可逆的（旁边就有"启用"），所以用描边红而不是实心红 */
.danger { color: #d93025; border-color: color-mix(in srgb, #d93025 40%, transparent); }
.danger:hover { background: color-mix(in srgb, #d93025 10%, transparent); border-color: color-mix(in srgb, #d93025 55%, transparent); }
</style>
<script>${themeBootstrap(options.theme)}</script>
</head>
<body>
<div class="shell shell--top shell--wide">
  <div class="shell__inner">
    <div class="topbar">
      <div class="brand" style="margin:0">
        <span class="brand__dot"></span>
        <span class="brand__name">用户管理</span>
      </div>
      <nav class="topbar__links">
        ${options.registrationOpen ? '<span class="tag tag--off">自助注册开启中</span>' : ''}
        <a href="/account">账号管理</a>
        <a href="/">返回应用</a>
      </nav>
    </div>
    <section class="card">
      <h2 class="card__title">新建用户</h2>
      <p class="card__hint">由你设置初始密码，交给对方后请提醒其自行修改。</p>
      <form class="create" id="createForm">
        <div>
          <label class="field__label" for="c-email">邮箱</label>
          <input class="input" id="c-email" type="email" autocomplete="off" required>
        </div>
        <div>
          <label class="field__label" for="c-username">用户名（可留空）</label>
          <input class="input" id="c-username" type="text" autocomplete="off" placeholder="3-32 位字母数字_-">
        </div>
        <div>
          <label class="field__label" for="c-password">初始密码</label>
          <input class="input" id="c-password" type="password" autocomplete="new-password" required>
        </div>
        <div class="check">
          <input id="c-admin" type="checkbox">
          <label for="c-admin" style="margin:0">设为管理员</label>
        </div>
        <div>
          <button class="btn btn--block" id="createSubmit" type="submit">创建用户</button>
        </div>
      </form>
      <p class="ok" id="createOk" role="status" aria-live="polite"></p>
      <p class="error" id="createError" role="alert" aria-live="polite"></p>
    </section>

    <section class="card">
      <h2 class="card__title">账号列表</h2>
      <p class="card__hint">当前管理员：${escapeHtml(options.actorEmail)}。停用会立刻注销该账号的所有登录，但数据保留。</p>
      <div class="scroll">
        <table class="table">
          <thead>
            <tr><th>邮箱</th><th>用户名</th><th>状态</th><th>用量</th><th>创建时间</th><th>操作</th></tr>
          </thead>
          <tbody id="rows"><tr><td colspan="6" style="color:var(--muted)">加载中…</td></tr></tbody>
        </table>
      </div>
      <p class="ok" id="ok" role="status" aria-live="polite"></p>
      <p class="error" id="error" role="alert" aria-live="polite"></p>
    </section>
  </div>
</div>

<script>
(() => {
  const rows = document.getElementById('rows');
  const okBox = document.getElementById('ok');
  const errBox = document.getElementById('error');
  const createOk = document.getElementById('createOk');
  const createErr = document.getElementById('createError');

  // 一次只留一条消息：提示过期不清会变成噪声，也容易看错是哪次操作的结果。
  const boxes = [okBox, errBox, createOk, createErr];
  function say(box, text, kind) {
    const ok = kind === 'ok';
    for (const peer of boxes) {
      peer.textContent = '';
      peer.className = ok ? 'ok' : 'error';
    }
    if (text === '') return;
    box.textContent = text;
    box.className = ok ? 'ok ok--on' : 'error error--on';
  }

  async function api(path, init) {
    const response = await fetch(path, {
      ...(init || {}),
      headers: { 'content-type': 'application/json', ...((init && init.headers) || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) {
      throw new Error((payload && payload.error && payload.error.message) || '操作失败');
    }
    return payload.data;
  }

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  };
  const formatDate = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };

  function cell(row, text, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    if (text instanceof Node) td.append(text);
    else td.textContent = text;
    return td;
  }

  function tag(text, kind) {
    const span = document.createElement('span');
    span.className = 'tag' + (kind ? ' ' + kind : '');
    span.textContent = text;
    return span;
  }

  function action(label, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = 'btn btn--ghost btn--sm' + (className ? ' ' + className : '');
    button.addEventListener('click', handler);
    return button;
  }

  /** 行内编辑：避免用 prompt，密码输入也不该明文弹出。 */
  function inlineEdit(host, placeholder, type, onConfirm) {
    const wrap = document.createElement('div');
    wrap.className = 'inline-form';
    wrap.style.marginTop = '6px';
    const input = document.createElement('input');
    input.className = 'input';
    input.type = type;
    input.placeholder = placeholder;
    const ok = action('确定', '', async () => {
      if (input.value === '') return;
      ok.disabled = true;
      try { await onConfirm(input.value); wrap.remove(); }
      catch (error) { say(errBox, error.message, 'bad'); ok.disabled = false; }
    });
    const cancel = action('取消', '', () => wrap.remove());
    wrap.append(input, ok, cancel);
    host.append(wrap);
    input.focus();
  }

  function render(users, actorEmail) {
    rows.textContent = '';
    if (users.length === 0) {
      const tr = document.createElement('tr');
      tr.append(cell(tr, '还没有用户', 'muted'));
      rows.append(tr);
      return;
    }
    for (const user of users) {
      const tr = document.createElement('tr');
      const self = user.email === actorEmail;

      tr.append(cell(tr, user.email + (self ? '（你）' : '')));

      const usernameCell = cell(tr, user.username || '未设置', user.username ? '' : 'muted');
      tr.append(usernameCell);

      const status = document.createElement('td');
      status.style.whiteSpace = 'nowrap';
      status.append(user.disabled ? tag('已停用', 'tag--off') : tag('正常'));
      if (user.isAdmin) { status.append(' '); status.append(tag('管理员', 'tag--accent')); }
      tr.append(status);

      const usageCell = document.createElement('td');
      const usage = document.createElement('div');
      usage.className = 'usage';
      // 每项各占一行：挤在一行里必然折在半个词上
      const lines = user.usage
        ? [formatBytes(user.usage.mediaBytes), user.usage.characterCount + ' 角色', user.usage.conversationCount + ' 会话']
        : ['—'];
      for (const text of lines) {
        const span = document.createElement('span');
        span.textContent = text;
        usage.append(span);
      }
      usageCell.append(usage);
      tr.append(usageCell);

      const dateCell = cell(tr, formatDate(user.createdAt), 'muted');
      dateCell.style.whiteSpace = 'nowrap';
      tr.append(dateCell);

      const ops = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'actions';

      actions.append(action('改密码', '', () => {
        inlineEdit(ops, '新密码（至少 8 位）', 'password', async (value) => {
          await api('/api/admin/users/password', { method: 'POST', body: JSON.stringify({ userId: user.id, password: value }) });
          say(okBox, '已重置 ' + user.email + ' 的密码。', 'ok');
        });
      }));
      actions.append(action('改用户名', '', () => {
        inlineEdit(ops, '新用户名（留空即清除）', 'text', async (value) => {
          await api('/api/admin/users/update', { method: 'POST', body: JSON.stringify({ userId: user.id, username: value }) });
          say(okBox, '已更新用户名。', 'ok');
          await load();
        });
      }));
      actions.append(action(user.isAdmin ? '取消管理员' : '设为管理员', '', async () => {
        try {
          await api('/api/admin/users/update', { method: 'POST', body: JSON.stringify({ userId: user.id, isAdmin: !user.isAdmin }) });
          say(okBox, '已更新权限。', 'ok');
          await load();
        } catch (error) { say(errBox, error.message, 'bad'); }
      }));
      actions.append(action(user.disabled ? '启用' : '停用', user.disabled ? '' : 'danger', async () => {
        try {
          await api('/api/admin/users/update', { method: 'POST', body: JSON.stringify({ userId: user.id, disabled: !user.disabled }) });
          say(okBox, (user.disabled ? '已启用 ' : '已停用 ') + user.email, 'ok');
          await load();
        } catch (error) { say(errBox, error.message, 'bad'); }
      }));

      ops.append(actions);
      tr.append(ops);
      rows.append(tr);

      if (self) {
        // 服务端也会拒绝，这里只是不给入口。
        for (const button of actions.querySelectorAll('button')) {
          if (button.textContent === '停用' || button.textContent === '取消管理员') button.disabled = true;
        }
      }
    }
  }

  let actorEmail = ${JSON.stringify(options.actorEmail)};
  async function load() {
    try {
      const data = await api('/api/admin/users');
      render(data.users, actorEmail);
    } catch (error) {
      rows.textContent = '';
      const tr = document.createElement('tr');
      tr.append(cell(tr, error.message, 'muted'));
      rows.append(tr);
    }
  }

  document.getElementById('createForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = document.getElementById('createSubmit');
    submit.disabled = true;
    say(createOk, '', 'ok');
    try {
      const created = await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('c-email').value,
          username: document.getElementById('c-username').value,
          password: document.getElementById('c-password').value,
          isAdmin: document.getElementById('c-admin').checked
        })
      });
      say(createOk, '已创建 ' + created.email + (created.username ? '（用户名 ' + created.username + '）' : ''), 'ok');
      event.target.reset();
      await load();
    } catch (error) {
      say(createErr, error.message, 'bad');
    } finally {
      submit.disabled = false;
    }
  });

  load();
})();
</script>
</body>
</html>
`
}
