# GitHub 发布方案

> 本文面向「照着做就能发布」。所有命令都**已在本机临时副本中实测通过**（不涉及推送）。
> 文中出现的域名 / IP / 端口 / 邮箱一律为占位符；真实值见 `docker/.env`（已被忽略，不入库）。
>
> 配套阅读：`docs/webui/AGPL与GitHub-fork合规调研.md`（合规与平台机制的来源与引文）。

---

## 0. 结论速览（TL;DR）

| 问题 | 结论 |
| --- | --- |
| 发布形态 | **Fork `eleckoi/ElecKoi`，在我们 fork 上开 `webui` 分支并设为默认分支**；代价是必须公开 |
| 提交切分 | **4 个提交**（基建 / 服务端 / 容器 / 文档） |
| 提交前必做 | `node scripts/apply-patches.mjs --revert`，再确认 `git diff --name-only upstream/main` **只剩 `package.json`（若已改 README，还应有 `README.md`）** |
| `package.json` 会冲突吗 | 上游改 `version` → 不冲突（已实测）；上游也在 `scripts` 末尾加脚本 → 会冲突，但保留双方即可 |
| 脱敏 | 5 个文件需要改；**邮箱与 NAS 路径实际不在待提交集里**，截图为干净占位符 |
| 最大的坑 | **忘记撤销补丁，门禁照样通过**（实测确认），但 rebase 会冲突 |
| 必须用户先拍板 | 仓库名、是否接受公开、README 是否改上游文件、是否上 CI |

---

## 1. 环境与现状（已核实的事实）

以下均由本机命令实测得出，不是推断。

### 1.1 仓库状态

```
$ git remote -v
upstream  https://github.com/eleckoi/ElecKoi.git (fetch/push)
# 没有 origin，没有任何属于我们的提交

$ git log --oneline -4
37aeb07 修复自动更新退出时的主进程异常     ← HEAD == upstream/main == tag v0.1.1
fd30638 新增轨迹与动态设置并修复聊天显示
0f55dac 更新界面展示截图
57a7cd3 Initial commit                    ← tag v0.1.0

$ git tag -l
v0.1.0   # → 57a7cd3（Initial commit）
v0.1.1   # → 37aeb07（与 HEAD 相同）
```

- 上游许可：**AGPL-3.0-or-later**（`README.md` 第 125 行、`NOTICE` 均确认）。
- `git config user.name` / `user.email` **未配置** —— 提交前必须先设，否则 commit 直接失败。

### 1.2 待提交文件集（权威判定）

用 `git add --dry-run -A .` 得到**恰好 91 个文件**：

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| 上游文件被修改 | 3 | `package.json`、`LocalMediaStore.ts`、`RichMessageFrame.jsx` |
| 新增 | 88 | `src/web/`（64）、`docs/webui/`（含 5 张 png）、`docker/`、`patches/`、2 个脚本、`.dockerignore` |

其中 2 个上游文件的改动**是补丁施加的结果**，当前工作树处于「补丁已施加」状态（两条补丁均可反向校验通过）。

### 1.3 忽略规则核查（含两处对前提的更正）

| 路径 | 状态 | 依据 |
| --- | --- | --- |
| `docker/.env` | ✅ 已忽略 | `.gitignore:7` `.env` |
| `docker/.env.bak-1789246950` | ✅ 已忽略 | `.gitignore:8` `.env.*` |
| `out/` | ✅ 已忽略 | `.gitignore:31` |
| `node_modules/` | ✅ 已忽略 | `.gitignore:24` |
| `packages/*/dist` | ✅ **已忽略** | `.gitignore:30` `dist/` |
| `*.tsbuildinfo` | ✅ 已忽略 | `.gitignore:37`（`src/web/tsconfig.tsbuildinfo` 已覆盖） |
| `docker/.env.example` | ✅ **可提交** | `.gitignore:9` `!.env.example` 否定规则对任意目录生效 |

**两处更正**（与任务前提不同）：

1. **`dist/` 无需补忽略规则** —— 上游 `.gitignore` 第 30 行已有 `dist/`，`packages/*/dist` 实测均被忽略，待提交列表里 0 个 `dist/` 条目。
2. **反而不能随便改 `.gitignore`** —— 它是上游文件，而门禁只允许修改 `package.json`。实测追加一行规则后门禁报错：
   `可更新性门禁未通过：- 修改了上游文件：.gitignore（不允许；改用 patches/ 承载改动）`

### 1.4 工具可用性

- `node v24.18.0`、`pnpm 10.32.1` 可用。
- **`gh` CLI 未安装** —— 文档里的远程操作给 `git` 命令，不依赖 `gh`。
- `.githooks/` 存在但 `core.hooksPath` 未设置，**当前不生效**（其 `pre-push` 只拦"删除远端 main"和私密知识库路径，不拦我们的流程）。

---

## 2. A. 发布形态选择

### 2.1 三个候选

| 维度 | ① Fork 上游（分支 `webui`） | ② 独立仓库 + 导入上游完整历史 | ③ 独立仓库 + 压成初始提交 |
| --- | --- | --- | --- |
| 与上游共享 Git 历史 | ✅ 天然 | ✅（需主动导入全部 refs） | ❌ 历史断裂 |
| `git rebase upstream/main` | ✅ | ✅ | ❌ 不可用 |
| GitHub 自动显示「forked from」横幅 | ✅ | ❌ | ❌ |
| compare 视图展示与上游的 diff | ✅（同 fork 网络内可用） | ❌ **跨网络不可用**（已实测，见调研报告 §2） | ❌ |
| 能否设为私有 | ❌ **公开仓的 fork 必定公开** | ✅ | ✅ |
| 默认是否出现在搜索结果 | ❌ 不显示（需 `fork:true`/`is:fork`） | ✅ | ✅ |
| 向上游提 PR | ✅ 直接 | 需再建 fork | 需再建 fork |
| AGPL「醒目声明修改」的成本 | 低（横幅 + README） | 中（全靠 README/NOTICE） | 中 |

> 平台事实依据：fork 可见性绑定上游网络、fork 默认不进搜索，均见调研报告 §2（GitHub 官方文档原文）。

### 2.2 推荐：① Fork 上游，分支 `webui`

**为什么**：

