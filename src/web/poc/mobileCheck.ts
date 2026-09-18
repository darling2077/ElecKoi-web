/**
 * 移动端布局验收：在真实浏览器里按手机视口测量，并验证抽屉交互。
 *
 * 为什么不用 `chromium --window-size=390,844`：无头 Chromium 对窗口宽度有
 * **500px 下限**，传 390 会被静默钳到 500——于是"测了手机布局"是假的，
 * 结论全部无效（这个坑真实踩过：前两轮截图与断言其实都是 500px 布局）。
 *
 * 因此改用 CDP 的 Emulation.setDeviceMetricsOverride 精确设定视口，
 * 用 Node 原生 WebSocket 通信，不引入任何新依赖。
 *
 * 运行：pnpm webui:mobile
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startWebUiStack } from '../stack'
import { startMockModelServer } from './mockModelServer'

/** 夹具立绘：8×8 深青渐变 PNG。用它当角色头像后，
 *  1) 消息头像会真的渲染（否则 .avatar 是空占位，量不到宽度）；
 *  2) 上游默认 chatBackground='character' 会把立绘当聊天壁纸，
 *     壁纸层 .chat-shell-backdrop 才会出现——手机端那条左侧长条就在这层。 */
const FIXTURE_ART = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAuElEQVR4nA3JQUpDQQwA0J6kB5gDzAHmAHOALFyIBBEpEqQEKRKKlFCKBCklFClBigQR+YgLFx7Oeds3mwOXK6kLbWx97bALPCTFNJtfcLmWStpW1jcOFnhMOo+45HIrdalNrG8d9oGnpByBXO6kPmh7sv7s4IFvSZ8jbrjcS33UptZfHF4D35OmEQsuLHWtbWf94BCBH0k/I4jLSupGm1k/OpwDv5J+Ryy5iNSttr31k0MGfif9Tf8FZlnBNMBlhwAAAABJRU5ErkJggg=='

const PROBE_PAGE = '__mobileprobe.html'
const PROBE_DRIVER = '__mobileprobe-driver.js'
const PROBE_SCRIPT = '__mobileprobe.js'
const PROBE_TARGET = '__mobileprobe-target.html'

const outcomes: Array<{ id: string; ok: boolean; detail: string }> = []

function record(id: string, ok: boolean, detail: string): void {
  outcomes.push({ id, ok, detail })
  console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${id}\n        ${detail}`)
}

function probePage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>mobile-probe</title></head>
<body><pre id="out">pending</pre><script src="/${PROBE_DRIVER}"></script></body></html>
`
}

function probeDriver(): string {
  return `(() => {
  const params = new URLSearchParams(location.search);
  const out = document.getElementById('out');
  const carry = new URLSearchParams();
  for (const [key, value] of params) {
    if (key !== 'email' && key !== 'password' && key !== 'target') carry.set(key, value);
  }
  const suffix = carry.toString() === '' ? '' : '?' + carry.toString();
  (async () => {
    const login = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: params.get('email') || '', password: params.get('password') || '' })
    });
    if (!login.ok) { out.textContent = 'LOGIN-FAILED ' + login.status; return; }
    location.replace((params.get('target') || '/') + suffix);
  })().catch((error) => { out.textContent = 'ERROR ' + String(error); });
})();
`
}

function injectProbe(html: string): string {
  return html.replace('</body>', `<script src="/${PROBE_SCRIPT}"></script></body>`)
}

