# ElecKoi → Docker 多用户 WebUI 改造方案

> 目标仓库：`github.com/eleckoi/ElecKoi`（Windows 桌面版，HEAD `0f55dac`）
> 形态目标：**多用户公网服务**（Docker 部署，浏览器访问）
> 硬约束：① 尽量不动原有 UI；② 后续能跟着上游一条线更新
> 本文为设计方案，未写任何代码；所有结论均标注了静态代码证据或待验证标记。

---

## 0. 结论摘要

**可行性：高。** 上游的分层纪律把"换宿主"变成了一件收敛的工作：

| 关键事实 | 证据 | 对改造的意义 |
|---|---|---|
| 渲染层只通过 `window.eleckoi.request/subscribe` 访问后端 | `src/renderer/src/bridge/desktopClient.ts:39,52`（全仓仅 3 个调用点） | **UI 可零改动**，注入同名 WebSocket 桥即可 |
| 业务模块不认识 Electron | `src/main/modules/**` 仅 `updatesPlugin.ts` import electron，且可不挂载 | **14 个业务模块插件原样复用** |
| 平台能力经 `ctx.provide` 注入，共 5 个服务 | `src/main/host/plugins.ts:12-22` | 只替换这 5 个即可换宿主 |
| **业务模块无模块级可变状态** | 全仓 `src/main` 顶层 `let` 仅 3 处，均在 `windowsNativeFrame.ts` / `main.ts`（都要替换） | **多租户可同进程共存**，这是本方案成立的前提 |
| `CredentialCipher` 是 interface | `src/main/platform/electron/CredentialCipher.ts:3-6` | 可无侵入替换为服务端加密 |
| `AppPaths` 构造函数接受显式路径 | `src/main/platform/filesystem/AppPaths.ts:11` | 可按租户指定数据目录 |
| 网关的 `register`/`dispatch` 是公开方法 | `src/main/gateway/DesktopGateway.ts:49,57` | 继承复用校验逻辑，只覆盖传输三方法 |
| 响应封套格式简单且稳定 | `src/shared/foundation/result.ts`：`{ok:true,data}` / `{ok:false,error}` | Web 桥按此实现即完全兼容 |
| `DshAgentRuntime` 用 `process.execPath` 起子进程 | `packages/dsh-runtime/src/DshRuntime.ts:269-274`；`ELECTRON_RUN_AS_NODE` 在纯 node 下是被忽略的普通环境变量 | **Agent 链路零改动**，容器内直接用 node |

**两个必须先接受的现实：**

1. **富内容卡片的隔离要动渲染层 1–5 行**（详见 §7.3）。`srcDoc` iframe 与宿主同源，卡片 JS 可以直接调 `parent.eleckoi.request()` 打穿全部 68 条 IPC——桌面端是"跑自己的卡片"，公网多用户是"任意用户的卡片能在服务端会话里调用一切"。这不是能用服务端手段关掉的口子，必须改 iframe 属性。方案用 `patches/` 机制承载，**git 树里上游文件仍然零修改**。
2. **上游没有迁移链，也没有账号级导出**（`installSchema.ts` 对 `user_version != 1` 直接拒绝启动；路由表里只有角色/正则/预设三个域的 import/export，没有会话、设置、变量）。公网服务必须自带租户级备份/迁移能力，详见 §10.3。

**工作量预估**：POC 2–3 天 → 单租户跑通 1 周 → 多租户 2 周 → 公网加固 1 周。合计约 **4–6 周**（单人全职）。

---

## 1. 目标与非目标

### 目标
- 浏览器访问，多用户注册/登录，数据彼此隔离。
- 复用上游全部业务能力：角色卡创作、设定库、变量、正则、Agent 演绎、生图、作者前端（HTML/CSS/JS 卡片）。
- 保持与上游可 rebase 的更新路径。
- 容器化部署，数据落卷，可备份可迁移。

### 非目标（明确不做）
- 不改造上游代码结构、不动渲染层业务逻辑。
- 不复刻 Electron 桌面特性（无边框窗口、系统托盘、自动更新、原生缩放命中）。
- 不提供模型服务：**用户自带 API Key**（与上游 README 的公开承诺一致，也避免运营方承担推理成本与合规风险）。
- 不做移动端适配（上游已有 Android 版）。

---

## 2. 架构总览