1. **与本项目架构同构**。整套「上游可一条线更新」的机制（`patches/` + `check-upstream-diff` 门禁）建立在共享历史上；fork 是唯一零改造就满足它的形态。
2. **合规姿态最省事**。AGPL §5(a) 要求「醒目地标注你修改过」，fork 横幅 + 顶部 README 声明天然满足；独立仓库则完全靠自觉。
3. **社区可审计**。compare 视图能直接回答"你们相对上游改了什么"——这恰好是本项目最值得展示的东西（上游只碰了 2 处）。
4. **两个补丁值得回馈上游**。`0001` 修的是上游在 Linux/macOS 上的真实缺陷（媒体路径前缀用反斜杠拼接，导致 POSIX 下媒体全 404）。在 fork 上可以直接发 PR。
5. **有强先例且许可证同源**：`glitch-soc/mastodon`（双方 AGPL-3.0，README 首句声明 fork）、`MisskeyIO/misskey`（双方 AGPL-3.0，确在 fork 网络内）、`git-for-windows/git`（GPL-2.0，最强 copyleft 先例）。

**补充：上游是朋友的项目时，fork 是唯一合适的选择。**

这不再是纯技术权衡，而是关系维护问题：

- **fork 横幅就是"署名"**。GitHub 会在仓库名下方显示 `forked from <朋友>/ElecKoi`，
  任何人一眼就知道这是你的分支，而非另起炉灶。独立仓库没有这一行，容易被误读成"另立门户"。
- **回馈路径最短**。`0001` 修的是上游真实缺陷，在 fork 上可以直接向朋友发 PR；
  独立仓库则要先再建一个 fork 才能提。
- **朋友随时能看到你的进度**。他在自己的仓库页面就能看到 fork 列表，不必你去同步说明。
- **同步他的更新是天然的**。`git fetch upstream && git rebase upstream/main` 直接可用。

**建议先和朋友打个招呼**（一句话即可）：你做了 WebUI 分支、打算公开 fork、
两个补丁是否可以合并回上游。朋友的项目里出现公开 fork，事先说明远比事后解释轻松。
另外可以顺势问一句：**他愿不愿意把 WebUI 模式合并进上游**——本项目只碰了他 2 处源码，
合并成本很低；若能合，你连长期维护 fork 都省了。

**必须接受的两个代价**：

- **只能公开**。上游是公开仓库 → 我们的 fork 无法设为私有。若需要"先私有开发、成熟后再公开"，只能走 ②/③。
- **默认搜不到**。GitHub 仓库搜索默认排除 fork。补救：仓库 Description/About 写清楚、README 顶部写清楚、在社区渠道（上游 QQ 群、相关论坛）主动发帖。

**风险点**：

| 风险 | 触发条件 | 后果 | 缓解 |
| --- | --- | --- | --- |
| 上游删除或转私有 | 上游维护者动作 | fork 会分离成新网络（代码不丢，关系变化） | 本地/异地保留完整 clone 与 tag |
| 误点「Leave fork network」 | 手动操作 | **永久**失去 issues/PR/wiki/star/watch/子 fork，且**不可重连** | 不要去动 Settings → Danger Zone |
| 可发现性低 | 默认行为 | 新用户找不到 | README + About + 社区渠道 |

> 「Leave fork network」（脱离 fork 网络）是官方自助功能，但代价是元数据全丢且不可逆——**本方案明确不建议**。若确实需要独立仓库，正确做法是一开始就走 ②，而不是 fork 后再脱离。

### 2.3 备选：② 独立仓库（仅在"必须能私有"时选）

如果决策是**先私有开发**，则走 ②，但有一条硬性要求：

> **必须导入上游的完整 Git 历史**（`git clone --mirror` 或直接把现有本地仓库整体推到新 remote），
> **绝不能**用「上游代码 + 我们的改动」压成一个初始提交（即候选 ③）。

原因：③ 会让 `git rebase upstream/main` 失效（无共同祖先），等于废掉本项目最核心的"一条线更新"能力；而 ② 保留了共享历史，rebase 照常可用。

选 ② 的额外代价：
- 没有 fork 横幅、**compare 视图用不了**（跨 fork 网络不可用，实测反例包括 `torvalds/linux` ↔ `raspberrypi/linux`）；
- 必须在 README + NOTICE 里显式写明谱系与修改。这正是 yt-dlp、OpenTofu、Valkey、Nextcloud、VSCodium 的做法（实测它们全部 `fork: false`）。

---

## 3. B. 提交历史组织

### 3.1 补丁机制对提交的约束（已实测验证）

`patches/` 的设计意图是：**git 树里的上游文件必须与上游逐字一致**，改动只在构建时由 `apply-patches.mjs` 施加。因此提交前必须撤销补丁。

**实测 1 —— 撤销补丁确实能还原出干净的上游文件：**

```
# 撤销前
13  5   src/main/platform/filesystem/LocalMediaStore.ts
24  1   src/renderer/src/modules/authorFrontend/components/RichMessageFrame.jsx

$ node scripts/apply-patches.mjs --revert
已撤销：0001-local-media-path-separator.patch
已撤销：0002-cross-origin-card-frame.patch

# 撤销后与上游基线 37aeb07 比对
✅ 上游文件还原为逐字一致 —— 补丁不落盘为提交的机制成立
```

**⚠️ 实测 2 —— 门禁存在盲区，不能靠它兜底：**

如果把补丁**已施加**的状态直接提交，`check-upstream-diff.mjs` **依然判定通过**。
原因：门禁比对的是「工作树 vs 基线的增删行数」，补丁落盘后行数完全一致，它区分不了"改动在工作树"还是"改动在提交里"。

后果是致命的 —— 后续上游一旦改动同一文件，rebase 立即冲突（实测）：

```
$ git rebase upstream-sim
error: could not apply d3f819b... 错误的发布：补丁已落盘进提交
CONFLICT (content): Merge conflict in src/main/platform/filesystem/LocalMediaStore.ts
```

**所以提交前必须人工执行这条断言**（本方案把它列为强制步骤）：

```bash
git diff --name-only upstream/main
# 期望输出只有：package.json
# 若已按决策 4 修改 README，则还应有：README.md
```

**只要出现 `src/main/...` 或 `src/renderer/...`，就说明补丁没撤干净**，必须停下来排查。
（`package.json` 与 `README.md` 都在门禁白名单内，属于预期内的改动。）

### 3.2 `package.json` 怎么处理

**现状**：只新增了 20 个 `scripts`（`webui:*` / `check:upstream-diff`），其余字段与上游逐字一致。门禁对此有字段级强制检查：除 `scripts` 外任何字段不一致、或改动上游既有 script，都会失败。

**rebase 冲突分析（已实测两种场景）**：

| 场景 | 结果 | 说明 |
| --- | --- | --- |
| 上游改 `version`（v0.1.0 → v0.1.1 真实发生过） | ✅ **不冲突** | 改动在不同区域，git 三方合并自动完成 |
| 上游也在 `scripts` **末尾追加**脚本 | ⚠️ **冲突** | 我们追加的位置与上游相同 |

