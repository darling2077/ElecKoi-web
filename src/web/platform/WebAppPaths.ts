/**
 * 多租户数据目录。
 *
 * 与上游 AppPaths 保持同形（同名只读字段 + resolveResource），
 * 但根目录按租户指定，而不是 Electron 的 userData。
 *
 * 目录布局与方案 §3.2 一致：
 *   <tenantRoot>/
 *     ├── db/eleckoi-common.sqlite3
 *     ├── media/
 *     ├── workspace/
 *     └── dsh-runtime/
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export class WebAppPaths {
  readonly userData: string
  readonly database: string
  readonly workspace: string
  readonly dshRuntime: string
  readonly media: string

  constructor(readonly tenantId: string, tenantRoot: string) {
    this.userData = tenantRoot
    this.database = join(tenantRoot, 'db', 'eleckoi-common.sqlite3')
    this.workspace = join(tenantRoot, 'workspace')
    this.dshRuntime = join(tenantRoot, 'dsh-runtime')
    this.media = join(tenantRoot, 'media')
    mkdirSync(join(tenantRoot, 'db'), { recursive: true })
    mkdirSync(this.workspace, { recursive: true })
    mkdirSync(this.dshRuntime, { recursive: true })
    mkdirSync(this.media, { recursive: true })
  }

  /**
   * 部署级只读资源（cordis.yml、预设模板、许可文件），所有租户共享同一份。
   * 开发态指向仓库 resources/，容器内由 ELECKOI_RESOURCES 指向挂载点。
   */
  resolveResource(...segments: string[]): string {
    const candidates = [
      join(process.env.ELECKOI_RESOURCES ?? '', ...segments),
      join(process.env.ELECKOI_APP_ROOT ?? process.cwd(), 'resources', ...segments),
      join(process.env.ELECKOI_APP_ROOT ?? process.cwd(), 'out', 'resources', ...segments)
    ].filter((candidate) => candidate.length > 0)
    const match = candidates.find(existsSync)
    if (match === undefined) throw new Error(`缺少应用资源：resources/${segments.join('/')}`)
    return match
  }
}
