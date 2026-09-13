/**
 * 卡片帧页面（部署在独立的卡片源上）。
 *
 * 为什么要有它：上游用 `srcDoc` 渲染角色卡的 HTML，而 srcdoc **继承父文档源**，
 * 于是卡片里的 JS 可以直接 `parent.eleckoi.request(...)` 调通全部 IPC——
 * 在多用户公网服务里，这等于把整个后端交给任意一张卡片。
 *
 * 做法：把卡片放到独立源（如 cards.example.com），父文档只把 HTML 通过
 * postMessage 交给本页面，由本页面 `document.write` 写入。写入后文档仍属于
 * 卡片源，因此卡片能正常工作（自有 localStorage/DOM），但 `parent` 是**跨源**的：
 * 读 `parent.eleckoi` 会直接抛安全错误。卡片只能走既有的 postMessage 协议，
 * 也就是只有 author SDK 那 7 项受控权限。
 *
 * 本页面只接受来自应用源的卡片文档，且只写入一次。
 */

export interface CardFrameOptions {
  /** 允许投递卡片文档的应用源（精确匹配 origin）。 */
  allowedOrigins: readonly string[]
  /** 卡片源自身的 CSP。 */
  csp: string
}

/**
 * 卡片帧的 CSP。
 *
 * 取舍：卡片本来就允许带内联脚本与样式（这是它的功能），所以 script/style 必须放开
 * inline；但把网络出口收紧——`connect-src 'none'` 挡住 fetch/XHR 外传数据，
 * `frame-src 'none'` 挡住嵌套 frame。图片/音视频只允许同源与 data:/blob:，
 * 而卡片用到的媒体（含签名 URL）都由卡片源自身提供，因此 'self' 足够。
 *
 * frame-ancestors 收到应用源白名单：卡片帧本来就只该被应用嵌入，别的站点嵌它
 * 只会得到一个空帧（文档靠 postMessage 投递且校验来源），但没必要留着这个口子。
 * 未配置应用源时不加该指令，与既有行为一致。
 */
export function cardFrameCsp(allowedOrigins: readonly string[] = []): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    ...(allowedOrigins.length === 0 ? [] : [`frame-ancestors ${allowedOrigins.join(' ')}`])
  ].join('; ')
}

export const CARD_FRAME_PATH = '/__eleckoi/card-frame.html'

export function renderCardFrame(options: CardFrameOptions): string {
  const origins = JSON.stringify([...options.allowedOrigins])
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>角色卡内容</title>
<style>html,body{margin:0;padding:0;background:transparent;color-scheme:light dark}</style>
</head>
<body>
<script>
(() => {
  'use strict';
  const allowed = new Set(${origins});
  let written = false;

  const receive = (event) => {
    if (!allowed.has(event.origin)) return;
    const data = event.data;
    if (!data || data.type !== 'eleckoi:card-document' || typeof data.html !== 'string') return;
    if (written) return;
    written = true;
    removeEventListener('message', receive);
    // document.open() 会替换文档内容但保留本源的 URL 与源，
    // 因此卡片代码运行在卡片源内，而不是应用源内。
    document.open();
    document.write(data.html);
    document.close();
  };

  addEventListener('message', receive);
  // 父文档可能早于本页面完成加载，因此由本页面主动索要文档。
  parent.postMessage({ type: 'eleckoi:card-ready' }, '*');
})();
</script>
</body>
</html>
`
}
