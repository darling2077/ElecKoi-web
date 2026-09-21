# better-sqlite3 退出断言：为什么每次优雅关闭都变成一次崩溃重启

## 一句话

Node 24 + better-sqlite3 12.x：进程退出时 V8 的最后一次 GC 回收残留的 `Statement` 包装对象，
其析构函数调用 `node::RemoveEnvironmentCleanupHook` 时 Environment 已经拆掉 → 断言 → SIGABRT。
于是**每一次正常关闭都被记成一次崩溃**，在 `restart: unless-stopped` 下表现为容器反复重启。
修法：镜像内把 better-sqlite3 顶到 13.x（改用 N-API 实现，析构不再走那个钩子）。

## 现场长什么样（怎么认出来）

容器日志（`docker logs eleckoi-web`）：

```
收到 SIGTERM，正在关闭……

  #  node[1]: void node::RemoveEnvironmentCleanupHook(v8::Isolate*, CleanupHook, void*) at ../src/api/hooks.cc:142
  #  Assertion failed: (env) != nullptr

----- Native stack trace -----
 1: node::Assert(node::AssertionInfo const&) [node]
 3: node::RemoveEnvironmentCleanupHook(v8::Isolate*, void (*)(void*), void*) [node]
 4: Statement::~Statement() [better-sqlite3]
 5: Statement::~Statement() [better-sqlite3]
 6: v8::internal::GlobalHandles::InvokeFirstPassWeakCallbacks()
 7: v8::internal::Heap::PerformGarbageCollection(...)
 8: v8::internal::Heap::CollectGarbage(...)
```

`docker inspect` 里 `RestartCount` 一路涨；`dmesg` 同一时刻还有一条

```
traps: MainThread[<pid>] general protection fault ip:... in libc.so.6[2650f,...]
```

**那条 GPF 不是起点，别从它往下查。** 它是 glibc `abort()` 走到最后一条兜底指令 `hlt` 留下的：
`raise(SIGABRT)` 没能终止进程时才执行，用户态执行 `hlt` → #GP → 内核记一条 trap。
反汇编可自证：`abort` 起始于 libc vaddr `0x2639f`，出错指令落在 `+0x170`（即 `0x2650f`）。
`sig` 只有 `MainThread`、且与容器重启一一对应时，就是本文这个缺陷。

## 为什么不怀疑内存/硬件/租户活动

| 现象 | 实测 |
| --- | --- |
| 宿主级硬件问题 | `dmesg` 里 13 次 trap 全是本容器的 `MainThread`；无 MCE/EDAC；同机其他容器零重启 |
| 内存压力 / OOM | `OOMKilled=false`；崩溃间隔 6 秒～17 小时不等，与负载无关 |
| 租户活动触发 | 空转 17 小时（期间无租户挂载）照样崩；**只与「进程要退出」相关** |
| 决定性实验 | 对主进程 `kill -TERM`：改前 100% 复现同样签名，改后干净退出 |

另外两个容易走偏的方向，都已排除：

- 崩溃栈里的 `Statement::~Statement()` 来自**主进程**（`node[1]` 是容器 PID 1；
  DSH 运行时子进程的 NSpid 是 33，且它没有加载 better-sqlite3）。
- 容器 rootfs 是只读的（`read_only: true`），core dump 不会落盘，别指望 core 文件。

## 机制（精确到代码）

- better-sqlite3 12.x 的 `Database`/`Statement` 继承 Node 原生 `node::ObjectWrap`。
- Node 24 的 `node_object_wrap.h`：构造函数 `AddEnvironmentCleanupHook(...)`，
  析构函数 `RemoveEnvironmentCleanupHook(v8::Isolate::GetCurrent(), ...)`，
  而 Node 侧该函数是 `CHECK_NOT_NULL(env)`（`src/api/hooks.cc:142`），**没有 null 兜底**。
- 退出顺序：Node 先拆掉 Environment → V8 做最后一次 GC → 弱回调 `delete` 残留的 `Statement`
  → 析构里 `Environment::GetCurrent(isolate)` 已是 `nullptr` → 断言 → `abort()`。
- 所以它与业务逻辑无关；残留语句越多（真实部署：registry 库 + 租户库 + drizzle 语句缓存）越必然命中。

## 修法：镜像内覆盖到 13.x

| 位置 | 做法 |
| --- | --- |
| `docker/Dockerfile` | `apply-patches` 之后依次：`scripts/webui-pin-better-sqlite3.mjs` → `pnpm install --no-frozen-lockfile` → 同脚本 `--verify` |
| `scripts/webui-pin-better-sqlite3.mjs` | 写入 `pnpm.overrides["better-sqlite3"] = 13.0.3`；`--verify` 校验实际装到 ≥13 **且原生模块能建库查数**，不满足就让构建失败 |
| 仓库 `package.json` / `pnpm-lock.yaml` | **保持上游原样**——门禁 `check:upstream-diff` 要求 `package.json` 与基线逐字一致（只允许新增 script），改了就毁掉「一条线 rebase 上游」这个前提 |

为什么 v13 就好了：13.0.0 起改用 **node-addon-api（N-API）** 实现，析构不再调用那个钩子；
公开 API（`prepare`/`transaction`/`exec`/`run`/`get`/`all`/`pragma`/`function`/`backup`…）未变，
不需要改任何业务代码。顺带好处：v13 移除了 `prebuild-install` 依赖树（`bindings`/`bl` 等），
预编译产物直接随包发布。

副作用（要知道，但不影响验收）：**本地开发树仍是上游锁的 12.x**，只有镜像里是 13.x。
这是「不动上游文件」换来的代价，也是当前唯一的「镜像 ≠ 本地树」差异来源。
本机 Node 同样 ≥24，理论上也有这个缺陷，但 POC 进程退出时没有残留语句，全量验收实测未见断言。

## 怎么验证（改前必崩、改后干净）

```bash
# 基线：记下 RestartCount
docker inspect -f '{{.RestartCount}}' eleckoi-web

# 复现/验证都靠这一下：给主进程发 SIGTERM
kill -TERM "$(docker inspect -f '{{.State.Pid}}' eleckoi-web)"

# 改前：日志里出现 Assertion failed，RestartCount +1，dmesg 多一条 general protection
# 改后期望：
docker logs --since 60s eleckoi-web | grep -c "Assertion failed"   # 0
docker inspect -f '{{.RestartCount}}' eleckoi-web                  # 只 +1（正常重启）
```

顺带说明：容器内 `better-sqlite3` 的实际版本可以直接问：

```bash
docker exec eleckoi-web node -p "require('better-sqlite3/package.json').version"
```

## 何时删掉这段覆盖

上游把 better-sqlite3 升到 13.x（或 Node 侧给 `RemoveEnvironmentCleanupHook` 补上兜底）之后，
删掉：Dockerfile 里的两步调用、`scripts/webui-pin-better-sqlite3.mjs`、以及本文。
`--verify` 只要求 ≥ 13，所以上游升级后即便忘了删也不会误报。

## 参考

- 同一个断言的上游报告：[earendil-works/pi#8492](https://github.com/earendil-works/pi/issues/8492)（同因、同解，含 better-sqlite3 12.x → 13.0.x 的建议）
- better-sqlite3 v13.0.0 发布说明：迁到 N-API、预编译产物随包发布
