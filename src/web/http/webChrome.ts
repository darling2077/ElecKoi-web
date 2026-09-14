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

/** 手机端把左侧图标栏横过来放到底部时的高度。 */
const MOBILE_RAIL_BAR_HEIGHT = 56

export function buildWebChromeCss(): string {
  return `/* ElecKoi WebUI：隐藏桌面端窗口控制按钮（浏览器里没有窗口可控制） */
.client-titlebar .window-controls { display: none !important; }

/* ────────────────────────────────────────────────────────────
 * 移动端竖屏：让聊天区真正占满屏幕
 *
 * 上游三栏布局：.navigation-rail-shell(51px) + .side-panel-shell(328px)
 * + .main-panel-shell(1fr)。宽度由 JS 计算后以内联样式挂在 .qq-shell 上
 * （useSidePanelLayout），且下限写死：SIDE_PANEL_MIN=264、MAIN_PANEL_MIN=640
 * ——即上游假定聊天区至少 640px。390px 的手机上 264+51 就吃掉 81%，
 * 表现就是"聊天页被左侧栏顶出去"。
 *
 * 内联样式优先级高于外部 CSS，因此只能用 !important 覆盖。
 * 上游若改类名或变量名，这段会失效——webui:chrome 的钩子自检会报警。
 * ──────────────────────────────────────────────────────────── */
@media (max-width: 720px) {
  /* 1. 单栏：聊天区独占整宽，另两栏改为浮层 */
  .qq-shell.main-window-shell {
    grid-template-columns: minmax(0, 1fr) !important;
    /* 覆盖 JS 写死的内联宽度，否则它仍会把聊天区顶出去 */
    --side-panel-width: 0px !important;
    --side-panel-content-width: min(84vw, 320px) !important;
  }

  /* 2. 图标栏横过来放到底部。
        原先把它固定在左侧，代价是永久占掉 52px——390px 屏的 13%。
        实测聊天正文因此只剩 205px（占 53%），用户反馈"缩得太窄可读性太差"。
        改到底部后横向零占用，且落在拇指可达区。
        .navigation-rail-title 是上游的 40px 拖拽条，横排下必须隐藏。 */
  .qq-shell.main-window-shell > .navigation-rail-shell {
    position: fixed !important;
    left: 0;
    right: 0;
    bottom: 0;
    top: auto;
    width: auto !important;
    height: ${MOBILE_RAIL_BAR_HEIGHT}px;
    grid-template-rows: minmax(0, 1fr) !important;
    border-top: 1px solid var(--rail-divider);
    z-index: 2147482000;
  }
  .qq-shell.main-window-shell > .navigation-rail-shell > .navigation-rail-title {
    display: none !important;
  }
  .qq-shell.main-window-shell .qq-rail {
    flex-direction: row !important;
    justify-content: space-evenly !important;
    align-items: center !important;
    height: 100% !important;
    padding: 0 6px !important;
    border-right: 0 !important;
  }
  /* 品牌图标靠 top:-35px 挂在拖拽条上，横排后没有落点 */
  .qq-shell.main-window-shell .rail-brand-logo { display: none !important; }
  .qq-shell.main-window-shell .rail-nav-group,
  .qq-shell.main-window-shell .rail-profile-zone,
  .qq-shell.main-window-shell .rail-bottom-zone {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 2px !important;
    width: auto !important;
    margin-top: 0 !important;
  }
  .qq-shell.main-window-shell .rail-bottom-zone { gap: 6px !important; }

  /* 3. 会话列表改为抽屉：默认滑出视野，由图标栏切换 */
  .qq-shell.main-window-shell > .side-panel-shell {
    position: fixed !important;
    left: 0;
    top: 0;
    bottom: ${MOBILE_RAIL_BAR_HEIGHT}px;
    width: var(--side-panel-content-width) !important;
    grid-column: auto !important;
    z-index: 2147481000;
    box-shadow: 0 0 0 100vmax color-mix(in srgb, var(--shadow-color) 30%, transparent);
  }

  /* 4. 聊天区占满整宽，底部让出图标栏。
        注意：上游给 .side-panel-shell 与 .main-panel-shell 都写死了
        grid-column(2 与 3)，网格改成单列后必须一并重置，否则它们会落到隐式列上。 */
  .qq-shell.main-window-shell > .main-panel-shell {
    grid-column: 1 / -1 !important;
    padding: 0 0 ${MOBILE_RAIL_BAR_HEIGHT}px 0;
  }

  /* 5. 抽屉的收起态。
        上游的收起只把 --side-panel-width 设为 0，内容仍按
        --side-panel-content-width 绘制——桌面端够用，手机上会让列表
        继续压在聊天区上。这里用位移彻底移出视野，展开走标题栏那个按钮。 */
  .qq-shell.main-window-shell > .side-panel-shell.collapsed {
    transform: translateX(-101%);
    pointer-events: none;
    box-shadow: none;
  }

  /* 打开抽屉时不再让 body 滚动，避免"抽屉动了页面也动" */
  .qq-shell.main-window-shell > .side-panel-shell:not(.collapsed) {
    transition: transform 0.24s cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* 6. 正文宽度回收。
        桌面端 roleplay 消息两侧各留一条 side-rail（头像 + 间距 + 内边距），
        因为头像可能出现在任一侧。手机上一个 avatar 只有一列，
        其余全是纯浪费。三项按收益排序：
          a) --chat-message-inline-inset 30px：给悬停才出现的操作按钮留的，
             触屏没有悬停，直接归零；
          b) .message-area 的 24px/12px 内边距 + 12px 透明边框（拖拽调宽用），
             手机上不需要，压到 6px；
          c) 头像列封顶 32px（默认 55px，可在"外观设置"里调到 96px）。
             只封顶宽度，圆角仍走用户设置，由浏览器自行夹取。
        默认外观下正文 205px → 约 316px（390px 屏，占 81%）。 */
  .qq-shell.main-window-shell .chat-panel,
  .qq-shell.main-window-shell .chat-display-preview {
    --chat-message-inline-inset: 0px !important;
    --chat-avatar-width: 32px !important;
    --chat-avatar-height: 32px !important;
  }
  .qq-shell.main-window-shell .message-area {
    padding: 10px 6px 14px !important;
    padding-inline-end: 6px !important;
    border-inline-end-width: 0 !important;
  }
  /* roleplay 布局默认用 scrollbar-gutter: stable both-edges 给滚动条两侧各留
     一条槽（各 12px）；上游只在 @container chat-panel 里才改回 auto，
     而"外观设置"的实时预览不在 .chat-panel 容器内，量不到那条规则，
     于是白白吃掉 24px——预览正文因此只剩 198px。窄屏一律不预留。 */
  .qq-shell.main-window-shell .message-area.layout-roleplay {
    scrollbar-gutter: auto !important;
  }
  .qq-shell.main-window-shell .chat-display-preview .message-area {
    padding: 8px !important;
  }
}

/* 账号区在窄屏收窄，避免压住标题 */
@media (max-width: 720px) {
  .eleckoi-web-account__trigger { max-width: 132px; }
}

/* 手机上抽屉展开时把账号区藏起来。
   抽屉是浮层（.side-panel-shell，z-index 2147481000），而账号区是
   position:fixed right:0 且 z-index 更高（2147483000）——它正好盖住抽屉
   标题行右端那个"收起侧边栏"按钮，用户点不到。抽屉展开时它覆盖 84vw，
   本来也只剩一条边可见，不如整体让位；抽屉一收起立刻恢复。
   （webui:mobile 的 M-phone 断言会以 overlap 报出这个问题。） */
@media (max-width: 720px) {
  body:has(.qq-shell.main-window-shell:not(.side-panel-collapsed)) .eleckoi-web-account {
    display: none;
  }
}

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

  /**
   * 移动端：点会话/角色后自动收起侧栏。
   *
   * 上游的 selectConversation 只调 loadChat，不会收起侧栏——桌面端够用
   * （空间富余），手机上则表现为"选完角色，列表还挡着聊天区，每次都要手动点
   * 那个小按钮"。这里用事件委托补上这一步，不改上游代码。
   *
   * 判定用 matchMedia，与 CSS 的 (max-width: 720px) 保持一致。
   */
  function setupMobileDrawer() {
    const narrow = window.matchMedia('(max-width: 720px)');
    const COLLAPSED_CLASS = 'side-panel-collapsed';

    // 必须用冒泡阶段（第三参 false）并把收起动作延后一拍。
    // 若在捕获阶段同步收起，React 还没来得及处理这次点击（onClick 里才 loadChat），
    // DOM 就已因重渲染被换掉，React 找不到事件目标 → 表现为"抽屉收起了，但会话没打开"。
    // 这个坑由 webui:mobile 的 M-text 断言抓到（消息数为 0）。
    document.addEventListener('click', (event) => {
      if (!narrow.matches) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // 两类命中：
      //  - 会话/角色列表项 → 收起抽屉，把空间让给聊天区（手机上的主流程）
      //  - 设置分类按钮   → 同理，否则"设置"导航会一直压住设置内容
      if (!target.closest('.conversation-item, .character-contact-row, .character-card,'
        + ' .app-settings-sidebar nav button')) return;
      collapseDrawer();
    }, false);

    // 点上游自己的"收起侧边栏"按钮收抽屉，而不是直接改 class：
    // class 由 React state 决定，直接改会被下一次渲染覆盖。
    // 注意标题栏那个按钮只在已收起时渲染（用于展开），收起入口在侧栏头部。
    // 必须延后一拍：React 的 onClick（loadChat / 切页）要先跑完。
    function collapseDrawer() {
      setTimeout(() => {
        const shell = document.querySelector('.qq-shell');
        if (!shell || shell.classList.contains(COLLAPSED_CLASS)) return;
        const collapse = document.querySelector('.side-panel-shell .side-panel-collapse-button');
        if (collapse instanceof HTMLElement) collapse.click();
      }, 0);
    }

    // 进入"设置"分区时自动收起。
    // 上游的折叠态纯手动（useSidePanelLayout 里没有按宽度判定的逻辑），
    // 而手机上抽屉是浮层：不收起的话设置内容会被"设置"导航整块盖住，
    // 只剩右边一条缝——用户反馈的"字体页缩得太窄"就是这个。
    // 分区名由上游写在 .qq-shell 的 section-<id> 类上，观察类变化即可。
    let lastSection = '';
    const syncSection = () => {
      const shell = document.querySelector('.qq-shell');
      if (!shell) return;
      const section = (String(shell.className).match(/section-([a-z]+)/) || [])[1] || '';
      if (section === lastSection) return;
      lastSection = section;
      if (!narrow.matches || section !== 'settings') return;
      collapseDrawer();
    };
    // 只关心 .qq-shell 自身的 class 变动。文档级属性监听会收到全站的 class
    // 改动（流式输出时很频繁），所以先在记录里筛一遍再查 DOM。
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof Element
          && record.target.classList.contains('qq-shell')) { syncSection(); return; }
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });
    syncSection();
  }

  async function start() {
    setupMobileDrawer();
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
