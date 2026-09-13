/**
 * Web 端「外壳」：把桌面端的窗口控制按钮换掉，放上账号相关操作。
 *
 * 为什么用注入而不是改上游 `TitleBar.jsx`：
 * 桌面端的最小化/最大化/关闭在浏览器里毫无意义，但那是**上游的 UI 代码**。
 * 为了一处外观偏好去改它，等于让每次上游动标题栏都要重新修补丁——
 * 收益很小，升级摩擦却是长期的。
 *
 * 注入做法的代价是：我们的样式挂在 `.client-titlebar .window-controls` 这个类名上。
 * 上游若改类名，旧按钮会重新出现（外观问题，不会崩、不会构建失败）。
 * 因此脚本会做一次**钩子自检**并把结果写进 `documentElement.dataset`，
 * 自动化验收会盯着它——真被改了会立刻报警，而不是等用户发现。
 */

export const WEB_CHROME_CSS_PATH = '/__eleckoi/web-chrome.css'
export const WEB_CHROME_JS_PATH = '/__eleckoi/web-chrome.js'

/** 标题栏高度，与上游 titlebar.css 的 .client-titlebar 保持一致。 */
const TITLEBAR_HEIGHT = 40

export function buildWebChromeCss(): string {
  return `/* ElecKoi WebUI：隐藏桌面端窗口控制按钮（浏览器里没有窗口可控制） */
.client-titlebar .window-controls { display: none !important; }

/* 账号区：占据右上角原本属于窗口按钮的位置 */
.eleckoi-web-account {
  position: fixed;
  top: 0;
  right: 0;
  height: ${TITLEBAR_HEIGHT}px;
  display: flex;
  align-items: center;
  padding-right: 10px;
  z-index: 2147483000;
  font-size: 13px;
  line-height: 1;
  color: var(--title-fg, inherit);
  -webkit-app-region: no-drag;
}

.eleckoi-web-account__trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  font: inherit;
}
.eleckoi-web-account__trigger:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
.eleckoi-web-account__trigger:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 45%, transparent); outline-offset: 1px; }
.eleckoi-web-account__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eleckoi-web-account__caret { opacity: 0.65; font-size: 10px; }

/* 菜单面板沿用应用自己的弹层规格（10px 圆角 / --surface-raised / --line-strong） */
.eleckoi-web-account__menu {
  position: absolute;
  top: ${TITLEBAR_HEIGHT - 4}px;
  right: 10px;
  min-width: 180px;
  margin: 0;
  padding: 5px;
  list-style: none;
  border-radius: 10px;
  background: var(--surface-raised, #ffffff);
  color: var(--text, currentColor);
  border: 1px solid var(--line-strong, rgba(0, 0, 0, 0.08));
  box-shadow: 0 10px 28px var(--shadow-color, rgba(0, 0, 0, 0.16));
}
.eleckoi-web-account__menu[hidden] { display: none; }
.eleckoi-web-account__menu button {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.eleckoi-web-account__menu button:hover { background: var(--control-bg-hover, rgba(0, 0, 0, 0.06)); }
.eleckoi-web-account__email {
  padding: 6px 10px 8px;
  font-size: 12px;
  color: var(--muted, currentColor);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-bottom: 1px solid var(--line, rgba(0, 0, 0, 0.06));
  margin-bottom: 4px;
}
`
}

export function buildWebChromeScript(): string {
  return `(() => {
  const root = document.documentElement;
  const HOOK_TIMEOUT_MS = 5000;

  // 标题栏由 React 渲染，而本脚本在 <head> 里就执行了——此刻 DOM 里还没有它。
  // 因此不能"查一次就下结论"，要等到它出现再判定；等不到才记为 unhooked。
  function findHook() {
    return document.querySelector('.client-titlebar .window-controls');
  }

  function renderAccount(email) {
    const container = document.createElement('div');
    container.className = 'eleckoi-web-account';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'eleckoi-web-account__trigger';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.title = email;

    const name = document.createElement('span');
    name.className = 'eleckoi-web-account__name';
    name.textContent = email;
    const caret = document.createElement('span');
    caret.className = 'eleckoi-web-account__caret';
    caret.textContent = '\\u25be';
    trigger.append(name, caret);

    const menu = document.createElement('div');
    menu.className = 'eleckoi-web-account__menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    const emailLine = document.createElement('div');
    emailLine.className = 'eleckoi-web-account__email';
    emailLine.textContent = email;

    const account = document.createElement('button');
    account.type = 'button';
    account.setAttribute('role', 'menuitem');
    account.textContent = '账号管理';
    account.addEventListener('click', () => { location.href = '/account'; });

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.setAttribute('role', 'menuitem');
    logout.textContent = '退出登录';
    logout.addEventListener('click', async () => {
      logout.disabled = true;
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (error) { /* 继续跳转 */ }
      location.replace('/login');
    });

    menu.append(emailLine, account, logout);
    container.append(trigger, menu);

    const close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const next = menu.hidden;
      menu.hidden = !next;
      trigger.setAttribute('aria-expanded', String(next));
    });
    document.addEventListener('click', close);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });

    document.body.append(container);
  }

  async function currentEmail() {
    try {
      const response = await fetch('/api/auth/me', { headers: { accept: 'application/json' } });
      if (!response.ok) return null;
      const payload = await response.json();
      const email = payload && payload.data && payload.data.email;
      return typeof email === 'string' && email !== '' ? email : null;
    } catch (error) {
      return null;
    }
  }

  async function start() {
    const email = await currentEmail();
    if (findHook()) return attach(email);

    // 等标题栏出现；用 MutationObserver 而不是轮询，出现即挂钩。
    const observer = new MutationObserver(() => {
      if (findHook()) { observer.disconnect(); attach(email); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      // 超时仍未出现：记录 unhooked。样式仍在，只是说明上游钩子变了。
      if (!findHook()) root.dataset.eleckoiWebChrome = 'unhooked';
    }, HOOK_TIMEOUT_MS);
  }

  function attach(email) {
    root.dataset.eleckoiWebChrome = 'hooked';
    if (email !== null && document.querySelector('.eleckoi-web-account') === null) renderAccount(email);
  }

  start();
})();
`
}
