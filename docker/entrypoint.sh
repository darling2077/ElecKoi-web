#!/bin/sh
#
# 容器入口：先做数据迁移，再启动服务。
#
# 为什么放在这里，而不是：
#   1) 放进上游代码（补丁）——上游正在频繁重写 AgentPresetRepository.ts，
#      补丁会在每次上游更新时冲突；而入口脚本完全不碰上游。
#   2) 放进我们的 Web 服务进程内——那样要等应用起来、数据库已被打开之后才跑，
#      既多一层耦合，也可能和运行中的连接抢锁。入口在应用之前跑，天然没有这个问题。
#   3) 留给用户手工执行——**会被漏掉**。漏掉的后果是预设页面直接报错。
#
# 迁移工具是幂等的：没有旧键的库上什么都不做，所以每次启动都跑一遍没有副作用。
#
# 环境变量：
#   ELECKOI_AUTO_MIGRATE=0   跳过自动迁移（想完全手动控制时用）
#   ELECKOI_DATA_DIR=/data   数据目录（与 compose 保持一致）
#
set -eu

DATA_DIR="${ELECKOI_DATA_DIR:-/data}"
MIGRATOR=/app/docker/migrate-preset-tool-policy.mjs

if [ "${ELECKOI_AUTO_MIGRATE:-1}" = "0" ]; then
  echo "[entrypoint] ELECKOI_AUTO_MIGRATE=0，跳过数据迁移"
else
  echo "[entrypoint] 数据迁移：agent 预设内容键 tool_policy → tool_configuration"
  # 迁移失败不阻断启动：服务本身仍可用（受影响的只是预设页面），
  # 而且让人进不去容器反而更难排查。这里把失败原因和补救命令打清楚。
  if ! node "$MIGRATOR" "$DATA_DIR" --apply; then
    echo "[entrypoint] ⚠️ 数据迁移失败，服务仍会启动。" >&2
    echo "[entrypoint]    若预设页面报「预设缺少工具配置」，请手动执行：" >&2
    echo "[entrypoint]    node $MIGRATOR $DATA_DIR --apply" >&2
  fi
fi

# exec：让 node 成为 PID 1，docker stop 的信号才能正确送达。
exec "$@"