场景 2 的冲突是**良性且极易解决**的：双方都是"在对象末尾加键"，解决方式就是**两边都保留**。因为我们的脚本是 `webui:*` 前缀、上游不会用这个前缀，语义上不可能真冲突。

```jsonc
// 冲突时保留双方即可
"check:database-schema": "node scripts/generate-common-schema.mjs --check",
"upstream:新任务": "...",          // ← 上游新增
"webui:build": "..."               // ← 我们的
```

**建议**：保持我们的 `scripts` 追加在对象末尾（现状即可），不要为了"避让冲突"把上游文件结构改乱——那反而会触发门禁。

### 3.3 建议的提交切分：4 个提交

删掉"基建 / 服务端 / 容器 / 文档"的边界，每个提交自洽、可读、可单独回滚。

| # | 提交信息 | 内容 |
| --- | --- | --- |
| 1 | `chore(webui): 引入对上游的最小补丁机制与可更新性门禁` | `.dockerignore`、`patches/`、`scripts/apply-patches.mjs`、`scripts/check-upstream-diff.mjs`、`package.json` |
| 2 | `feat(webui): 新增 Docker 多用户 WebUI 服务端` | `src/web/` 全部（64 文件） |
| 3 | `feat(webui): 新增容器镜像与部署编排` | `docker/`（Dockerfile、compose、Caddyfile、备份脚本） |
| 4 | `docs(webui): 补充 WebUI 方案、进展与部署文档` | `docs/webui/`（含 5 张截图与本方案） |

> 风格说明：上游提交信息是朴素中文（如「修复自动更新退出时的主进程异常」）。我们采用 `type(scope): 中文描述` 的约定式前缀，好处是 `git log upstream/main..HEAD` 一眼能看出"这四个提交是我们的"。若希望与上游风格完全一致，可去掉前缀，只留中文描述。

> 备选：若希望 `src/web/` 更细，可拆成「平台适配层 / 多租户控制面 / HTTP 层」三个提交，但中间提交无法独立构建（第一个提交缺少依赖的模块），review 价值有限，不推荐。

### 3.4 精确命令序列（实测通过，勿直接粘贴执行推送）

```bash
cd /root/eleckoi

# ── 步骤 0：配置身份（当前未配置，不设则无法提交）──
git config user.name  "<你的 GitHub 用户名>"
git config user.email "<你的 GitHub 邮箱>"

# ── 步骤 1：撤销补丁，让上游文件回到与上游逐字一致 ──
node scripts/apply-patches.mjs --revert

# ── 步骤 2：【强制】断言上游文件已干净 ──
#     期望输出只有 package.json（已改 README 时再加 README.md）
#     多出任何 src/ 路径都必须停下来排查
git diff --name-only upstream/main

# ── 步骤 3：建工作分支 ──
git checkout -b webui

# ── 步骤 4：四个提交（逐个 add，避免误纳）──
git add .dockerignore patches/ scripts/apply-patches.mjs scripts/check-upstream-diff.mjs package.json
git commit -m "chore(webui): 引入对上游的最小补丁机制与可更新性门禁"

git add src/web/
git commit -m "feat(webui): 新增 Docker 多用户 WebUI 服务端"

git add docker/
git commit -m "feat(webui): 新增容器镜像与部署编排"

git add docs/webui/
git commit -m "docs(webui): 补充 WebUI 方案、进展与部署文档"

# ── 步骤 5：验证（两条都要过）──
git log --oneline upstream/main..HEAD          # 应看到 4 个提交
git diff --name-only upstream/main HEAD -- src/main src/renderer
#   ↑ 必须为空：证明上游源码在提交树里仍是原样
node scripts/check-upstream-diff.mjs           # 期望「可更新性门禁通过」

# ── 步骤 6：恢复本地工作树的补丁（继续开发/构建需要）──
node scripts/apply-patches.mjs
```

**实测输出（在临时副本中执行的结果）**：

```
=== 4) 我们的提交 ===
1230081 docs(webui): 补充 WebUI 方案、进展与部署文档
ab0b3e6 feat(webui): 新增容器镜像与部署编排
f0f8f9e feat(webui): 新增 Docker 多用户 WebUI 服务端
04ee400 chore(webui): 引入对上游的最小补丁机制与可更新性门禁

=== 5) 关键断言：上游源码文件在提交树里是否与上游逐字一致 ===
✅ 是（补丁未落盘）
=== 6) 门禁（提交后、补丁未施加）===
可更新性门禁通过：对上游仅有新增与受控补丁，rebase 预期零冲突。
=== 7) 恢复本地工作树补丁 ===
补丁 2 个：处理 2、跳过 0、失败 0
```

> 注意步骤 6：提交完成后本地工作树会重新变"脏"（两个补丁文件显示为已修改）。**这是本机制的正常稳态**，不是错误。

### 3.5 ⚠️ 必须同步修改：升级流程文档已失效

`docs/webui/上游升级流程.md` 第 3 步写的是：

```bash
git merge --ff-only upstream/main
```

这条命令**在我们有了自己的提交之后必然失败**（实测）：

```
$ git merge --ff-only upstream/main
fatal: Not possible to fast-forward, aborting.
```

它当初能用，是因为当时仓库零提交、HEAD 就等于 `upstream/main`。**发布之后必须改成 rebase**，并删掉"stash package.json"那一步（`package.json` 已成为提交的一部分，不再需要用 stash 挪开）：

```bash
# 1. 撤销补丁
node scripts/apply-patches.mjs --revert

# 2. 抓取上游
git fetch upstream --tags

# 3. 把我们的 4 个提交重放到新上游之上（替换原来的 merge --ff-only）
git rebase upstream/main

# 4. 重新施加补丁
node scripts/apply-patches.mjs

# 5.（其余步骤不变）重建 workspace 包 / 渲染产物 / 全量验收
pnpm build:workspace-runtime
pnpm exec electron-vite build
pnpm webui:verify
```

> 这条建议要在**发布前**落到 `上游升级流程.md` 里，否则文档会教出一个必然失败的命令。

### 3.6 ✅ 已修复：`patches/README.md` 内容过期

**原问题**：文件里「当前补丁」写着「（暂无）」，而实际已有 2 个补丁；「预留给 M3 的候选」里写的 `0001-rich-frame-sandbox.patch` 与实际文件名 `0002-cross-origin-card-frame.patch` 编号与命名都对不上。

**现已修复**：`patches/README.md` 已更新为真实清单（0001 媒体路径分隔符、0002 跨源卡片帧，各自记录改动/原因/验证命令），并新增「⚠️ 提交时不能带着补丁」一节，把本方案 §3.1 的断言写进了补丁目录自身的文档里。

同时 `docs/webui/上游升级流程.md` 也已同步：把 `merge --ff-only` 改为 `rebase`，并补上「断言与白名单必须同步演进」的说明。

