/**
 * 登录/账号/用户管理三个独立页面共用的样式。
 *
 * 这里**不写任何颜色字面量**，全部走 `/__eleckoi/app-tokens.css` 提供的
 * 上游主题令牌，因此三个页面的观感与应用本体一致，并自动跟随上游的主题改动。
 */

export function pageCss(): string {
  return `
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--shell-backdrop);
  color: var(--text);
  font-family: "Noto Sans", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--blue); text-decoration: none; }
a:hover { color: var(--blue-hover); text-decoration: underline; }

.shell {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 32px 20px 48px;
}
.shell--top { justify-content: flex-start; padding-top: 48px; }
.shell__inner { width: 100%; max-width: 460px; }
.shell--wide .shell__inner { max-width: 880px; }

.brand { display: flex; align-items: baseline; gap: 8px; justify-content: center; margin-bottom: 16px; }
.brand__dot {
  align-self: center;
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--blue);
}
.brand__name { font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
.brand__en { font-size: 11.5px; color: var(--soft-text); letter-spacing: 0.08em; }

.foot { margin: 14px 0 0; color: var(--soft-text); font-size: 12px; text-align: center; }
.foot a { color: var(--soft-text); text-decoration: underline; text-underline-offset: 3px; }
.foot a:hover { color: var(--muted); }

.card {
  background: var(--surface-raised);
  border: 1px solid var(--line);
  border-radius: 12px;
  /* 与应用里弹层/面板同一档投影（0 8px 24px var(--shadow-color)） */
  box-shadow: 0 8px 24px var(--shadow-color);
  padding: 22px 22px 20px;
}
.card + .card { margin-top: 14px; }
.card__title { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
.card__hint { margin: 0 0 18px; color: var(--muted); font-size: 12.5px; }

.field { margin-bottom: 13px; }
.field__label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 12.5px; }

/* 输入框与应用里的字段同一规格：高 34、圆角 7、字重 500、聚焦只换描边色 */
.input {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  background: var(--field-bg);
  color: var(--text);
  border: 1px solid color-mix(in srgb, var(--text) 15%, transparent);
  border-radius: 7px;
  font: inherit;
  font-weight: 500;
  outline: 0;
  transition: border-color 0.15s ease;
}
.input:hover { border-color: color-mix(in srgb, var(--text) 28%, transparent); }
.input:focus { border-color: var(--blue); }
.input::placeholder { color: var(--soft-text); font-weight: 400; }

/* 主/次按钮与应用对话框按钮同一规格：高 40、圆角 9、字号 13、字重 600 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 96px;
  height: 40px;
  padding: 0 18px;
  border: 1px solid var(--blue);
  border-radius: 9px;
  background: var(--blue);
  color: var(--on-accent);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.btn:hover { background: var(--blue-hover); border-color: var(--blue-hover); }
.btn:disabled {
  border-color: var(--line);
  background: var(--field-disabled);
  color: var(--soft-text);
  cursor: default;
}
.btn--ghost { border-color: var(--line-strong); background: var(--surface-raised); color: var(--text); }
.btn--ghost:hover { background: var(--control-bg-hover); border-color: var(--line-strong); }
.btn--block { width: 100%; }
.btn--sm {
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 500;
}

/* 键盘可达性：鼠标点击不出框，Tab 走查必须有可见焦点 */
.input:focus-visible, .btn:focus-visible, a:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--blue) 65%, transparent);
  outline-offset: 2px;
}

.note { margin: 14px 0 0; color: var(--muted); font-size: 12.5px; text-align: center; }
/*
 * 令牌里没有语义色，这三处红直接取应用自己的取值：
 * 报错文字 #d93025（avatar-crop.css / settings-panel.css 同款）。
 * 这是全文件仅有的颜色字面量，改动时保持一致。
 */
.error, .ok {
  margin: 0 0 13px;
  padding: 9px 11px;
  border-radius: 8px;
  font-size: 12.5px;
  display: none;
}
.error { background: color-mix(in srgb, #d93025 12%, transparent); color: #d93025; }
.ok { background: color-mix(in srgb, var(--blue) 16%, transparent); color: var(--blue); }
.error--on, .ok--on { display: block; }

.rows { margin: 0; display: grid; grid-template-columns: 108px 1fr; gap: 9px 12px; font-size: 13px; }
.rows dt { color: var(--muted); }
.rows dd { margin: 0; word-break: break-all; }

.muted { color: var(--muted); }

/* 顶栏与内容同宽同列：两者宽度不一致时，标题会飘在卡片外面 */
.topbar {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.topbar__links { display: flex; align-items: center; gap: 14px; font-size: 13px; }

.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th {
  text-align: left;
  padding: 8px 10px;
  color: var(--muted);
  font-weight: 500;
  font-size: 12.5px;
  border-bottom: 1px solid var(--line-strong);
  white-space: nowrap;
}
.table td { padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.table tr:last-child td { border-bottom: none; }
.table .actions { display: flex; flex-wrap: wrap; gap: 6px; }

.tag {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--control-bg);
  color: var(--muted);
  font-size: 11.5px;
}
.tag--accent { background: color-mix(in srgb, var(--blue) 18%, transparent); color: var(--blue); }
.tag--off { background: color-mix(in srgb, #d93025 14%, transparent); color: #d93025; }

.inline-form { display: flex; align-items: center; gap: 6px; }
.inline-form .input { width: auto; min-width: 120px; padding: 5px 9px; font-size: 12.5px; border-radius: 6px; }
`;
}
