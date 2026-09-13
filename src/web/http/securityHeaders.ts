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
export function appCsp(cardOrigin: string): string {
  const frameSources = cardOrigin === '' ? "'self'" : `'self' ${cardOrigin}`
  return [
    "default-src 'self'",
    "script-src 'self'",
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

export function securityHeaders(kind: DocumentKind, cardOrigin: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': kind === 'app' ? appCsp(cardOrigin) : LOGIN_CSP,
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