---

## 4. C. 脱敏方案

> **执行状态：已完成（2026-09-13）**。实际命中 **30 处**（比预估的 26 处多 4 处，
> 差额来自 `*.<顶级域名>` 这类独立出现的泛域名）。替换后对全部 600 个待提交文件
> 重新扫描：**真实域名片段、内网 IP、邮箱、NAS 路径均为 0 处**（扫描用的字面关键词
> 刻意不写进本文件，避免把敏感值本身带进公开仓库——这正是本节要防的事）。
> 下文保留原始改法说明，作为复核依据。

### 4.1 待脱敏文件（已全量扫描确认，恰好 5 个）

扫描方法：`git ls-files --cached --others --exclude-standard`（并修正中文路径转义）后对全部待提交文件做正则匹配。

| 文件 | 命中位置 | 敏感内容 |
| --- | --- | --- |
| `docker/compose.yml` | 第 22 行注释 | 内网 IP |
| `docs/webui/M3-进展报告.md` | 第 187、190、191 行 | 内网 IP |
| `docs/webui/反向代理部署.md` | 多处 | 真实域名、端口、内网 IP、证书形态、隧道拓扑 |
| `src/web/poc/avatarCheck.ts` | 第 63 行 | 内网 IP（测试样例字符串） |
| `src/web/poc/proxyCheck.ts` | 第 29、30、170、171 行 | 真实域名、端口、内网 IP |

### 4.2 三处对任务前提的更正

1. **邮箱不在待提交集里**。全仓扫描仅在 `docker/.env` 与 `docker/.env.bak-*` 中找到，两者均被 `.gitignore` 第 7–8 行忽略 → **无需处理**。
2. **NAS 路径（形如 `/vol<N>/...` 的群晖路径）全仓不存在** → 无需处理。
3. **`docker/compose.yml` 里 `ELECKOI_CARD_ORIGIN` / `ELECKOI_APP_ORIGINS` 本来就是空占位**（`"${ELECKOI_CARD_ORIGIN:-}"`），不含真实域名。该文件唯一需要改的是第 22 行注释里的内网 IP。

### 4.3 逐文件改法

统一占位符约定（**建议固定下来，全项目一致**）：

| 用途 | 占位符 |
| --- | --- |
| 应用域 | `app.example.com` |
| 卡片域 | `cards.example.com` |
| 泛域名证书 | `*.example.com` |
| 局域网 IP | `192.0.2.10` |
| 对外端口 | `8443` |
| 容器内端口 | `8790` / `8791`（非敏感，保持原样） |

> `example.com` 是 RFC 2606 保留域，永不会被真实注册，是最合适的示例域名。

#### 4.3.1 `docker/compose.yml`（仅第 22 行）

```diff
     ports:
       # ELECKOI_BIND：默认只绑回环（本机可用）。要给局域网访问，设为该网卡的 IP
-      # （例如 ELECKOI_BIND=<该注释里现在写的真实内网 IP>），比 0.0.0.0 更收敛。
+      # （例如 ELECKOI_BIND=192.0.2.10），比 0.0.0.0 更收敛。
       - "${ELECKOI_BIND:-127.0.0.1}:${ELECKOI_PORT_HOST:-8790}:8790"
```

第 44–49 行的 `ELECKOI_CARD_ORIGIN` / `ELECKOI_APP_ORIGINS` **无需改动**（本就是空串）。若想顺带提升可读性，可在注释里补一行示例，但这不是脱敏必需：

```yaml
      # 公网示例：
      #   ELECKOI_CARD_ORIGIN=https://cards.example.com
      #   ELECKOI_APP_ORIGINS=https://app.example.com
      ELECKOI_CARD_ORIGIN: "${ELECKOI_CARD_ORIGIN:-}"
      ELECKOI_APP_ORIGINS: "${ELECKOI_APP_ORIGINS:-}"
```

#### 4.3.2 `src/web/poc/proxyCheck.ts`

第 29–30 行（域名 + 端口）：

```diff
-const PROXY_HOST = '<真实应用域名>:<真实对外端口>'
-const CARD_HOST = '<真实卡片域名>:<真实对外端口>'
+// 示例域名（RFC 2606 保留域）与示例端口：仅用于构造 Host / Origin 头，
+// 测试全程只请求本机回环地址，不解析也不连接这些主机名。
+const PROXY_HOST = 'app.example.com:8443'
+const CARD_HOST = 'cards.example.com:8443'
```

**不破坏测试可读性**：这两个常量本就是"示例性质"，用来演示"两个不同的源"。`APP_ORIGIN` / `CARD_ORIGIN` 由它们拼接，全部断言都是拿拼接结果互相比对，因此改值不影响任何断言语义。

第 170–171 行（局域网明文入口用例）：

```diff
     const plain = await viaProxy('/api/auth/login', {
       method: 'POST',
-      host: '<真实内网 IP>:8790',
-      origin: 'http://<真实内网 IP>:8790',
+      host: '192.0.2.10:8790',
+      origin: 'http://192.0.2.10:8790',
       body: { email, password }
     })
```

这里必须保留一个**与 `APP_ORIGIN` 不同的明文 http 源**（P-4 断言的正是"明文入口的 Cookie 不带 Secure"），换成任意内网 IP 均可。

**安全性确认**：已核对 `viaProxy()` 实现——它只把 `host`/`origin` 写进请求头，实际 `fetch` 打的是 `stack.server.url`（本机临时端口）。**不存在对示例域名的真实网络请求**，改值无副作用。

#### 4.3.3 `src/web/poc/avatarCheck.ts`（第 63 行）

```diff
       ['/media/v1/aa/avatar/bb.png?t=t_1&exp=2&sig=x', `${CANONICAL}aa/avatar/bb.png`],
-      ['http://<真实内网 IP>:8791/media/v1/aa/avatar/bb.png?t=t_1&sig=x', `${CANONICAL}aa/avatar/bb.png`],
+      ['http://192.0.2.10:8791/media/v1/aa/avatar/bb.png?t=t_1&sig=x', `${CANONICAL}aa/avatar/bb.png`],
       ['data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
```

这是纯函数 `restoreMediaReference()` 的样例输入，断言只关心"带源前缀的 URL 能被还原成 canonical 形式"，主机名可任意替换。

#### 4.3.4 `docs/webui/M3-进展报告.md`（第 187–191 行）

