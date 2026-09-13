# ElecKoi (github.com/eleckoi/ElecKoi) 项目解析

> 分析对象：`https://github.com/eleckoi/ElecKoi`，HEAD `0f55dac`（2026-09-12），本地副本 `/tmp/ElecKoi-win`。
> 方法：只读静态分析（4 路并行深挖 + 关键路径人工核对），未构建、未运行。

## 0. 仓库身份

| 项 | 值 |
|---|---|
| 名称 | ElecKoi（产品名「电子爱」，提交者署名 ElecGhost） |
| 定位 | **Windows 桌面版**客户端，Electron 41 + React 19 + TypeScript |
| 组织 / 许可证 | eleckoi / AGPL-3.0-or-later |
| 创建时间 | 2026-09-11T15:41Z |
| 提交数 | **仅 2 个**：`57a7cd3` Initial commit（501 文件 / 89395 行一次性导入）、`0f55dac` 更新截图 |
| 发布 | tag `v0.1.0`，GitHub Actions 已产出 `ElecKoi-0.1.0-x64-setup.exe`（160 MB，24 次下载）+ `.blockmap` + `latest.yml` → 自动更新链路已通 |
| 规模 | `src` 371 个文件；`src` + `packages` 约 37,073 行；`src/main` 94 个 `.ts` / 10,132 行 |

**与 Android 仓库的关系**：`ElecKoi`（本仓，Windows）= 桌面端；`ElecKoi-app` = Android 端（Kotlin Multiplatform，本地副本 `/tmp/eleckoi`，remote 指向 `ElecKoi-app.git`，已发到 v0.1.4）。Android 版 README 里那条未勾选的「开发 PC 端电子爱客户端」TODO，正是本仓补上的。两端共享同一套 `eleckoi_*` Agent 工具命名空间，代码注释多处标注 "Mirrors Android's ..."。

## 1. 它是什么

一个由 **DSH Agent 驱动的 AI 角色卡创作与演绎客户端**——即当前这个会话所用框架（DeepSeek Harness）被当作运行时内核嵌进了桌面应用。

三个产品主张：

1. **会自己查设定的角色 Agent**：角色演绎时主动检索设定库，只读取当前剧情所需片段，再调用变量 / 联网 / 其他工具继续演绎。
2. **Agent 参与创作**：创作 Agent 可搭建与修改角色、设定库、变量、正则、形象素材；改动先预览、校验，再由创作者决定保存。
3. **变量用工具调用更新，而不是文本协议**：Agent 输出里不写变量更新格式，改为调用专用工具（JSON Pointer 补丁 + Zod 校验），降低模型输出漂移；角色卡还能自带 HTML/CSS/JS/素材，把状态渲染成可交互界面。

官方承诺：Windows 与 Android 客户端永久免费开源、不内置付费功能、不推荐 API 中转站、无数据后台（本地运行）。

## 2. 总体架构

```
Renderer   React 19.2.8（100 × .jsx + 80 × .js + 2 × .ts，17k 行手写 CSS）
   ↕  window.eleckoi.request/subscribe   ← preload 仅 15 行，暴露面极窄
DesktopGateway   68 条 request + 9 条 event，zod 入参/出参双向 safeParse
   ↕
DesktopHost      cordis DI 容器（与 DSH 同款框架），两阶段装载 19 个插件
   ├ 数据：better-sqlite3 + drizzle（51 表 + 2 视图）
   ├ 领域：conversations / personas / settingLibraries / variables / regexRules / agentPresets / models …
   └ Agent 适配器：DshAgentRuntime
          ↓ fork 子进程：process.execPath + ELECTRON_RUN_AS_NODE=1
      DSH runtime（@deepseek-ai/dsh-sdk-jsonrpc-server，stdio JSON-RPC）
          ├ cordis.yml：27 项组合（22 个 npm 插件 + 5 个本地 .mjs）
          └ 每个预设物化一份 agent.cordis.yml：16 项
```

### 2.1 主进程即 cordis 容器

`src/main/main.ts` → `DesktopHost.mountFoundation()` / `mountInteractive()` 两阶段装载插件。这不是"用了 DSH 的几个包"，而是**整个应用宿主本身就是 cordis 插件树**，DSH 只是其中一个被适配的子系统——`scripts/check-architecture.mjs` 甚至强制 DSH 只能经 `src/main/modules/agent/DshAgentRuntime.ts` 访问。

