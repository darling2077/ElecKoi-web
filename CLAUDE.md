# CLAUDE.md

给 AI 编码助手的指引。人类读者请从 `README.md` 与 `docs/webui/` 开始。

> **为什么这个文件叫 `CLAUDE.md` 而不是 `AGENTS.md`？**
> 上游 `.gitignore` 第 40 行把 `/AGENTS.md` 归入「Local maintenance and review material」
> 有意排除（作者把它当本地材料）。本 fork 想公开这份指引，又不想去改上游的 `.gitignore`，
> 于是改用同为主流约定、且未被忽略的 `CLAUDE.md`。
> **请不要"顺手"把它改回 `AGENTS.md`**——那个名字提交不上去。

## 这是什么

`eleckoi/ElecKoi` 的 **fork**。上游是 Windows/Android 桌面客户端；
本分支（`webui`）让同一套内核以 **Docker 多用户 Web 服务**运行。

## 一键部署

```bash
cp docker/.env.example docker/.env
openssl rand -base64 32        # 生成主密钥，填进 ELECKOI_MASTER_KEY
$EDITOR docker/.env
docker compose -f docker/compose.yml up -d --build
```

完成后打开 `http://127.0.0.1:8790/login` 注册第一个账号（自动成为管理员）。

**首次构建约 20–40 分钟**（apt 依赖 + 886 个 pnpm 包 + Electron 相关下载）。
这不是卡住，请勿中断。

## 部署时必须知道的约束

- `ELECKOI_MASTER_KEY` **一旦设定永不更换**。它是唯一能解开用户已存 API Key 的东西，
  换掉后那些 Key 全部无法解密且不可恢复。缺失时 compose 会直接报错并给出生成命令。
- **公网部署必须同时配** `ELECKOI_CARD_ORIGIN` 与 `ELECKOI_APP_ORIGINS`，
  且两者是**不同的源**。只配前者服务启动即失败。
- `ELECKOI_SECURE_COOKIES=1` 只在**仅经 HTTPS** 访问时使用。局域网明文访问时设它会
  导致 Cookie 被浏览器丢弃、登录不上。挂反向代理时通常只需开 `ELECKOI_TRUST_PROXY=1`。
- 反向代理后必须开 `ELECKOI_TRUST_PROXY=1`，否则所有用户共用一个代理 IP，
  累计十次登录失败会让**全站**被限流十五分钟。
- 反向代理的后端读超时需 ≥300 秒：`POST /api/rpc` 会同步等待整个 Agent 回合结束才返回。
- **升级旧部署时不要绕过容器入口脚本**（`docker/entrypoint.sh`）：它会在服务启动前
  跑一次幂等的数据迁移。上游改 schema 常量名却不给迁移时（v0.1.2 的预设内容键
  `tool_policy` → `tool_configuration` 就是），老库会静默不兼容、预设页面直接报错。
  若数据卷文件属主不是 uid 10001，迁移会失败并在日志里给出 `chown` 命令；
  **迁移失败不会阻止服务启动**。`ELECKOI_AUTO_MIGRATE=0` 可关闭自动迁移。

## 改代码前必读

本仓库用 `patches/` + `scripts/check-upstream-diff.mjs` 维持「上游可一条线 rebase」：

- **不要直接编辑上游文件**（`src/main/`、`src/renderer/`、其余非本 fork 新增的文件）。
  必须改的走 `patches/`，由 `scripts/apply-patches.mjs` 施加。
- 提交前必须 `node scripts/apply-patches.mjs --revert`，否则补丁会落盘进提交，
  上游改同一处时 rebase 必冲突（门禁看不出这个问题，详见 `patches/README.md`）。
- 改动后跑：`pnpm check:upstream-diff`（可更新性门禁）与 `pnpm webui:verify`（全量验收）。
- `pnpm webui:verify` 里的浏览器检查跑的是 `out/renderer/` **构建产物**；
  改了渲染层源码必须先 `pnpm exec electron-vite build`，否则测的是旧前端。

## 详细文档

| 文档 | 内容 |
| --- | --- |
| `docs/webui/ElecKoi-Docker-WebUI-多用户方案.md` | 架构、多租户模型与取舍 |
| `docs/webui/反向代理部署.md` | 公网部署（子域分流、代理头、超时） |
| `docs/webui/凭据与主密钥.md` | 主密钥为什么不能换、坏了怎么排查 |
| `docs/webui/上游升级流程.md` | 跟进上游更新的标准步骤与坑 |
| `docs/webui/自有页面外观.md` | 登录/账号/管理页如何与应用本体保持一致 |
| `docs/webui/GitHub-发布方案.md` | 发布与提交切分 |