```diff
-export ELECKOI_BIND=<真实内网 IP>             # 或 0.0.0.0（暴露面更大）
+export ELECKOI_BIND=192.0.2.10           # 或 0.0.0.0（暴露面更大）
 export ELECKOI_PORT_HOST=8790              # 应用域
 export ELECKOI_CARD_PORT_HOST=8791         # 卡片域（必须与卡片域配置一致）
-export ELECKOI_CARD_ORIGIN=http://<真实内网 IP>:8791
-export ELECKOI_APP_ORIGINS=http://<真实内网 IP>:8790
+export ELECKOI_CARD_ORIGIN=http://192.0.2.10:8791
+export ELECKOI_APP_ORIGINS=http://192.0.2.10:8790
```

该文档其余处（第 29、116 行）**已经在用 `example.com`**，无需改动。

#### 4.3.5 `docs/webui/反向代理部署.md`（改动最多）

这份文档是**以"本机实际拓扑"口吻写的**，脱敏之外还建议改一下叙事人称，避免暴露真实部署。建议做全量替换 + 局部改写：

| 原文（当前文件里的真实值） | 替换为 |
| --- | --- |
| `<真实应用域名>` | `app.example.com` |
| `<真实卡片域名>` | `cards.example.com` |
| `*.<真实顶级域名>` | `*.example.com` |
| `<真实内网 IP>` | `192.0.2.10` |
| `<真实对外端口>` | `8443` |

**还需改写（非纯替换）的地方**：

1. 标题与开头：`# 公网部署：反向代理（lucky）+ 固定端口 + 子域分流` 下的「本机实际拓扑」，改为「示例拓扑」，表明这是可套用的参考架构而非某台机器的实录。
2. 第 10 行暴露了隧道规模与拓扑：
   `frp 隧道（frpc ×N，remote <真实对外端口> → local <真实对外端口>）或 home IPv6 直连`
   → 建议泛化为 `内网穿透隧道（frp 等）或 IPv6 直连`（去掉 `×5` 与 IPv6 细节）。
3. 第 35–36 行的「状态」列（`已配` / `已配（2026-09-12 验证通过）`）→ 改为 `已配置` / `已验证`，去掉具体日期。
4. 第 100–113 行的「公网实测（2026-09-12）」curl 示例 → 域名端口替换即可，日期可保留（无个人标识）或改为「实测」。
5. 第 20 行「证书是 `*.example.com`（泛域名）、DNS 是泛解析，都不用动；frp 也不用动」——替换后语义仍成立，保留。

### 4.4 截图核查结论：**无需处理**

对 `docs/webui/ui/*.png` 逐张目视检查 + PNG 文本块解析，结论：

| 截图 | 内容 | 结论 |
| --- | --- | --- |
| `account.png` | 账号页，显示 `appearance@example.com` | ✅ 已是占位符 |
| `admin-users.png` | 用户管理页，当前管理员 `appearance@example.com` | ✅ 已是占位符 |
| `app-reference.png` | 应用主界面右上角 `appearance@example.com` | ✅ 已是占位符 |
| `login.png` | 登录页，无账号信息 | ✅ 干净 |
| `login-dark.png` | 登录页深色模式，无账号信息 | ✅ 干净 |

另外解析了全部 5 张图的 PNG 元数据：**无 `tEXt`/`iTXt`/`eXIf` 等文本块**，不存在"图里干净、元数据里带路径/用户名"的情况。

> 特别确认了任务里点名的**账号页那张**：它显示的邮箱是 `appearance@example.com`，属于本项目的演示账号，**不是真实邮箱**。

### 4.5 额外发现的两处低风险泄露（建议一并处理）

| 文件 | 内容 | 建议 |
| --- | --- | --- |
| `docs/webui/凭据与主密钥.md` 第 74 行 | 本机绝对路径 `/root/eleckoi-backups/master-key.env` | 改为 `~/eleckoi-backups/master-key.env` 或 `<仓库之外的备份位置>/master-key.env` |
| `docs/webui/ElecKoi-仓库解析.md` 第 3、18 行 | 本地临时路径 `/tmp/ElecKoi-win`、`/tmp/eleckoi` | 可选：改为「本地克隆副本」。风险很低，不阻塞发布 |

> `docs/webui/AGPL与GitHub-fork合规调研.md` 与本文已扫描确认**不含**任何真实域名/IP/邮箱。

### 4.6 脱敏后自查命令

```bash
cd /root/eleckoi

# 应为空（把下面的占位串换成你真实的域名/IP/端口/邮箱后执行）
git ls-files --cached --others --exclude-standard -z \
  | xargs -0 grep -nE "<真实域名>|<真实内网IP>|<真实端口>|<真实邮箱>"

# 正向确认：只应看到占位符
git ls-files --cached --others --exclude-standard -z \
  | xargs -0 grep -nE "example\.com|192\.168\.1\.10" | head
```

---

## 5. D. 发布前检查清单

### 5.1 许可证合规（AGPL-3.0-or-later）

| # | 事项 | 状态 / 做法 | 依据 |
| --- | --- | --- | --- |
| 1 | 保留上游 `LICENSE` 全文 | ✅ **不要动它** | §4 |
| 2 | 保留版权声明与免责声明 | ✅ 上游文件保持原样即满足 | §4 |
| 3 | **醒目声明"我们修改过"并给出日期** | ⚠️ 待办 | §5(a) |
| 4 | 声明以本许可发布 | ⚠️ 待办（随 3 一起写） | §5(b) |
| 5 | 提供**对应源码**的获取途径 | ⚠️ 待办（见下） | §13 |
| 6 | 运行时向用户展示源码入口 | ✅ 已实现（`ELECKOI_SOURCE_URL` → 登录页"查看对应源代码"） | §13 |

**关于第 5 项（最容易做错）**：FSF FAQ 明文要求**完整可构建的源码，而不是只给 diff**
（"you need to provide complete sources, not just diffs"）。
好消息是：**发布整个仓库即满足** —— 仓库里有上游完整源码树 + 我们的新增 + `patches/`，
克隆后 `node scripts/apply-patches.mjs` 即得可构建源码，这正是"对应源码"。

但有一处**必须改**：

> `docker/.env` 里当前 `ELECKOI_SOURCE_URL=https://github.com/eleckoi/ElecKoi`（**指向上游**）。
> 按 §13，必须提供**我们这个版本**的源码，因此要改成我们发布的仓库地址。
> 同时建议打一个 tag（如 `webui-v0.1.1`）并在 `ELECKOI_SOURCE_URL` 里指向该 tag，
> 这样"运行中的版本"与"可获取的源码"能精确对应。

### 5.2 README 该写什么（面向"想自己部署一份"的人）

**这里有一个必须由用户拍板的取舍**：

