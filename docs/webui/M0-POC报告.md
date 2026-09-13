# M0 POC 报告 · ElecKoi WebUI

> 日期：2026-09-12　上游基线：`eleckoi/ElecKoi` @ `0f55dac`（tag v0.1.0）
> 环境：Linux / Node 24.18.0 / pnpm 10.32.1（corepack 按 `packageManager` 解析）
> 结论：**方案成立，可以进入 M1。**

---

## 1. 结果总览

| 编号 | 假设 | 状态 | 证据 |
|---|---|---|---|
| P1 | 同进程多棵 cordis Context 不串台 | ✅ 通过 | 见 §2.1 |
| P2 | 上游 13 个模块插件可在自建 Web Context 挂载 | ✅ 通过 | 见 §2.2 |
| P2b | 真实模型回合跑通 | ⏳ 未做 | 见 §4 |
| P3 | DSH runtime 在 Linux 用 node 启动 | ✅ 通过 | 见 §2.3 |
| P4 | 渲染产物在 http 下可用（UI 零改动） | ✅ 通过 | 见 §2.4 |
| P5 | window/updates 路由缺失不炸 UI | ✅ 通过（已补路由） | 见 §2.5 |
| P6 | 无模块依赖 `senderId` 做窗口路由 | ✅ 通过 | 见 §2.6 |

自动化 POC（`out/web/poc.mjs`）在临时目录里并发挂载两个租户并执行 **11 项断言，11/11 通过**；
浏览器验证用真实 Chromium 无头渲染 + 真实 HTTP/API 往返完成。

---

## 2. 各项实测

### 2.1 P1 · 多租户隔离

两个租户在**同一进程内并发挂载，用时 188 ms**：

- **服务实例隔离**：`appPaths` / `database` / `credentialCipher` / `mediaAssets` / `conversations` / `agentSessions` / `gateway` 全部互不相同。
- **存储隔离**：两个 SQLite 分别落在 `<tenant>/db/eleckoi-common.sqlite3`（各 655 360 B，即上游 51 表基线）。
- **数据隔离**：经**真实网关**（走 zod 契约）向租户 A 写 `locale.current='zh-CN-tenant-a'`，租户 B 读回仍为默认 `"zh-CN"`。
- **生命周期**：`dispose()` 后进程文件描述符 28 → 25，确认 SQLite 已关闭、无句柄泄漏。
- **路由隔离**：两个网关各自注册 **68/68** 条请求路由；未知路由返回 `NOT_FOUND`。

### 2.2 P2 · 上游模块插件复用

13 个上游业务模块插件（conversations / messages / characters / personas / settingLibraries /
variables / regexRules / agentPresets / agentTools / models / agentSessions / authorSdk /
messageDisplayCompatibility）**原样挂载、零修改**，另复用上游 `sqlitePlugin`。

被替换的只有 5 个平台服务与 1 个网关（方案 §5.2）；Electron 专属插件 `mediaProtocolPlugin` /
`mainWindowPlugin` / `updatesPlugin` 不挂载。

### 2.3 P3 · DSH Agent 运行时

直接以 `node`（非 Electron）运行上游 `scripts/probe-dsh-runtime.mjs`：

```
Electron DSH runtime handshake passed.
```

该脚本通过 `@eleckoi/dsh-runtime` 拉起真实 stdio JSON-RPC 子进程并完成握手，
证明容器内纯 node 环境可用。`ELECTRON_RUN_AS_NODE` 在纯 node 下只是被忽略的环境变量。

### 2.4 P4 · 渲染层在浏览器（**UI 源码零改动**）

服务端把 `out/renderer`（`electron-vite build` 产物，未做任何改动）经 HTTP 提供，
并在响应时向 `index.html` 注入 `<script src="/__eleckoi/web-bridge.js">`（不改磁盘文件）。

- `GET /` → 200，桥脚本已注入，应用包引用正确
- `GET /__eleckoi/web-bridge.js` → 200 `text/javascript`
- `GET /assets/index-*.js` → 200，3 803 221 B，MIME 正确
- `POST /api/rpc` → 200，返回上游 `{ok:true,data}` 封套
- `GET /api/events` → SSE 正常；`command.settings.write` 触发的 `settings.changed` 事件
  以 `{name,payload}` 形状送达（与 `desktopClient.on()` 期望一致）

**Chromium 150 无头渲染结果**（真实浏览器，非模拟）：

```html
<title>ElecKoi</title>
…
可见文本：ElecKoi / 还没有聊天角色 / 先创建一个角色，再开始第一段对话。 / 去创建角色
```

**端到端数据→界面验证**：`POST command.appearance.set_mode {mode:"dark"}`
→ 网关 → SQLite → 重新加载页面 → DOM 中 `data-theme="dark"`、`data-appearance-mode="dark"`
（切换前为 `light`）。渲染层源码在这一整条链路中**未做任何修改**。

> 说明：无头快照需临时关闭 SSE 事件流（`ELECKOI_DISABLE_EVENT_STREAM=1`），
> 否则 `--virtual-time-budget` 会因长连接永不进入网络空闲而挂起。
> 事件通道本身已用 curl 单独验证。

### 2.5 P5 · Electron 专属路由

初次运行时缺 6 条路由（均由 `mainWindowPlugin` / `updatesPlugin` 注册），据此定位到渲染层调用点：

