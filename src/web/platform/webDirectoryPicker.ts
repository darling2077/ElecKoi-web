/**
 * Web 版的「选择目录」。
 *
 * 上游 v0.1.10 给 `characterTransferPlugin` 增加了 `directoryPicker` 依赖（批量导出角色卡时
 * 弹一次原生目录对话框，之后由主进程直接写盘）。浏览器里没有这种能力，于是这里给出
 * **服务端等价物**：导出统一写到该租户的导出目录 `<租户根>/exports`，
 * 用户在站内 `/exports` 页面即可下载（见 `http/server.ts` 的导出路由与 `http/exportsPage.ts`）。
 *
 * 为什么不能简单返回 `undefined`（当作"用户取消"）：
 *   该插件把 `directoryPicker` 放在 `inject` 里，**缺这个服务整块 apply 都不会执行** ——
 *   连角色卡导入那三条路由也会一起消失（我们的图床搬运正挂在导入上）。
 *   返回取消虽然能让路由重新注册，但会把上游新功能在 Web 上变成"点了没反应"。
 */
export interface DirectoryPickerRequest {
  readonly title: string
  readonly buttonLabel: string
}

export class WebDirectoryPicker {
  constructor(
    private readonly directory: string,
    private readonly log: (message: string) => void
  ) {}

  async pickDirectory(request: DirectoryPickerRequest): Promise<string | undefined> {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(this.directory, { recursive: true })
    this.log(
      `${request.title}：Web 端没有原生目录对话框，统一导出到 ${this.directory}（可在站内 /exports 下载）`
    )
    return this.directory
  }
}