上游 `README.md` 与 `NOTICE` 都是**上游文件**，修改它们会被门禁拦下（实测报错 `修改了上游文件：.gitignore`，同理适用）。

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A（推荐）** | 把 `README.md`、`NOTICE` 加入门禁的 `ALLOWED_MODIFICATIONS`，在 README **顶部**插入 fork 声明 + 部署指引，上游正文保留在下方 | GitHub 落地页直接呈现部署信息；满足 §5(a) 醒目声明 | 上游若大改 README 可能冲突（已实测：我们在顶部加段、上游改中段 → **不冲突**） |
| **B（保守）** | 不动上游 README/NOTICE，把部署文档放 `docs/webui/README.md` | 零冲突风险，门禁完全不用改 | 仓库落地页仍是"Windows 桌面应用"说明，与"想部署 WebUI"的读者错位 |

方案 A 的门禁改动（`scripts/check-upstream-diff.mjs` 第 36 行，该文件是我们的新增文件，改它不受限）：

```js
/** 允许直接修改的上游文件（package.json 另有字段级约束）。 */
const ALLOWED_MODIFICATIONS = new Set(['package.json', 'README.md', 'NOTICE'])
```

> 这会让 README/NOTICE 失去字段级校验（不像 `package.json` 那样有强约束）。考虑到两者都是纯文档、且冲突可人工轻易解决，这个放松是可接受的；**不建议**把 `src/` 下的文件加进去。

**README 正文建议包含（面向自部署者）**：

