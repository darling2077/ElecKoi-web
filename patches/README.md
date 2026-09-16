# patches/ · 对上游源码的最小补丁

本目录承载**不得不改上游源码**的改动，使其在 git 树中不体现为「修改了上游文件」，
从而保住 `git rebase upstream/main` 的一条线更新能力。

## 约定

- 每个补丁一个文件，命名 **`NNNN-简短说明.patch`**（四位数字前缀，`git diff` 格式）。
- 补丁由构建前的 `scripts/apply-patches.mjs` 施加；**打不上即失败**，
  这正是上游改动到我们依赖的那几行时的告警点。
- 每增加一个补丁，必须在本文件登记：改了什么、为什么非改不可、如何验证。
- **上游自带同类修复时删掉我们的补丁**，不重复维护。先例：0003 曾修「块级 HTML 标签
  吞掉代码围栏」，上游 v0.1.1 的 `normalizeMarkdownForRendering.js` 修得更彻底，我们随即删除。

### ⚠️ 数字前缀不是风格问题，是硬约束（v0.1.2 起）

**上游 v0.1.2 开始，`patches/` 这个目录上游自己也在用了**——里面放的是 pnpm 包补丁：

```
patches/@deepseek-ai__dsh-llm@0.1.1-rc.2.patch
patches/@deepseek-ai__dsh-llm-pi-ai@0.1.1-rc.2.patch
patches/@deepseek-ai__dsh-sdk-jsonrpc-server@0.1.1-rc.2.patch
patches/@earendil-works__pi-ai.patch
```

它们由 `package.json` 的 `pnpm.patchedDependencies` 消费，**不是 git 补丁**。
两个后果，升级时都实际踩到了：

1. **`apply-patches.mjs` 不能按 `*.patch` 通配。** 拿它们去 `git apply` 必然失败
   （内部路径相对包根，目标文件在 `node_modules` 里）。现只认 `^\d{4}-.+\.patch$`。
2. **门禁解析补丁时同样要筛。** pnpm 补丁里的路径写作 `a/package.json`
   （指**该包自己的** package.json），不筛掉就会被当成**本仓库根** `package.json`
   的期望改动量，报出「补丁 +1/-1，实际 +22/-1」这种看起来毫不相干的错。

同理**不要整目录放行 `patches/`**：门禁白名单已改为按模式放行
（`patches/NNNN-*.patch` 与 `patches/README.md`），这样「上游删掉或改了自己的某个
pnpm 补丁」仍会被门禁抓到。

## 当前补丁

### 0001-local-media-path-separator.patch

- **改动**：`src/main/platform/filesystem/LocalMediaStore.ts`（+13/−5）。
- **为什么非改不可**：原实现把媒体根路径的 `\` 写死，在 POSIX 上所有媒体请求 404。
  Docker/Linux 部署下这是硬故障，不是偏好问题。
- **验证**：`pnpm webui:media`（媒体读写与签名 URL 走通）。

### 0002-cross-origin-card-frame.patch

- **改动**：`src/renderer/src/modules/authorFrontend/components/RichMessageFrame.jsx`（+24/−1）。
- **为什么非改不可**：卡片 iframe 原为 `srcDoc` 且与宿主同源，角色卡的 JS 可直接调用
  `parent.eleckoi.request()` 打穿全部 IPC。公网多用户形态必须隔离，
  改为加载独立的**卡片源**（跨源），方案见
  `docs/webui/ElecKoi-Docker-WebUI-多用户方案.md` §7.3（方案 A：跨源卡片域）。
  未配置卡片源时保持原行为（同源 `srcDoc`），因此桌面端不受影响。
- **验证**：`pnpm webui:cardisolation`（真实浏览器里验证恶意卡片取不到 `parent.eleckoi`）。

## ⚠️ 提交时不能带着补丁

`scripts/check-upstream-diff.mjs` 比对的是**工作树 vs 上游基线**
（`git diff --name-status <baseline>`）。因此补丁**已施加**的状态下直接提交，
门禁仍会判「通过」，但提交内容里已经包含了被修改的上游文件——
上游一旦改同一处，`git rebase upstream/main` 必然冲突。

**提交前必须先撤销补丁**，并断言上游文件在提交树中逐字一致：

```bash
node scripts/apply-patches.mjs --revert
git diff --name-only upstream/main          # 只允许 package.json（及已决定修改的 README.md）
# …提交…
git diff --name-only upstream/main HEAD -- src/main src/renderer   # 必须为空
node scripts/apply-patches.mjs              # 提交后再施加回来（构建需要）
```

## 为什么不用 fork 的方式改

直接改上游文件会让每次上游更新都产生冲突，而冲突解决的质量无法验证。
补丁 + 门禁（`scripts/check-upstream-diff.mjs`）能让「我们改过哪里」始终显式可审计。
