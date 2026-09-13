/**
 * 登录/注册页。
 *
 * 约束与取舍：
 *  - 上游渲染层 UI **零改动**，所以鉴权入口必须由我们自己的页面承担，
 *    它不参与应用 UI，只是进入应用的「门」。
 *  - 不引入任何外部资源（无 CDN、无图片）：容器环境未必能出网，
 *    且登录页不该有第三方依赖。
 *  - 视觉**不另立一套**：样式表由 /__eleckoi/app-tokens.css 提供，
 *    内容是从上游构建产物里提取的主题令牌与 Noto Sans 字体，
 *    因此本页与应用本体同色、同字、同圆角，并跟随上游改版自动更新；
 *    明暗主题也随应用设置（登录时未知账号，故先跟随系统）。
 */

import type { AuthError } from '../control/AuthService'
import { APP_TOKENS_PATH } from './appTokens'
import { pageCss } from './pageStyles'
import { loginThemeBootstrap } from './pageTheme'

export interface LoginPageOptions {
  /** 是否开放注册；关闭时只显示登录表单与提示。 */
  allowRegistration: boolean
  /** 首次启动尚无任何用户时，默认落在注册态。 */
  defaultMode: 'login' | 'register'
  /**
   * 本服务的对应源码地址。AGPL-3.0 §13 要求以网络提供服务时向使用者提供源码，
   * 因此部署者必须配置它；未配置时不渲染该入口。
   */
  sourceUrl?: string
}

/** 只接受 http(s) 链接，避免把配置项变成注入点。 */
function sourceLink(sourceUrl: string | undefined): string {
  if (sourceUrl === undefined || sourceUrl === '') return ''
  let parsed: URL
  try {
    parsed = new URL(sourceUrl)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
  const href = parsed.toString().replace(/"/g, '%22')
  return `<p class="foot">本服务基于 ElecKoi 构建，<a href="${href}" rel="noopener noreferrer">查看对应源代码</a>。</p>`
}

export function renderLoginPage(options: LoginPageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>登录 · 电子爱</title>
<link rel="stylesheet" href="${APP_TOKENS_PATH}">
<style>
${pageCss()}
</style>
<script>
  // 在首次绘制前定好主题，避免闪一下再变。
  // 登录前不知道是谁，沿用上次登录时的主题，没有则按应用默认（亮色）。
${loginThemeBootstrap()}
</script>
</head>
<body>
<div class="shell">
  <div class="shell__inner">
    <div class="brand">
      <span class="brand__dot"></span>
      <span class="brand__name">电子爱</span>
      <span class="brand__en">ELECKOI</span>
    </div>

    <main class="card">
      <h1 class="card__title" id="title">登录</h1>
      <p class="card__hint" id="intro">角色卡、设定库与对话都保存在这台服务器上，模型密钥由你的账号自行提供。</p>

      <p class="error" id="error" role="alert" aria-live="polite"></p>

      <form id="form" novalidate>
        <div class="field">
          <label class="field__label" for="identifier" id="identifierLabel">邮箱或用户名</label>
          <input class="input" id="identifier" name="identifier" type="text" autocomplete="username" required>
        </div>
        <div class="field" id="usernameField" hidden>
          <label class="field__label" for="username">用户名（可留空，之后也能用邮箱登录）</label>
          <input class="input" id="username" name="username" type="text" autocomplete="off" placeholder="3-32 位字母、数字、下划线或连字符">
        </div>
        <div class="field">
          <label class="field__label" for="password">密码</label>
          <input class="input" id="password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <p class="card__hint" id="passwordHint" hidden style="margin:-6px 0 13px">至少 8 个字符。</p>
        <button class="btn btn--block" id="submit" type="submit">登录</button>
      </form>

      <p class="note" id="switch"${options.allowRegistration ? '' : ' hidden'}>
        <span id="switchText">还没有账号？</span> <a href="#" id="toggle">注册一个</a>
      </p>
      ${options.allowRegistration ? '' : '<p class="note">本服务未开放自助注册，请联系服务提供者开通账号。</p>'}
    </main>

    ${sourceLink(options.sourceUrl)}
  </div>
</div>

<script>
(() => {
  const allowRegistration = ${options.allowRegistration ? 'true' : 'false'};
  let mode = ${JSON.stringify(options.defaultMode)};

  const form = document.getElementById('form');
  const title = document.getElementById('title');
  const intro = document.getElementById('intro');
  const identifier = document.getElementById('identifier');
  const identifierLabel = document.getElementById('identifierLabel');
  const usernameField = document.getElementById('usernameField');
  const usernameInput = document.getElementById('username');
  const password = document.getElementById('password');
  const passwordHint = document.getElementById('passwordHint');
  const submit = document.getElementById('submit');
  const errorBox = document.getElementById('error');
  const switchRow = document.getElementById('switch');
  const switchText = document.getElementById('switchText');
  const toggle = document.getElementById('toggle');

  function applyMode() {
    const registering = mode === 'register';
    title.textContent = registering ? '注册' : '登录';
    intro.textContent = registering
      ? '创建后即可开始；所有数据都留在这台服务器的你的账号下。'
      : '角色卡、设定库与对话都保存在这台服务器上，模型密钥由你的账号自行提供。';
    submit.textContent = registering ? '注册并开始' : '登录';
    password.setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
    passwordHint.hidden = !registering;
    usernameField.hidden = !registering;
    // 登录时是「邮箱或用户名」，注册时必须填邮箱
    identifierLabel.textContent = registering ? '邮箱' : '邮箱或用户名';
    identifier.setAttribute('type', registering ? 'email' : 'text');
    identifier.setAttribute('autocomplete', registering ? 'email' : 'username');
    if (allowRegistration) {
      switchRow.hidden = false;
      switchText.textContent = registering ? '已经有账号？' : '还没有账号？';
      toggle.textContent = registering ? '去登录' : '注册一个';
    }
    errorBox.className = 'error';
    errorBox.textContent = '';
  }

  toggle?.addEventListener('click', (event) => {
    event.preventDefault();
    mode = mode === 'register' ? 'login' : 'register';
    applyMode();
    identifier.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const registering = mode === 'register';
    errorBox.className = 'error';
    errorBox.textContent = '';
    submit.disabled = true;
    try {
      const body = registering
        ? { email: identifier.value, username: usernameInput.value, password: password.value }
        : { identifier: identifier.value, password: password.value };
      const response = await fetch('/api/auth/' + mode, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) {
        showError((payload && payload.error && payload.error.message) || '请求失败，请重试。');
        return;
      }
      window.location.replace('/');
    } catch {
      showError('无法连接到服务器，请检查网络后重试。');
    } finally {
      submit.disabled = false;
    }
  });

  function showError(message) {
    errorBox.textContent = message;
    errorBox.className = 'error error--on';
  }

  applyMode();
})();
</script>
</body>
</html>
`
}

/** 认证失败时的统一文案，避免区分「账号不存在」与「密码错误」。 */
export function authErrorMessage(error: unknown): string {
  const code = (error as AuthError | undefined)?.code
  if (code === 'EMAIL_TAKEN') return '该邮箱已被注册。'
  if (code === 'INVALID_INPUT') return error instanceof Error ? error.message : '输入不合法。'
  if (code === 'DISABLED') return '该账号已被停用。'
  return '邮箱或密码不正确。'
}