1. **顶部声明块**（AGPL §5(a)）：
   > 本仓库是 [ElecKoi](https://github.com/eleckoi/ElecKoi) 的 WebUI 分支，在 v0.1.1 基础上改造为 Docker 部署的多用户 WebUI 服务，修改日期 2026-09。上游原始 README 见下方。
2. **一句话定位**：把 Windows 桌面应用变成可公网部署的多用户 Web 服务。
3. **快速开始**（复制即可跑）：
   ```bash
   export ELECKOI_MASTER_KEY=$(openssl rand -base64 32)
   docker compose -f docker/compose.yml up -d --build
   # 浏览器打开 http://127.0.0.1:8790/login，注册的第一个账号自动成为管理员
   ```
4. **环境变量表**：至少覆盖 `ELECKOI_MASTER_KEY`（**必填，丢了所有 API Key 解不开**）、`ELECKOI_BIND`、`ELECKOI_PORT_HOST`、`ELECKOI_CARD_PORT_HOST`、`ELECKOI_CARD_ORIGIN`、`ELECKOI_APP_ORIGINS`、`ELECKOI_SOURCE_URL`、`ELECKOI_ALLOW_REGISTRATION`、`ELECKOI_TRUST_PROXY`、`ELECKOI_MAX_LIVE_TENANTS`。
5. **公网部署必读**：卡片域必须与主域**不同源**（否则角色卡可触达宿主 IPC），指向 `docs/webui/反向代理部署.md`；提醒反代读超时 ≥300s（`POST /api/rpc` 同步等整个回合）。
6. **与上游的关系**：列出 2 个补丁改了什么、为什么必须改；说明 `node scripts/check-upstream-diff.mjs` 与 rebase 更新流程。
7. **数据与备份**：`eleckoi-data` 卷、主密钥备份的重要性、`docker/backup-tenants.mjs`。
8. **许可证**：AGPL-3.0-or-later，指向 `LICENSE`。

**建议添加 `docker/.env.example`**（实测**可以提交**，`!.env.example` 否定规则生效）：把 `docker/.env` 去掉真实值后作为模板，能显著降低自部署者的门槛。

### 5.3 GitHub Actions

| 事项 | 结论 |
| --- | --- |
| 现有 workflow | 上游有 2 个：`desktop-ci.yml`（Windows，push 到 main / PR 触发）、`release-windows.yml`（推 `v*` tag 触发，构建 Windows 安装包） |
| 在 fork 上是否跑 | **默认不跑**，需手动在 Actions 页启用 |
| 能否删除/修改这两个文件 | ❌ **不能** —— 它们是上游文件，删除会触发门禁「删除了上游文件」 |
| 是否建议加 CI | 可选。若加，新文件放 `.github/workflows/`，而该前缀**不在门禁白名单内** → 需把 `.github/workflows/` 加进 `ALLOWED_ADDITIONS` |
| ~~推荐做法~~ **已实施** | 加了 `.github/workflows/web-image.yml`：推 `webui-v*` tag 时构建镜像推到 ghcr.io，并在构建成功后创建 Release。白名单已加入 `.github/workflows/`（只放行该子目录，上游那两个 workflow 若被改动/删除仍会被门禁拦下）。本地 `pnpm webui:verify` 仍是主验收门禁，CI 不重复跑它 |

**⚠️ 一条容易踩的坑**：`release-windows.yml` 的触发条件是 `push: tags: ['v*']`。
如果发布时顺手 `git push --tags`，而 fork 又启用了 Actions，就会**触发上游的 Windows 发布流程**。
→ **不要推 `--tags`**；如需 tag，用 `git push origin <tag>` 精确推送，且 tag 名避开 `v*`（例如 `webui-v0.1.1`）。

### 5.4 `.gitignore` 是否需要补充

**结论：不需要，且不应改。**

- `dist/` 已在第 30 行被忽略（实测 `packages/*/dist` 全部被忽略，待提交列表 0 个 `dist/` 条目）。
- `out/`、`node_modules/`、`.env`/`.env.*`、`*.tsbuildinfo` 均已被上游规则覆盖。
- **改 `.gitignore` 会被门禁拦下**（它是上游文件，实测报错）。
- 若将来确实需要新规则（例如某个只属于我们的产物目录），正确做法是**写进 `patches/`**，而不是直接改文件；但那样会给 `.gitignore` 增加 rebase 冲突面，**非必要不做**。
- 本地临时忽略（不想入库的）可用 `.git/info/exclude`，不影响仓库。

### 5.5 首次推送命令

以下命令**不要由我执行**，请用户确认后自行执行。

```bash
# ── 前提：已在 GitHub 网页上点击 Fork 得到 <你的用户名>/ElecKoi ──

cd /root/eleckoi

# 1. 添加我们 fork 为 origin，并把 upstream 语义固定为上游
git remote add origin git@github.com:<你的用户名>/ElecKoi.git
git remote -v      # 确认：origin=我们的 fork，upstream=eleckoi/ElecKoi

# 2. 只推 webui 分支（不要 --tags，理由见 5.3）
git push -u origin webui

# 3. 在 GitHub 仓库 Settings → Branches 把默认分支切到 webui
#    （否则访问者落地在 main = 纯上游桌面版代码，会非常困惑）

# 4. 设置仓库 About：Description 写清"ElecKoi 的 Docker 多用户 WebUI 分支"，
#    Topics 建议：eleckoi, webui, docker, self-hosted, roleplay, agpl
```

**推送后**（在另一台机器或临时目录克隆验证，确保发布出去的东西真的是可用的）：

```bash
git clone --branch webui https://github.com/<你的用户名>/ElecKoi.git /tmp/verify-clone
cd /tmp/verify-clone
node scripts/apply-patches.mjs          # 应成功施加 2 个补丁
docker compose -f docker/compose.yml up -d --build
```

> ⚠️ 注意：`check-upstream-diff.mjs` 在**全新克隆里会因找不到基线而失败或误判**。
> 实测：没有 `upstream` remote 时它会退化到 `v0.1.0` tag（= Initial commit），
> 于是把上游 v0.1.0→v0.1.1 的正常改动误报成"我们改了上游文件"，输出 46 个虚假错误。
> **必须在 README/升级文档里写明**：克隆后先执行
> `git remote add upstream https://github.com/eleckoi/ElecKoi.git && git fetch upstream`，
> 或显式指定基线 `node scripts/check-upstream-diff.mjs v0.1.1`。
> （更好的做法是把脚本的候选列表从 `['upstream/main', 'v0.1.0']` 改成
> `['upstream/main', 'v0.1.1']` —— 但那是代码改动，本次不执行。）

### 5.6 关于 tag 与版本号（两件不同的事）

**tag 是什么**：git 标签，给某个 commit 起一个**固定不变**的名字（如 `v0.1.1`）。
分支会随提交不断前移，**tag 不会** —— 所以 tag 用来标记"这就是某个发布版本的源码"。

**tag ≠ 改版本号**，两者完全独立：

| | git tag | `package.json` 的 `version` |
| --- | --- | --- |
| 是什么 | 仓库里的一个书签，指向某个 commit | 应用代码里的版本字符串 |
| 是否改仓库文件 | 否（只加一个引用） | 是（改文件内容） |
| 本项目能否动 | ✅ 可以 | ❌ **不能**（会触发门禁，见下） |

**⚠️ 本项目不能改 `package.json` 的 `version`**：门禁强制"除 `scripts` 外不得改动上游声明"。实测把 `version` 改成 `0.2.0` 会直接失败：

```
可更新性门禁未通过：
- package.json 的 "version" 与基线不一致；除 scripts 外不得改动上游声明。
```

而且**这个限制是好事**：`version` 恰好是上游每次发版必改的那一行。如果我们也改它，
就会在**每一次**上游更新时稳定冲突——正是本项目最想避免的事。

**那怎么表达"我们自己的版本"？** 三种方式，推荐前两种：

1. **用 git tag 表达**（不碰任何文件）。建议命名 `webui-v0.1.1`，含义是"基于上游 v0.1.1 的 WebUI 分支"。
2. **用环境变量表达**：`src/web/entry.ts:46` 读的是
   `process.env.ELECKOI_VERSION ?? '0.1.0-web'` —— **它不读 `package.json`**。
   设 `ELECKOI_VERSION=1.0.0` 即可让运行中的服务显示你自己的版本号（可在 `docker/compose.yml` 里加一行）。
3. 在 README 里写清"基于上游 v0.1.1"。

**现在要不要打 tag？** 已实施 —— 首个版本 tag 为 `webui-v0.1.1`：

- 推 tag 会触发 `.github/workflows/web-image.yml`：构建镜像 → 推 `ghcr.io/darling2077/eleckoi-web:0.1.1`
  与 `:latest` → 构建成功后用 `docs/webui/发行说明.md` 作正文创建 Release。
- **顺序很重要**：Release 由 CI 创建，不要手动再建一个（会撞车）。
- tag 指向固定 commit，所以 `ELECKOI_SOURCE_URL` 指向它才是 AGPL §13 要的"对应源码"；
  指向分支会随分支前移而漂移。
- 发下一个版本：先更新 `docs/webui/发行说明.md`，再打 `webui-v<下一个版本>` tag。

### 版本号约定

**三段版本，每个版本一个 tag，不设子标签。**

| tag | 镜像 tag | 含义 |
| --- | --- | --- |
| `webui-v0.1.1` | `0.1.1` | 基于上游 v0.1.1 |
| `webui-v0.1.2` | `0.1.2` | 基于上游 v0.1.2（含其修订版 8f61b29） |
| `webui-v0.1.3` | `0.1.3` | 下一次发布 |

规则：

- **上游发版时对齐上游的版本号**（上游发 v0.1.3 → 我们发 `webui-v0.1.3`）。
- **上游没动、我们自己要发修补时，patch 位顺延**（0.1.3、0.1.4……），
  并在 Release 正文里写明基于哪个上游提交。
- 与上游撞号也无需回避：两个仓库各自独立编号，读者看的是本仓库的 Release。

> **曾经短暂用过四段版本**（`webui-v0.1.2.1`）来区分"同一上游版本上的第几次修补"，
> 已废弃：用户明确要求不要子标签。`webui-v0.1.2.1` 的 tag 与 Release 均已删除，
> `webui-v0.1.2` 被移动到当时的最新提交（上游自己也强制移动过 `v0.1.2`，重新发布是正常操作）。

**发布工作流是幂等的**：`gh release view` 存在则 `gh release edit`、不存在才 `create`，
所以移动 tag 后重新发布不会因为"Release 已存在"而失败。

**⚠️ tag 命名必须避开 `v*`**：上游的 `.github/workflows/release-windows.yml` 触发条件是
`push: tags: ['v*']`。如果你打了 `v0.2.0` 这类 tag 并推送、而 fork 又启用了 Actions，
就会触发**上游的 Windows 打包发布流程**（大概率失败或产生奇怪的 release）。
用 `webui-v0.1.1` 这类前缀可完全避开。

---

## 6. 风险登记表

| # | 风险 | 严重度 | 触发条件 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | 补丁落盘进提交，门禁却不报警 | **高** | 忘记 `--revert` | 强制 `git diff --name-only upstream/main` 断言：只允许出现 `package.json`（及已决定修改的 `README.md`），见 §3.1 |
| R2 | fork 必须公开 | 中 | 平台规则 | 预先接受；否则改走独立仓库方案（§2.3） |
| R3 | 真实域名/IP 泄露 | 中 | 漏改文件 | 按 §4 清单改 + §4.6 自查命令 |
| R4 | `ELECKOI_SOURCE_URL` 仍指向上游 | 中 | 忘记改配置 | 列入 §5.1 第 5 项待办 |
| R5 | 升级文档教出必然失败的 `--ff-only` | 中 | 未同步 §3.5 | 发布前先改 `上游升级流程.md` |
| R6 | `git push --tags` 触发上游 Windows 发布流程 | 低 | 顺手推 tag | 只推分支；tag 避开 `v*` |
| R7 | 新克隆下门禁误报 | 低 | 无 upstream remote | README 写明先加 upstream（§5.5） |
| R8 | fork 默认搜不到 | 低 | 平台规则 | About + README + 社区渠道 |
| R9 | 误操作 Leave fork network | 低 | 手动 | 不碰 Danger Zone；不可逆 |

---

## 7. 待用户决策的问题清单

请逐条拍板，这些直接决定文档后续怎么落地。

> **已确认（2026-09-13 用户答复）**：
> - 上游是**朋友的项目** → 决策 1 选 **A. Fork**（理由见 §2.2 补充）。
> - **README 确定要改**（本改造本质上是上游的一个分支形态）→ 决策 4 选 **A**，
>   因此必须同步把 `README.md`、`NOTICE` 加入门禁白名单（改法见 §5.2）。
> - 关于 tag 的疑问已解答 → 见 §5.6（**tag 不是改版本号**；且本项目改 `package.json`
>   的 `version` 会被门禁拒绝）。

### 决策 1：发布形态（最关键）　→ 已定：A

- [x] **A. Fork 上游，分支 `webui`**（推荐）—— 必须公开，换来 fork 横幅 + compare 视图 + 顺畅 rebase
- [ ] **B. 独立仓库 + 导入上游完整历史** —— 可先私有；代价是无横幅、compare 不可用、须自证谱系
- [ ] C. 其他：____________

> 若选 B，请确认「导入完整历史」而非压成一个初始提交 —— 后者会废掉 rebase 能力。

### 决策 2：仓库名

- [ ] 沿用 fork 默认名 `ElecKoi`（推荐，fork 场景下改名会让横幅关系不易读）
- [ ] 改名，例如 `ElecKoi-WebUI`：____________

### 决策 3：公开还是私有

- [ ] 立即公开
- [ ] 先私有（**注意：选此项则决策 1 只能选 B**，因为公开仓的 fork 无法私有）

### 决策 4：README 方案　→ 已定：A

- [x] **A. 改上游 `README.md`**（顶部加 fork 声明 + 部署指引），并把 `README.md`、`NOTICE` 加入门禁白名单（推荐）
- [ ] B. 不动上游 README，部署文档只放 `docs/webui/README.md`（落地页仍是桌面版说明）

> 此项同时决定 AGPL §5(a)「醒目声明修改」怎么落地。
>
> **选定 A 之后的必做改动**（`scripts/check-upstream-diff.mjs` 第 36 行）：
> ```js
> const ALLOWED_MODIFICATIONS = new Set(['package.json', 'README.md', 'NOTICE'])
> ```
> 不加这一行，改 README 会让门禁直接失败（实测报错 `修改了上游文件：…`）。
> 已实测：我们在 README 顶部加段、上游改 README 中段 → rebase **不冲突**，风险可接受。

### 决策 5：发布范围与命名

- [ ] 分支名用 `webui`（推荐）还是别的：____________
- [ ] 是否同时打 tag？（**tag 是什么、要不要打，见 §5.6**）首次发布可不打；
      若打，建议 `webui-v0.1.1`（**避开 `v*`**，否则触发上游 Windows 发布流程）
- [ ] 是否把 `docs/webui/` 全部文档（含 M0–M3 进展报告、本方案、合规调研）一起公开？
  - 这些文档记录了大量内部推理过程，公开有助于建立信任，但也会暴露踩坑史
  - [ ] 全部公开（推荐）　[ ] 只公开面向部署者的部分（`README`、`反向代理部署`、`上游升级流程`）

### 决策 6：CI　→ 已定：加「构建并发布镜像」作业

- [ ] ~~暂不加 Actions，用本地 `pnpm webui:verify`~~
- [x] 加 Actions（已把 `.github/workflows/` 加入门禁白名单）
  - 实际加的不是"最小 Linux CI"，而是 **`web-image.yml`：推 `webui-v*` tag 时
    构建镜像推到 ghcr.io 并创建 Release**。理由是首次构建要 20–40 分钟，
    让每个用户各自构建一遍是纯浪费；发一个现成镜像价值最大。
  - 本地 `pnpm webui:verify`（16 组、137 项断言）仍是主验收门禁，CI 不重复跑。

### 决策 7：作者身份与提交署名

- [ ] `git config user.name` / `user.email` 用什么？（当前**未配置**，不设无法提交）
- [ ] 是否用 GitHub 的 noreply 邮箱隐藏真实邮箱？

### 决策 8：两个补丁是否回馈上游

- [ ] 是 —— `0001`（POSIX 媒体路径分隔符）是上游真实缺陷，值得提 PR（fork 路线下可直接提）
- [ ] 否，仅自用

---

## 附录 A：本次实测清单（可复现）

所有结论均在 `/tmp` 下的临时副本中验证，**未触碰 `/root/eleckoi` 的工作树，未执行任何 push**：

| 实验 | 结论 |
| --- | --- |
| 补丁撤销后与 `37aeb07` 比对 | ✅ 逐字一致 |
| 补丁在无 `.git` 目录下可用（模拟 Docker 构建上下文） | ✅ 可用（`git apply` 不依赖仓库） |
| 干净 clone 上施加补丁 | ✅ 成功 |
| 补丁已施加状态下提交 → 跑门禁 | ⚠️ **误判为通过**（盲区） |
| 同上，再让上游改同一文件 → rebase | ❌ 冲突（证明盲区后果） |
| 我们改 `package.json` scripts + 上游改 `version` → rebase | ✅ 不冲突 |
| 我们追加 script + 上游也追加 script → rebase | ⚠️ 冲突（保留双方即可） |
| 我们在 README 顶部加段 + 上游改 README 中段 → rebase | ✅ 不冲突 |
| 有自有提交后 `git merge --ff-only upstream/main` | ❌ `fatal: Not possible to fast-forward` |
| 有自有提交后 `git rebase upstream/main` | ✅ 成功 |
| 改 `.gitignore` → 跑门禁 | ❌ 被拒（`修改了上游文件`） |
| 无 `upstream` remote 时跑门禁 | ⚠️ 退化到 `v0.1.0`，产生 46 个虚假错误 |
| 完整 4 提交流程端到端 | ✅ 通过，且上游源码在提交树中保持原样 |
| `git add --dry-run -A .` 文件数 | 恰好 91，无 `.env` / `out/` / `node_modules/` / `dist/` |
| 5 张 PNG 目视 + 元数据解析 | ✅ 全部干净，无真实邮箱 |

## 附录 B：本文档未覆盖的事项

- 具体仓库名、GitHub 账号、SSH key 配置 —— 由用户决定。
- Docker 镜像的发布（是否推送到 GHCR/Docker Hub）—— 本次范围只到源码仓库。
- 上游 PR 的具体流程 —— 取决于决策 8。