```
浏览器 A                   浏览器 B                  浏览器 C
   │ https                 │                        │
   └──────────────┬────────┴────────────┬───────────┘
                  ▼
        ┌──────────────────────────────┐
        │  反向代理 (Caddy/Nginx)       │  TLS · WS upgrade · 限流
        └──────────────┬───────────────┘
                       ▼
   ┌───────────────────────────────────────────────────────┐
   │  容器：eleckoi-web                                     │
   │                                                       │
   │  控制面（我们写的，结构独立于上游）                      │
   │   ├ 认证服务    用户表 / 会话 / 配额  ← registry.sqlite │
   │   ├ 租户注册表  租户生命周期、懒加载、空闲回收           │
   │   ├ HTTP       静态 out/renderer · /media/* · 上传下载  │
   │   └ WS 接入    会话 → 租户路由                          │
   │                                                       │
   │  租户面（每个用户一棵 cordis Context，互不可见）          │
   │   ┌─ TenantContext(userId) ────────────────────────┐   │
   │   │  web platform plugin                           │   │
   │   │   appPaths / credentialCipher /                │   │
   │   │   conversationFiles / mediaAssets / appLog      │   │
   │   │  ─────────────────────────────────────────────  │   │
   │   │  上游模块插件（原样挂载，共 13 个）                │   │
   │   │   conversations · messages · characters ·       │   │
   │   │   personas · settingLibraries · variables ·     │   │
   │   │   regexRules · agentPresets · models ·          │   │
   │   │   agentTools · agentSessions · authorSdk ·      │   │
   │   │   messageDisplayCompatibility                   │   │
   │   │  ─────────────────────────────────────────────  │   │
   │   │  WebGateway extends DesktopGateway              │   │
   │   └────────────────┬───────────────────────────────┘   │
   │                    ▼                                   │
   │   node 子进程：DSH runtime（stdio JSON-RPC）—— 原样     │
   │                    ▼                                   │
   │   租户数据目录 /data/tenants/<uid>/                     │
   └───────────────────────────────────────────────────────┘
```

**一句话**：上游是一个单租户应用；我们不改它，而是**把它实例化 N 次**，每次喂一副自己的数据目录和服务实现。

---

## 3. 多租户模型（本方案核心）

### 3.1 为什么"一个租户 = 一棵 cordis Context"可行

上游 `DesktopHost` 是一个 `new Context()` 根容器，插件通过 `ctx.provide(name, instance)` 注册服务、通过 `inject` 声明依赖（`src/main/host/plugins.ts`、各 `*Plugin.ts`）。整张服务图**没有一处依赖进程级单例**：

- 业务模块顶层只有常量（`new Set([...])` 这类纯查表），无缓存、无计数器、无连接池。
- 唯一的顶层 `let` 在 `windowsNativeFrame.ts:9`（被我们丢弃）与 `main.ts:17-18`（被我们的入口替代）。
- 单例只在 `main.ts` 里创建（`new DesktopHost()`），而我们不复用 `main.ts`。

因此：**为每个用户 `new Context()`，挂同一批模块插件，注入该用户自己的平台服务**，即可获得完全隔离的服务图。`register` 的重复注册保护（`DesktopGateway.ts:50`）也天然要求每租户一个网关实例。

> ⚠️ 待验证（M0-P1）：需实测在**同一进程**内并发挂载多棵 Context 时，`@deepseek-ai/cordis` 的服务解析不会串台（尤其 `inject` 的名字解析是否走就近上下文）。若串台，退化方案见 §3.4。

### 3.2 租户资源布局

每个租户一个目录，边界即备份边界：

```
/data/
├── registry.sqlite                 # 控制面：用户、会话、配额、租户状态（我们的库）
├── tenants/
│   └── <userId>/
│       ├── db/eleckoi-common.sqlite3    # 上游产品库（每租户一个）
│       ├── media/                       # 角色图、聊天背景、卡片素材
│       ├── workspace/                   # DSH 工作目录
│       ├── dsh-runtime/                 # DSH_HOME / sessions / agent-presets
│       └── .meta.json                   # schema epoch、创建时间、配额水位
└── shared/
    └── resources/dsh/                   # cordis.yml + 本地插件（只读，所有租户共用）
```

关键点：
- **控制面库与产品库物理分离**。上游库结构不容我们改（`check-database-schema` 会校验），用户/会话/配额必须放我们自己的库。
- 租户目录名用不可猜的内部 ID（非邮箱/用户名），避免路径穿越与枚举（上游 `safeConversationDirectory` 只处理会话名，租户目录由我们负责）。

### 3.3 租户生命周期

```
首次登录 → 创建目录结构 → new Context() → 挂 web platform + 上游模块 → 提供 gateway
                                                          ↓
访问期间 → WS 连接绑定该租户的 gateway（一个租户可多标签页，共用一个 Context）
                                                          ↓
空闲 T 分钟（默认 30）→ 关闭所有 DSH 子进程 → dispose Context → 释放 SQLite 连接
                                                          ↓
再次访问 → 按需重建（数据在盘上，无感）
```

