/**
 * Web 版的「在文件管理器中显示」。
 *
 * 上游 v0.2.0 让 agentPlugin 注入 `fileOpener`（桌面端调 `shell.showItemInFolder`，
 * 在资源管理器/Finder 里高亮文件）。浏览器没有系统文件管理器，这里给一个**诚实的等价物**：
 * 明确告诉用户该怎么做，而不是假装成功。
 *
 * 为什么不静默忽略：上游有 `command.agent.file.reveal` 路由，用户点了「在文件夹中显示」
 * 却什么也没发生，是最难排查的一类问题；给一句明确的话，用户就知道该去下载页取文件。
 *
 * ⚠️ 这个服务不能省：agentPlugin 的 inject 里有它，缺了整块 Agent 插件都不会加载
 * （连 `command.agent.start` 在内的 18 条路由都会一起消失）。
 */
export class WebFileOpener {
  constructor(private readonly log: (message: string) => void) {}

  reveal(path: string): void {
    this.log(`Web 端不支持在系统文件管理器中显示文件：${path}`)
    throw new Error('这是网页版：请在下载页取回文件，或直接在对话里下载。')
  }
}
