/**
 * 站点图标（浏览器标签页 / 添加到主屏幕）。
 *
 * 上游 `src/renderer/index.html` 里**没有任何 `<link rel="icon">`**，
 * 所以浏览器标签页一直显示默认图标。
 *
 * 为什么是内联 data URL，而不是放一个静态文件：
 *   - 静态文件得落在 `src/renderer/public/` 才会被 Vite 拷进 `out/renderer`，
 *     而那是上游目录——往里加文件会破坏「上游可一条线 rebase」的门禁
 *     （见 scripts/check-upstream-diff.mjs 的白名单）；
 *     走 Dockerfile 另拷一份又要多一处需要跟着改的地方。
 *   - 内联只是让 HTML 头部多几 KB，一次性成本；
 *     应用文档与自有页面的 CSP 都已经放行 `img-src data:`
 *     （securityHeaders.ts），不需要再放宽任何策略。
 *
 * 图是用户提供的 64×64 PNG 像素画，原样下发，由浏览器按需缩放。
 *
 * ⚠️ base64 必须写成**数组 join**，不能写成相邻的多个字符串字面量：
 *    JS 会在换行处自动插入分号，那样只有第一段会被赋值，后面全成死表达式，
 *    而且类型检查不会报错——webui:appearance 的 A-11 就是为抓这个加的。
 */
const FAVICON_BASE64 = [
  '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',
].join('')

const FAVICON_DATA_URL = `data:image/png;base64,${FAVICON_BASE64}`

/** 供各页面 `<head>` 直接拼接的图标标签。 */
export function faviconLinks(): string {
  return `<link rel="icon" type="image/png" sizes="64x64" href="${FAVICON_DATA_URL}">`
    + `<link rel="apple-touch-icon" href="${FAVICON_DATA_URL}">`
}
