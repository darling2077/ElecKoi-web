# ElecKoi WebUI · 多阶段构建
#
# 阶段 1（builder）：完整安装依赖并构建
#   - 跳过 Electron 二进制下载（Web 端运行时不需要，省 ~150 MB）
#   - better-sqlite3 在此阶段针对容器平台编译
#   - postinstall 会构建三个 workspace 包（author-sdk / compatibility-mvu / dsh-runtime）
# 阶段 2（runtime）：只复制运行所需内容，两阶段保持同一路径 /app，使 pnpm 的符号链接继续有效
#
# 注意：当前为 M1 单租户形态，**没有鉴权**。仅可用于本地/内网，不要直接暴露公网。

# ── 阶段 1：构建 ──────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    CI=1

# 原生模块编译工具链 + git
#   python3/make/g++：better-sqlite3 等原生模块
#   git：scripts/apply-patches.mjs 用 `git apply` 施加 patches/（slim 镜像默认不含 git）
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

WORKDIR /app

# 分层策略：依赖安装只依赖清单、packages/ 与 patches/，因此改 src/ 下任何文件都不会触发重装。
#   packages/ 必须在安装前就位：根 postinstall 会构建三个 workspace 包。
#   patches/ 同样必须就位：上游 v0.1.2 起用 package.json 的 pnpm.patchedDependencies
#   指向 patches/@scope__name@version.patch，pnpm install 阶段就要读这些文件
#   （原先只有末尾的 COPY . . 才带进来，安装会以 ENOENT 直接失败）。
#   patches/ 体积很小，单独拷一层不会影响缓存收益。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY patches ./patches

# 依赖安装源。默认走官方 registry（可移植），国内网络可换成镜像站大幅提速——
# 实测同一台机器上：元数据 632 KB/s → 11773 KB/s、包体 2465 KB/s → 5763 KB/s。
# 用法：docker/.env 里设 NPM_REGISTRY=https://registry.npmmirror.com（compose 会作为 build arg 传进来）。
# 锁定完整性由 pnpm-lock.yaml 里的 integrity 保证，换源不会改变包内容。
ARG NPM_REGISTRY=https://registry.npmjs.org
# COREPACK_NPM_REGISTRY 也要给：corepack 下载 pnpm 自身**不看** NPM_CONFIG_REGISTRY。
# 实测官方源下这步能卡十几分钟（甚至超时），走镜像站 28 秒。
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY \
    COREPACK_NPM_REGISTRY=$NPM_REGISTRY
RUN pnpm install --frozen-lockfile

# 其余源码（src/ resources/ scripts/ patches/ docker/ …）
COPY . .

# 渲染产物（out/renderer）+ 多租户服务端（out/web/entry.mjs）
# 先施加对上游的最小补丁（patches/），打不上会立刻失败——这是可更新性的告警点。
#
# 中间两步是 Node 24 下的必需覆盖，不是可选优化：
#   上游锁的 better-sqlite3 12.x 在 Node 24 上会让**每一次优雅关闭**都以
#   `Assertion failed: (env) != nullptr` → SIGABRT 收场（进程退出时 V8 最后一次 GC
#   回收残留的 Statement，其析构调 node::RemoveEnvironmentCleanupHook 时 Environment 已拆掉）。
#   restart: unless-stopped 下这表现为容器反复重启，看起来像崩溃循环。
#   覆盖只发生在镜像里（仓库的 package.json 保持上游原样，见 scripts/check-upstream-diff.mjs 的约束）；
#   --verify 会在版本没顶上去、或 N-API 产物不可用时直接让构建失败。
#   上游自行升级 better-sqlite3 后，删掉这两步与脚本本身。
#   详见 docs/webui/better-sqlite3-退出断言与容器重启.md
RUN node scripts/apply-patches.mjs \
 && node scripts/webui-pin-better-sqlite3.mjs \
 && pnpm install --no-frozen-lockfile \
 && node scripts/webui-pin-better-sqlite3.mjs --verify \
 && pnpm exec electron-vite build \
 && pnpm exec vite build --config src/web/vite.entry.config.ts

# ── 阶段 2：运行 ──────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    ELECKOI_APP_ROOT=/app \
    ELECKOI_DATA_DIR=/data \
    ELECKOI_RESOURCES=/app/resources \
    ELECKOI_HOST=0.0.0.0 \
    ELECKOI_PORT=8790 \
    ELECKOI_LOG_LEVEL=info \
    ELECKOI_ALLOW_REGISTRATION=1

# 非 root 运行；/data 为租户数据卷
RUN groupadd --gid 10001 eleckoi \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin eleckoi \
 && mkdir -p /data \
 && chown -R eleckoi:eleckoi /data

WORKDIR /app

# 同路径复制，保证 node_modules 里的 workspace 符号链接仍然指向有效目标
COPY --from=builder --chown=root:root /app/node_modules ./node_modules
COPY --from=builder --chown=root:root /app/package.json ./package.json
COPY --from=builder --chown=root:root /app/packages ./packages
COPY --from=builder --chown=root:root /app/resources ./resources
COPY --from=builder --chown=root:root /app/out ./out
# 运维脚本：备份/恢复需要在容器内可执行（依赖镜像里已有的 better-sqlite3 与 tar）。
# 两个坑都要避开：
#   1) 仓库签出的文件权限可能是 600，以 root 复制后非 root 进程读不到 → 必须 --chmod；
#   2) 若让 COPY 顺手创建父目录，--chmod 会一并套到目录上，目录失去执行位就进不去 → 先显式建目录。
RUN mkdir -p /app/docker && chmod 755 /app/docker
COPY --from=builder --chown=root:root --chmod=0644 /app/docker/backup-tenants.mjs ./docker/backup-tenants.mjs

USER eleckoi

EXPOSE 8790
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ELECKOI_PORT||8790)+'/__eleckoi/web-bridge.js').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "out/web/entry.mjs"]