/** 探针挂在 documentElement 上：应用是 SPA，body 会被 React 重写。 */
function probeScript(): string {
  return `(() => {
  const params = new URLSearchParams(location.search);
  const write = (payload) => {
    let host = document.getElementById('mobileprobe');
    if (!host) {
      host = document.createElement('pre');
      host.id = 'mobileprobe';
      host.style.display = 'none';
      document.documentElement.append(host);
    }
    host.textContent = 'REPORT:' + JSON.stringify(payload);
  };
  const measure = () => {
    const shell = document.querySelector('.qq-shell');
    const chat = document.querySelector('.main-panel-shell');
    const panel = document.querySelector('.side-panel-shell');
    const bubble = document.querySelector('.message-content, .bubble');
    return {
      bubbleWidth: bubble ? Math.round(bubble.getBoundingClientRect().width) : 0,
      // 拆解开销：正文列之外的宽度都花在哪了
      diag: (() => {
        const row = document.querySelector('.message-roleplay');
        const av = document.querySelector('.message-roleplay > .avatar');
        const panel = document.querySelector('.chat-panel');
        if (!row) return null;
        const cs = getComputedStyle(row);
        const bubbleEl = row.querySelector('.bubble');
        const bcs = bubbleEl ? getComputedStyle(bubbleEl) : null;
        return {
          rowWidth: Math.round(row.getBoundingClientRect().width),
          columns: cs.gridTemplateColumns,
          rowPadding: cs.paddingLeft + '/' + cs.paddingRight,
          avatarWidth: av ? Math.round(av.getBoundingClientRect().width) : 0,
          panelPadding: panel ? getComputedStyle(panel).paddingLeft + '/' + getComputedStyle(panel).paddingRight : '',
          bubblePad: bcs ? bcs.paddingLeft + '/' + bcs.paddingRight : '',
          contentWidth: bubble ? Math.round(bubble.getBoundingClientRect().width) : 0,
          avatarVar: getComputedStyle(row).getPropertyValue('--chat-avatar-width'),
          railVar: getComputedStyle(row).getPropertyValue('--chat-roleplay-side-rail'),
          chain: (() => {
            const out = [];
            let el = row;
            const stop = document.querySelector('.main-panel-shell');
            for (let i = 0; el && i < 12; i += 1) {
              const c = getComputedStyle(el);
              const cls = String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
              out.push(el.tagName.toLowerCase() + '.' + cls
                + ' w=' + Math.round(el.getBoundingClientRect().width)
                + ' pad=' + c.paddingLeft + '/' + c.paddingRight
                + ' mar=' + c.marginLeft + '/' + c.marginRight
                + ' max=' + c.maxWidth
                + ' ovf=' + c.overflowX);
              if (el === stop) break;
              el = el.parentElement;
            }
            return out;
          })()
        };
      })(),
      // 诊断：会话打开后 DOM 里到底有什么
      messageCount: document.querySelectorAll('.message').length,
      bubbleCount: document.querySelectorAll('.bubble, .message-content').length,
      emptyHint: (document.querySelector('.chat-empty-guide, .message-area')?.textContent || '').slice(0, 40),
      // 生成统计条：每项都必须完整显示（上游窄屏会把每项截成 "1…""LL…"）
      stats: (() => {
        const line = document.querySelector('.generation-stats-line');
        if (!line) return null;
        const items = [...line.querySelectorAll('.generation-stats-item')];
        return {
          count: items.length,
          height: Math.round(line.getBoundingClientRect().height),
          clipped: items.filter((el) => el.scrollWidth > el.clientWidth + 1).length,
          // 有壁纸时必须改用壁纸前景色，否则 --muted 的灰字糊在背景里
          color: getComputedStyle(line).color,
          wallpaper: (document.querySelector('.qq-shell')?.classList.contains('has-chat-wallpaper')) === true,
          wallpaperFg: getComputedStyle(document.querySelector('.qq-shell') || line)
            .getPropertyValue('--chat-wallpaper-content-fg').trim(),
          text: items.map((el) => el.textContent.trim()).join(' | ').slice(0, 120)
        };
      })(),
      // 壁纸层：窄屏必须从 0 起，否则左边露出通高白条
      backdrop: (() => {
        const b = document.querySelector('.chat-shell-backdrop');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { left: Math.round(r.left), width: Math.round(r.width) };
      })(),
      // 手机上抽屉展开时，账号区不能盖住抽屉自己的收起按钮
      chromeOverlap: (() => {
        const account = document.querySelector('.eleckoi-web-account');
        const collapse = document.querySelector('.side-panel-shell .side-panel-collapse-button');
        if (!account || !collapse) return { checked: false };
        const a = account.getBoundingClientRect();
        const c = collapse.getBoundingClientRect();
        const hidden = a.width === 0 || a.height === 0;
        const overlap = !hidden && a.right > c.left && a.left < c.right && a.bottom > c.top && a.top < c.bottom;
        return { checked: true, accountHidden: hidden, overlap };
      })(),
      viewport: window.innerWidth,
      chatWidth: chat ? Math.round(chat.getBoundingClientRect().width) : 0,
      panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      columns: shell ? getComputedStyle(shell).gridTemplateColumns.split(' ').length : 0,
      collapsed: shell ? shell.classList.contains('side-panel-collapsed') : false
    };
  };
  const tick = () => {
    if (!document.querySelector('.qq-shell')) { setTimeout(tick, 250); return; }
    const before = measure();
    if (params.get('tap') === '1') {
      const item = document.querySelector('.conversation-item');
      if (!item) { setTimeout(tick, 250); return; }
      item.click();
      // 不要固定等 800ms：会话渲染快慢会波动，等待不足会让 M-text / M-wallpaper /
      // M-stats 一起误报"没打开会话"（真的遇到过，重跑又全绿）。
      // 改成轮询到消息出现为止，超时再如实上报。
      let waited = 0;
      const pollChat = () => {
        waited += 250;
        const after = measure();
        // 两个条件都要满足：消息出现（会话确实打开了）**且**统计条渲染出来
        // （整轮生成结束）。只看消息会在生成中途就退出，统计条还没挂上。
        if ((after.messageCount > 0 && after.stats != null) || waited >= 15000) {
          write({ ...before, tapped: true, waitedMs: waited, collapsedAfterTap: after.collapsed, chatWidthAfterTap: after.chatWidth, bubbleWidthAfterTap: after.bubbleWidth, diagAfterTap: after.diag, messageCountAfterTap: after.messageCount, backdropAfterTap: after.backdrop, statsAfterTap: after.stats });
          return;
        }
        setTimeout(pollChat, 250);
      };
      setTimeout(pollChat, 250);
      return;
    }
    if (params.get('font') === '1') {
      const trigger = document.querySelector('.rail-settings-trigger');
      if (!trigger) { setTimeout(tick, 250); return; }
      trigger.click();
      setTimeout(() => {
        const page = document.querySelector('.chat-display-settings-page');
        const preview = document.querySelector('.chat-display-preview');
        const content = document.querySelector('.chat-display-preview .message-content');
        const column = document.querySelector('.chat-display-preview-column');
        const controls = document.querySelector('.chat-display-controls');
        const rect = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0);
        const shell = document.querySelector('.qq-shell');
        const pr = preview ? preview.getBoundingClientRect() : null;
        const sidebar = document.querySelector('.app-settings-sidebar');
        write({
          ...before,
          fontOpened: page !== null,
          // 手机上抽屉必须自动收起：它和设置内容是浮层叠放关系，
          // 展开时会把内容整块盖住（"字体页太窄"的真实成因）
          drawerCollapsed: shell ? shell.classList.contains('side-panel-collapsed') : null,
          sidebarVisible: sidebar ? sidebar.getBoundingClientRect().right > 0 : null,
          previewLeft: pr ? Math.round(pr.left) : -1,
          previewRight: pr ? Math.round(pr.right) : -1,
          previewWidth: rect(preview),
          previewContentWidth: rect(content),
          previewColumnWidth: rect(column),
          controlsWidth: rect(controls),
          overflowX: page ? page.scrollWidth - page.clientWidth : -1,
          fontDiag: (() => {
            const row = document.querySelector('.chat-display-preview .message-roleplay, .chat-display-preview .message-social');
            const prev = document.querySelector('.chat-display-preview');
            if (!row) return { row: null };
            const cs = getComputedStyle(row);
            const av = row.querySelector('.avatar');
            const out = [];
            let el = row;
            for (let i = 0; el && i < 8; i += 1) {
              const c = getComputedStyle(el);
              const cls = String(el.className || '').replace(/[^a-zA-Z0-9_-]+/g, '.').slice(0, 40);
              out.push(el.tagName.toLowerCase() + '.' + cls
                + ' w=' + Math.round(el.getBoundingClientRect().width)
                + ' pad=' + c.paddingLeft + '/' + c.paddingRight
                + ' bd=' + c.borderLeftWidth + '/' + c.borderRightWidth);
              if (el === prev) break;
              el = el.parentElement;
            }
            return {
              rowClass: String(row.className),
              columns: cs.gridTemplateColumns,
              rowOriginAvatar: cs.getPropertyValue('--chat-avatar-width'),
              inlineAvatar: prev ? prev.style.getPropertyValue('--chat-avatar-width') : '',
              avatarWidth: av ? Math.round(av.getBoundingClientRect().width) : 0,
              chain: out
            };
          })()
        });
      }, 1200);
      return;
    }
    if (params.get('outside') === '1') {
      const shell = document.querySelector('.qq-shell');
      if (!shell) { setTimeout(tick, 250); return; }
      const startOpen = !shell.classList.contains('side-panel-collapsed');
      setTimeout(() => {
        const drawer = document.querySelector('.side-panel-shell');
        const dr = drawer ? drawer.getBoundingClientRect() : { right: 0 };
        // 取抽屉右缘再往右 24px、垂直居中：这正是"露在外面的空白区"
        const x = Math.round(Math.min(window.innerWidth - 12, dr.right + 24));
        const y = Math.round(window.innerHeight / 2);
        const hit = document.elementFromPoint(x, y);
        const blank = hit instanceof Element && !hit.closest('.side-panel-shell');
        if (blank) {
          hit.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, view: window, clientX: x, clientY: y
          }));
        }
        setTimeout(() => {
          const after = document.querySelector('.qq-shell');
          write({
            ...before,
            outsideStartOpen: startOpen,
            outsidePoint: x + ',' + y,
            outsideHitBlank: blank,
            outsideClosed: after ? after.classList.contains('side-panel-collapsed') : null
          });
        }, 600);
      }, 700);
      return;
    }
    if (params.get('model') === '1') {
      const item = document.querySelector('.conversation-item');
      if (!item) { setTimeout(tick, 250); return; }
      item.click();
      let tries = 0;
      const openPicker = () => {
        tries += 1;
        const trigger = document.querySelector('.chat-model-trigger');
        if (!trigger) {
          if (tries < 12) { setTimeout(openPicker, 250); return; }
          write({ ...before, modelOpened: false });
          return;
        }
        trigger.click();
        setTimeout(() => {
          const panel = document.querySelector('.chat-model-panel');
          const configs = document.querySelector('.chat-model-configs');
          const pane = document.querySelector('.chat-model-list-pane');
          const name = document.querySelector('.chat-model-list > button .chat-model-name');
          const box = (el) => (el ? el.getBoundingClientRect() : null);
          const pr = box(panel);
          write({
            ...before,
            modelOpened: panel !== null,
            panelLeft: pr ? Math.round(pr.left) : -1,
            panelRight: pr ? Math.round(pr.right) : -1,
            panelWidth: pr ? Math.round(pr.width) : 0,
            panelHeight: pr ? Math.round(pr.height) : 0,
            // 纵向边界：弹窗整体必须装进视口（这才是"没被挤压"的真正判据）
            panelTop: pr ? Math.round(pr.top) : -1,
            panelBottom: pr ? Math.round(pr.bottom) : -1,
            viewportHeight: window.innerHeight,
            configsWidth: configs ? Math.round(box(configs).width) : 0,
            listPaneWidth: pane ? Math.round(box(pane).width) : 0,
            listNameClipped: name ? name.scrollWidth > name.clientWidth + 1 : null,
            // 配置条里每一项都必须完整可见（不能靠横滑才能看到）
            configsScrolls: (() => {
              const box = document.querySelector('.chat-model-configs');
              if (!box) return null;
              return box.scrollHeight - box.clientHeight;
            })(),
            configsDiag: (() => {
              const box = document.querySelector('.chat-model-configs');
              if (!box) return null;
              const out = [];
              for (const group of box.children) {
                const h3 = group.querySelector('h3');
                const g = group.getBoundingClientRect();
                out.push('组[' + (h3 ? h3.textContent.trim() : '?') + '] y=' + Math.round(g.top)
                  + ' h=' + Math.round(g.height)
                  + ' 项=' + [...group.querySelectorAll('button')].map((b) => {
                    const r = b.getBoundingClientRect();
                    return b.textContent.trim().slice(0, 14) + '@' + Math.round(r.left) + '-' + Math.round(r.right);
                  }).join(','));
              }
              return out;
            })(),
            configsClipped: (() => {
              const box = document.querySelector('.chat-model-configs');
              if (!box) return null;
              const br = box.getBoundingClientRect();
              const items = [...box.querySelectorAll('.chat-model-provider-group > button')];
              if (items.length < 2) return null;
              return items.some((el) => {
                const r = el.getBoundingClientRect();
                return r.right > br.right + 1 || r.width === 0;
              });
            })(),
            docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
          });
        }, 900);
      };
      openPicker();
      return;
    }
    setTimeout(() => write(before), 400);
  };
  setTimeout(tick, 900);
})();
`
}

