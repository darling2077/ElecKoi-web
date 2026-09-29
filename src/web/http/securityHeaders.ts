/**
 * 安全响应头。
 *
 * 三类文档各有自己的策略：
 *   app   —— 上游渲染产物，脚本全部来自本源的打包文件，因此 script-src 可以收到 'self'；
 *            配置随桥脚本下发而非内联 script，就是为了不必开 'unsafe-inline'。
 *   login —— 我们自己的登录页，带内联样式与脚本，单独放宽。
 *   card  —— 见 cardFrame.ts（allow-scripts 式放开，但把网络出口收紧）。
 */

export type DocumentKind = 'app' | 'login'

/** 应用文档 CSP。frame-src 需放行卡片源；未配置卡片源时退回同源（srcdoc 帧）。 */
export function appCsp(cardOrigin: string, nonce = ''): string {
  const frameSources = cardOrigin === '' ? "'self'" : `'self' ${cardOrigin}`
  // v0.2.0 的界面由 DSH 宿主注入**内联脚本**（引导门面、__DSH_BOOT__ 等配置），
  // 桌面端由 Electron 原生注入不受 CSP 约束，Web 端必须放行。用 nonce 而不是
  // 'unsafe-inline'：只有我们自己在文档里写的那些 <script> 才带得上这个随机值。
  // ⚠️ 'unsafe-eval' 是 v0.2.0 的硬性要求：DSH 客户端的模块系统用 eval/new Function
  // 装配插件包（插件产物是 classic script，不是 ESM），少了它整块界面起不来
  // （实测报 "Evaluating a string as JavaScript violates ... 'unsafe-eval' is not allowed"）。
  // 脚本来源仍然限制在 'self' + 本次响应的 nonce，所以没有引入第三方脚本源；
  // 代价是 XSS 的影响面变大——这是为了跑上游新架构而接受的取舍，记录在
  // docs/webui/上游升级流程.md 里。
  const scriptSources = nonce === '' ? "'self' 'unsafe-eval'" : `'self' 'nonce-${nonce}' 'unsafe-eval'`
  return [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    // React 组件会写 style 属性（如 iframe 高度），因此必须放行内联样式。
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    // 桥用 fetch 打 /api/rpc、用 EventSource 订阅 /api/events，两者都受 connect-src 约束。
    "connect-src 'self'",
    `frame-src ${frameSources}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

/**
 * 登录/账号/用户管理页：自带内联样式与脚本，只与本源通信。
 * style-src/font-src 放行 'self' 是为了能引用从构建产物提取的主题令牌与
 * 应用同款网络字体（/__eleckoi/app-tokens.css 与 /assets/noto-sans-*）。
 */
export const LOGIN_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ')

export function securityHeaders(kind: DocumentKind, cardOrigin: string, nonce = ''): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': kind === 'app' ? appCsp(cardOrigin, nonce) : LOGIN_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
    'cross-origin-opener-policy': 'same-origin'
  }
  // 排障开关：定位「加了 CSP 之后某个功能失效」时用来做对照实验。
  // 仅去掉 CSP，其余安全头保留。生产环境不应设置。
  if (process.env.ELECKOI_DISABLE_CSP === '1') delete headers['content-security-policy']
  return headers
}