- 租户实例表：`Map<userId, { context, gateway, lastActiveAt, activeRuns, refCount }>`。
- **不随 WS 断开立即销毁**：上游每个 `conversation` 持有一个 DSH harness（`DshRuntime.sessions`），频繁重建代价高（重新拉起 node 子进程 + 重放会话）。
- 销毁必须走 `host.dispose()`（对应上游 `DesktopHost.dispose()` 的 `root.fiber.dispose()`），确保 SQLite 正常 `close()`（`SqliteDatabase.close()` 会 `wal_checkpoint(TRUNCATE)`）。

### 3.4 隔离强度与失效模式

| 风险 | 现状 | 措施 |
|---|---|---|
| 上下文串台 | 待验证 | M0-P1 实测；退化方案：① 每租户独立 `worker_thread`（Context 本身可整体搬进 worker）；② 每租户独立进程 + 路由器 |
| 一个租户拖垮全进程 | 同进程共享事件循环 | 每租户并发 run 上限 + 全局上限 + 超时熔断（§8） |
| 共享资源路径穿越 | 上游只保护会话目录 | 租户目录在服务端拼接，禁止来自客户端的路径片段 |
| 跨租户 ID 猜测 | 上游 ID 无租户前缀 | 一切路由在服务端按 `userId` 取 Context，**绝不接受客户端传 tenantId** |

---

## 4. 请求链路

### 4.1 认证与租户解析

1. `POST /api/login`（邮箱+口令，或 OAuth）→ 服务端签发会话 Cookie：`HttpOnly; Secure; SameSite=Lax; Path=/`。
2. 控制面库存 `sessions(tokenHash, userId, expiresAt, ua, ip)`；token 用 `crypto.randomBytes(32)`，**只存哈希**。
3. `GET /` 返回 `out/renderer/index.html`（注入 web 桥脚本，见 §5.1）。
4. `GET /ws` 升级时校验 Cookie → 解析 `userId` → `tenantRegistry.acquire(userId)` → 绑定该租户的 `gateway`。**租户身份只来自会话，不接受任何客户端字段。**

### 4.2 WebSocket 协议（与上游封套 1:1）

客户端 → 服务端：
```json
{ "id": 17, "kind": "request", "name": "command.agent.start", "input": { ... } }
```
服务端 → 客户端：
```json
{ "id": 17, "kind": "result", "result": { "ok": true, "data": { ... } } }
{ "kind": "event", "name": "agent.output.delta", "payload": { ... } }
```

- `result` 的 `result` 字段**原样使用上游 `success()` / `failure()` 的产物**（`DesktopGateway.dispatch` 的返回值天然就是这个形状），因此渲染层 `desktopClient.unwrap` 无需任何适配。
- 事件方向复用 `gateway.broadcast(name, payload)`；我们的实现只把它从"遍历 BrowserWindow"换成"推给该租户的所有 WS 连接"。
- 渲染层 `subscribe` 收到的必须是 `GatewayEventEnvelope = { name, payload }`（`src/shared/contracts/gateway/types.ts:19-22`），照抄即可。

### 4.3 需要在 Web 层特殊处理的路由

| 路由 | 处理方式 |
|---|---|
| `command.window.control` | 上游操作 Electron 窗口（最小化/最大化/关闭）。Web 端返回成功但空操作，或映射为前端无需动作；**需实测渲染层对返回值的依赖**（M0-P5） |
| `command.updates.*` / `query.updates.status` | 不挂载 `updatesPlugin`，路由不存在；但渲染层若有"检查更新"入口，会收到 `NOT_FOUND`。需确认 UI 是否容错（M0-P5） |
| `command.appearance.set_mode` | 上游在 `mainWindowPlugin` 注册，Web 端由我们的服务端实现（写租户偏好即可，也可直接空操作，因为主题已由前端 CSS 变量驱动） |
| `query.agent.image` / 媒体类查询 | 媒体 URL 前缀重写，见 §5.3 |

---

## 5. 宿主替换层（我们写的代码）

### 5.1 渲染层桥注入（UI 零改动的关键）

上游渲染层通过 `window.eleckoi.request/subscribe` 访问宿主（`desktopClient.ts:39,52`），该对象由 `src/preload/preload.ts` 用 `contextBridge` 注入。Web 端等价物：

```js
// 服务端在返回 index.html 时，在 <head> 注入：
//   <script src="/__eleckoi/web-bridge.js"></script>
window.eleckoi = {
  request(name, input) { /* WS 请求，返回 {ok,data} / {ok,error} */ },
  subscribe(listener) { /* WS 事件，listener({name, payload}) */ }
}
```

