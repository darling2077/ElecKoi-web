/**
 * 导出文件的存放与清理。
 *
 * 为什么需要清理：批量导出把角色卡写到服务端（浏览器没有原生目录对话框），
 * 这些文件是**中转品**而不是用户数据——用户下载完就没用了。留在磁盘上既占空间，
 * 也让"导出目录"慢慢变成一堆无人认领的卡（角色卡里可能有隐私内容）。
 *
 * 因此定成两条：
 *   - 下载页提供「清理」按钮，用户自己随时清；
 *   - 超过 TTL（默认 15 分钟）的文件每次访问都会被顺手清掉，另有定时清扫兜底，
 *     即使没人打开页面也不会一直留着。
 */

import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export interface ExportFileEntry {
  readonly name: string
  readonly bytes: number
  readonly modified: Date
}

/** 默认保留时长：15 分钟。 */
export const DEFAULT_EXPORT_TTL_MS = 15 * 60 * 1000

/** 只接受单层文件名：挡掉目录穿越、隐藏文件与子目录。 */
export function exportFilePath(directory: string, name: string): string | undefined {
  if (name === '' || name.includes('/') || name.includes('\\') || name.startsWith('.')) return undefined
  const file = join(directory, name)
  return existsSync(file) && statSync(file).isFile() ? file : undefined
}

export function listExports(directory: string): ExportFileEntry[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => {
      const stats = statSync(join(directory, entry.name))
      return { name: entry.name, bytes: stats.size, modified: stats.mtime }
    })
    .sort((left, right) => right.modified.getTime() - left.modified.getTime())
}

/** 删除超过 ttlMs 的导出文件，返回删掉的个数。 */
export function pruneExports(directory: string, ttlMs: number, now = Date.now()): number {
  if (ttlMs <= 0 || !existsSync(directory)) return 0
  let removed = 0
  for (const entry of listExports(directory)) {
    if (now - entry.modified.getTime() < ttlMs) continue
    try {
      unlinkSync(join(directory, entry.name))
      removed += 1
    } catch {
      // 单个文件删不掉（例如正被下载）不该影响其余清理。
    }
  }
  return removed
}

/** 清空该租户的导出目录，返回删掉的个数。 */
export function clearExports(directory: string): number {
  if (!existsSync(directory)) return 0
  let removed = 0
  for (const entry of listExports(directory)) {
    try {
      unlinkSync(join(directory, entry.name))
      removed += 1
    } catch {
      // 同上：尽力而为。
    }
  }
  return removed
}

/**
 * 清扫所有租户的导出目录（定时兜底用）。
 * 目录约定是 `<数据根>/tenants/<租户 id>/exports`，这里只按约定遍历，不依赖租户是否已挂载。
 */
export function pruneAllTenantExports(tenantsRoot: string, ttlMs: number): number {
  if (ttlMs <= 0 || !existsSync(tenantsRoot)) return 0
  let removed = 0
  for (const entry of readdirSync(tenantsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    removed += pruneExports(join(tenantsRoot, entry.name, 'exports'), ttlMs)
  }
  return removed
}

/** 目录整体不可用时也不要抛：清理永远不该把主流程带崩。 */
export function tryRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // 忽略
  }
}