### 2.2 Agent 不在主线程跑

`packages/dsh-runtime/src/DshRuntime.ts:267-333`：用 `process.execPath`（即 Electron 二进制）加 `ELECTRON_RUN_AS_NODE=1` 拉起独立 Node 子进程，入口 `@deepseek-ai/dsh-sdk-jsonrpc-demo/packaged-bin`，配置 `resources/dsh/cordis.yml`，经 `@deepseek-ai/dsh-sdk-client` 的 `DeepSeekHarness` 走 stdio JSON-RPC。

- **每会话一个 harness**，`settingsKey`（模型/工具策略/预设/联网设置）变化即销毁重建。
- **配置全靠环境变量注入**：30+ 个 `ELECKOI_*` 变量，`cordis.yml` 里用 `!!js process.env.…` 读；API Key、baseURL、上下文窗口、压缩阈值、子 Agent 模型全部如此。
- **状态经 JSON 桥文件双向传**：`eleckoi-variable-state.json`、`eleckoi-setting-library-state.json`、`eleckoi-conversation-context.json` 写在会话目录；工具子进程改文件 → 主进程回合结束后读回。
- **事务语义**：只有本轮出现 `turn/end` 才 `onVariableState` 回写落库（`DshRuntime.ts:170-178`），因此变量更新"随本回合成功完成后提交"。
- **预设即配置模板**：`agent-preset-template/agent.cordis.yml` 用 `# ELECKOI:<section>:BEGIN/END` 段标记工具组，物化时按用户策略整段删除，并按需注入子 Agent 的 provider/model 选项。

### 2.3 组合内容

`cordis.yml` 关键装配：`dsh-agent-spine-demo`（会话/工具/skills/jobs/goals/系统提示/循环，`maxParallelToolCalls: 4`、`toolBash: false`）、`dsh-llm-pi-ai`（双 provider：`eleckoi-upstream` 主模型 + `eleckoi-subagent` 子 Agent 模型，可分别配不同厂商）、`dsh-session-persistence-jsonl` + checkpoint + projection、`dsh-session-*`、子 Agent（`spawn` 可续 + `fork` 一次性）、`dsh-workflow-worker-thread`、`dsh-fs-local` / `dsh-pwsh-local` / `dsh-subprocess-local`、`dsh-token-meter`、`dsh-compaction-basic`、`dsh-web` + DeepSeek/Tavily 双搜索 provider。

依赖里 81 个 `@deepseek-ai/dsh-*`，但只有 34 个真正出现在组合文件中——其余约 45 个是生产闭包的版本钉死，由 `check-dsh-runtime.mjs` 保证与 `runtime-manifest.json`（upstream commit `b150a551…`、版本 `0.1.1-rc.2`）双向一致。

## 3. 数据层

- **单库 SQLite**：51 张业务表 + 2 视图 + 47 索引；权威定义 `resources/database/eleckoi-common-schema-v1.sql`，drizzle 映射与 TS 常量由脚本生成，`--check` 防漂移。
- **无迁移链**：`installSchema.ts` 硬编码 `BASELINE_ID` + `user_version = 1`，基线不符直接抛错拒绝启动（明示"不会自动转换或删除数据"）。0.1.0 阶段的取舍，但意味着**未来任何表结构变更都无法平滑升级**。
- **没有 `messages` 表**：消息 = `agent_turns` + `agent_responses` + `agent_content_parts`（64 KB 分块）组成的事件账本，顺序由 `agent_branch_turns(sequence)` 决定，投影靠手写 UNION SQL。每条 turn/response 带 `variableStateJson` 楼层快照 → 支持分支/重生成回滚。
- **变量三层**：设计期 `variable_configs` 版本树（带 DEFERRABLE 延迟外键）→ 运行期按会话 `chat_session_variable_states(initial|current)` → 楼层快照。
- **补丁协议**：`eleckoi_apply_variable_patch` 用 JSON Pointer，`op ∈ replace|delta|insert|remove`，1–200 条；先应用补丁，再执行作者提供的 `schemaCode`（Zod）校验，失败返回 `state_unchanged: true`；再做"归一化是否吞掉修改路径"检查。三态语义相当严谨。
- **设定库**：内容与链接分离 + revision 化（`setting_entry_contents` / `setting_library_entry_links` / `..._versions` + 两个视图还原），字段含 `agentReadStrategy(required|keyword|normal|variable_condition)`、`dynamicMode(single_condition|ejs_controller|ejs_reference)`、8 种 position 锚点。
- **author-sdk**：给角色卡作者前端页面的 37 个方法 / 16 项权限 JSON-RPC 契约（`0.2.0-preview.5`，stage=preview），注入 `window.ElecKoi`；限流 256 KB / 8 并发 / 10 s 120 次；**消息内嵌页面只放 7 项权限**。