**注入方式不修改上游文件**：服务端读 `out/renderer/index.html`，做一次字符串替换（在 `</head>` 前插入 `<script>`）。原文件保持不动。

桥的实现要点：
- 请求-响应用自增 `id` + `Map` 挂起；连接断开时把所有挂起请求 reject 成 `{ok:false,error:{code:'INTERNAL',message:'连接已断开'}}`，避免渲染层永久 pending。
- 断线自动重连（指数退避），重连后由渲染层自身的 `records.changed` 事件驱动数据重取（上游 `useChatClient.js:172-177` 已有此机制）。
- **不要**在桥里做 zod 校验：渲染层 `desktopClient` 已经双向校验（`desktopClient.ts:30-48`），服务端 `dispatch` 再校验一次，中间重复无意义。

### 5.2 五个平台服务的 Web 实现

| 服务名 | 上游实现 | Web 实现 | 备注 |
|---|---|---|---|
| `appPaths` | `platform/filesystem/AppPaths.ts`（默认 `app.getPath('userData')`） | `WebAppPaths`：`userData = /data/tenants/<uid>`；`resolveResource` 指向 `/data/shared/resources` | 结构上可替换（无 private 成员）；也可复用上游类 + electron stub |
| `appLog` | `createAppLog()`（pino） | 同左，per 租户加 `userId` 字段 | 直接复用 |
| `credentialCipher` | `safeStorage` 包装（`CredentialCipher.ts`） | `WebCredentialCipher`：AES-256-GCM，密钥 HKDF(masterKey, userId) | ⚠️ 上游客器前缀是 `desktop-safe-v1:`，我们用自己的前缀（如 `web-aes-v1:`）以免误读 |
| `conversationFiles` | `ConversationFiles([workspace, dshSessions])` | 同左，指向租户目录 | 直接复用 |
| `mediaAssets` | `LocalMediaStore`（产出 `eleckoi-media://asset/v1/...`） | `WebMediaStore` 或前缀重写 | 见 §5.3 |

`credentialCipher` 的密钥管理：`masterKey` 来自容器环境变量或 Docker secret；**不可放入镜像**。轮换密钥需要能重加密（我们自己的库表记录版本号）。

### 5.3 媒体 URL：`eleckoi-media://` → `/media/v1/...`

上游在 `LocalMediaStore.ts:13-14` 把协议前缀写成常量，产出的引用形如 `eleckoi-media://asset/v1/<sha256>/<name>`，浏览器无法解析。两种做法：

**做法 A（推荐）**：在 `WebGateway.dispatch` 的返回值上做一次字符串前缀重写（对序列化后的 JSON 做 `replaceAll`）。理由：只依赖一个稳定的协议前缀常量，上游改媒体存储内部实现也不影响我们；且实现集中在传输层一处。

**做法 B**：自己实现 `WebMediaStore`，URL 直接产出 `/media/`。更直接，但 `LocalMediaStore` 有 private 成员（`LocalMediaStore.ts:108-152`），赋值给 `ctx.mediaAssets` 需要一个 `as unknown as LocalMediaStore` 断言，上游若改公开方法签名，运行期才会暴露——需配一个方法名契约测试兜底。

无论 A/B，HTTP 层都需要：
- `GET /media/v1/:sha/:name` 路由，按租户鉴权（见 §8.5，卡片帧必须用签名 URL）。
- 路径穿越防护：上游已有 `pathForReference` 的校验逻辑（`LocalMediaStore.ts:83-98`），能复用就复用。

### 5.4 WebGateway

```ts
class WebGateway extends DesktopGateway {
  start()            { /* 不碰 ipcMain */ }
  broadcast(name, p) { /* 推给本租户所有 WS 连接 */ }
  send(target, ...)  { /* 定向到某个连接 */ }
  dispose()          { /* 关闭连接、清 handlers */ }
  // register / dispatch 直接继承 —— 契约校验逻辑完全复用
}
```

`RequestContext` 是 `{ senderId: number; windowId?: number }`（`gateway/types.ts:23-26`）。Web 端把 `senderId` 填为"连接 ID"，`windowId` 留空或填标签页编号。**需确认没有模块依赖 `senderId` 做窗口级路由**（M0-P6）。

---

## 6. 上游零改动纪律

### 6.1 目录纪律

```
src/web/                    ← 我们唯一的代码地盘
├── entry.ts                服务入口
├── TenantRegistry.ts       租户生命周期
├── WebHost.ts              等价于上游 DesktopHost，但只挂我们要的插件
├── control/                认证、用户、配额、控制面库
├── platform/               §5.2 的五个服务实现
├── transport/              WebGateway + WS 接入
├── http/                   静态服务、媒体路由、上传下载、响应头
└── shims/electron.ts       electron 替身（见 6.2）
patches/                    ← 允许的极少数上游源码补丁（见 7.3）
docker/                     ← Dockerfile / compose / caddy
scripts/check-upstream-diff.mjs
```

