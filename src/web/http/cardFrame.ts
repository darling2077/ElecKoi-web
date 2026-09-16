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
 * 额外允许卡片加载图片/媒体的源（`ELECKOI_CARD_IMAGE_ORIGINS`）。
 *
 * 为什么需要：角色卡经常把立绘放在外部图床上（`<img src="https://i.postimg.cc/...">`
 * 这类写法很常见）。默认 CSP 的 `img-src 'self' data: blob:` 会把它们全部拦掉，
 * 卡片就会显示成一片黑。把**自己的**图床加进来，卡片就能正常显示。
 *
 * 放宽到自己的域和放宽到第三方图床是两件性质不同的事：
 * 卡片只能通过图片 URL 发起 GET，数据最多落在**你自己服务器的访问日志**里，
 * 攻击者读不到；而第三方图床的图片是公开可访问的，等于直接泄给第三方。
 * 因此这里只应当填你自己的域，不要填公共图床。
 */
/**
 * 校验 `ELECKOI_CARD_IMAGE_ORIGINS`：必须是 `scheme://host[:port]` 形式的纯源。
 *
 * 严格拒绝带路径、查询、通配符的写法——这个值会直接进 CSP，
 * 写错会静默放宽成比预期更大的范围（例如写了路径，浏览器会忽略整条 host-source，
 * 反而把该条从策略里丢掉）。宁可直接报错。
 */
export function resolveCardImageOrigins(explicit?: readonly string[]): string[] {
  const raw = explicit ?? []
  return raw.map((item) => item.trim()).filter((item) => item !== '').map((item) => {
    let url: URL
    try {
      url = new URL(item)
    } catch {
      throw new Error(`ELECKOI_CARD_IMAGE_ORIGINS 里的 "${item}" 不是合法 URL，应形如 https://img.example.com:8443`)
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`ELECKOI_CARD_IMAGE_ORIGINS 只支持 http/https，"${item}" 不是。`)
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new Error(`ELECKOI_CARD_IMAGE_ORIGINS 只接受源（scheme://host:port），不要带路径或查询："${item}"`)
    }
    if (url.hostname.includes('*')) {
      throw new Error(`ELECKOI_CARD_IMAGE_ORIGINS 不接受通配符："${item}"`)
    }
    return url.origin
  })
}

function mediaSourceList(extraOrigins: readonly string[]): string {
  return ["'self'", 'data:', 'blob:', ...extraOrigins].join(' ')
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
 *
 * imageOrigins 只放宽 img-src / media-src；connect-src 仍是 'none'，
 * 所以卡片依旧发不出 fetch/XHR/WebSocket，只是能"显示"外部图片而已。
 */
export function cardFrameCsp(
  allowedOrigins: readonly string[] = [],
  imageOrigins: readonly string[] = []
): string {
  const mediaSources = mediaSourceList(imageOrigins)
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    `img-src ${mediaSources}`,
    `media-src ${mediaSources}`,
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