/** 极简 CDP 客户端：只用 Emulation 与 Page 两个域，靠 Node 原生 WebSocket。 */
class CdpSession {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static async connect(wsUrl: string): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((done, fail) => {
      ws.addEventListener('open', () => done(), { once: true })
      ws.addEventListener('error', () => fail(new Error('CDP 连接失败')), { once: true })
    })
    return new CdpSession(ws)
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.ws.close()
  }
}

async function waitForEndpoint(port: number, timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      const payload = await response.json() as { webSocketDebuggerUrl?: string }
      if (payload.webSocketDebuggerUrl) return payload.webSocketDebuggerUrl
    } catch {
      // 还没起来
    }
    await new Promise((done) => setTimeout(done, 300))
  }
  throw new Error('Chromium 调试端口未就绪')
}

interface Capture {
  report?: Record<string, unknown>
  screenshot?: string
}

/** 用 CDP 在指定视口下打开页面，取回探针报告（可选截图）。 */
async function captureAt(
  url: string,
  viewport: { width: number; height: number },
  options: { screenshot?: string } = {}
): Promise<Capture> {
  const port = 9300 + Math.floor(Math.random() * 500)
  const profile = mkdtempSync(join(tmpdir(), 'eleckoi-mobile-'))
  const child = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-sync', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'
  ], { stdio: 'ignore' })

  const cleanup = (): void => {
    if (!child.killed) child.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
  }

  try {
    const browserWs = await waitForEndpoint(port)
    const browser = await CdpSession.connect(browserWs)
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()) as Array<{ id: string; webSocketDebuggerUrl: string }>
    const pageInfo = list.find((item) => item.id === targetId)
    if (pageInfo === undefined) throw new Error('找不到新建的页面目标')
    const page = await CdpSession.connect(pageInfo.webSocketDebuggerUrl)

    await page.send('Page.enable')
    // 关键一步：精确设置视口，绕开无头模式 500px 下限
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 2,
      mobile: true
    })
    await page.send('Page.navigate', { url })

    // 等探针写出报告
    const deadline = Date.now() + 30000
    let report: Record<string, unknown> | undefined
    while (Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 500))
      const evaluated = await page.send('Runtime.evaluate', {
        expression: "document.getElementById('mobileprobe')?.textContent || ''",
        returnByValue: true
      }) as { result?: { value?: string } }
      const text = evaluated.result?.value ?? ''
      if (text.startsWith('REPORT:')) {
        report = JSON.parse(text.slice('REPORT:'.length)) as Record<string, unknown>
        break
      }
    }

    let screenshot: string | undefined
    if (options.screenshot !== undefined) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' }) as { data?: string }
      if (shot.data !== undefined) {
        writeFileSync(options.screenshot, Buffer.from(shot.data, 'base64'))
        screenshot = options.screenshot
      }
    }

    page.close()
    browser.close()
    return { ...(report === undefined ? {} : { report }), ...(screenshot === undefined ? {} : { screenshot }) }
  } finally {
    cleanup()
  }
}

