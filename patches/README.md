# patches/ · 对上游源码的最小补丁

本目录承载**不得不改上游源码**的改动，使其在 git 树中不体现为「修改了上游文件」，
从而保住 `git rebase upstream/main` 的一条线更新能力。

## 约定

- 每个补丁一个文件，命名 `NNNN-简短说明.patch`（`git diff` 格式）。
- 补丁由构建前的 `scripts/apply-patches.mjs` 施加；**打不上即失败**，
  这正是上游改动到我们依赖的那几行时的告警点。
- 每增加一个补丁，必须在本文件登记：改了什么、为什么非改不可、如何验证。
- **上游自带同类修复时删掉我们的补丁**，不重复维护。先例：0003 曾修「块级 HTML 标签
  吞掉代码围栏」，上游 v0.1.1 的 `normalizeMarkdownForRendering.js` 修得更彻底，我们随即删除。

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