### 6.2 electron stub 是关键技巧

上游有些文件我们想复用，但它们 `import ... from 'electron'`（如 `DesktopGateway.ts:1` 拿 `ipcMain`/`BrowserWindow`，`AppPaths.ts:3` 拿 `app`）。做法：**构建期为 `electron` 配置别名，指向 `src/web/shims/electron.ts`**，只实现被复用代码真正碰到的面：

- `app.getPath()` / `app.getAppPath()` → 返回部署路径
- `safeStorage` → 抛错（强制走我们的 `WebCredentialCipher`）
- `ipcMain.handle/removeHandler` → 空实现
- `BrowserWindow.getAllWindows/fromWebContents` → 空数组/undefined

这样连 `DesktopGateway`、`AppPaths` 这些文件都**不需要 fork**。

### 6.3 唯一允许的偏差：富内容卡片隔离

见 §7.3。用 `patches/*.patch` 承载，由 `scripts/apply-patches.mjs` 在构建前应用：**git 树里上游文件依然零修改**，补丁是独立、可评审、可失效告警的产物。

### 6.4 可更新性门禁（机器强制，不靠自觉）

`scripts/check-upstream-diff.mjs` 做三件事：

1. 比对 `git diff upstream/<pinned-tag> --name-only`，任何不在白名单（`src/web/`、`patches/`、`docker/`、`scripts/`、`package.json`、`docs/`）内的路径 → 失败。
2. `package.json` 的 diff 只允许新增 script 与 workspace 字段，禁止改动上游依赖版本（避免与 `check-dsh-versions.mjs` 冲突）。
3. 逐个试应用 `patches/*.patch`：若某个 hunk 打不上（说明上游改了那段），**立即失败**并提示人工复核——这正是"一条线更新"需要的告警点。

配套流程：`git remote add upstream …`，升级 = `git fetch upstream && git rebase upstream/main`。因为上游文件零修改，冲突预期为零；补丁失配是唯一的真实冲突信号。

---

## 7. 安全设计

### 7.1 上游带来的既有风险（改造中必须一并处理）

| # | 风险 | 证据 | 处置 |
|---|---|---|---|
| 1 | Agent 无沙箱、无审批 | `resources/dsh/cordis.yml` 中 `dsh-user-approval: policy never`，且 `dsh-sandbox`/`dsh-authorization`/`dsh-credentials` 未装配 | 容器边界兜底（非 root、只读根、受限网络出口）；**不要**在容器内挂载宿主敏感路径；可选：为 Web 部署定制 `cordis.yml`（这是我们自己的资源配置，不算改上游源码） |
| 2 | 卡片 iframe 无 sandbox、同源 | `RichMessageFrame.jsx:109-118` | §7.3，公网必须修 |
| 3 | API Key 明文回渲染层 | `query.models.list` 返回含 `api_key` 的 `ModelConfig` | 短期接受（登录用户看自己的 key）；**必须**修掉 §7.3 才算安全 |
| 4 | 密钥经环境变量传子进程 | `DshRuntime.ts:275-308` | 容器内进程同属一个租户，风险可控；禁止跨租户共享子进程 |
| 5 | 作者 `schemaCode` 走 `new Function` | `variable-tools.mjs:380-388` | 只在 DSH 子进程内执行；子进程以受限用户运行 |

### 7.2 传输与会话

- TLS 终结于反代；容器内只跑 HTTP。
- Cookie：`HttpOnly` + `Secure` + `SameSite=Lax`；WS 升级同样校验 Cookie。
- 状态变更类请求要求 `Origin` 校验（防 CSRF），并校验 `Sec-Fetch-Site`。
- 登录限流（IP + 账号维度）、口令用 Argon2id、失败锁定。

### 7.3 卡片隔离方案（本轮最关键的取舍）

问题：`RichMessageFrame` 用 `srcDoc` 渲染卡片 HTML，**srcdoc 继承父文档源**，因此卡片 JS 与 App 同源，可直呼 `parent.eleckoi.request()` 打穿全部 68 条 IPC。上游的设计意图是"卡片只能经 `command.author_sdk.invoke`（7–16 项权限 + 限流）"，但这个闸门在同源面前形同虚设。

三种取舍：