async function main(): Promise<void> {
  process.env.ELECKOI_DISABLE_EVENT_STREAM = '1'
  const root = await mkdtemp(join(tmpdir(), 'eleckoi-web-mobile-'))
  const rendererDir = resolve('out/renderer')
  mkdirSync(rendererDir, { recursive: true })
  writeFileSync(join(rendererDir, PROBE_PAGE), probePage())
  writeFileSync(join(rendererDir, PROBE_DRIVER), probeDriver())
  writeFileSync(join(rendererDir, PROBE_SCRIPT), probeScript())

  const shotDir = process.env.ELECKOI_SHOT_DIR ?? '/tmp/mobile-shots'
  mkdirSync(shotDir, { recursive: true })

  const stack = await startWebUiStack({
    dataRoot: root,
    rendererDir,
    masterKeyBase64: randomBytes(32).toString('base64'),
    appVersion: '0.1.0-web-mobile',
    port: 0,
    allowRegistration: true,
    publicPaths: [`/${PROBE_PAGE}`, `/${PROBE_DRIVER}`, `/${PROBE_SCRIPT}`, `/${PROBE_TARGET}`]
  })
  const base = stack.server.url
  const email = 'mobile@example.com'
  const password = 'mobile-check-password'
  console.log(`\n== 移动端布局验收 ==\n服务：${base}\n截图：${shotDir}\n`)

  const longReply = '夜里的风从半开的窗缝钻进来，带着雨后潮湿的凉意。夏心语坐在宿舍床沿，指尖轻轻压着覆眼的白色丝带；'
    + '贴在她肩上的深灰衣料随呼吸传来熟悉的温度——她知道，你还在。'
    + '“小白……”她朝你的意识所在处偏过头，声音很轻，却带着终于能放松下来的笑意，'
    + '“今天的冥想结束得比平时早一点。外面雨好像停了。”'
  const mock = await startMockModelServer({ replyPrefix: longReply, wrapInFinalTag: false, chunkDelayMs: 5 })

  const jar: Record<string, string> = {}
  try {
    const register = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, username: 'mobile', password })
    })
    for (const entry of register.headers.getSetCookie?.() ?? []) {
      const pair = entry.split(';')[0] ?? ''
      if (pair.startsWith('eleckoi_session=')) jar.cookie = pair
    }
    if (register.status !== 200) throw new Error(`注册失败：${register.status}`)

    const call = async (name: string, input: unknown): Promise<unknown> => {
      const response = await fetch(`${base}/api/rpc`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...jar },
        body: JSON.stringify({ name, input })
      })
      return ((await response.json()) as { data?: unknown }).data
    }
    // 角色创建契约里没有 firstMessage（zod 会静默丢弃），所以开场白这条路走不通。
    // 改用 mock 模型跑一个真实回合——这正是 webui:render 里验证过可行的方式。
    const configs = await call('command.models.save', {
      name: 'MOBILE-MOCK',
      provider: 'custom',
      api_key: 'mock-key',
      base_url: mock.url,
      proxy_url: '',
      model: 'mock-model',
      model_options: [],
      custom_headers: {},
      supports_tools: null,
      enabled: true,
      image_settings: {},
      api_format: 'chat_completions'
    }) as Array<{ id: string; name: string }>
    const configId = configs.find((c) => c.name === 'MOBILE-MOCK')?.id
    // 再建一条**不同提供商**下的配置。模型弹窗左栏是按提供商分组的，
    // 只有一个分组时"配置项是否被挤出屏幕"这条断言等于空过。
    await call('command.models.save', {
      name: 'MOBILE-SECOND',
      provider: 'deepseek',
      api_key: 'mock-key-2',
      base_url: mock.url,
      proxy_url: '',
      model: 'mock-model-2',
      model_options: [],
      custom_headers: {},
      supports_tools: null,
      enabled: true,
      image_settings: {},
      api_format: 'chat_completions'
    })
    await call('command.settings.write', {
      key: 'models.active',
      value: { capability: 'chat', config_id: configId, model: 'mock-model' }
    })
    await call('command.characters.create', {
      id: 'char-mobile', name: '移动端测试', description: '布局验收', personality: '', scenario: '',
      avatar: FIXTURE_ART,
      chatBackground: '', chatBackgroundOpacity: 1, chatBackgroundBlur: 0, chatBackgroundScrim: 0.5
    })
    const details = await call('command.conversations.create', {
      title: '移动端测试会话',
      metadata: {
        characterId: 'char-mobile', characterName: '移动端测试',
        characterAvatar: FIXTURE_ART, characterPersona: {}
      }
    }) as { conversation?: { id?: string } }
    const conversationId = details?.conversation?.id
    if (!conversationId) throw new Error('会话创建失败')

    // 跑一个回合产生助手消息（正文要够长，宽度才量得准）
    await call('command.agent.start', { conversationId, requestId: `mobile-${Date.now()}`, text: '请写一段较长的场景描写' })
    const deadline = Date.now() + 120_000
    let ready = false
    while (Date.now() < deadline && !ready) {
      await new Promise((done) => setTimeout(done, 500))
      const page = await call('query.conversations.messages', { conversationId, limit: 50 }) as {
        messages?: Array<{ role: string; status: string }>
      }
      const assistant = [...(page.messages ?? [])].reverse().find((m) => m.role === 'assistant')
      if (assistant !== undefined && assistant.status !== 'streaming') ready = true
    }
    if (!ready) throw new Error('mock 回合未在时限内结束')

    // 诊断：确认夹具真的产生了可渲染内容
    const detail = await call('query.conversations.details', { conversationId }) as {
      conversation?: { id?: string }
      metadata?: { openingOptions?: unknown[] }
      messages?: unknown[]
    }
    const msgs = await call('query.conversations.messages', { conversationId, limit: 50 }) as { messages?: unknown[] }
    console.log(`        [夹具] 会话 ${conversationId}：详情键 ${Object.keys(detail ?? {}).join(',')}`
      + `、消息 ${msgs?.messages?.length ?? '?'} 条`)

    const page = await fetch(`${base}/`, { headers: jar, redirect: 'manual' })
    if (page.status !== 200) throw new Error(`抓取应用页失败：${page.status}`)
    writeFileSync(join(rendererDir, PROBE_TARGET), injectProbe(await page.text()))

    const url = (extra = ''): string =>
      `${base}/${PROBE_PAGE}?target=${encodeURIComponent(`/${PROBE_TARGET}`)}`
      + `&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}${extra}`

    // 手机竖屏 / 小屏安卓 / 手机横屏 / 桌面
    const viewports = [
      { key: 'phone', width: 390, height: 844, label: '手机竖屏 iPhone 14' },
      { key: 'phone-small', width: 360, height: 780, label: '小屏安卓' },
      { key: 'landscape', width: 844, height: 390, label: '手机横屏' },
      { key: 'desktop', width: 1280, height: 800, label: '桌面（须保持三栏）' }
    ]

    for (const v of viewports) {
      const { report } = await captureAt(url(), v, { screenshot: join(shotDir, `app-${v.key}.png`) })
      if (report === undefined) {
        record(`M-${v.key}`, false, `${v.label}：未取到测量结果`)
        continue
      }
      const measured = Number(report.viewport ?? 0)
      const chatWidth = Number(report.chatWidth ?? 0)
      const columns = Number(report.columns ?? 0)
      // 视口必须就是我们要求的宽度——否则说明又被环境钳制了
      const viewportOk = Math.abs(measured - v.width) <= 2
      // 判定标准按形态区分：
      //  - 桌面（宽且高）：维持三栏
      //  - 竖屏手机（窄）：必须单栏，聊天区近乎占满
      //  - 横屏手机（宽但矮）：三栏也可接受（用户横过来就是想要更宽），
      //    只要聊天区仍有可用宽度。硬套单栏反而浪费横向空间。
      const isPortraitPhone = v.width < 720 && v.height > v.width
      const layoutOk = isPortraitPhone
        ? columns === 1 && chatWidth >= measured - 60
        : columns === 3 && chatWidth >= 500
      // 账号区不得盖住抽屉的收起按钮（浮层遮挡类问题，尺寸断言抓不到）
      const overlapInfo = report.chromeOverlap as
        { checked?: boolean; overlap?: boolean; accountHidden?: boolean } | undefined
      const chromeOk = !isPortraitPhone || overlapInfo?.checked !== true || overlapInfo.overlap !== true
      record(`M-${v.key}`, viewportOk && layoutOk && chromeOk,
        `${v.label}：视口 ${measured}px（目标 ${v.width}px${viewportOk ? '' : ' ⚠️被钳制'}）、`
        + `聊天区 ${chatWidth}px、侧栏 ${String(report.panelWidth)}px、列数 ${columns}`
        + (chromeOk ? '' : ` ｜ ⚠️ 账号区盖住了抽屉的收起按钮：${JSON.stringify(overlapInfo)}`))
    }

    // ── M-tap：窄屏点会话后，抽屉应自动收起 ──
    const tapped = await captureAt(url('&tap=1'), { width: 390, height: 844 })
    const tapReport = tapped.report
    const tapOk = tapReport?.tapped === true
      && tapReport.collapsedAfterTap === true
      && Number(tapReport.chatWidthAfterTap ?? 0) >= 380
    // ── M-text：窄屏下正文本该占满可用宽度，不能被头像栏/内边距挤成细条 ──
    const bubbleWidth = Number(tapReport?.bubbleWidthAfterTap ?? tapReport?.bubbleWidth ?? 0)
    const chatWidthAfterTap = Number(tapReport?.chatWidthAfterTap ?? 0)
    // 期望：正文至少占聊天区的 78%（留出头像与内边距的合理开销）
    const textOk = chatWidthAfterTap > 0 && bubbleWidth >= chatWidthAfterTap * 0.78
    record('M-text', textOk,
      `窄屏正文宽度 ${bubbleWidth}px / 聊天区 ${chatWidthAfterTap}px`
      + ` ｜ 消息数 ${String(tapReport?.messageCountAfterTap ?? tapReport?.messageCount)}、气泡数 ${String(tapReport?.bubbleCount)}、`
      + `\n        拆解：${JSON.stringify(tapReport?.diagAfterTap ?? tapReport?.diag ?? {})}`
      + `（占 ${chatWidthAfterTap > 0 ? Math.round((bubbleWidth / chatWidthAfterTap) * 100) : 0}%，期望 ≥78%）`)

    record('M-tap', tapOk,
      tapReport === undefined
        ? '未取到点击后的状态'
        : `点会话后：收起=${String(tapReport.collapsedAfterTap)}、聊天区 ${String(tapReport.chatWidthAfterTap)}px`
          + `、等待 ${String(tapReport.waitedMs)}ms`)

    // ── M-font：「字体页」（外观设置）在手机上的实时预览宽度 ──
    const font = await captureAt(url('&font=1'), { width: 390, height: 844 },
      { screenshot: join(shotDir, 'font-phone.png') })
    const fontReport = font.report
    const previewContent = Number(fontReport?.previewContentWidth ?? 0)
    const previewWidth = Number(fontReport?.previewWidth ?? 0)
    const noOverflow = Number(fontReport?.overflowX ?? 1) <= 1
    // 光量宽度不够——抽屉是浮层，内容是"宽度正常但被盖住"，
    // 所以还要断言抽屉已自动收起、且预览框完整落在视口内。
    const viewport = Number(fontReport?.viewport ?? 0)
    const previewLeft = Number(fontReport?.previewLeft ?? -1)
    const previewRight = Number(fontReport?.previewRight ?? -1)
    const notCovered = fontReport?.drawerCollapsed === true
      && previewLeft >= 0 && previewRight <= viewport + 1
    const fontOk = fontReport?.fontOpened === true && previewContent >= 200 && noOverflow && notCovered
    record('M-font', fontOk,
      `字体页：预览 ${previewWidth}px（${previewLeft}→${previewRight}，视口 ${viewport}px）`
      + `、预览正文 ${previewContent}px`
      + `、预览列 ${String(fontReport?.previewColumnWidth)}px、控件列 ${String(fontReport?.controlsWidth)}px`
      + `、横向溢出 ${String(fontReport?.overflowX)}px、进页自动收起=${String(fontReport?.drawerCollapsed)}`
      + `（期望：正文 ≥200px、不被抽屉遮挡、不横向溢出）`
      + `\n        预览内部：${JSON.stringify(fontReport?.fontDiag ?? {})}`)

    // ── M-wallpaper：窄屏壁纸层必须从 0 起（否则左边一条通高白条） ──
    const backdrop = (tapReport?.backdropAfterTap ?? tapReport?.backdrop) as { left?: number; width?: number } | null | undefined
    const backdropOk = backdrop != null && Number(backdrop.left) === 0
      && Number(backdrop.width) >= Number(tapReport?.chatWidthAfterTap ?? 0) - 1
    record('M-wallpaper', backdropOk,
      backdrop == null
        ? '未取到壁纸层（夹具立绘没生效？）'
        : `壁纸层 left=${String(backdrop.left)}px、宽 ${String(backdrop.width)}px`
          + `（聊天区 ${String(tapReport?.chatWidthAfterTap)}px，期望 left=0 且铺满）`)

    // ── M-stats：底部生成统计条不能被截成省略号 ──
    const stats = tapReport?.statsAfterTap as
      { count?: number; clipped?: number; text?: string; height?: number
        color?: string; wallpaper?: boolean; wallpaperFg?: string } | null | undefined
    // 颜色维度：开了壁纸就必须用上游那套壁纸前景色（RGB 比对，浏览器会归一化写法）
    // 注意：自定义属性读出来是原始 token（#15171a），computed color 是 rgb(...)，
    // 必须先归一化。这里不用正则——整段页面脚本是 TS 模板字符串，
    // 反斜杠转义会被吃掉（之前已经栽过一次）。
    const colorNorm = (value: unknown): string => {
      const raw = String(value).trim().toLowerCase()
      if (raw.charAt(0) === '#') {
        let hex = raw.slice(1)
        if (hex.length === 3) {
          hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1)
            + hex.charAt(2) + hex.charAt(2)
        }
        const n = Number.parseInt(hex.slice(0, 6), 16)
        return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255)
      }
      return raw.replace('rgba(', '').replace('rgb(', '').replace(')', '')
        .split(',').slice(0, 3).map((part) => part.trim()).join(',')
    }
    const colorOk = stats?.wallpaper !== true
      || (stats.color !== undefined && colorNorm(stats.color) === colorNorm(stats.wallpaperFg))
    const statsOk = stats != null && Number(stats.count) >= 3 && Number(stats.clipped) === 0 && colorOk
    record('M-stats', statsOk,
      stats == null
        ? '未取到生成统计条'
        : `统计条 ${String(stats.count)} 项、高 ${String(stats.height)}px、被截断 ${String(stats.clipped)} 项`
          + `、壁纸前景色=${colorOk ? '已套用' : '未套用(' + colorNorm(stats.color) + ' vs ' + colorNorm(stats.wallpaperFg) + ')'}`
          + `（期望全部完整显示且不被壁纸吞掉）\n        ${String(stats.text)}`)

    // ── M-outside：点抽屉外的空白处应当收起侧栏 ──
    const outside = await captureAt(url('&outside=1'), { width: 390, height: 844 },
      { screenshot: join(shotDir, 'drawer-outside.png') })
    const outReport = outside.report
    const outsideOk = outReport?.outsideStartOpen === true
      && outReport?.outsideHitBlank === true
      && outReport?.outsideClosed === true
    record('M-outside', outsideOk,
      `侧栏展开时点空白处（${String(outReport?.outsidePoint)}，命中非抽屉元素=${String(outReport?.outsideHitBlank)}）`
      + `→ 收起=${String(outReport?.outsideClosed)}`)

    // ── M-model：模型选择弹窗在窄屏不该挤压 ──
    const model = await captureAt(url('&model=1'), { width: 390, height: 844 },
      { screenshot: join(shotDir, 'model-phone.png') })
    const modelReport = model.report
    const panelWidth = Number(modelReport?.panelWidth ?? 0)
    const listPaneWidth = Number(modelReport?.listPaneWidth ?? 0)
    const panelInside = Number(modelReport?.panelLeft ?? -1) >= 0
      && Number(modelReport?.panelRight ?? 1e9) <= Number(modelReport?.viewport ?? 0) + 1
    // 模型列表列至少占弹窗的 60%（改前 141/361 = 39%）
    // 判据是"窄屏下弹窗没有被挤压/超出视口"，而不是"配置条绝不能滚动"：
    // 上游 v0.1.5 增加了「自定义模型提供商」分组后内容变高，配置条自身可滚动属于正常交互，
    // 真正要守的是弹窗整体仍在视口内、模型列表仍有足够宽度、名字不被截断。
    const panelFitsVertically = Number(modelReport?.panelTop ?? -1) >= 0
      && Number(modelReport?.panelBottom ?? 1e9) <= Number(modelReport?.viewportHeight ?? 0) + 1
    const modelOk = modelReport?.modelOpened === true && panelInside && panelFitsVertically
      && listPaneWidth >= panelWidth * 0.6
      && modelReport?.configsClipped !== true
      && Number(modelReport?.docOverflowX ?? 1) <= 1
    record('M-model', modelOk,
      `模型弹窗：宽 ${panelWidth}px（${String(modelReport?.panelLeft)}→${String(modelReport?.panelRight)}，视口 ${String(modelReport?.viewport)}px）、`
      + `配置条 ${String(modelReport?.configsWidth)}px、模型列表 ${listPaneWidth}px`
      + `（占 ${panelWidth > 0 ? Math.round((listPaneWidth / panelWidth) * 100) : 0}%，期望 ≥60%）、`
      + `名字被截断=${String(modelReport?.listNameClipped)}、`
      + `配置项被截=${String(modelReport?.configsClipped)}、配置条可滚动 ${String(modelReport?.configsScrolls)}px、`
      + `弹窗纵向 ${String(modelReport?.panelTop)}→${String(modelReport?.panelBottom)}（视口高 ${String(modelReport?.viewportHeight)}）、`
      + `横向溢出 ${String(modelReport?.docOverflowX)}px`
      + `\n        配置条：${JSON.stringify(modelReport?.configsDiag ?? [])}`)

    // 点开会话后的"游玩视图"截图：这才是用户实际长时间面对的画面
    await captureAt(url('&tap=1'), { width: 390, height: 844 }, { screenshot: join(shotDir, 'chat-open.png') })
    await captureAt(url('&account=1'), { width: 390, height: 844 }, { screenshot: join(shotDir, 'account-phone.png') })
    console.log(`\n截图：${shotDir}`)
  } finally {
    await mock.close()
    for (const p of [PROBE_PAGE, PROBE_DRIVER, PROBE_SCRIPT, PROBE_TARGET]) rmSync(join(rendererDir, p), { force: true })
    await stack.close()
    await rm(root, { recursive: true, force: true })
  }

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log(`\n== 结果：${outcomes.length - failed.length}/${outcomes.length} 通过 ==\n`)
  if (failed.length > 0) {
    console.log('未通过：' + failed.map((outcome) => outcome.id).join('、'))
    process.exitCode = 1
  }
}

await main()
