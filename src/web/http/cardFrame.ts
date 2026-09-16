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
  /**
   * 图片黑名单（主机名或后缀，如 `postimg.cc`、`i.postimg.cc`）。
   * 命中的图片地址会在写入卡片 HTML 前被替换成透明占位图，动态插入的也会被兜底拦掉。
   * **尽力而为**，不是安全边界——真正的边界是 CSP 白名单/放开策略。
   */
  blockedImageHosts?: readonly string[]
}

/**
 * 卡片图片来源的两种策略。
 *
 * **白名单（精确）**：`ELECKOI_CARD_IMAGE_ORIGINS` 列出的源才允许加载。
 * 安全性最好，但每来一张引用新图床的卡就要加一条——用起来烦。
 *
 * **放开（宽松）+ 可选黑名单**：`ELECKOI_CARD_IMAGE_MODE=third-party` 时
 * img-src/media-src 直接用 `https:` 通配，任意 https 图床都能显示，零配置；
 * 再给一个 `ELECKOI_CARD_IMAGE_BLOCKED_HOSTS` 让你把不想要的域排除掉。
 *
 * ⚠️ 必须说清楚的危险：放宽 img-src 就等于承认**卡片能把你的数据发出去**——
 * 卡片是作者写的 JS，它拼一个 `https://任意域/<聊天内容>.png` 就能外传，
 * 这是图片请求（GET），CSP 拦不住。放开之后，这件事的去向就取决于你导入的卡
 * 是否可信，而不是取决于配置。
 *
 * 黑名单是**尽力而为**，不是安全边界：CSP 只能"允许某些源"，做不到"允许全部、
 * 排除某几个"，所以黑名单由卡片帧在写入卡片 HTML 前过滤、并对常见的动态插入
 * 做兜底。它能挡住普通卡片的静态引用，但**挡不住蓄意绕过的脚本**。
 * 真要隔离，用白名单模式或 self-hosted/local（把图搬到你自己的域）。
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
export interface CardImagePolicy {
  /** 放行任意 https 图床（third-party 模式）。 */
  allowAnyHttps?: boolean
  /** 连 http 图床也放行（更宽松，默认否）。 */
  allowAnyHttp?: boolean
}

export function cardFrameCsp(
  allowedOrigins: readonly string[] = [],
  imageOrigins: readonly string[] = [],
  policy: CardImagePolicy = {}
): string {
  // 通配是"放开"那一档：任意 https 图床都能显示，代价是卡片也能把数据发往任意域。
  const wildcards = [
    ...(policy.allowAnyHttps === true ? ['https:'] : []),
    ...(policy.allowAnyHttp === true ? ['http:'] : [])
  ]
  const mediaSources = [mediaSourceList(imageOrigins), ...wildcards].join(' ')
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
  const blocked = JSON.stringify([...(options.blockedImageHosts ?? [])].map((host) => host.trim().toLowerCase()).filter((host) => host !== ''))
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
  const blockedHosts = ${blocked};
  let written = false;

  // ── 图片黑名单：尽力而为，不是安全边界 ────────────────────────────────
  // CSP 只能"允许哪些源"，做不到"允许全部、排除某几个"，所以黑名单只能在
  // 卡片 HTML 写入前过滤、并对常见的动态插入兜底。它挡得住普通卡片的静态引用，
  // 挡不住蓄意绕过的脚本——真要隔离请用白名单模式或把图搬到自己域。
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const hostBlocked = (hostname) => {
    const host = String(hostname || '').toLowerCase();
    return blockedHosts.some((blocked) => host === blocked || host.endsWith('.' + blocked));
  };
  // 注意：这里是**注入到页面的脚本**，外层是模板字符串——正则里的反斜杠必须写两份，
  // 否则会被模板吃掉（曾因此让整段脚本语法错误、卡片帧直接不工作）。
  const isHttpUrl = (text) => {
    const head = text.slice(0, 8).toLowerCase();
    return head.startsWith('http://') || head.startsWith('https://');
  };
  const urlBlocked = (raw) => {
    const text = String(raw || '').trim();
    if (!isHttpUrl(text)) return false;
    try { return hostBlocked(new URL(text).hostname); } catch (error) { return false; }
  };
  /** 把一段属性值里被屏蔽的地址换成透明占位图（srcset 逐项处理）。 */
  const scrubValue = (value) => value
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      const url = trimmed.split(/\\s+/)[0];
      return urlBlocked(url) ? trimmed.replace(url, BLANK) : part;
    })
    .join(',');
  /** 写入前过滤：属性里的 src/srcset/poster/data-src，以及 style 与 <style> 里的 url()。 */
  const scrubHtml = (html) => {
    if (blockedHosts.length === 0) return html;
    let out = html.replace(
      /(\\s(?:src|srcset|poster|data-src|data-original)\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s>]+)/gi,
      (match, prefix, rawValue) => {
        const quote = rawValue[0] === '"' || rawValue[0] === "'" ? rawValue[0] : '';
        const inner = quote ? rawValue.slice(1, -1) : rawValue;
        return prefix + quote + scrubValue(inner) + quote;
      }
    );
    out = out.replace(/url\\(\\s*("[^"]*"|'[^']*'|[^)]*)\\s*\\)/gi, (match, rawValue) => {
      const quote = rawValue[0] === '"' || rawValue[0] === "'" ? rawValue[0] : '';
      const inner = quote ? rawValue.slice(1, -1) : rawValue;
      const url = inner.trim();
      return urlBlocked(url) ? 'url(' + quote + BLANK + quote + ')' : match;
    });
    return out;
  };
  /** 运行期兜底：卡片脚本动态插进来的图片也拦一道。 */
  const guardNode = (node) => {
    if (blockedHosts.length === 0 || !node || node.nodeType !== 1) return;
    for (const attr of ['src', 'poster', 'data-src']) {
      const value = node.getAttribute && node.getAttribute(attr);
      if (value && urlBlocked(value)) node.setAttribute(attr, BLANK);
    }
    const srcset = node.getAttribute && node.getAttribute('srcset');
    if (srcset) node.setAttribute('srcset', scrubValue(srcset));
    const style = node.getAttribute && node.getAttribute('style');
    if (style && /url\\(/i.test(style)) node.setAttribute('style', scrubHtml(style));
  };
  if (blockedHosts.length > 0) {
    const nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      const key = String(name).toLowerCase();
      if ((key === 'src' || key === 'poster' || key === 'data-src') && urlBlocked(value)) value = BLANK;
      else if (key === 'srcset') value = scrubValue(String(value));
      else if (key === 'style') value = scrubHtml(String(value));
      return nativeSetAttribute.call(this, name, value);
    };
    const imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (imgSrc && imgSrc.set) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        ...imgSrc,
        set(value) { imgSrc.set.call(this, urlBlocked(value) ? BLANK : value); }
      });
    }
    const mediaSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (mediaSrc && mediaSrc.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        ...mediaSrc,
        set(value) { mediaSrc.set.call(this, urlBlocked(value) ? '' : value); }
      });
    }
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          guardNode(node);
          if (node.querySelectorAll) for (const child of node.querySelectorAll('img,video,audio,source')) guardNode(child);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

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
    document.write(scrubHtml(data.html));
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