| 方案 | 改动量 | 卡片兼容性 | 安全性 | 建议 |
|---|---|---|---|---|
| **A. 跨源卡片域** | 渲染层约 3–5 行（`srcDoc` → `src` 指向 `cards.example.com`，加 `sandbox`） | 高（卡片在自有源内可正常用 localStorage、自有 DOM） | **最高**（`parent.eleckoi` 跨源不可达） | **公网推荐** |
| **B. 仅加 `sandbox="allow-scripts"`** | 1 行（加属性） | 中（不透明源：`localStorage` 抛错、无 Cookie，用到这些的卡片会坏） | 高（桥不可达） | 折中 |
| **C. 不改，靠审核与裁剪** | 0 | 高 | **低**（等价于把服务端全部权限交给任意卡片） | 仅限完全可信的私用场景 |

> ⚠️ 注意 `sandbox="allow-scripts allow-same-origin"` 两个都开等于没加沙箱（同源 + 可执行脚本），必须避免。

方案 A/B 都要求媒体资源改用**签名 URL**（卡片帧不携带 App 的 Cookie）：`/media/v1/:sha/:name?sig=<HMAC>&exp=<ts>`，签名绑定 `userId + sha + exp`，短时效，服务端校验后回源到租户 `media/` 目录。这同时解决了"卡片帧跨源取图"的问题。

**落地方式**：`patches/0001-rich-frame-sandbox.patch`，由 `apply-patches.mjs` 应用；同时补一条 e2e 断言（用一条恶意卡片验证 `parent.eleckoi` 不可达）。这样"UI 零改动"变成"UI 源码零改动 + 一个受门禁保护的补丁"，我认为这是能同时满足你两条约束的最优解——**如果你的优先级是绝对零补丁，那就只能选 C，但请务必不要开放公网**。

### 7.4 响应头（服务端可加，不需要动 UI）

我们对 HTTP 层有完全控制权，可加：`Content-Security-Policy`（`default-src 'self'`；`frame-src` 指向卡片域；`object-src 'none'`；`base-uri 'none'`）、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`、HSTS。

⚠️ 注意：srcdoc 子文档**继承父文档 CSP**，因此上 CSP 前必须先在测试卡片上验证不误伤（EJS/卡片内联脚本、内联样式、`data:` 图片等）。

### 7.5 上传与配额

- 卡片/角色导入走已有的 `command.characters.import.prepare/commit/discard` 三段式（上游自带事务语义），我们只在传输层加体积上限与类型白名单。
- 每租户配额：媒体字节数、角色数、会话数、消息数；超限由控制面拒绝（在 WS 层拦截对应路由）。
- 图片解码风险：上游已有尺寸/像素上限（`DshRuntime.ts:27-35`），复用。

### 7.6 容器加固

非 root 用户运行、`read_only: true` 根文件系统（`/data` 与 `/tmp` 用卷/ tmpfs）、`cap_drop: [ALL]`、`no-new-privileges`、限制内存与 PID 数（DSH 子进程多）、出口网络可限制为模型 API 域名白名单（若用户自带 key 指向任意域名，则只能放开出口——这是一个真实的取舍：**放开出口 = Agent 可访问任意网络**，需在文档里向用户明示）。

---

## 8. 资源、配额与伸缩

### 8.1 DSH 子进程是主要成本

每个活跃会话 = 一个 node 子进程（`DshRuntime.getSession` 按 `conversationId` 持有 harness）。多用户场景必须加：

- **每租户并发 run 上限**（默认 2）：上游已有单会话互斥（`DshRuntime.stream` 里 `activeRuns` 检查），但跨会话不限。
- **空闲 harness 回收**：上游只在 `settingsKey` 变化或 `close()` 时销毁。我们要加一个定时器，对超过 N 分钟无活动的会话调用 `disposeSession`（可经 `runtime.close()` 或按会话粒度——上游 `disposeSession` 是 private，需通过 `close()` 全量释放或在 `DshRuntime` 外层包一层）。
- **全局进程上限**：超过则排队或拒绝（返回 `INTERNAL` + 友好文案）。
- 容量估算：每子进程常驻约 60–120 MB。若目标 100 并发会话，需预留 8–12 GB 内存，建议**按用户数分片部署**而不是单容器硬扛。

### 8.2 SQLite 同步 API 的单线程瓶颈

上游用 `better-sqlite3`（**同步**），且所有租户共用主线程事件循环。一个租户的大量消息查询会阻塞其他所有用户。

演进路径（按需）：
1. **M2 先接受**：加查询上限与超时，观察 p95。
2. **M3 隔离**：把租户 Context 搬进 `worker_thread`（每 worker 承载 K 个租户），主线程只做 HTTP/WS 路由。因为租户已经是自包含的 `Context`，搬迁面收敛。
3. **M4 分片**：多容器 + 一致性哈希路由（会话粘性）。

`query.conversations.messages` 在渲染层是分页拉取 + 虚拟滚动（`ChatPanel.jsx:253-261`），压力相对可控。

### 8.3 其他配额

WS 连接数/用户、请求速率、单条消息字节数、生成 Token 上限（按用户可调）、`command.agent.start` 频率。

---

## 9. 数据、备份与升级

### 9.1 备份

- 租户目录整体快照即备份（`db/` 含 WAL：上游 `SqliteDatabase.backupTo` 已支持含 WAL 的一致性快照，`SqliteDatabase.ts:58` 注释）。
- 控制面库单独备份。
- 建议每日增量（文件系统快照）+ 每周全量；**备份必须包含 `dsh-runtime/`**，否则会话的 DSH 侧事件溯源日志与会话历史不一致（上游 SQLite 才是产品权威库，但 DSH JSONL 用于恢复运行时分支状态）。

### 9.2 升级流程

```
拉新镜像 → 起一个"兼容性探测"容器，对抽样租户库执行上游 check-electron-sqlite 等价的表结构断言
        → 全部通过：滚动替换；任何失败：中止并保留旧镜像