## 4. 生态兼容

- **MVU / Tavern-Helper**：`packages/compatibility/mvu` 解析 `{{get_message_variable::}}` / `{{format_message_variable::}}`、`<StatusPlaceHolderImpl/>` 占位；注入**只读快照桥**（`getAllVariables` / `Mvu.getMvuData` / `eventOn` / 迷你 jQuery）与**受限动作桥**（`setChatMessages` 仅允许切换 `message_id=0` 开场白、`triggerSlash` 仅允许 `/send` 与 `/trigger`）。导入时解析 `tavern_helper.variables`、`[initvar]`、`[mvu_update]`、JS Schema → VariableConfig。
- **EJS**：以设定库 `dynamicMode` 承载，未内置上游运行库，属独立实现。
- **SillyTavern**：只做选择性格式兼容（角色卡、世界书），明确不以复刻其前端/扩展运行环境为目标。
- 兼容版本与工具名与 Android 端保持一致（`eleckoi_glob_setting_files`、`eleckoi_apply_variable_patch`、`eleckoi_capability_probe` …）。

## 5. 工程亮点（这块明显强于同类个人项目）

1. **架构约束脚本化**：`scripts/check-architecture.mjs` 强制目录闭集、分层禁依赖（Renderer 禁 electron/node/DB/DSH；Shared 禁一切 IO）、每模块唯一公开入口、模块图无环、**24 张表归属独占**、单文件 ≤600 行、禁 `localStorage`、`ipcRenderer` 仅限 preload、DSH 只能走适配器。违反即构建失败。
2. **依赖纪律**：`@deepseek-ai/*` 必须精确版本（禁 `^`/`~`）、所有 `dsh-*` 必须同一兼容批次、manifest ↔ cordis.yml ↔ 实际安装版本三方比对。
3. **门禁打穿到运行时与产物**：`electron-rebuild` 后在 Electron 内真实打开 better-sqlite3 并断言 51 表 / 2 视图 / 外键完整性；对 **app.asar 内**的 DSH runtime 做真实 `verify()` 握手。
4. **合规自动化**：由 lockfile 生成第三方声明（11,426 行），按 LICENSE 文本 SHA256 去重，CI 检查陈旧；NOTICE 逐项说明 Electron/Chromium、Sharp-libvips、OFL 字体、CC-BY 图标。
5. **Windows 原生适配**：`packages/windows-native-frame/src/native_frame.cpp` 用 `SetWindowSubclass` 为无边框窗口重建 DPI 感知的缩放命中区（`WM_NCHITTEST` 8 个 HT*）与 DWM 阴影，只把缩放命中转发 `DefWindowProcW` 以保留系统吸附；koffi 仅用于调用单个 C 导出，**刻意不让回调跨越 FFI 边界**。
6. **CI 在目标平台**（windows-latest）、pin pnpm/Node 版本、tag 必须等于 `package.json` version。

## 6. 问题清单

### 安全（按严重度）

1. **富内容 iframe 未加 `sandbox`**（`RichMessageFrame.jsx:109-118`）：`srcDoc` 与宿主**同源**、`index.html` 无 CSP、`postMessage(..., '*')`。原本设计的受控通道是「卡片 JS → postMessage → 父窗 → `command.author_sdk.invoke`（7–16 项权限）」，但同源让这道闸门形同虚设——卡片脚本可直接 `parent.eleckoi.request(...)` 调**全部 68 条 IPC**，包括 `command.characters.delete`、`command.conversations.delete`、`command.models.delete`。
2. **API Key 明文过桥**：`query.models.list` 返回的 `ModelConfig` 含 `api_key` 字段（`contracts/entities/model.ts:35`），虽有 `safeStorage` 加密入库，但解密后明文交渲染层——叠加第 1 条即等于卡片可读走用户全部密钥。
3. **Agent 无沙箱无审批**：`cordis.yml` 里 `dsh-user-approval` 设 `policy: never`，且 `dsh-sandbox` / `dsh-sandbox-policy` / `dsh-authorization` / `dsh-credentials` **未装配**——Agent 的 PowerShell / 文件工具以用户权限直接执行。
4. **密钥经环境变量传子进程**（含 Tavily、子 Agent Key），工具再拉起的子进程可继承。
5. **作者 `schemaCode` 走 `new Function` 执行**（`variable-tools.mjs:380-388`），角色卡内容在 Agent 运行时进程内获得代码执行能力。