| 路由 | 渲染层调用点 | Web 语义 |
|---|---|---|
| `command.window.control` | `windowControls.js:34,38,42`（**无 catch**） | 返回 `{ok:true}`，标题栏按钮静默无效，避免未捕获 rejection |
| `command.appearance.set_mode` | `appearanceApi.js:12` | 真实写设置；`system` 交由客户端偏好提示解析 |
| `query.updates.status` | `useAppUpdates.js:15`（挂载即调用，**有 catch**） | 返回 `phase:'disabled'` |
| `command.updates.check/download/install` | `useAppUpdates.js:40,41,45` | 同上，走镜像升级语义 |

`phase:'disabled'` 不在 `AppUpdateController.jsx:4` 的 `VISIBLE_PHASES` 中，
因此**更新弹窗不出现、也不显示错误**——这是 Web 端最干净的行为。

已新增 `src/web/modules/webShellPlugin.ts` 补上这 6 条，路由覆盖回到 **68/68**。

### 2.6 P6 · `senderId` 语义

全仓检索确认：`senderId` 唯一用途是 `AuthorSdkService.ts:61` 的限流键
`${senderId}:${conversationId}:${messageId}`，**不存在窗口级路由语义**。

→ Web 端可安全使用每连接稳定 ID；M2 建议直接改用 `userId`，
这样开多标签页也无法绕过作者 API 限流（比桌面端更严）。

---

## 3. 新增文件与「上游零修改」核对

```
src/web/
├── shims/electron.ts              Electron 替身（构建期别名）
├── platform/
│   ├── WebAppPaths.ts             按租户的数据目录
│   ├── WebCredentialCipher.ts     AES-256-GCM + HKDF 按租户派生密钥
│   └── webPlatformPlugin.ts       提供 5 个平台服务
├── modules/webShellPlugin.ts      补 6 条 Electron 专属路由
├── transport/WebGateway.ts        继承上游网关 + 媒体 URL 重写
├── http/
│   ├── webBridge.ts               注入渲染层的桥（与 preload 同形）
│   └── server.ts                  静态 + /api/rpc + SSE + /media/v1
├── WebHost.ts                     租户宿主（挂载上游模块插件）
├── vite.web.config.ts             独立构建配置
└── poc/{run.ts,serve.ts}          POC 入口
```

`git status` 结果：**没有任何被修改的上游文件**，只有新增的 `src/web/` 与 `docs/webui/`。
唯一的构建期侵入是把裸导入 `electron` 别名到 `src/web/shims/electron.ts`，
上游 `DesktopGateway.ts` / `AppPaths.ts` / `CredentialCipher.ts` 因此**无需 fork**。

---

## 4. 未完成项与下一步

### 4.1 唯一未验证：P2b 真实模型回合

需要一个能返回模型响应的端点。**不使用真人密钥**，计划用本地 mock 模型服务
（实现 `openai-completions` 的 SSE 流式响应）指向 `http://127.0.0.1:<port>`，
覆盖「创建模型配置 → 建角色 → 建会话 → `command.agent.start` → 流式增量 → 落库」全链路。
这样既确定性、零成本，又能验证流式与投影器。

### 4.2 M1 待办（按优先级）

1. P2b mock 模型端到端回合
2. 系统提示/预设物化验证（`materializeAgentPreset` 在非 Windows 下的路径行为）
3. `/media/v1` 路由实测（含 `pathForReference` 的穿越防护）
4. `check-upstream-diff.mjs` + `patches/` 机制落地（M3 前必须有，防止后续无意改动上游）
5. Dockerfile / compose（多阶段构建；`ELECTRON_SKIP_BINARY_DOWNLOAD=1`；better-sqlite3 编译）
6. `src/web/tsconfig.json` 让新增代码纳入类型检查（当前上游 `tsconfig.node.json` 不含 `src/web`）

### 4.3 上游架构门禁实测（重要）

`pnpm check:architecture` 对 `src/` 下**所有**文件做 DSH 字面量扫描
（`check-architecture.mjs:298-304`：除 `DshAgentRuntime.ts` 外，任何文件出现
`@eleckoi/dsh-runtime` 或 `@deepseek-ai/dsh-` 即失败）。

初次运行**抓到我们**：`src/web/vite.shared.ts` 的 `ssr.noExternal` 里写了
`'@eleckoi/dsh-runtime'` 字面量 → 门禁报警「绕过了 Agent 模块的 DSH Runtime Adapter」。

处置：直接删掉 `noExternal`（工作区包已构建出 `dist/` 并作为真实包存在于 node_modules，
SSR 外部化后 node 可正常解析），**不改上游校验脚本**。结果：

```
Architecture check passed: Host, Gateway, Modules, Platform and Renderer boundaries are intact.
```

且 POC 仍 11/11 通过。结论：

1. 我们的新增代码**天然符合上游分层约束**，`pnpm build` 全链路不会被我们阻塞。
2. 反向收益：上游门禁同时成了我们代码的免费守卫——它会在 CI 里替我们盯住边界。
3. 约束需记住：`src/web/**` 里不要出现 `@deepseek-ai/dsh-*` / dsh-runtime 字面量
   （用 `@deepseek-ai/cordis` 是允许的，规则只匹配 `dsh-`）。
   `pnpm check:dsh-versions` 亦通过：81 个 DSH 包 @ 0.1.1-rc.2 对齐。

### 4.4 环境备注

- 磁盘偏紧（约 5 G 可用），`node_modules` 764 MB；Electron 二进制已跳过（Web 端不需要）。
- 后续若跑 `pnpm build`（上游完整构建链），会触发 `check-architecture` 等门禁；
  `src/web/` 不在其闭集校验范围内，预期不冲突，但需实测确认。