```

### 9.3 上游无迁移链的应对（最高运维风险）

上游 `installSchema.ts:33-40` 对基线不符的库**直接拒绝启动**。这意味着上游某天把 `user_version` 从 1 提到 2，我们所有租户库都会开不起来，且**上游没有账号级导出**（只有角色/正则/预设三个域能 import/export）。

应对（按优先级）：
1. **版本钉死**：本服务锁定某个上游 tag，绝不自动跟 `main`。升级是显式动作。
2. **租户级迁移工具（自建）**：因为每租户一个独立库文件，可以做"旧库 → 新基线"的转换器；实现方式是比对 `resources/database/eleckoi-common-schema-v1.sql` 与新版基线的差异，生成 `ALTER TABLE`/数据搬迁脚本。此项应在第一次上游 schema 变更**之前**就准备好骨架。
3. **`.meta.json` 记录 schema epoch**：租户创建时写入当前基线指纹（上游 `installSchema.ts:11-30` 有表清单 + SQL 文本归一化比对，可复用其思路），升级前先扫描全部租户的 epoch 分布。
4. **兜底：文件级导出**给用户（下载自己的 sqlite + media 打包），至少不丢用户数据。

---

## 10. 合规

### 10.1 AGPL-3.0 §13（硬义务）

以网络服务形式向他人提供修改版，必须向使用者提供**对应源码**。具体做法：
- 公开 fork 仓库（含 `src/web/` 与 `patches/`）。
- 在服务上提供可达的源码入口。**注意**：UI 零改动意味着没有天然的"关于"页，需在服务端注入的位置给出（例如登录页/页脚注入，属服务端渲染层，不算改上游 UI 源码），或在响应头加 `Link: <源码地址>; rel="source"`，并在使用条款中写明。
- 保留上游 `LICENSE` / `NOTICE` 与 `THIRD_PARTY_NOTICES`。

### 10.2 内容与运营合规

公网多用户服务承载用户生成内容（角色卡、剧情），在中国大陆涉及 ICP 备案、公安备案与内容审核义务；同时上游明确"项目方不提供模型服务"。建议：服务条款明示"用户自带模型 Key、内容由用户负责"、提供举报与删除通道、保留审计日志（注意隐私边界：聊天内容属用户隐私，日志只记录元数据）。

---

## 11. 里程碑与验收

### M0 · POC（2–3 天，先证伪再投入）

| 编号 | 待验证假设 | 验证方法 | 失败兜底 |
|---|---|---|---|
| P1 | 同进程多棵 Context 服务不串台 | 起 2 个租户，各写一条角色，互查 | 每租户 worker_thread / 独立进程 |
| P2 | 上游 13 个模块插件可在自建 Context 里挂载并跑通一次真实对话 | 用我们 5 个平台服务 + WebGateway，经 WS 发 `command.agent.start` | 逐模块排查缺失的 `inject` |
| P3 | DSH runtime 在 Linux 容器内用 node 起得来 | 容器内跑 `DshRuntime.verify()` 等价流程（上游有 `probe-dsh-runtime.mjs` 可参考） | 调整 `executablePath` / 资源路径 |
| P4 | 渲染产物在 http:// 下可用 | 静态服务 `out/renderer`，注入桥，验证登录→建房→对话 | 排查 file:// 假设 |
| P5 | `command.window.control` / `command.updates.*` 缺失不炸 UI | 观察渲染层对 `NOT_FOUND` 的处理 | 提供空操作实现 |
| P6 | 无模块依赖 `RequestContext.senderId` 做窗口路由 | 静态检索 + 运行验证 | 按连接分配稳定 ID |

**M0 的产出是一份"能不能做"的实测结论**，若 P1/P2 失败，整个"同进程多租户"路线要改成进程/worker 隔离，架构不变但工作量上浮。

### M1 · 单用户跑通（1 周）
Dockerfile + compose、数据卷、五个平台服务、媒体路由、WS 桥、静态服务、一次完整对话 + 一次角色创作 + 一次卡片渲染。

### M2 · 多租户（2 周）
控制面库、注册登录、租户注册表与回收、租户目录隔离、配额与并发上限、`/media` 签名 URL、审计日志。

### M3 · 公网加固（1 周）
卡片隔离补丁（§7.3）、CSP 与响应头、CSRF/Origin 校验、容器加固、限流、备份脚本、升级演练、`check-upstream-diff` 接入 CI、AGPL 源码入口。

### 验收标准（可执行）
1. 两个租户并发使用，任何一方数据在对方界面不可见（含媒体 URL 越权尝试被拒）。
2. 恶意卡片（尝试 `parent.eleckoi.request('command.characters.delete', …)`）无法取得任何数据或造成变更。
3. `git rebase upstream/main` 在无冲突前提下完成，`check-upstream-diff` 通过。
4. 冷启动到首次对话 < 30 s；租户空闲回收后再次访问数据完整。
5. 备份→新容器→恢复，全链路可复现。

---

## 12. 风险登记表

| 风险 | 影响 | 概率 | 处置 |
|---|---|---|---|
| 上游 schema 变更导致全租户库拒启 | 服务不可用 | 中 | §9.3 版本钉死 + 迁移工具骨架 |
| cordis 多 Context 串台 | 数据泄露 | 低（已有审计证据支持） | M0-P1 先验证；worker 隔离兜底 |
| 卡片隔离补丁失配 | 安全或更新受阻 | 中 | 补丁失败即 CI 失败，人工复核 |
| SQLite 同步阻塞 | 性能 | 高（用户量上去后） | §8.2 分阶段演进 |
| DSH 子进程内存失控 | OOM | 中 | 并发上限 + 回收 + 容器内存限制 + PID 限制 |
| AGPL 合规漏做 | 法律 | 低 | M3 明确交付源码入口 |
| 上游把 Electron 耦合进模块层 | 复用面收窄 | 低 | `check-upstream-diff` 会先报警 |

---

## 13. 文件级任务清单（M1 参考）

```
src/web/
├── entry.ts                    启动：读配置 → 起 HTTP/WS → 起控制面
├── config.ts                   环境变量解析（端口、数据目录、masterKey、配额默认值）
├── WebHost.ts                  mountTenant(userId)：5 个平台服务 + 13 个上游模块插件 + WebGateway
├── TenantRegistry.ts           acquire/release/reap，实例表
├── control/
│   ├── ControlDatabase.ts      控制面库（用户/会话/配额）
│   ├── AuthService.ts          口令哈希、会话签发与校验
│   └── QuotaService.ts         配额检查与计数
├── platform/
│   ├── webPlatformPlugin.ts    ctx.provide 五个服务
│   ├── WebAppPaths.ts
│   ├── WebCredentialCipher.ts
│   └── WebMediaStore.ts        （或改用响应重写，二选一）
├── transport/
│   ├── WebGateway.ts           extends DesktopGateway
│   ├── wsEndpoint.ts           升级、鉴权、连接管理、请求分发
│   └── mediaUrlRewrite.ts      eleckoi-media:// → /media/v1/
├── http/
│   ├── server.ts
│   ├── staticAssets.ts         服务 out/renderer + 注入 web-bridge
│   ├── mediaRoutes.ts          签名 URL 校验 + 回源
│   ├── uploadRoutes.ts         导入文件上传
│   └── headers.ts              CSP 等安全响应头
└── shims/electron.ts

patches/0001-rich-frame-sandbox.patch
scripts/apply-patches.mjs
scripts/check-upstream-diff.mjs
docker/Dockerfile
docker/compose.yml
docker/Caddyfile
```

---

## 附：待你决策的两个点

1. **卡片隔离选 A / B / C**（§7.3）。我推荐 **A**：只有它同时满足"公网安全"和"卡片生态完整"，代价是 3–5 行渲染层补丁，用 `patches/` 承载以保住 git 树零修改。若坚持绝对零补丁，只能选 C，且**不应开放公网**。
2. **用户 Key 还是服务端 Key**。我推荐用户自带 Key（成本与合规都更干净），但这意味着 Agent 需要放行出口网络，需在使用条款中明示"Agent 具备联网能力"。