### 工程债

6. **渲染层逃过类型检查**：`tsconfig.web.json` 开了 `strict` / `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`，但 `include` 只有 `.ts`/`.tsx`——而渲染层是 100 `.jsx` + 80 `.js` + **仅 2 个 `.ts`**，严格模式实际只覆盖 2 个文件。
7. **发布流水线不跑测试**：`release-windows.yml` 完整跳过 `pnpm test`（59 个测试只在 CI 跑），tag 发布可绕过。
8. **无迁移体系**：旧库一律拒绝启动，升级=用户重来。
9. **双份明文持久化**：产品库 SQLite + DSH 的 JSONL 会话日志（`userData/dsh-runtime/sessions`）内容重复且未加密。
10. **零星门禁漏洞**：`check-built-preload.mjs` 不清空 `out/`，二次构建近乎失效；原生模块处理不一致（只 rebuild better-sqlite3，`asarUnpack` 只列 better-sqlite3 + koffi）；非 Windows 上 `build-windows-native-frame.mjs` 静默 `exit 0`，`pnpm build` 会"通过"却缺 DLL。
11. **i18n 形同虚设**：`src/main/i18n/index.ts` 仅 2 条消息，main 层 168 处硬编码中文。
12. **文档薄**：`docs/` 只有 3 篇 open-problems + 1 张截图；无架构 / API / 贡献 / 发布文档。
13. **前端无代码分割**：无 `React.lazy` / 动态 import，多窗口复用同一 bundle 全量解析；17 k 行手写 CSS，Tailwind 实际只当变量层用。

## 7. 项目自陈的难题（`docs/open-problems/`）

项目主动公开了三个尚未解决的课题，且写明失败实验——这在开源项目里少见：

1. **Token 消耗与回复速度**：Agent 一轮可能多次请求 + 工具调用；如何压缩剧情而不丢人物关系/承诺/因果/语气、如何避免重复携带提示词与工具上下文、能否用历史管理子 Agent 且不反而更贵、如何同时度量请求数/Token/缓存命中/首字延迟。
2. **回复界面与最终正文稳定性**：现协议 `<FINAL>…</FINAL>`；**已判定失败的实验**是让 Agent 自己判断"哪次请求是最后一次"（误判阶段、反复调用失效操作、请求失控）；当前只靠"角色扮演计划把输出正文设为最后一项"提高概率，不能消除标签丢失。
3. **工具结果的长期记忆**：旧回合工具结果不再重发（合理的基础选择），但 user/assistant 正文仍每次全量重发，自评"没解决角色对话本身越来越长"。

## 8. 判断

- 这是一个**地基已成型、安全边界未建成**的 0.1.0。架构纪律（分层、契约、门禁、依赖锁定、原生适配）明显超出同类个人 Electron 项目一个身位；但产品最核心的卖点——角色卡自带 HTML/CSS/JS 的富内容前端——恰好是当前最薄的一环，同源 iframe 让它从"受控能力"变成"完全信任"。
- 产品路线清晰：不做"更好的聊天软件"，而是做 Agent 原生的角色创作工具链 + 创作者生态（README 明确谈了版权、商业模式与贡献者权利边界，并承诺官方客户端永久免费开源）。
- 若打算使用：注意它会让 Agent 以你的用户权限执行 PowerShell；自行确认可接受，并只导入可信来源的角色卡。
- 若打算参与：优先修 1–3 条安全项（iframe `sandbox="allow-scripts"` + 不给 same-origin、`api_key` 不出主进程、装配 `dsh-sandbox` 与审批策略），其次补迁移体系与渲染层类型检查。
