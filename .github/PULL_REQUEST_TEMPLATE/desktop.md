## Desktop Change（桌面端改动）

### What changed（改了什么）

<!-- 用中文或 English（中文）说明用户可见变化和底层变化。 -->

### Architecture route（架构归属）

- [ ] Main 新文件位于闭合集合：`host / gateway / modules / platform / i18n`
- [ ] Shared 新文件位于闭合集合：`contracts / foundation`
- [ ] Renderer 的 Query / Command / Event 只走 `Desktop Gateway`
- [ ] Renderer 未直接访问 Electron、Node、SQLite 或 DSH SDK
- [ ] DSH 只经 `@eleckoi/dsh-runtime`；上游包仍是同一个精确版本批次
- [ ] 新业务进入垂直模块，跨模块依赖只使用对方 `index.ts` 公开面
- [ ] 长生命周期资源已注册为 Host/Cordis Plugin，并能反向释放

### Data and compatibility（数据与兼容）

- [ ] Schema 改动附带新的向前迁移，没有重写已发布迁移
- [ ] 没有把会话、消息、角色或模型配置写入 localStorage
- [ ] 旧数据、取消、失败或异常退出路径已考虑

### Verification（验证）

- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] DSH 改动已通过 `pnpm check:electron-dsh`；发布链改动已通过 `pnpm build:unpack`
- [ ] 没有启动 Android、Docker、QEMU 或 ARM64 DSH 核心编译
- [ ] UI 未定稿阶段没有借底层改造擅自改变 JSX/CSS 视觉

### Review scope（审查范围）

<!-- 列出需要审查的明确路径；不要混入 Android、私有知识库、截图或构建产物。 -->
